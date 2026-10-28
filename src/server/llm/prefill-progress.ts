import { stripVersionPrefix } from './url-utils.js'

/**
 * Live prefill progress from a llama.cpp server's GET /slots endpoint.
 *
 * The only field the engine reports reliably while a request is being
 * prefilled is n_prompt_tokens_processed (advancing, but only for the tokens
 * NOT served from the KV cache — n_prompt_tokens_cache). The prompt TOTAL is
 * known by the caller (it built the prompt), so progress is measured over the
 * uncached remainder of that known total; n_prompt_tokens is a rolling value
 * in some builds (it lags n_prompt_tokens_processed) and is only used as a
 * fallback when no known total is available.
 *
 * Slot identity: with multiple parallel slots (llama.cpp --parallel >= 2),
 * matching by prompt size alone is ambiguous (two busy slots of similar size,
 * or a stale estimate pointing at the wrong slot). llama.cpp reports a
 * unique, monotonically-increasing id_task per request in /slots, so the
 * caller snapshots the known task ids BEFORE sending the request and the
 * poller tracks the slot whose id_task is new. Two concurrent sessions on
 * the same server would each see the other's fresh task, so a fresh task is
 * only adopted when its prompt size is plausible (within ADOPTION_TOLERANCE
 * of the expected size) and task ids adopted by other pollers of the same
 * server are excluded via a per-server claim registry. The size heuristic
 * remains the fallback for builds that do not report id_task.
 *
 * The poller runs for the duration of ONE LLM call and degrades silently
 * (no emission) when it cannot reliably identify the request's slot.
 */

export interface PrefillProgressSnapshot {
  /** Total prompt tokens for the in-flight request (known total, engine fallback). */
  promptTokens: number
  /** Prompt tokens processed so far (the uncached work done). */
  processedTokens: number
  /** Prefill completion, 0-100. */
  percent: number
  /** Remaining time in seconds (from the live prefill speed), when measurable. */
  etaSeconds?: number
  /** Live prefill speed in tokens/sec, when measurable. */
  speedTps?: number
  /** The engine slot handling the request (llama.cpp slot id). */
  slotId: number
  /** The engine task id of the request (llama.cpp id_task), when reported. */
  taskId?: number
  /** Prompt tokens served from the KV cache, when reported by the engine. */
  cachedTokens?: number
}

export interface SlotInfo {
  id: number
  is_processing: boolean
  n_prompt_tokens: number
  n_prompt_tokens_processed: number
  /** Prompt tokens served from the KV cache (done without compute). */
  n_prompt_tokens_cache?: number
  /** Unique, monotonically-increasing task id assigned by llama.cpp when a request lands. */
  id_task?: number
}

export interface PrefillProgressOptions {
  /** LLM server base URL (version prefix stripped internally), e.g. http://host:8080/v1. */
  serverBaseUrl: string
  /** Expected prompt size in tokens — the progress denominator (and size-heuristic tiebreaker). */
  expectedPromptTokens: number
  onProgress: (snapshot: PrefillProgressSnapshot) => void
  signal?: AbortSignal
  /** Poll interval in ms (default 350). */
  intervalMs?: number
  /** Stop after this many consecutive poll failures (default 4). */
  maxConsecutiveFailures?: number
  /** Fetch implementation override (tests). */
  fetchImpl?: typeof fetch
  /**
   * Task ids the engine already knew about before the request was sent.
   * The slot whose id_task is NOT in this set is the one handling our
   * request — identity tracking that replaces the size heuristic.
   */
  knownTaskIds?: Set<number>
}

const DEFAULT_INTERVAL_MS = 350
const MAX_CONSECUTIVE_FAILURES = 4
/** The pre-request /slots snapshot is an optimization, never a blocker for the LLM call. */
const KNOWN_TASKS_TIMEOUT_MS = 2000
/** ~4 chars per token — same heuristic as the tool-definition budget (chat/token-budget.ts). */
const CHARS_PER_TOKEN = 4

