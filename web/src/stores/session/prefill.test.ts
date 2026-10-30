// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))

const fetchMock = vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }), status: 200 }),
)
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const { wsSendMock, wsSubscribeMock, wsConnectMock, wsDisconnectMock, wsStatusMock } = vi.hoisted(() => ({
  wsSendMock: vi.fn(() => 'message-id'),
  wsSubscribeMock: vi.fn(() => () => undefined),
  wsConnectMock: vi.fn(async () => undefined),
  wsDisconnectMock: vi.fn(() => undefined),
  wsStatusMock: vi.fn(() => undefined),
}))

vi.mock('../../lib/ws', () => ({
  wsClient: {
    send: wsSendMock,
    subscribe: wsSubscribeMock,
    connect: wsConnectMock,
    disconnect: wsDisconnectMock,
    onStatusChange: wsStatusMock,
  },
}))

vi.mock('../../lib/sound', () => ({
  playNotification: vi.fn(),
  playAchievement: vi.fn(),
  playIntervention: vi.fn(),
  playWaitingForUser: vi.fn(),
  playNewMessage: vi.fn(),
}))

type SessionStoreModule = typeof import('../session')

async function loadSessionStore(): Promise<SessionStoreModule['useSessionStore']> {
  vi.resetModules()
  const module = await import('../session')
  return module.useSessionStore
}

const makeSession = (id: string) => ({
  id,
  projectId: 'project-1',
  workdir: `/tmp/${id}`,
  mode: 'builder',
  phase: 'plan',
  isRunning: true,
  criteria: [],
  summary: null,
})

function mockSessionApis() {
  fetchMock.mockImplementation(((url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/background-processes')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ processes: [] }) })
    }
    const match = /\/sessions\/([^/?]+)/.exec(u)
    const id = match?.[1] ?? 'unknown'
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          success: true,
          session: makeSession(id),
          messages: [],
          contextState: null,
          queueState: [],
          pendingQuestions: [],
        }),
    })
  }) as never)
}

const assistantMessage = (id: string) => ({
  id,
  role: 'assistant',
  content: '',
  timestamp: '2024-01-01',
  tokenCount: 0,
})

