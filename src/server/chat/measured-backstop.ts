import { TOOL_MESSAGE_OVERHEAD_TOKENS } from './token-budget.js'
// Dense-content token estimate (code/JSON/markup tokenize ~2.4 chars/token,
// deliberately denser than the chars/4 budget heuristic). Shared with the
// dynamic tool-output cap so the backstop and the cap can never diverge.
import { DENSE_CHARS_PER_TOKEN } from '../tools/output-cap.js'

/** Hard output reserve: max_tokens always leaves this much room for the reply. */
export const OUTPUT_RESERVE_TOKENS = 2048

/** Max iterative truncation passes (the prompt is re-measured after each cut). */
export const MAX_BACKSTOP_ITERATIONS = 3

/** Safety margin on the target tool budget so the dense/ceil estimate lands
 *  under the window even after rounding. */
const BUDGET_SAFETY_FACTOR = 0.99

export type TokenizeFn = (content: string, model?: string) => Promise<number | null>

export interface MeasuredBackstopInput {
  toolMessages: Array<{ content: string }>
  /** Tokens already consumed by the prior context (last LLM usage). */
  usedTokens: number
  contextWindow: number
  tokenize?: TokenizeFn
  model?: string
}

export interface MeasuredBackstopResult {
  /** Truncated tool message contents, in original order. */
  contents: string[]
  measuredPromptTokens: number
  measuredToolTokens: number
  maxTokens: number
  truncated: boolean
}

function denseEstimate(content: string): number {
  return Math.ceil(content.length / DENSE_CHARS_PER_TOKEN)
}

/**
 * Measure the token count of a batch of tool messages, using the backend
 * tokenizer per message when available and falling back to the dense ratio.
 */
export async function measureToolMessages(
  toolMessages: Array<{ content: string }>,
  tokenize?: TokenizeFn,
  model?: string,
): Promise<number> {
  const counts = await Promise.all(
    toolMessages.map(async (m) => {
      if (tokenize && m.content) {
        const t = await tokenize(m.content, model)
        return t ?? denseEstimate(m.content)
      }
      return denseEstimate(m.content)
    }),
  )
  return toolMessages.length * TOOL_MESSAGE_OVERHEAD_TOKENS + counts.reduce((s, t) => s + t, 0)
}

/**
 * The hard invariant: max_tokens leaves room for the measured prompt plus the
 * output reserve, floored at 256 so the model always has room to respond.
 */
export function computeMaxTokens(contextWindow: number, measuredPromptTokens: number): number {
  return Math.max(256, contextWindow - measuredPromptTokens - OUTPUT_RESERVE_TOKENS)
}

/**
 * Measured backstop: measure the real prompt size, then iteratively truncate
 * the tool results (re-measuring after each pass, up to MAX_BACKSTOP_ITERATIONS)
 * until prompt + reserve fits the window. Returns the truncated contents and
 * the invariant max_tokens.
 */
export async function applyMeasuredBackstop(input: MeasuredBackstopInput): Promise<MeasuredBackstopResult> {
  const { toolMessages, usedTokens, contextWindow, tokenize, model } = input
  const contents = toolMessages.map((m) => m.content)
  let measuredToolTokens = await measureToolMessages(
    contents.map((c) => ({ content: c })),
    tokenize,
    model,
  )
  let measuredPromptTokens = usedTokens + measuredToolTokens
  let truncated = false

  for (let i = 0; i < MAX_BACKSTOP_ITERATIONS; i++) {
    if (measuredPromptTokens + OUTPUT_RESERVE_TOKENS <= contextWindow) break
    const budget = Math.floor((contextWindow - OUTPUT_RESERVE_TOKENS - usedTokens) * BUDGET_SAFETY_FACTOR)
    if (budget <= 0) break
    const scale = budget / measuredToolTokens
    if (scale >= 1) break
    for (let j = 0; j < contents.length; j++) {
      const target = Math.max(0, Math.floor(contents[j]!.length * scale))
      contents[j] = contents[j]!.slice(0, target)
    }
    truncated = true
    measuredToolTokens = await measureToolMessages(
      contents.map((c) => ({ content: c })),
      tokenize,
      model,
    )
    measuredPromptTokens = usedTokens + measuredToolTokens
  }

  return {
    contents,
    measuredPromptTokens,
    measuredToolTokens,
    maxTokens: computeMaxTokens(contextWindow, measuredPromptTokens),
    truncated,
  }
}
