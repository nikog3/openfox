/**
 * Estimated prefill progress for backends that do not expose live engine
 * progress (everything except llama.cpp's /slots endpoint).
 *
 * The estimate projects the session's most recently measured prefill speed
 * onto the current call. With a warm KV cache only the tokens added since
 * the previous call need real compute — the rest is a cache hit — so the
 * incremental token count is used as the work size when it is known and
 * positive. Returns no estimate when no speed is known (e.g. the first call
 * of a session): the UI then falls back to the minimal tier.
 */

export interface PrefillEstimateInput {
  /** Prompt size being prefilled (tokens). */
  contextTokens: number
  /** Tokens added since the previous call (warm-cache incremental work), when known. */
  tokenIncrement?: number
  /** Measured prefill speed of the most recent LLM call (tokens/sec), when known. */
  lastPrefillSpeed?: number
  /** Elapsed time in ms since the prefill started. */
  elapsedMs: number
}

export interface PrefillEstimate {
  /** Estimated completion 0-99 (never 100 — the first token is the truth). */
  percent?: number
  /** Estimated remaining time in seconds. */
  etaSeconds?: number
}

export function estimatePrefill(input: PrefillEstimateInput): PrefillEstimate {
  const speed = input.lastPrefillSpeed
  if (!speed || speed <= 0) return {}
  const work =
    input.tokenIncrement !== undefined && input.tokenIncrement > 0
      ? Math.min(input.tokenIncrement, input.contextTokens)
      : input.contextTokens
  const totalSeconds = work / speed
  if (totalSeconds <= 0) return {}
  const elapsedSeconds = input.elapsedMs / 1000
  const percent = Math.min(99, Math.max(0, Math.round((elapsedSeconds / totalSeconds) * 100)))
  const etaSeconds = Math.max(0, Math.round(totalSeconds - elapsedSeconds))
  return { percent, etaSeconds }
}
