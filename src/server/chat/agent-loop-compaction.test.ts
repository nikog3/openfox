import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionManager } from '../session/index.js'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'
import type { ToolCall } from '../../shared/types.js'

vi.mock('./stream-pure.js', () => ({
  streamLLMPure: vi.fn(),
  consumeStreamGenerator: vi.fn(),
  TurnMetrics: vi.fn(),
  createMessageStartEvent: vi.fn((messageId: string, role: string, content?: string, options?: any) => ({
    type: 'message.start',
    data: { messageId, role, content, ...options },
  })),
  createMessageDoneEvent: vi.fn((messageId: string, options?: any) => ({
    type: 'message.done',
    data: { messageId, ...options },
  })),
  createChatDoneEvent: vi.fn((messageId: string, reason: string) => ({
    type: 'chat.done',
    data: { messageId, reason },
  })),
  createToolResultEvent: vi.fn((messageId: string, toolCallId: string, result: any) => ({
    type: 'tool.result',
    data: { messageId, toolCallId, result },
  })),
  evaluateLLMRetry: vi.fn(() => ({ retry: true, delayMs: 0, attempt: 2 })),
  sleepThroughRetryBackoff: vi.fn(async () => 'waited' as const),
  recordLLMFailure: vi.fn(),
  clearLLMFailure: vi.fn(),
}))

vi.mock('./execute-tools.js', () => ({
  executeTools: vi.fn(),
}))

vi.mock('../context/compactor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context/compactor.js')>()
  return {
    ...actual,
    shouldCompact: vi.fn().mockReturnValue(false),
    appendCompactionPrompt: vi.fn((_sessionId: string, append: (event: any) => void) => {
      append({
        type: 'message.start',
        data: {
          messageId: 'compact-prompt',
          role: 'user',
          content: 'You are a helpful AI assistant tasked with summarizing conversations for continuation.',
          isSystemGenerated: true,
          messageKind: 'auto-prompt',
          metadata: { type: 'compaction', name: 'Compaction', color: '#64748b' },
        },
      })
      append({ type: 'message.done', data: { messageId: 'compact-prompt' } })
      return 'compact-prompt'
    }),
  }
})

vi.mock('./conversation-history.js', () => ({
  getConversationMessages: vi.fn().mockReturnValue([]),
}))

vi.mock('../db/settings.js', () => ({
  getSetting: vi.fn(),
  SETTINGS_KEYS: { LLM_DYNAMIC_SYSTEM_PROMPT: 'llm.dynamicSystemPrompt' },
}))

vi.mock('../context/instructions.js', () => ({
  getAllInstructions: vi.fn().mockResolvedValue({ content: '', files: [] }),
}))

vi.mock('../skills/registry.js', () => ({
  getEnabledSkillMetadata: vi.fn().mockResolvedValue([]),
}))

vi.mock('../runtime-config.js', () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({
    mode: 'test',
    workdir: '/test',
    agent: {},
    context: { compactionThreshold: 0.8 },
    llm: {
      baseUrl: 'http://localhost:11434',
      model: 'test-model',
      timeout: 30000,
      idleTimeout: 30000,
      backend: 'ollama',
    },
  }),
}))

vi.mock('../../cli/paths.js', () => ({
  getGlobalConfigDir: vi.fn().mockReturnValue('/test/config'),
}))

vi.mock('../events/index.js', () => {
  const store = {
    append: vi.fn(),
    getEvents: vi.fn(() =>
      (store.append as { mock: { calls: unknown[][] } }).mock.calls.map((args, i) => ({
        seq: i,
        ...((args[0] ?? {}) as object),
      })),
    ),
    tombstoneEvents: vi.fn(),
  }
  return {
    getCurrentContextWindowId: vi.fn().mockReturnValue(undefined),
    getCurrentWindowMessageOptions: vi.fn().mockReturnValue(undefined),
    getEventStore: vi.fn(() => store),
  }
})

import { runTopLevelAgentLoop } from './agent-loop.js'
import { consumeStreamGenerator } from './stream-pure.js'
import { executeTools } from './execute-tools.js'
import { shouldCompact, MAX_COMPACTION_TOOLCALL_REJECTIONS } from '../context/compactor.js'
import { getEventStore } from '../events/index.js'