describe('prefill indicator store state', () => {
  beforeEach(() => {
    wsSendMock.mockClear()
    wsSubscribeMock.mockClear()
    fetchMock.mockReset()
  })

  it('sets the pane prefill state on chat.prefill and clears it on the first delta', async () => {
    const useSessionStore = await loadSessionStore()
    mockSessionApis()

    await useSessionStore.getState().openPane('s1', { focus: true })

    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill',
      sessionId: 's1',
      payload: { messageId: 'm1', contextTokens: 40000 },
    })

    const withPrefill = useSessionStore.getState()
    expect(withPrefill.panes['s1']?.prefill?.messageId).toBe('m1')
    expect(withPrefill.panes['s1']?.prefill?.contextTokens).toBe(40000)
    // Focused pane mirrors to the flat aliases
    expect(withPrefill.prefill?.messageId).toBe('m1')

    useSessionStore.getState().handleServerMessage({
      type: 'chat.delta',
      sessionId: 's1',
      payload: { messageId: 'm1', content: 'hi' },
    })

    const cleared = useSessionStore.getState()
    expect(cleared.panes['s1']?.prefill).toBeNull()
    expect(cleared.prefill).toBeNull()
  })

  it('hydrates the pane prefill state from the session load payload (F5 parity)', async () => {
    const useSessionStore = await loadSessionStore()
    fetchMock.mockImplementation(((url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/background-processes')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ processes: [] }) })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            success: true,
            session: makeSession('s1'),
            messages: [],
            contextState: null,
            queueState: [],
            pendingQuestions: [],
            prefill: { messageId: 'm1', contextTokens: 42_000, startedAt: 1_700_000_000_000 },
          }),
      })
    }) as never)

    await useSessionStore.getState().openPane('s1', { focus: true })

    const prefill = useSessionStore.getState().panes['s1']?.prefill
    expect(prefill?.messageId).toBe('m1')
    expect(prefill?.contextTokens).toBe(42_000)
    expect(prefill?.startedAt).toBe(1_700_000_000_000)
    // Focused pane mirrors to the flat alias
    expect(useSessionStore.getState().prefill?.messageId).toBe('m1')
  })

  it('restores the in-flight prefill from session.state (unrelated state updates must not wipe it)', async () => {
    const useSessionStore = await loadSessionStore()
    mockSessionApis()

    await useSessionStore.getState().openPane('s1', { focus: true })

    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill',
      sessionId: 's1',
      payload: { messageId: 'm1', contextTokens: 40000 },
    })
    expect(useSessionStore.getState().panes['s1']?.prefill?.messageId).toBe('m1')

    // An unrelated session update (rename, provider change…) carries the
    // in-flight prefill back — the indicator survives the snapshot.
    useSessionStore.getState().handleServerMessage({
      type: 'session.state',
      sessionId: 's1',
      payload: {
        session: makeSession('s1'),
        messages: [],
        pendingConfirmations: [],
        prefill: { messageId: 'm1', contextTokens: 40000, startedAt: 1_700_000_000_000 },
      },
    })

    const restored = useSessionStore.getState()
    expect(restored.panes['s1']?.prefill?.messageId).toBe('m1')
    expect(restored.panes['s1']?.prefill?.contextTokens).toBe(40000)
    expect(restored.panes['s1']?.prefill?.startedAt).toBe(1_700_000_000_000)
    expect(restored.prefill?.messageId).toBe('m1')

    // When the call is no longer in flight, session.state clears the state.
    useSessionStore.getState().handleServerMessage({
      type: 'session.state',
      sessionId: 's1',
      payload: { session: makeSession('s1'), messages: [], pendingConfirmations: [] },
    })
    expect(useSessionStore.getState().panes['s1']?.prefill).toBeNull()
    expect(useSessionStore.getState().prefill).toBeNull()
  })

  it('keeps prefill state per pane: a sibling pane never sees it', async () => {
    const useSessionStore = await loadSessionStore()
    mockSessionApis()

    await useSessionStore.getState().openPane('s1', { focus: true })
    await useSessionStore.getState().openPane('s2', { focus: false })

    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill',
      sessionId: 's2',
      payload: { messageId: 'm2', contextTokens: 20000 },
    })

    const state = useSessionStore.getState()
    expect(state.panes['s2']?.prefill?.messageId).toBe('m2')
    expect(state.panes['s1']?.prefill).toBeNull()
    // s1 is focused — the flat alias stays clean
    expect(state.prefill).toBeNull()
  })

  it('updates engine progress only when the message id matches', async () => {
    const useSessionStore = await loadSessionStore()
    mockSessionApis()

    await useSessionStore.getState().openPane('s1', { focus: true })

    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill',
      sessionId: 's1',
      payload: { messageId: 'm1', contextTokens: 40000 },
    })
    // A stale progress for another message must be ignored
    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill_progress',
      sessionId: 's1',
      payload: { messageId: 'm0', promptTokens: 40000, processedTokens: 1000, percent: 2 },
    })
    expect(useSessionStore.getState().panes['s1']?.prefill?.percent).toBeUndefined()

    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill_progress',
      sessionId: 's1',
      payload: {
        messageId: 'm1',
        promptTokens: 40000,
        processedTokens: 20000,
        percent: 50,
        etaSeconds: 1,
        speedTps: 20000,
        avgTps: 15000,
        slotId: 1,
        taskId: 15247,
        cachedTokens: 35000,
      },
    })

    const prefill = useSessionStore.getState().panes['s1']?.prefill
    expect(prefill?.percent).toBe(50)
    expect(prefill?.processedTokens).toBe(20000)
    expect(prefill?.etaSeconds).toBe(1)
    expect(prefill?.speedTps).toBe(20000)
    expect(prefill?.avgTps).toBe(15000)
    expect(prefill?.slotId).toBe(1)
    expect(prefill?.taskId).toBe(15247)
    expect(prefill?.cachedTokens).toBe(35000)
  })

  it('clears the prefill state on assistant message start and thinking', async () => {
    const useSessionStore = await loadSessionStore()
    mockSessionApis()

    await useSessionStore.getState().openPane('s1', { focus: true })
    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill',
      sessionId: 's1',
      payload: { messageId: 'm1', contextTokens: 40000 },
    })

    useSessionStore.getState().handleServerMessage({
      type: 'chat.thinking',
      sessionId: 's1',
      payload: { messageId: 'm1', content: 'hmm' },
    })
    expect(useSessionStore.getState().panes['s1']?.prefill).toBeNull()

    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill',
      sessionId: 's1',
      payload: { messageId: 'm2', contextTokens: 41000 },
    })
    useSessionStore.getState().handleServerMessage({
      type: 'chat.message',
      sessionId: 's1',
      payload: { message: assistantMessage('m2') },
    })
    expect(useSessionStore.getState().panes['s1']?.prefill).toBeNull()
  })

  it('ignores prefill for sub-agent calls (main-session indicator only)', async () => {
    const useSessionStore = await loadSessionStore()
    mockSessionApis()

    await useSessionStore.getState().openPane('s1', { focus: true })

    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill',
      sessionId: 's1',
      payload: { messageId: 'm1', contextTokens: 40000, subAgentId: 'sub-1', subAgentType: 'explorer' },
    })
    expect(useSessionStore.getState().panes['s1']?.prefill).toBeNull()

    // Progress for the sub-agent call must not resurrect the state
    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill_progress',
      sessionId: 's1',
      payload: { messageId: 'm1', promptTokens: 40000, processedTokens: 20000, percent: 50 },
    })
    expect(useSessionStore.getState().panes['s1']?.prefill).toBeNull()
    expect(useSessionStore.getState().prefill).toBeNull()
  })

  it('clears the prefill state as a safety net on done, error, and stop', async () => {
    const useSessionStore = await loadSessionStore()
    mockSessionApis()

    await useSessionStore.getState().openPane('s1', { focus: true })

    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill',
      sessionId: 's1',
      payload: { messageId: 'm1', contextTokens: 40000 },
    })
    useSessionStore.getState().handleServerMessage({
      type: 'chat.done',
      sessionId: 's1',
      payload: { messageId: 'm1', reason: 'complete' },
    })
    expect(useSessionStore.getState().panes['s1']?.prefill).toBeNull()

    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill',
      sessionId: 's1',
      payload: { messageId: 'm2', contextTokens: 40000 },
    })
    useSessionStore.getState().handleServerMessage({
      type: 'chat.error',
      sessionId: 's1',
      payload: { error: 'boom', recoverable: false },
    })
    expect(useSessionStore.getState().panes['s1']?.prefill).toBeNull()

    useSessionStore.getState().handleServerMessage({
      type: 'chat.prefill',
      sessionId: 's1',
      payload: { messageId: 'm3', contextTokens: 40000 },
    })
    useSessionStore.getState().handleServerMessage({
      type: 'session.running',
      sessionId: 's1',
      payload: { isRunning: false },
    })
    expect(useSessionStore.getState().panes['s1']?.prefill).toBeNull()
    expect(useSessionStore.getState().prefill).toBeNull()
  })
})
