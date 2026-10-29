/**
 * Context compaction utilities.
 *
 * Compaction runs inside the agent loop for both auto and manual compaction.
 * Manual compaction appends the compaction prompt and starts the agent loop
 * with initialCompacting=true. Both paths use the COMPACTION_PROMPT from chat/prompts.ts.
 * This module provides helper functions for deciding when to compact.
 */

import { COMPACTION_PROMPT } from '../chat/prompts.js'
import { createMessageStartEvent } from '../chat/stream-pure.js'
import { getCurrentWindowMessageOptions } from '../events/index.js'
import { OUTPUT_RESERVE_TOKENS } from '../chat/measured-backstop.js'
import { DENSE_CHARS_PER_TOKEN } from '../tools/output-cap.js'
import type { ContextMessage } from '../events/fold-types.js'

/**
 * Append the compaction prompt to the event store.
 * Used by both auto-compaction (threshold-gated, in agent-loop.ts) and
 * manual compaction (always appended, in ws/server.ts).
 * When a sub-agent compacts, the prompt is tagged with its metadata so it
 * stays scoped to the sub-agent's context and chatfeed window.
 * Returns the prompt's message id so a failed attempt can roll the pair back.
 */
export function appendCompactionPrompt(
  sessionId: string,
  append: (event: import('../events/types.js').TurnEvent) => void,
  subAgent?: { subAgentId: string; subAgentType: string },
): string {
  const compactPromptMsgId = crypto.randomUUID()
  append(
    createMessageStartEvent(compactPromptMsgId, 'user', COMPACTION_PROMPT, {
      ...(getCurrentWindowMessageOptions(sessionId) ?? {}),
      isSystemGenerated: true,
      messageKind: 'auto-prompt',
      metadata: { type: 'compaction', name: 'Compaction', color: '#64748b' },
      ...(subAgent ? { subAgentId: subAgent.subAgentId, subAgentType: subAgent.subAgentType } : {}),
    }),
  )
  append({ type: 'message.done', data: { messageId: compactPromptMsgId } })
  return compactPromptMsgId
}

/**
 * Fixed headroom: compaction always fires when fewer than 5K tokens remain,
 * regardless of the configured threshold. This is the safety trigger — it is
 * window-relative (never percentage-based) so a 25k window is protected exactly
 * like a 200k one.
 */
export const COMPACTION_HEADROOM_TOKENS = 5_000

/**
 * Output budget for the compaction summary call. Measured on a real model the
 * summary is stable at 600-850 tokens for ~15k-token conversations, but a
 * large (50k+) context can need more, so the budget is 4096 to give the
 * summary room to finish (a truncated summary aborts compaction and leaves the
 * context over-full). It is ALWAYS granted in full — the input side is fitted
 * to the window instead (see fitSummaryInput), so the call can never overflow
 * (no 400s) even when the context is already over-full.
 */
export const COMPACTION_SUMMARY_BUDGET_TOKENS = 4_096

/**
 * Max summary LLM calls per compaction trigger. A failed attempt (empty or
 * truncated summary) must not re-trigger compaction endlessly: each failure
 * used to append its prompt+summary pair to the context, making the next
 * attempt start fuller than the last (observed: 7 attempts in 60s, context
 * growing +418 tokens per attempt past the window).
 */
export const MAX_COMPACTION_ATTEMPTS = 2

/**
 * Max tool-call rejections per compaction trigger. A model that keeps
 * emitting tool calls during compaction (e.g. a habit step_done after the
 * summary) must not loop the summary call forever: after this many
 * rejections, compaction is aborted and the turn continues with the full
 * context (mirroring the empty-summary path).
 */
export const MAX_COMPACTION_TOOLCALL_REJECTIONS = 3

/**
 * Minimum length for a summary to be allowed to replace the whole
 * conversation context. A one-line non-summary ("OK") must never wipe a
 * 130k-token context — below this floor the summary is treated as empty
 * and the full context is kept.
 */
export const MIN_COMPACTION_SUMMARY_LENGTH = 50

/**
 * Wire size of a message: content + thinking. convertMessages re-echoes prior
 * thinkingContent into the request (gated by sendReasoningInMessages, NOT by
 * the summary call's reasoningEffort:'none), so the fitted input must count
 * both — counting only content underestimates the real prompt and lets the
 * summary call overflow the window.
 */
export function messageWireSize(message: ContextMessage): number {
  return message.content.length + (message.thinkingContent?.length ?? 0)
}

/**
 * Trim the summarization input so the call can never overflow the window.
 *
 * The summary always gets COMPACTION_SUMMARY_BUDGET_TOKENS (decoupled from
 * `availableForOutput`, which floors at 256 exactly when the context is
 * over-full — the state where compaction is needed). To keep
 * `input + budget + reserve ≤ window`, the conversation is trimmed from the
 * FRONT (oldest first): the oldest content is the least relevant, and the
 * window already starts with the previous summary, so nothing essential is
 * lost. The last message (the compaction prompt itself) is never dropped,
 * and a dropped assistant message never leaves its tool results orphaned.
 */
export function fitSummaryInput(
  messages: ContextMessage[],
  systemPrompt: string,
  contextWindow: number,
): ContextMessage[] {
  if (contextWindow <= 0 || messages.length === 0) return messages

  const allowedChars =
    Math.max(0, contextWindow - COMPACTION_SUMMARY_BUDGET_TOKENS - OUTPUT_RESERVE_TOKENS) * DENSE_CHARS_PER_TOKEN

  let total = systemPrompt.length
  for (const message of messages) total += messageWireSize(message)
  // Already fits — nothing to trim.
  if (total <= allowedChars) return messages

  // Drop messages from the FRONT (oldest first) until the remainder — which
  // always includes the last message, the compaction prompt — fits the budget.
  let start = 0
  while (start < messages.length - 1 && total > allowedChars) {
    total -= messageWireSize(messages[start]!)
    start++
  }
  // A dropped assistant message must not leave its tool results behind: skip
  // leading tool messages whose parent was dropped.
  while (start < messages.length - 1 && messages[start]!.role === 'tool') {
    total -= messageWireSize(messages[start]!)
    start++
  }
  return messages.slice(start)
}

/**
 * Check if automatic compaction should be triggered.
 *
 * Two independent triggers:
 * 1. Safety (fixed): fewer than COMPACTION_HEADROOM_TOKENS of headroom remain.
 *    Always active — the threshold cannot disable it.
 * 2. Quality (optional): the configured percentage threshold, honored as-is.
 */
export function shouldCompact(currentTokens: number, maxTokens: number, threshold: number): boolean {
  if (maxTokens <= 0) return false
  if (maxTokens - currentTokens < COMPACTION_HEADROOM_TOKENS) return true
  if (threshold > 0 && currentTokens > maxTokens * threshold) return true
  return false
}
