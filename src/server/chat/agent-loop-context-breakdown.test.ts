import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TurnMetrics } from './stream-pure.js'
import type { TopLevelLoopConfig } from './agent-loop.js'

vi.mock('../events/store.js', () => ({
  getEventStore: vi.fn(),
}))

vi.mock('../events/index.js', () => ({
  getCurrentContextWindowId: vi.fn(() => undefined),
  getCurrentWindowMessageOptions: vi.fn(() => undefined),
}))

vi.mock('../context/instructions.js', () => ({
  getAllInstructions: vi.fn(),
}))

vi.mock('../skills/registry.js', () => ({
  getEnabledSkillMetadata: vi.fn(),
}))

vi.mock('../runtime-config.js', () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({
    mode: 'test',
    workdir: '/test',
    context: { compactionThreshold: 800000 },
    llm: {
      baseUrl: 'http://localhost:11434',
      model: 'test-model',
      timeout: 30000,
      idleTimeout: 30000,
      backend: 'ollama',
    },
    agent: { toolTimeout: 30000 },
  }),
}))

vi.mock('../../cli/paths.js', () => ({
  getGlobalConfigDir: vi.fn().mockReturnValue('/test/config'),
}))

vi.mock('./conversation-history.js', () => ({
  getConversationMessages: vi.fn().mockReturnValue([]),
}))

vi.mock('../context/compactor.js', () => ({
  shouldCompact: vi.fn(() => false),
  appendCompactionPrompt: vi.fn(),
}))

vi.mock('../agents/registry.js', () => ({
  loadAllAgentsDefault: vi.fn(async () => []),
  getSubAgents: vi.fn(() => []),
}))

vi.mock('../drain-queue.js', () => ({
  drainQueue: vi.fn(),
}))

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('./stream-pure.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stream-pure.js')>()
  return {
    ...actual,
    streamLLMPure: vi.fn(),
    consumeStreamGenerator: vi.fn(),
  }
})

vi.mock('./execute-tools.js', () => ({
  executeTools: vi.fn(),
}))

import { runTopLevelAgentLoop } from './agent-loop.js'
import { consumeStreamGenerator } from './stream-pure.js'
import { executeTools } from './execute-tools.js'
import { logger } from '../utils/logger.js'

const FAST_POLICY = { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 40 }

