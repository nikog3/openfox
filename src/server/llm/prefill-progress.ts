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
}

export interface SlotInfo {
  id: number
  is_processing: boolean
  n_prompt_tokens: number
  n_prompt_tokens_processed: number
  /** Prompt tokens served from the KV cache (done without compute). */
  n_prompt_tokens_cache?: number
}

export interface PrefillProgressOptions {
  /** LLM server base URL (version prefix stripped internally), e.g. http://host:8080/v1. */
  serverBaseUrl: string
  /** Expected prompt size in tokens — the progress denominator and the slot disambiguator. */
  expectedPromptTokens: number
  onProgress: (snapshot: PrefillProgressSnapshot) => void
  signal?: AbortSignal
  /** Poll interval in ms (default 350). */
  intervalMs?: number
  /** Stop after this many consecutive poll failures (default 4). */
  maxConsecutiveFailures?: number
  /** Fetch implementation override (tests). */
  fetchImpl?: typeof fetch
}

const DEFAULT_INTERVAL_MS = 350
const MAX_CONSECUTIVE_FAILURES = 4
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
 * Pick the busy slot that matches the expected prompt size.
 * Returns null when no slot is busy, or when two busy slots are both close
 * enough to the expected size to be indistinguishable (fail-safe: the caller
 * emits nothing rather than a confidently-wrong number).
 */
export function selectPrefillSlot(slots: SlotInfo[], expectedPromptTokens: number): SlotInfo | null {
  const busy = slots.filter(
    (s) =>
      s.is_processing && s.n_prompt_tokens > 0 && slotDone(s, expectedPromptTokens) < slotWork(s, expectedPromptTokens),
  )
  if (busy.length === 0) return null
  if (busy.length === 1) return busy[0] ?? null
  const scored = busy
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

  const stop = (): void => {
    if (stopped) return
    stopped = true
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
      const slot = selectPrefillSlot(Array.isArray(data) ? data : [], options.expectedPromptTokens)
      if (slot) {
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
