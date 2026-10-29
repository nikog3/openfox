import { describe, expect, it } from 'vitest'
import { runSequentialFold } from './fold-compactor.js'
import { COMPACTION_PROMPT } from '../chat/prompts.js'
import { COMPACTION_SUMMARY_BUDGET_TOKENS } from './compactor.js'
import type { LLMClientWithModel } from '../llm/client.js'
import type { LLMCompletionRequest, LLMCompletionResponse } from '../llm/types.js'
import type { ContextMessage } from '../events/fold-types.js'

const SUMMARY_1 = 'First-half summary. '.repeat(5)
const SUMMARY_2 = 'Final folded summary. '.repeat(5)

interface CallSpec {
  content: string
  finishReason?: LLMCompletionResponse['finishReason']
  usage?: LLMCompletionResponse['usage']
}

function makeClient(specs: CallSpec[]) {
  const calls: LLMCompletionRequest[] = []
  let next = 0
  const client = {
    complete: async (request: LLMCompletionRequest) => {
      calls.push(request)
      const spec = specs[Math.min(next, specs.length - 1)]!
      next += 1
      return {
        id: `resp-${next}`,
        content: spec.content,
        finishReason: spec.finishReason ?? 'stop',
        usage: spec.usage ?? { promptTokens: 1_000 + next, completionTokens: 100 + next, totalTokens: 1_100 + next },
      }
    },
    stream: async function* () {},
    getModel: () => 'test-model',
  } as unknown as LLMClientWithModel
  return { client, calls }
}

const msg = (role: ContextMessage['role'], chars: number, extra?: Partial<ContextMessage>): ContextMessage => ({
  role,
  content: 'x'.repeat(chars),
  ...extra,
})

const wireSize = (request: LLMCompletionRequest): number =>
  request.messages.reduce((sum, m) => sum + m.content.length + (m.thinkingContent?.length ?? 0), 0)

