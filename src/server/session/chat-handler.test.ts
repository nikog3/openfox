/**
 * Chat Handler Tests
 *
 * TDD: session naming must complete (sequentially) before the chat turn starts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./name-generator.js', () => ({
  generateSessionNameForSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../chat/orchestrator.js', () => ({
  runChatTurn: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../events/index.js', () => ({
  getEventStore: vi.fn().mockReturnValue({
    append: vi.fn(),
    getEventsSinceSnapshot: vi.fn().mockReturnValue({ snapshot: undefined, events: [] }),
  }),
}))

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('startChatSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('awaits session naming before starting the chat turn', async () => {
    const { startChatSession } = await import('./chat-handler.js')
    const { generateSessionNameForSession } = await import('./name-generator.js')
    const { runChatTurn } = await import('../chat/orchestrator.js')

    const order: string[] = []
    ;(generateSessionNameForSession as any).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push('named')
    })
    ;(runChatTurn as any).mockImplementation(async () => {
      order.push('turn')
    })

    const session = {
      id: 'test-session',
      isRunning: false,
      phase: 'build',
      metadata: { title: 'Session 1' },
    }
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(session),
      setRunning: vi.fn(),
      setPhase: vi.fn(),
      addMessage: vi.fn().mockReturnValue({ id: 'm1', role: 'user', content: 'hello' }),
      drainCompletionMessages: vi.fn().mockReturnValue([]),
      clearMessageQueue: vi.fn(),
      getContextState: vi.fn().mockReturnValue(null),
    }

    await startChatSession('test-session', 'hello', {
      sessionManager: sessionManager as any,
      providerManager: {} as any,
      llmClient: {} as any,
      statsIdentity: { providerId: 'p', providerName: 'P', backend: 'b', model: 'm' } as any,
      broadcastForSession: vi.fn(),
    })

    expect(order).toEqual(['named', 'turn'])
    expect(generateSessionNameForSession).toHaveBeenCalledWith(
      'test-session',
      'hello',
      expect.any(Object),
      expect.any(AbortSignal),
    )
  })
})