describe('agent loop context breakdown logging', () => {
  let mockSessionManager: any
  let mockLLMClient: any
  let mockTurnMetrics: TurnMetrics

  beforeEach(async () => {
    vi.clearAllMocks()

    mockSessionManager = {
      enterPauseGate: vi.fn().mockResolvedValue('released'),
      requireSession: vi.fn().mockReturnValue({
        workdir: '/test',
        projectId: 'test-project',
        executionState: null,
        criteria: [],
        isRunning: false,
      }),
      getEffectiveWorkdir: vi.fn().mockReturnValue('/test'),
      getProjectWorkdir: vi.fn().mockReturnValue('/test'),
      getContextState: vi.fn().mockReturnValue({
        currentTokens: 0,
        maxTokens: 128000,
        compactionCount: 0,
        dangerZone: false,
        canCompact: false,
        dynamicContextChanged: false,
      }),
      getCurrentModelContext: vi.fn().mockReturnValue(128000),
      getCurrentModelSettings: vi.fn().mockReturnValue({ maxTokens: 4096 }),
      getModelCompactionThreshold: vi.fn().mockReturnValue(800000),
      setCurrentContextSize: vi.fn(),
      getCachedPrompt: vi.fn().mockReturnValue(undefined),
      setCachedPrompt: vi.fn(),
      drainAsapMessages: vi.fn().mockReturnValue([]),
    }

    mockLLMClient = { getModel: vi.fn().mockReturnValue('test-model') }
    mockTurnMetrics = {
      addToolTime: vi.fn(),
      addLLMCall: vi.fn(),
      buildStats: vi.fn().mockReturnValue({ durationMs: 0 }),
    } as unknown as TurnMetrics

    const { getAllInstructions } = await import('../context/instructions.js')
    const { getEnabledSkillMetadata } = await import('../skills/registry.js')
    ;(getAllInstructions as any).mockResolvedValue({ content: 'test instructions', files: [] })
    ;(getEnabledSkillMetadata as any).mockResolvedValue([])
  })

  function makeConfig(overrides?: Partial<TopLevelLoopConfig>): TopLevelLoopConfig {
    return {
      mode: 'planner',
      append: vi.fn(),
      sessionManager: mockSessionManager,
      sessionId: 'test-session',
      llmClient: mockLLMClient,
      statsIdentity: { providerId: 'test', providerName: 'Test', backend: 'unknown' as const, model: 'test-model' },
      assembleRequest: vi.fn().mockResolvedValue({ systemPrompt: 'sys', messages: [] }),
      getToolRegistry: () => ({ tools: [], definitions: [], execute: vi.fn() }) as any,
      getConversationMessages: vi.fn().mockResolvedValue([]),
      ...overrides,
    }
  }

  function erroredResult(error: string) {
    return {
      content: '',
      toolCalls: [],
      segments: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      timing: { ttft: 0, completionTime: 0, tps: 0, prefillTps: 0 },
      aborted: false,
      modelParams: { temperature: 0, topP: 1, topK: 1, maxTokens: 4096 },
      finishReason: 'stop',
      error,
    }
  }

  function successResultWithToolCalls(content: string, toolCalls: any[]) {
    return {
      content,
      toolCalls,
      segments: [{ type: 'text' as const, content }],
      usage: { promptTokens: 1000, completionTokens: 200 },
      timing: { ttft: 1, completionTime: 1, tps: 1, prefillTps: 1 },
      aborted: false,
      modelParams: { temperature: 0, topP: 1, topK: 1, maxTokens: 4096 },
      finishReason: 'stop',
    }
  }

  it('logs context breakdown on overflow (context length error)', async () => {
    ;(consumeStreamGenerator as any)
      .mockImplementationOnce(async () =>
        erroredResult(
          'context length exceeded: request (154020 tokens) exceeds the available context size (150016 tokens)',
        ),
      )
      .mockImplementationOnce(async () => ({
        content: 'ok',
        toolCalls: [],
        segments: [{ type: 'text' as const, content: 'ok' }],
        usage: { promptTokens: 10, completionTokens: 5 },
        timing: { ttft: 1, completionTime: 1, tps: 1, prefillTps: 1 },
        aborted: false,
        modelParams: { temperature: 0, topP: 1, topK: 1, maxTokens: 4096 },
        finishReason: 'stop',
      }))

    const append = vi.fn()
    const result = await runTopLevelAgentLoop(makeConfig({ append, llmRetryPolicy: FAST_POLICY }), mockTurnMetrics)

    expect(result.failed).toBeUndefined()
    const warnCalls = (logger.warn as any).mock.calls
    const overflowLog = warnCalls.find((c: any[]) => c[0] === 'Context length error: retrying with reduced maxTokens')
    expect(overflowLog).toBeDefined()
    const ctx = overflowLog[1]
    expect(ctx.ctxWindow).toBe(128000)
    expect(ctx.currentTokens).toBe(0)
    expect(ctx.estimatedResultTokens).toBe(0)
    expect(ctx.reserveTokens).toBe(2048)
    expect(ctx.availableTokens).toBe(125952)
    expect(ctx.estimatedRequestTokens).toBe(0)
    expect(ctx.actualTokens).toBe(154020)
    expect(ctx.serverLimit).toBe(150016)
    expect(ctx.gapTokens).toBe(154020)
    expect(ctx.attempt).toBe(1)
  })

  it('logs context breakdown on tool result truncation', async () => {
    const largeContent = 'x'.repeat(600_000)
    const toolCall = { id: 'call-1', name: 'read_file', arguments: { path: '/test' } }

    ;(consumeStreamGenerator as any)
      .mockImplementationOnce(async () => successResultWithToolCalls('Let me read the file', [toolCall]))
      .mockImplementationOnce(async () => ({
        content: 'done',
        toolCalls: [],
        segments: [{ type: 'text' as const, content: 'done' }],
        usage: { promptTokens: 10, completionTokens: 5 },
        timing: { ttft: 1, completionTime: 1, tps: 1, prefillTps: 1 },
        aborted: false,
        modelParams: { temperature: 0, topP: 1, topK: 1, maxTokens: 4096 },
        finishReason: 'stop',
      }))

    ;(executeTools as any).mockResolvedValue({
      toolMessages: [{ role: 'tool', content: largeContent, source: 'history', toolCallId: 'call-1' }],
      executedResults: [
        {
          toolCall,
          toolResult: { success: true, output: largeContent, durationMs: 10, truncated: false },
          content: largeContent,
          index: 0,
        },
      ],
      criteriaChanged: false,
    })

    const append = vi.fn()
    await runTopLevelAgentLoop(makeConfig({ append, llmRetryPolicy: FAST_POLICY }), mockTurnMetrics)

    const warnCalls = (logger.warn as any).mock.calls
    const truncationLog = warnCalls.find((c: any[]) => c[0] === 'Tool result truncated to fit context window')
    expect(truncationLog).toBeDefined()
    const ctx = truncationLog[1]
    expect(ctx.sessionId).toBe('test-session')
    expect(ctx.ctxWindow).toBe(128000)
    expect(ctx.currentTokens).toBe(1200)
    expect(ctx.estimatedResultTokens).toBeGreaterThan(0)
    expect(ctx.reserveTokens).toBe(2048)
    expect(ctx.availableTokens).toBeGreaterThan(0)
    expect(ctx.estimatedResultChars).toBe(600_000)
  })

  it('sends context breakdown in chat.llm_retry payload once context retries are exhausted', async () => {
    const ctxError = 'maximum context length is 128000 tokens, you requested 154020 tokens'
    let calls = 0
    ;(consumeStreamGenerator as any).mockImplementation(async () => {
      calls += 1
      if (calls <= 4) return erroredResult(ctxError)
      return {
        content: 'ok',
        toolCalls: [],
        segments: [{ type: 'text' as const, content: 'ok' }],
        usage: { promptTokens: 10, completionTokens: 5 },
        timing: { ttft: 1, completionTime: 1, tps: 1, prefillTps: 1 },
        aborted: false,
        modelParams: { temperature: 0, topP: 1, topK: 1, maxTokens: 4096 },
        finishReason: 'stop',
      }
    })

    const onMessage = vi.fn()
    await runTopLevelAgentLoop(makeConfig({ onMessage, llmRetryPolicy: FAST_POLICY }), mockTurnMetrics)

    const retryMsgs = onMessage.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.type === 'chat.llm_retry')
    expect(retryMsgs).toHaveLength(1)
    const retryMsg = retryMsgs[0]
    expect(retryMsg.payload.actualTokens).toBe(154020)
    expect(retryMsg.payload.serverLimit).toBe(128000)
    expect(retryMsg.payload.ctxWindow).toBe(128000)
    expect(retryMsg.payload.reserveTokens).toBe(2048)
  })
})
