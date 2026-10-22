import { describe, expect, it, vi, beforeEach } from 'vitest'
import { appendCompactionPrompt, shouldCompact, fitSummaryInput } from './compactor.js'
import type { TurnEvent } from '../events/types.js'
import type { ContextMessage } from '../events/fold-types.js'

vi.mock('../events/index.js', () => ({
  getCurrentWindowMessageOptions: vi.fn(() => ({ contextWindowId: 'window-1' })),
}))

describe('appendCompactionPrompt', () => {
  let events: TurnEvent[]

  beforeEach(() => {
    events = []
  })

  it('returns the compaction prompt message id so a failed attempt can roll it back', () => {
    const promptMsgId = appendCompactionPrompt('session-1', (event) => events.push(event))

    expect(typeof promptMsgId).toBe('string')
    expect(promptMsgId.length).toBeGreaterThan(0)
    const start = events[0]
    const data = (start as Extract<TurnEvent, { type: 'message.start' }>).data
    expect(data.messageId).toBe(promptMsgId)
  })

  it('tags the compaction prompt with sub-agent metadata when provided', () => {
    appendCompactionPrompt('session-1', (event) => events.push(event), {
      subAgentId: 'sub-1',
      subAgentType: 'verifier',
    })

    const start = events[0]
    expect(start?.type).toBe('message.start')
    const data = (start as Extract<TurnEvent, { type: 'message.start' }>).data
    expect(data.subAgentId).toBe('sub-1')
    expect(data.subAgentType).toBe('verifier')
    expect(data.messageKind).toBe('auto-prompt')
  })

  it('does not tag the compaction prompt for top-level compaction', () => {
    appendCompactionPrompt('session-1', (event) => events.push(event))

    const start = events[0]
    expect(start?.type).toBe('message.start')
    const data = (start as Extract<TurnEvent, { type: 'message.start' }>).data
    expect(data.subAgentId).toBeUndefined()
    expect(data.subAgentType).toBeUndefined()
  })
})

describe('fitSummaryInput', () => {
  const msg = (role: ContextMessage['role'], chars: number): ContextMessage => ({
    role,
    content: 'x'.repeat(chars),
  })

  it('returns the input unchanged when it already fits', () => {
    const messages = [msg('user', 100), msg('assistant', 100), msg('user', 100)]
    // 200k window → huge allowed budget, nothing to trim.
    const result = fitSummaryInput(messages, 'sys', 200_000)
    expect(result).toBe(messages)
  })

  it('trims from the front (oldest first) until the input fits', () => {
    // 25k window → allowedChars ≈ (25000 - 4096 - 2048) * 2.4 ≈ 45k chars.
    const messages: ContextMessage[] = [
      msg('user', 20_000),
      msg('assistant', 20_000),
      msg('user', 20_000),
      msg('user', 100), // last (compaction prompt)
    ]
    const result = fitSummaryInput(messages, 'sys', 25_000)
    // The two oldest 20k messages are dropped; the 3rd (20k) + prompt (100) fit.
    expect(result[0]?.content).toHaveLength(20_000)
    expect(result[result.length - 1]?.content).toHaveLength(100)
    expect(result.length).toBeLessThan(messages.length)
  })

  it('never drops the last message (the compaction prompt)', () => {
    // Everything overflows — worst case keeps only the prompt.
    const messages: ContextMessage[] = [msg('user', 50_000), msg('assistant', 50_000), msg('user', 100)]
    const result = fitSummaryInput(messages, 'sys', 25_000)
    expect(result.length).toBe(1)
    expect(result[0]?.content).toHaveLength(100)
  })

  it('does not leave orphaned tool results behind a dropped assistant', () => {
    const messages: ContextMessage[] = [
      msg('assistant', 50_000),
      { role: 'tool', content: 'tool result' },
      msg('user', 100), // last
    ]
    const result = fitSummaryInput(messages, 'sys', 25_000)
    // The 50k assistant is dropped; its tool result must be dropped too.
    expect(result.some((m) => m.role === 'tool')).toBe(false)
    expect(result[result.length - 1]?.content).toHaveLength(100)
  })

  it('counts thinkingContent so a thinking-heavy message is trimmed to fit the window', () => {
    // 25k window → allowedChars ≈ (25000 - 4096 - 2048) * 2.4 ≈ 45k chars.
    // The assistant message has a tiny content but a huge thinkingContent
    // (convertMessages re-echoes prior thinking into the wire, gated by
    // sendReasoningInMessages — not by the summary call's reasoningEffort:'none').
    // If thinking were ignored, the input would appear to fit and nothing
    // would be trimmed, letting the real (thinking-laden) prompt overflow.
    const messages: ContextMessage[] = [
      { role: 'assistant', content: 'short', thinkingContent: 't'.repeat(60_000) },
      msg('user', 100), // last (compaction prompt)
    ]
    const result = fitSummaryInput(messages, 'sys', 25_000)
    // The thinking-heavy assistant message must be dropped; only the prompt remains.
    expect(result.length).toBe(1)
    expect(result[0]?.content).toHaveLength(100)
    expect(result[0]?.thinkingContent).toBeUndefined()
  })

  it('is safe on an empty message list', () => {
    expect(fitSummaryInput([], 'sys', 25_000)).toEqual([])
  })

  it('is a no-op when the window is unknown (<= 0)', () => {
    const messages = [msg('user', 100), msg('user', 100)]
    expect(fitSummaryInput(messages, 'sys', 0)).toBe(messages)
  })
})

describe('context compactor helpers', () => {
  it('fires the fixed headroom safety on a 200k window, regardless of threshold', () => {
    // Fewer than 5K tokens of headroom → compact, even with threshold 0
    expect(shouldCompact(200_000, 200_000, 0)).toBe(true)
    expect(shouldCompact(196_000, 200_000, 0)).toBe(true) // 4k headroom
    expect(shouldCompact(195_000, 200_000, 0)).toBe(false) // 5k headroom
  })

  it('fires the fixed headroom safety on a 25k window', () => {
    expect(shouldCompact(21_000, 25_000, 0)).toBe(true) // 4k headroom
    expect(shouldCompact(20_000, 25_000, 0)).toBe(false) // 5k headroom
  })

  it('applies the optional quality threshold when set', () => {
    // 200K window, threshold 0.8: fires above 160K
    expect(shouldCompact(161_000, 200_000, 0.8)).toBe(true)
    expect(shouldCompact(160_000, 200_000, 0.8)).toBe(false)
    expect(shouldCompact(10_000, 200_000, 0.8)).toBe(false)
  })

  it('honors the quality threshold as-is (no 0.95 cap)', () => {
    // 500K window, threshold 0.96: fires above 480K
    expect(shouldCompact(481_000, 500_000, 0.96)).toBe(true)
    expect(shouldCompact(479_000, 500_000, 0.96)).toBe(false)
  })

  it('does nothing when the window is empty and no threshold is set', () => {
    expect(shouldCompact(0, 0, 0)).toBe(false)
  })

  it('does not compact when there is headroom and no threshold', () => {
    expect(shouldCompact(10_000, 200_000, 0)).toBe(false)
  })

  it('lets the fixed headroom override a low quality threshold', () => {
    // 25K window, threshold 0.5 (→12.5K) but only 4k of headroom left → safety fires
    expect(shouldCompact(21_000, 25_000, 0.5)).toBe(true)
  })
})
