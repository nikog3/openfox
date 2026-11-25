import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WorkflowDefinition } from './types.js'
import type { OrchestratorOptions } from '../runner/types.js'

const { mockAppend } = vi.hoisted(() => ({ mockAppend: vi.fn() }))
const { mockRunAgentTurn } = vi.hoisted(() => ({ mockRunAgentTurn: vi.fn() }))

vi.mock('../events/index.js', () => ({
  getEventStore: () => ({
    append: mockAppend,
    getLatestSeq: vi.fn(() => 0),
    getLatestSnapshotSeq: vi.fn(() => 0),
    getEventsSinceSnapshot: vi.fn(() => ({ snapshot: undefined, events: [] })),
    getEventLogTail: vi.fn(() => ({ events: 0, bytes: 0 })),
  }),
  combineEventsWithSnapshot: (_sessionId: string, _snapshot: unknown, events: unknown[]) => events,
  getCurrentContextWindowId: vi.fn(() => undefined),
}))

vi.mock('../chat/orchestrator.js', () => ({
  runAgentTurn: mockRunAgentTurn,
  createMessageStartEvent: vi.fn(
    (messageId: string, role: string, content: string | undefined, options?: Record<string, unknown>) => ({
      type: 'message.start',
      data: { messageId, role, content, ...options },
    }),
  ),
  TurnMetrics: class TurnMetrics {
    start = vi.fn()
    end = vi.fn()
    addLLMCall = vi.fn()
    addToolTime = vi.fn()
    buildStats = vi.fn(() => ({ durationMs: 0, tokenCount: 0, generationTokens: 0, completionTokens: 0 }))
  },
}))

vi.mock('../sub-agents/manager.js', () => ({
  executeSubAgent: vi.fn(async () => ({ content: '', result: 'success' })),
}))

vi.mock('../agents/registry.js', () => ({
  loadAllAgentsDefault: vi.fn(async () => []),
  findAgentById: vi.fn(() => undefined),
  resolveDefaultAgentId: vi.fn(() => 'planner'),
}))

vi.mock('../tools/index.js', () => ({
  getToolRegistryForAgent: vi.fn(() => ({ tools: [], definitions: [], execute: vi.fn() })),
}))

vi.mock('./shell.js', () => ({
  executeShellCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
}))

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../shared/stats.js', () => ({
  computeSessionStats: vi.fn(() => ({ generationTokens: 0, avgGenerationSpeed: 0, responseCount: 0, llmCallCount: 0 })),
}))

vi.mock('../git/diff.js', () => ({
  formatGitDiffFiles: vi.fn(async () => '(none)'),
}))

import { executeWorkflow } from './executor.js'

function wireStepDone(call: { onToolExecuted?: (tc: any, tr: any) => void } | undefined): void {
  call?.onToolExecuted?.({ name: 'step_done', arguments: {} }, { success: true, output: '' })
}

function createWorkflow(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return {
    metadata: { id: 'test', name: 'Test', description: '', version: '1' },
    entryStep: steps[0]?.id ?? 'build',
    settings: { maxIterations: 10 },
    steps,
  }
}

function createMockOptions(extra?: Partial<OrchestratorOptions>): OrchestratorOptions {
  return {
    scope: 'auto',
    sessionManager: {
      requireSession: vi.fn(() => ({
        workdir: '/tmp/test',
        messages: [],
        metadataEntries: {},
      })),
      setMode: vi.fn(),
      setPhase: vi.fn(),
      getEffectiveWorkdir: vi.fn().mockReturnValue('/tmp/test'),
      getProjectWorkdir: vi.fn().mockReturnValue('/tmp/test'),
      addMessage: vi.fn(),
      startWorkflow: vi.fn(),
      updateWorkflowStep: vi.fn(),
      completeWorkflow: vi.fn(),
      blockWorkflow: vi.fn(),
      waitAtStep: vi.fn(),
      resumeWorkflow: vi.fn(),
      getActiveWorkflowExecution: vi.fn(() => null),
      cancelWorkflow: vi.fn(),
    } as any,
    sessionId: 'test-session',
    llmClient: { getModel: () => 'test-model' } as any,
    llmRetryPolicy: { backoffMs: [0, 0, 0, 0], minIntervalMs: 0, maxDurationMs: 60_000, maxAttempts: 40 },
    ...extra,
  }
}