/** Message shape sufficient to estimate a prompt size (LLMMessage and ContextMessage both match). */
export interface EstimatableMessage {
  role: string
  content: string
  thinkingContent?: string
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>
}

/**
 * Rough token estimate of an outgoing prompt (system prompt + messages).
 * Used as the progress denominator when the session's tracked context size
 * is unavailable — the first call of a session (context state is 0 until a
 * response completes and reports real usage) or right after a server
 * restart. An estimate keeps the bar meaningful instead of falling back to
 * the engine's rolling n_prompt_tokens.
 */
export function estimatePromptTokens(messages: ReadonlyArray<EstimatableMessage>, systemPrompt?: string): number {
  let chars = systemPrompt?.length ?? 0
  for (const message of messages) {
    chars += message.content.length
    if (message.thinkingContent) chars += message.thinkingContent.length
    for (const call of message.toolCalls ?? []) {
      chars += call.name.length + JSON.stringify(call.arguments).length
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}
/**
 * Two busy slots are considered ambiguous when the runner-up's distance from
 * the expected prompt size is within this fraction of the expected size of
 * the best slot's distance — in that case we cannot tell which slot is ours.
 */
const MATCH_TOLERANCE = 0.15
/**
 * A fresh task is adopted as the request's own only when its prompt size is
 * within this fraction of the expected size — the pre-request snapshot and
 * the request landing are not atomic, so a lone fresh task may belong to a
 * concurrent request of another session.
 */
const ADOPTION_TOLERANCE = 0.5

/**
 * Task ids already adopted by other pollers of the same server (module-level
 * registry, keyed by version-stripped server root). A claim is released when
 * its poller stops; stale claims are harmless because id_task is monotonic
 * and finished tasks are no longer reported as busy.
 */
const claimedTaskIdsByServer = new Map<string, Set<number>>()

function claimedTaskIdsFor(serverBaseUrl: string): Set<number> {
  const key = stripVersionPrefix(serverBaseUrl).replace(/\/+$/, '')
  let claims = claimedTaskIdsByServer.get(key)
  if (!claims) {
    claims = new Set()
    claimedTaskIdsByServer.set(key, claims)
  }
  return claims
}

/**
 * Prompt tokens served from the KV cache (done without compute).
 */
function slotCached(slot: SlotInfo): number {
  return slot.n_prompt_tokens_cache ?? 0
}

/**
 * The prompt total: the caller-known size, falling back to the engine's
 * n_prompt_tokens (a rolling value in some builds) when unknown.
 */
function slotTotal(slot: SlotInfo, expectedPromptTokens: number): number {
  return expectedPromptTokens > 0 ? expectedPromptTokens : slot.n_prompt_tokens
}

/**
 * The real work of the request: prompt tokens NOT served from the KV cache.
 * llama.cpp does not count cache hits in n_prompt_tokens_processed, so
 * progress must be measured over this remainder — a warm prefill would
 * otherwise sit at 0% (or jump to 100%) for its whole duration.
 */
function slotWork(slot: SlotInfo, expectedPromptTokens: number): number {
  return Math.max(0, slotTotal(slot, expectedPromptTokens) - slotCached(slot))
}

/**
 * Work done so far, capped at the real work (the engine can report a few
 * processed tokens beyond the uncached remainder).
 */
function slotDone(slot: SlotInfo, expectedPromptTokens: number): number {
  return Math.min(slot.n_prompt_tokens_processed, slotWork(slot, expectedPromptTokens))
}

/**
 * A fresh task is a plausible candidate for the request's own slot when its
 * prompt size is within ADOPTION_TOLERANCE of the expected size — a lone
 * fresh task whose size is far off is most likely a concurrent request from
 * another session, not ours.
 */
function slotIsPlausible(slot: SlotInfo, expectedPromptTokens: number): boolean {
  if (expectedPromptTokens <= 0) return true
  return Math.abs(slot.n_prompt_tokens - expectedPromptTokens) <= expectedPromptTokens * ADOPTION_TOLERANCE
}

/**
 * Snapshot the task ids the engine already knows about (one GET /slots).
 * Used to identify the new request's slot: the slot whose id_task is absent
 * from this set is ours. Returns null when the endpoint is unreachable, the
 * fetch is aborted or times out, the payload is not an array, or the build
 * does not report id_task — the caller then falls back to the prompt-size
 * heuristic. The fetch is bounded (KNOWN_TASKS_TIMEOUT_MS) so a wedged engine
 * degrades to the heuristic instead of stalling the LLM call.
 */
export async function fetchKnownTaskIds(
  serverBaseUrl: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<number> | null> {
  try {
    const url = `${stripVersionPrefix(serverBaseUrl).replace(/\/+$/, '')}/slots`
    const res = await fetchImpl(url, {
      signal: AbortSignal.any([AbortSignal.timeout(KNOWN_TASKS_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    })
    if (!res.ok) return null
    const data = (await res.json()) as SlotInfo[]
    if (!Array.isArray(data)) return null
    const ids = data.map((s) => s.id_task).filter((id): id is number => typeof id === 'number')
    return ids.length > 0 ? new Set(ids) : null
  } catch {
    return null
  }
}

/**
 * Pick the request's slot by identity (fresh id_task) when known task ids are
 * available and the build reports them; otherwise by prompt-size proximity.
 * A fresh task is only adopted when its prompt size is plausible for the
 * expected prompt (a lone fresh task of a very different size is most likely
 * a concurrent request of another session). claimedTaskIds are task ids
 * already adopted by other pollers of the same server and are excluded from
 * the fresh set. Returns null when no slot is busy, when no fresh task has
 * landed yet, or when the size heuristic cannot disambiguate (fail-safe: the
 * caller emits nothing rather than a confidently-wrong number).
 */
export function selectPrefillSlot(
  slots: SlotInfo[],
  expectedPromptTokens: number,
  knownTaskIds?: Set<number>,
  claimedTaskIds?: Set<number>,
): SlotInfo | null {
  const busy = slots.filter(
    (s) =>
      s.is_processing && s.n_prompt_tokens > 0 && slotDone(s, expectedPromptTokens) < slotWork(s, expectedPromptTokens),
  )
  if (busy.length === 0) return null
  if (knownTaskIds && busy.some((s) => s.id_task !== undefined)) {
    const fresh = busy.filter(
      (s) => s.id_task !== undefined && !knownTaskIds.has(s.id_task) && !claimedTaskIds?.has(s.id_task),
    )
    if (fresh.length === 1) {
      const slot = fresh[0] ?? null
      return slot && slotIsPlausible(slot, expectedPromptTokens) ? slot : null
    }
    if (fresh.length > 1) {
      // Several fresh tasks (concurrent external requests) — disambiguate
      // among the fresh candidates only, with the size heuristic.
      const slot = selectByPromptSize(fresh, expectedPromptTokens)
      return slot && slotIsPlausible(slot, expectedPromptTokens) ? slot : null
    }
    // Every busy slot carries a pre-existing task: our request has not
    // landed yet (or prefill already finished between polls).
    return null
  }
  return selectByPromptSize(busy, expectedPromptTokens)
}

/**
 * Pick the candidate slot closest to the expected prompt size.
 * Returns null when two candidates are both close enough to the expected
 * size to be indistinguishable.
 */
function selectByPromptSize(candidates: SlotInfo[], expectedPromptTokens: number): SlotInfo | null {
  if (candidates.length === 1) return candidates[0] ?? null
  const scored = candidates
    .map((slot) => ({ slot, distance: Math.abs(slot.n_prompt_tokens - expectedPromptTokens) }))
    .sort((a, b) => a.distance - b.distance)
  const best = scored[0]
  const runnerUp = scored[1]
  if (!best) return null
  if (runnerUp && Math.abs(runnerUp.distance - best.distance) <= expectedPromptTokens * MATCH_TOLERANCE) {
    return null
  }
  return best.slot
}

/**
 * Compute a progress snapshot for a busy slot. The percentage covers the
 * uncached remainder of the caller-known prompt total, so warm prefills
 * advance 0→100 over the real work and the engine's rolling n_prompt_tokens
 * never inflates the number. The live speed (and thus the ETA) is derived
 * from the delta between this poll and the previous one, so the first
 * snapshot of a call carries no speed/ETA.
 */
export function computePrefillSnapshot(
  slot: SlotInfo,
  expectedPromptTokens: number,
  prev: { processedTokens: number; at: number } | undefined,
  now: number,
): PrefillProgressSnapshot {
  const work = slotWork(slot, expectedPromptTokens)
  const done = slotDone(slot, expectedPromptTokens)
  const percent = work > 0 ? Math.min(100, Math.round((done / work) * 100)) : 100
  let speedTps: number | undefined
  let etaSeconds: number | undefined
  if (prev && now > prev.at && done > prev.processedTokens) {
    speedTps = (done - prev.processedTokens) / ((now - prev.at) / 1000)
    const remaining = work - done
    if (speedTps > 0 && remaining > 0) {
      etaSeconds = remaining / speedTps
    }
  }
  return {
    promptTokens: slotTotal(slot, expectedPromptTokens),
    processedTokens: done,
    percent,
    ...(speedTps !== undefined ? { speedTps: Math.round(speedTps) } : {}),
    ...(etaSeconds !== undefined ? { etaSeconds: Math.ceil(etaSeconds) } : {}),
    slotId: slot.id,
    ...(slot.id_task !== undefined ? { taskId: slot.id_task } : {}),
    ...(slot.n_prompt_tokens_cache !== undefined ? { cachedTokens: slot.n_prompt_tokens_cache } : {}),
  }
}

/**
 * Start polling the server's /slots endpoint for the prefill progress of one
 * LLM call. Returns a stop function; polling also stops on its own when the
 * matched slot finishes prefilling, on abort, or after consecutive failures.
 */
export function startPrefillProgressPolling(options: PrefillProgressOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const maxFailures = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${stripVersionPrefix(options.serverBaseUrl).replace(/\/+$/, '')}/slots`
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  let prev: { processedTokens: number; at: number } | undefined
  let myTaskId: number | undefined
  const claims = claimedTaskIdsFor(options.serverBaseUrl)

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (myTaskId !== undefined) claims.delete(myTaskId)
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const poll = async (): Promise<void> => {
    if (stopped) return
    try {
      const res = await fetchImpl(url, {
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (!res.ok) throw new Error(`slots endpoint returned ${res.status}`)
      const data = (await res.json()) as SlotInfo[]
      failures = 0
      const otherClaims = new Set(claims)
      if (myTaskId !== undefined) otherClaims.delete(myTaskId)
      const slot = selectPrefillSlot(
        Array.isArray(data) ? data : [],
        options.expectedPromptTokens,
        options.knownTaskIds,
        otherClaims,
      )
      if (slot) {
        if (slot.id_task !== undefined && myTaskId !== slot.id_task) {
          myTaskId = slot.id_task
          claims.add(slot.id_task)
        }
        const now = Date.now()
        const snapshot = computePrefillSnapshot(slot, options.expectedPromptTokens, prev, now)
        prev = { processedTokens: slotDone(slot, options.expectedPromptTokens), at: now }
        options.onProgress(snapshot)
        if (slotDone(slot, options.expectedPromptTokens) >= slotWork(slot, options.expectedPromptTokens)) {
          stop()
          return
        }
      }
    } catch {
      if (options.signal?.aborted) {
        stop()
        return
      }
      failures += 1
      if (failures >= maxFailures) {
        stop()
        return
      }
    }
    if (!stopped) {
      timer = setTimeout(poll, intervalMs)
    }
  }

  timer = setTimeout(poll, intervalMs)
  options.signal?.addEventListener('abort', stop, { once: true })
  return stop
}