const tombstonedSeqs = (): number[] =>
  (
    getEventStore() as unknown as { tombstoneEvents: { mock: { calls: unknown[][] } } }
  ).tombstoneEvents.mock.calls.flatMap((call) => call[1] as number[])

function createMockSessionManager(overrides?: Record<string, any>): SessionManager {
  return {
    requireSession: vi.fn().mockReturnValue({
      workdir: '/test',
      projectId: 'test-project',
      executionState: null,
      criteria: [],
      isRunning: false,
    }),
    getContextState: vi.fn().mockReturnValue({
      currentTokens: 0,
      maxTokens: 200000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    }),
    getCurrentModelSettings: vi.fn().mockReturnValue({}),
    getCurrentModelContext: vi.fn().mockReturnValue(200000),
    getModelCompactionThreshold: vi.fn().mockReturnValue(undefined),
    setCurrentContextSize: vi.fn(),
    getDynamicContextChanged: vi.fn().mockReturnValue(false),
    setDynamicContextChanged: vi.fn(),
    getCachedPrompt: vi.fn().mockReturnValue(undefined),
    setCachedPrompt: vi.fn(),
    getLspManager: vi.fn(),
    getEffectiveWorkdir: vi.fn().mockReturnValue('/test'),
    getProjectWorkdir: vi.fn().mockReturnValue('/test'),
    drainAsapMessages: vi.fn().mockReturnValue([]),
    getCurrentWindowMessages: vi.fn().mockReturnValue([]),
    updateMessage: vi.fn(),
    getQueueState: vi.fn().mockReturnValue({ queued: 0, processing: false }),
    enterPauseGate: vi.fn().mockResolvedValue('released'),
    ...overrides,
  } as any
}