describe('runSequentialFold', () => {
  it('makes a single summary call when the conversation fits the budget', async () => {
    const { client, calls } = makeClient([{ content: SUMMARY_1 }])
    const messages = [msg('user', 1_000), msg('assistant', 1_000)]

    const result = await runSequentialFold({
      client,
      systemPrompt: 'sys',
      messages,
      contextWindow: 200_000,
    })

    expect(calls).toHaveLength(1)
    expect(result.summary).toBe(SUMMARY_1)
    expect(result.promptTokens).toBe(1_001)
    expect(result.completionTokens).toBe(101)
    const last = calls[0]!.messages[calls[0]!.messages.length - 1]
    expect(last?.content).toBe(COMPACTION_PROMPT)
  })

  it('strips a trailing compaction prompt and appends exactly one', async () => {
    const { client, calls } = makeClient([{ content: SUMMARY_1 }])
    const messages: ContextMessage[] = [msg('user', 1_000), { role: 'user', content: COMPACTION_PROMPT }]

    await runSequentialFold({ client, systemPrompt: 'sys', messages, contextWindow: 200_000 })

    const promptCount = calls[0]!.messages.filter((m) => m.content === COMPACTION_PROMPT).length
    expect(promptCount).toBe(1)
    expect(calls[0]!.messages[calls[0]!.messages.length - 1]?.content).toBe(COMPACTION_PROMPT)
  })

  it('uses the summary budget and disables reasoning on every call', async () => {
    const { client, calls } = makeClient([{ content: SUMMARY_1 }])
    await runSequentialFold({
      client,
      systemPrompt: 'sys',
      messages: [msg('user', 1_000)],
      contextWindow: 200_000,
    })
    expect(calls[0]!.maxTokens).toBe(COMPACTION_SUMMARY_BUDGET_TOKENS)
    expect(calls[0]!.reasoningEffort).toBe('none')
  })

  it('folds recursively when the conversation exceeds one window', async () => {
    const { client, calls } = makeClient([
      { content: SUMMARY_1, usage: { promptTokens: 5_000, completionTokens: 200, totalTokens: 5_200 } },
      { content: SUMMARY_2, usage: { promptTokens: 6_000, completionTokens: 300, totalTokens: 6_300 } },
    ])
    const m1 = msg('user', 20_000)
    const m2 = msg('assistant', 20_000)
    // 20k window → budget ≈ 33.2k chars; the 40k conversation must be folded.
    const result = await runSequentialFold({
      client,
      systemPrompt: 'sys',
      messages: [m1, m2],
      contextWindow: 20_000,
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]!.messages[0]).toEqual(m1)
    expect(calls[1]!.messages[0]?.content).toBe(SUMMARY_1)
    expect(calls[1]!.messages[1]).toEqual(m2)
    expect(calls[1]!.messages[calls[1]!.messages.length - 1]?.content).toBe(COMPACTION_PROMPT)
    expect(result.summary).toBe(SUMMARY_2)
    expect(result.promptTokens).toBe(6_000)
    expect(result.completionTokens).toBe(300)
  })

  it('never starts a summary call with an orphaned tool message', async () => {
    const { client, calls } = makeClient([
      { content: SUMMARY_1 },
      { content: SUMMARY_2 },
      { content: SUMMARY_1 },
      { content: SUMMARY_2 },
    ])
    const toolCall = { id: 'tc-1', name: 'run_command', arguments: {} }
    const messages: ContextMessage[] = [
      msg('assistant', 10_000, { toolCalls: [toolCall] }),
      msg('tool', 2_000, { toolCallId: 'tc-1' }),
      msg('tool', 2_000, { toolCallId: 'tc-1' }),
      msg('assistant', 8_000, { toolCalls: [toolCall] }),
      msg('tool', 2_000, { toolCallId: 'tc-1' }),
      msg('tool', 2_000, { toolCallId: 'tc-1' }),
    ]
    // 16k window → budget ≈ 23.6k chars; the 26k conversation must be folded.
    const result = await runSequentialFold({
      client,
      systemPrompt: 'sys',
      messages,
      contextWindow: 16_000,
    })

    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const call of calls) {
      expect(call.messages[0]?.role).not.toBe('tool')
    }
    expect(calls[0]!.messages.some((m) => m.role === 'tool')).toBe(true)
    expect(result.summary).toBe(SUMMARY_2)
  })

  it('truncates a single oversized block proportionally as a last resort', async () => {
    const { client, calls } = makeClient([{ content: SUMMARY_1 }])
    const messages = [
      msg('assistant', 10_000, { toolCalls: [{ id: 'tc-1', name: 'run_command', arguments: {} }] }),
      msg('tool', 10_000, { toolCallId: 'tc-1' }),
    ]
    // 8k window → budget ≈ 4.4k chars for a 20k-char single block.
    const result = await runSequentialFold({
      client,
      systemPrompt: 'sys',
      messages,
      contextWindow: 8_000,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.messages[0]?.content.length).toBeLessThan(10_000)
    expect(calls[0]!.messages[1]?.content.length).toBeLessThan(10_000)
    expect(wireSize(calls[0]!)).toBeLessThanOrEqual((8_000 - COMPACTION_SUMMARY_BUDGET_TOKENS - 2_048) * 2.4)
    expect(result.summary).toBe(SUMMARY_1)
  })

  it('returns no summary when the summary call is truncated', async () => {
    const { client } = makeClient([{ content: SUMMARY_1, finishReason: 'length' }])
    const result = await runSequentialFold({
      client,
      systemPrompt: 'sys',
      messages: [msg('user', 1_000)],
      contextWindow: 200_000,
    })
    expect(result.summary).toBeUndefined()
  })

  it('returns no summary when the summary is too short', async () => {
    const { client } = makeClient([{ content: 'ok' }])
    const result = await runSequentialFold({
      client,
      systemPrompt: 'sys',
      messages: [msg('user', 1_000)],
      contextWindow: 200_000,
    })
    expect(result.summary).toBeUndefined()
  })

  it('returns no summary when the LLM call fails', async () => {
    const client = {
      complete: async () => {
        throw new Error('backend down')
      },
      stream: async function* () {},
      getModel: () => 'test-model',
    } as unknown as LLMClientWithModel
    const result = await runSequentialFold({
      client,
      systemPrompt: 'sys',
      messages: [msg('user', 1_000)],
      contextWindow: 200_000,
    })
    expect(result.summary).toBeUndefined()
  })

  it('rethrows Aborted when the signal is aborted', async () => {
    const client = {
      complete: async () => {
        throw new Error('aborted')
      },
      stream: async function* () {},
      getModel: () => 'test-model',
    } as unknown as LLMClientWithModel
    const controller = new AbortController()
    controller.abort()
    await expect(
      runSequentialFold({
        client,
        systemPrompt: 'sys',
        messages: [msg('user', 1_000)],
        contextWindow: 200_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow('Aborted')
  })
})