describe('workflow summarize step (kind: summarize)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tags the assistant message with session-summary metadata at message.start', async () => {
    mockRunAgentTurn.mockImplementation(
      async (_opts: any, _metrics: any, _agentId: string, _append: any, extra: any) => {
        wireStepDone(extra)
        return { returnValueResult: 'completed' }
      },
    )

    const workflow = createWorkflow([
      {
        id: 'summarize',
        name: 'Summarize',
        type: 'agent',
        phase: 'verification',
        agentId: 'builder',
        kind: 'summarize',
        prompt: 'Produce a summary.',
        transitions: [{ when: { type: 'always' }, goto: '$done' }],
      },
    ])

    const result = await executeWorkflow(workflow, createMockOptions())

    expect(result.finalAction.type).toBe('DONE')
    const turnCalls = mockRunAgentTurn.mock.calls
    expect(turnCalls).toHaveLength(1)
    const turnOptions = turnCalls[0]?.[0] as {
      assistantMessageMetadata?: { type: string; name: string; color: string }
    }
    expect(turnOptions.assistantMessageMetadata).toEqual({
      type: 'session-summary',
      name: 'Summary',
      color: '#8b5cf6',
    })
  })

  it('does not tag regular agent steps', async () => {
    mockRunAgentTurn.mockImplementation(
      async (_opts: any, _metrics: any, _agentId: string, _append: any, extra: any) => {
        wireStepDone(extra)
        return { returnValueResult: 'completed' }
      },
    )

    const workflow = createWorkflow([
      {
        id: 'build',
        name: 'Builder',
        type: 'agent',
        phase: 'build',
        agentId: 'builder',
        prompt: 'Implement.',
        transitions: [{ when: { type: 'always' }, goto: '$done' }],
      },
    ])

    await executeWorkflow(workflow, createMockOptions())

    const turnOptions = mockRunAgentTurn.mock.calls[0]?.[0] as { assistantMessageMetadata?: unknown }
    expect(turnOptions.assistantMessageMetadata).toBeUndefined()
  })

  it('fills task.completed summary from the tagged message content', async () => {
    const summaryMessage = {
      id: 'msg-summary',
      role: 'assistant',
      content: '# Session summary\nAll done.',
      timestamp: new Date().toISOString(),
      metadata: { type: 'session-summary', name: 'Summary', color: '#8b5cf6' },
    }
    mockRunAgentTurn.mockImplementation(
      async (_opts: any, _metrics: any, _agentId: string, _append: any, extra: any) => {
        wireStepDone(extra)
        return { returnValueResult: 'completed' }
      },
    )

    const workflow = createWorkflow([
      {
        id: 'summarize',
        name: 'Summarize',
        type: 'agent',
        phase: 'verification',
        agentId: 'builder',
        kind: 'summarize',
        prompt: 'Produce a summary.',
        transitions: [{ when: { type: 'always' }, goto: '$done' }],
      },
    ])

    // The session grows as the turn runs: empty at workflow start (so the
    // pre-run message count is 0), tagged message present at terminal time.
    let requireSessionCalls = 0
    const options = createMockOptions()
    ;(options.sessionManager as any).requireSession = vi.fn(() => {
      requireSessionCalls++
      return {
        workdir: '/tmp/test',
        messages: requireSessionCalls >= 2 ? [summaryMessage] : [],
        metadataEntries: {},
      }
    })

    const result = await executeWorkflow(workflow, options)

    expect(result.finalAction.type).toBe('DONE')
    const taskCompletedEvents = mockAppend.mock.calls
      .map((c: any[]) => c[1])
      .filter((e: any) => e?.type === 'task.completed')
    expect(taskCompletedEvents).toHaveLength(1)
    expect(taskCompletedEvents[0]?.data?.summary).toBe('# Session summary\nAll done.')
  })

  it('keeps task.completed summary null when no tagged message exists', async () => {
    mockRunAgentTurn.mockImplementation(
      async (_opts: any, _metrics: any, _agentId: string, _append: any, extra: any) => {
        wireStepDone(extra)
        return { returnValueResult: 'completed' }
      },
    )

    const workflow = createWorkflow([
      {
        id: 'build',
        name: 'Builder',
        type: 'agent',
        phase: 'build',
        agentId: 'builder',
        prompt: 'Implement.',
        transitions: [{ when: { type: 'always' }, goto: '$done' }],
      },
    ])

    const result = await executeWorkflow(workflow, createMockOptions())

    expect(result.finalAction.type).toBe('DONE')
    const taskCompletedEvents = mockAppend.mock.calls
      .map((c: any[]) => c[1])
      .filter((e: any) => e?.type === 'task.completed')
    expect(taskCompletedEvents).toHaveLength(1)
    expect(taskCompletedEvents[0]?.data?.summary).toBeNull()
  })
})