function makeConfig(overrides?: Partial<TopLevelLoopConfig>): TopLevelLoopConfig {
  return {
    mode: 'planner',
    append: vi.fn(),
    sessionManager: createMockSessionManager(),
    sessionId: 'test-session',
    llmClient: { getModel: vi.fn().mockReturnValue('test-model') } as any,
    statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'test-model' },
    assembleRequest: vi.fn().mockReturnValue({
      systemPrompt: 'test-prompt',
      messages: [],
    }),
    getToolRegistry: () => ({ definitions: [], execute: vi.fn() }) as any,
    getConversationMessages: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function makeStreamResult(overrides?: Record<string, any>) {
  return {
    content: '',
    thinkingContent: undefined,
    toolCalls: [],
    segments: [],
    usage: { promptTokens: 100, completionTokens: 50 },
    timing: {} as any,
    aborted: false,
    modelParams: {},
    finishReason: 'stop' as const,
    ...overrides,
  }
}

function makeAppend() {
  // Forward to the mock event store so tombstoneMessageEvents can see the
  // appended events (the real loop's append writes through the store).
  const append = vi.fn((event: unknown) => {
    ;(getEventStore() as unknown as { append: (e: unknown) => void }).append(event)
  })
  return append
}

function eventsOf(append: { mock: { calls: unknown[][] } }): any[] {
  return append.mock.calls.map((args: unknown[]) => args[0] as any)
}

describe('agentLoop compaction loop', () => {
  let turnMetrics: TurnMetrics

  beforeEach(() => {
    vi.clearAllMocks()
    turnMetrics = {
      addToolTime: vi.fn(),
      addLLMCall: vi.fn(),
      buildStats: vi.fn().mockReturnValue({}),
    } as any
    ;(consumeStreamGenerator as any).mockResolvedValue(makeStreamResult())
    ;(shouldCompact as any).mockReturnValue(false)
  })

  it('accepts a complete summary even when the model appends a tool call (no rejection loop)', async () => {
    const append = makeAppend()
    const stepDone: ToolCall = { id: 'call-sd', name: 'step_done', arguments: {} }
    const summaryText =
      'The conversation covered the compaction loop fix, its tests and the production database repair.'

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(makeStreamResult({ content: 'Normal response', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: summaryText, finishReason: 'stop', toolCalls: [stepDone] }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Final after compaction', finishReason: 'stop' }))
    ;(shouldCompact as any).mockReturnValueOnce(true)

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // Normal → summary (accepted despite the tool call) → post-compaction turn
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(3)

    // The summary was accepted: context.compacted carries it
    const compacted = eventsOf(append).filter((e) => e.type === 'context.compacted')
    expect(compacted.length).toBe(1)
    expect(compacted[0]!.data.summary).toBe(summaryText)

    // No rejection nudge was emitted
    const rejections = eventsOf(append).filter(
      (e) => e.type === 'message.start' && e.data?.content?.includes('Tool calls are not possible'),
    )
    expect(rejections.length).toBe(0)

    // The tool call attached to the summary was NOT executed
    expect(executeTools).not.toHaveBeenCalled()

    // The summary's assistant message was finalized
    const summaryStart = eventsOf(append).find(
      (e) => e.type === 'message.start' && e.data?.role === 'assistant' && e.data?.content === summaryText,
    )
    expect(summaryStart).toBeDefined()
    const summaryDone = eventsOf(append).find(
      (e) => e.type === 'message.done' && e.data?.messageId === summaryStart.data.messageId,
    )
    expect(summaryDone).toBeDefined()

    const chatDone = eventsOf(append).filter((e) => e.type === 'chat.done')
    expect(chatDone.length).toBeGreaterThanOrEqual(1)
  })

  it('rejects a too-short summary with a tool call (min-length guard)', async () => {
    const append = makeAppend()
    const stepDone: ToolCall = { id: 'call-sd2', name: 'step_done', arguments: {} }

    let call = 0
    ;(consumeStreamGenerator as any).mockImplementation(async () => {
      call++
      if (call === 1) return makeStreamResult({ content: 'Normal response', finishReason: 'stop' })
      // A one-line non-summary must never replace the whole context: it is
      // treated as a tool-call-only rejection, bounded by the same cap.
      if (call <= 1 + MAX_COMPACTION_TOOLCALL_REJECTIONS + 2) {
        return makeStreamResult({ content: 'OK', finishReason: 'tool_calls', toolCalls: [stepDone] })
      }
      return makeStreamResult({ content: 'Done', finishReason: 'stop' })
    })
    ;(shouldCompact as any).mockReturnValueOnce(true)
    ;(executeTools as any).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'output', source: 'history', toolCallId: 'call-sd2' }],
      stepDoneCalled: false,
    })

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // No compaction happened: the short summary was never accepted
    const compacted = eventsOf(append).filter((e) => e.type === 'context.compacted')
    expect(compacted.length).toBe(0)

    // The rejections were bounded and the abort announced as recoverable
    const rejections = eventsOf(append).filter(
      (e) => e.type === 'message.start' && e.data?.content?.includes('Tool calls are not possible'),
    )
    expect(rejections.length).toBe(MAX_COMPACTION_TOOLCALL_REJECTIONS)
    const errors = eventsOf(append).filter((e) => e.type === 'chat.error')
    expect(errors.length).toBe(1)
    expect(errors[0]!.data.recoverable).toBe(true)
  })

  it('aborts compaction after a bounded number of tool-call rejections', async () => {
    const append = makeAppend()
    const toolCall: ToolCall = { id: 'call-1', name: 'run_command', arguments: { command: 'echo x' } }

    let call = 0
    ;(consumeStreamGenerator as any).mockImplementation(async () => {
      call++
      if (call === 1) return makeStreamResult({ content: 'Normal response', finishReason: 'stop' })
      // Calls 2..(2+MAX) return tool calls only: MAX are rejected, the
      // (MAX+1)-th exceeds the cap → compaction aborted, then the next tool
      // call round runs normally and the turn completes.
      if (call <= 1 + MAX_COMPACTION_TOOLCALL_REJECTIONS + 2) {
        return makeStreamResult({ content: '', finishReason: 'tool_calls', toolCalls: [toolCall] })
      }
      return makeStreamResult({ content: 'Done', finishReason: 'stop' })
    })
    ;(shouldCompact as any).mockReturnValueOnce(true)
    ;(executeTools as any).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: 'output', source: 'history', toolCallId: 'call-1' }],
      stepDoneCalled: false,
    })

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    // Exactly MAX_COMPACTION_TOOLCALL_REJECTIONS nudges were emitted
    const rejections = eventsOf(append).filter(
      (e) => e.type === 'message.start' && e.data?.content?.includes('Tool calls are not possible'),
    )
    expect(rejections.length).toBe(MAX_COMPACTION_TOOLCALL_REJECTIONS)

    // The abort is announced as a recoverable error
    const errors = eventsOf(append).filter((e) => e.type === 'chat.error')
    expect(errors.length).toBe(1)
    expect(errors[0]!.data.recoverable).toBe(true)

    // The loop terminated (no unbounded loop): total LLM calls are bounded
    expect(consumeStreamGenerator).toHaveBeenCalledTimes(2 + MAX_COMPACTION_TOOLCALL_REJECTIONS + 2)

    // The pre-compaction assistant message is finalized; the rejected and
    // aborted ones are tombstoned (hidden from the context, so they carry no
    // message.done — mirroring the empty-summary path); the post-abort turns
    // run and finalize normally
    const starts = eventsOf(append).filter((e) => e.type === 'message.start' && e.data?.role === 'assistant')
    const doneIds = new Set(
      eventsOf(append)
        .filter((e) => e.type === 'message.done')
        .map((e) => e.data?.messageId),
    )
    // starts: [0] pre-compaction, [1..MAX] rejected, [1+MAX] aborted, then
    // the post-abort turns
    expect(starts.length).toBe(2 + MAX_COMPACTION_TOOLCALL_REJECTIONS + 2)
    expect(doneIds.has(starts[0]!.data.messageId)).toBe(true)
    for (let i = 1; i <= 1 + MAX_COMPACTION_TOOLCALL_REJECTIONS; i++) {
      const id = starts[i]!.data.messageId
      expect(doneIds.has(id)).toBe(false)
      const startSeq = eventsOf(append).findIndex((e) => e.type === 'message.start' && e.data?.messageId === id)
      expect(tombstonedSeqs()).toContain(startSeq)
    }
    for (let i = 2 + MAX_COMPACTION_TOOLCALL_REJECTIONS; i < starts.length; i++) {
      expect(doneIds.has(starts[i]!.data.messageId)).toBe(true)
    }

    // Compaction was abandoned: no context.compacted
    const compacted = eventsOf(append).filter((e) => e.type === 'context.compacted')
    expect(compacted.length).toBe(0)

    const chatDone = eventsOf(append).filter((e) => e.type === 'chat.done')
    expect(chatDone.length).toBeGreaterThanOrEqual(1)
  })

  it('finalizes the assistant message when compaction triggers right after an LLM success', async () => {
    const append = makeAppend()
    const summaryText =
      'The conversation covered the compaction loop fix, its tests and the production database repair.'

    ;(consumeStreamGenerator as any)
      .mockResolvedValueOnce(makeStreamResult({ content: 'Normal response', finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: summaryText, finishReason: 'stop' }))
      .mockResolvedValueOnce(makeStreamResult({ content: 'Final', finishReason: 'stop' }))
    ;(shouldCompact as any).mockReturnValueOnce(true)

    await runTopLevelAgentLoop(makeConfig({ append }), turnMetrics)

    const events = eventsOf(append)
    // The pre-compaction assistant message is the first assistant start
    const firstAssistantStart = events.find((e) => e.type === 'message.start' && e.data?.role === 'assistant')
    expect(firstAssistantStart).toBeDefined()

    const promptStart = events.find((e) => e.data?.messageId === 'compact-prompt' && e.type === 'message.start')
    expect(promptStart).toBeDefined()

    const firstDoneIdx = events.findIndex(
      (e) => e.type === 'message.done' && e.data?.messageId === firstAssistantStart.data.messageId,
    )
    expect(firstDoneIdx).toBeGreaterThan(-1)
    // message.done for the pre-compaction message comes BEFORE the compaction prompt
    expect(firstDoneIdx).toBeLessThan(events.indexOf(promptStart))
  })
})
