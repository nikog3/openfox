import { COMPACTION_PROMPT } from '../chat/prompts.js'
import { OUTPUT_RESERVE_TOKENS } from '../chat/measured-backstop.js'
import { DENSE_CHARS_PER_TOKEN } from '../tools/output-cap.js'
import { COMPACTION_SUMMARY_BUDGET_TOKENS, MIN_COMPACTION_SUMMARY_LENGTH, messageWireSize } from './compactor.js'
import type { LLMClientWithModel } from '../llm/client.js'
import type { ContextMessage } from '../events/fold-types.js'
import { logger } from '../utils/logger.js'

export interface SequentialFoldOptions {
  client: LLMClientWithModel
  systemPrompt: string
  messages: ContextMessage[]
  contextWindow: number
  signal?: AbortSignal
}

export interface SequentialFoldResult {
  summary: string | undefined
  promptTokens?: number
  completionTokens?: number
}

const MAX_FOLD_DEPTH = 8

/**
 * Sequential fold compaction for conversations that no longer fit a single
 * summary call (input + summary budget > window). The conversation is split
 * in half; the first half is summarized (recursively, the same way) and the
 * result is folded into the second half as a user message. Recursion stops
 * when a candidate fits the budget, and the final call summarizes the folded
 * candidate — so every call sees at most one window of input. Only a single
 * message larger than the whole budget is ever truncated (proportionally).
 *
 * The trailing COMPACTION_PROMPT (already present in rebuilt conversation
 * messages) is stripped up front; each summary call appends it itself.
 *
 * Any failure (truncated summary, too-short summary, LLM error) returns
 * `{ summary: undefined }` so the caller can roll back the compaction prompt
 * and continue with the full context. An aborted signal rethrows 'Aborted'.
 */
export async function runSequentialFold(options: SequentialFoldOptions): Promise<SequentialFoldResult> {
  const { client, systemPrompt, contextWindow, signal } = options
  const last = options.messages[options.messages.length - 1]
  const messages =
    last !== undefined && last.content === COMPACTION_PROMPT ? options.messages.slice(0, -1) : options.messages

  const inputBudgetChars =
    Math.max(0, contextWindow - COMPACTION_SUMMARY_BUDGET_TOKENS - OUTPUT_RESERVE_TOKENS) * DENSE_CHARS_PER_TOKEN
  const usage = { promptTokens: 0, completionTokens: 0 }

  const fits = (candidate: ContextMessage[]): boolean => {
    let chars = systemPrompt.length + COMPACTION_PROMPT.length
    for (const message of candidate) chars += messageWireSize(message)
    return chars <= inputBudgetChars
  }

  const summarize = async (candidate: ContextMessage[]): Promise<string> => {
    const response = await client.complete({
      messages: [...candidate, { role: 'user', content: COMPACTION_PROMPT }],
      maxTokens: COMPACTION_SUMMARY_BUDGET_TOKENS,
      reasoningEffort: 'none',
      ...(signal ? { signal } : {}),
    })
    usage.promptTokens = response.usage.promptTokens
    usage.completionTokens = response.usage.completionTokens
    const summary = response.content || ''
    if (response.finishReason === 'length') throw new Error('Compaction fold summary truncated')
    if (summary.length < MIN_COMPACTION_SUMMARY_LENGTH) throw new Error('Compaction fold summary too short')
    return summary
  }

  const fold = async (candidate: ContextMessage[], depth: number): Promise<string> => {
    if (fits(candidate)) return summarize(candidate)
    if (depth >= MAX_FOLD_DEPTH) return summarize(truncateToBudget(candidate, systemPrompt, inputBudgetChars))
    const parts = splitInHalf(candidate)
    if (parts === null) return summarize(truncateToBudget(candidate, systemPrompt, inputBudgetChars))
    const [first, second] = parts
    const firstSummary = await fold(first, depth + 1)
    return fold([{ role: 'user', content: firstSummary }, ...second], depth + 1)
  }

  try {
    const summary = await fold(messages, 0)
    return { summary, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }
  } catch (error) {
    if (signal?.aborted) throw new Error('Aborted')
    logger.warn('Sequential fold compaction failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { summary: undefined }
  }
}

/**
 * Split at a block boundary (~half of the total wire size). A block is a
 * non-tool message plus the tool results that follow it, so a half never
 * starts with an orphaned tool result (backends reject tool messages that do
 * not answer a preceding assistant tool call). Returns null when the
 * candidate is a single inseparable block.
 */
function splitInHalf(messages: ContextMessage[]): [ContextMessage[], ContextMessage[]] | null {
  const blocks: ContextMessage[][] = []
  for (const message of messages) {
    const last = blocks[blocks.length - 1]
    if (message.role === 'tool' && last !== undefined) last.push(message)
    else blocks.push([message])
  }
  if (blocks.length < 2) return null

  const blockSize = (block: ContextMessage[]): number => block.reduce((sum, m) => sum + messageWireSize(m), 0)
  const total = blocks.reduce((sum, block) => sum + blockSize(block), 0)
  let cut = 1
  let accumulated = 0
  for (let i = 0; i < blocks.length - 1; i++) {
    accumulated += blockSize(blocks[i]!)
    cut = i + 1
    if (accumulated >= total / 2) break
  }

  const first: ContextMessage[] = []
  const second: ContextMessage[] = []
  for (let i = 0; i < blocks.length; i++) {
    for (const message of blocks[i]!) (i < cut ? first : second).push(message)
  }
  return [first, second]
}

/**
 * Last resort (single oversized message, or fold depth exhausted): truncate
 * every message's content and thinking proportionally so the candidate fits
 * the budget. The only lossy step in the fold.
 */
function truncateToBudget(
  messages: ContextMessage[],
  systemPrompt: string,
  inputBudgetChars: number,
): ContextMessage[] {
  const messageChars = messages.reduce((sum, m) => sum + messageWireSize(m), 0)
  const budget = Math.max(0, inputBudgetChars - systemPrompt.length - COMPACTION_PROMPT.length)
  if (messageChars <= 0 || budget >= messageChars) return messages
  const keep = budget / messageChars
  return messages.map((message) => ({
    ...message,
    content: message.content.slice(0, Math.floor(message.content.length * keep)),
    ...(message.thinkingContent
      ? { thinkingContent: message.thinkingContent.slice(0, Math.floor(message.thinkingContent.length * keep)) }
      : {}),
  }))
}
