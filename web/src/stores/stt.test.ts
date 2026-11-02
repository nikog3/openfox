// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { wsSendMock, startAudioCaptureMock } = vi.hoisted(() => ({
  wsSendMock: vi.fn(() => 'message-id'),
  startAudioCaptureMock: vi.fn(async () => ({ stop: vi.fn() })),
}))

vi.mock('../lib/ws', () => ({
  wsClient: {
    send: wsSendMock,
    subscribe: vi.fn(() => () => undefined),
  },
}))

vi.mock('../lib/audio-capture', () => ({
  startAudioCapture: startAudioCaptureMock,
  bytesToBase64: vi.fn(() => ''),
  CaptureError: class CaptureError extends Error {},
}))

import { useSttStore } from './stt'
import { settingResource, SETTINGS_KEYS } from '../lib/resources'

function setLoadingState(): void {
  useSttStore.setState({
    status: 'loading',
    sessionId: 'sess-1',
    startedAt: Date.now(),
    cancelled: false,
    progress: null,
    loadPhase: 'init',
  })
}

describe('stt store', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    useSttStore.setState({
      status: 'idle',
      partialText: '',
      finalText: null,
      error: null,
      sessionId: null,
      level: 0,
      speaking: false,
      progress: null,
      loadPhase: null,
      startedAt: null,
      cancelled: false,
      captureError: null,
    })
    settingResource.write('false', SETTINGS_KEYS.STT_DEBUG)
  })

  afterEach(() => {
    debugSpy.mockRestore()
  })

  it('stop while loading cancels the start without transcribing', () => {
    setLoadingState()
    useSttStore.getState().stop()
    const state = useSttStore.getState()
    expect(state.status).toBe('idle')
    expect(state.cancelled).toBe(true)
    expect(state.finalText).toBeNull()
    expect(state.loadPhase).toBeNull()
    expect(wsSendMock).toHaveBeenCalledWith('stt.stop', { sessionId: 'sess-1' })
  })

  it('ignores the final text after a cancelled load', () => {
    setLoadingState()
    useSttStore.getState().stop()
    useSttStore.getState().handleFinal('bonjour')
    const state = useSttStore.getState()
    expect(state.status).toBe('idle')
    expect(state.finalText).toBeNull()
    expect(state.cancelled).toBe(false)
  })

  it('stop while listening keeps the transcribing flow', () => {
    useSttStore.setState({ status: 'listening', sessionId: 'sess-1', cancelled: false })
    useSttStore.getState().stop()
    const state = useSttStore.getState()
    expect(state.status).toBe('transcribing')
    expect(state.cancelled).toBe(false)
  })

  it('final text is kept after a normal stop', () => {
    useSttStore.setState({ status: 'listening', sessionId: 'sess-1', cancelled: false })
    useSttStore.getState().stop()
    useSttStore.getState().handleFinal('bonjour')
    const state = useSttStore.getState()
    expect(state.status).toBe('idle')
    expect(state.finalText).toBe('bonjour')
  })

  it('handleProgress tracks the loading phase', () => {
    useSttStore.getState().handleProgress(null, 'init')
    expect(useSttStore.getState().loadPhase).toBe('init')
    useSttStore.getState().handleProgress(42, 'model')
    const state = useSttStore.getState()
    expect(state.progress).toBe(42)
    expect(state.loadPhase).toBe('model')
    useSttStore.getState().handleProgress(null, 'ready')
    expect(useSttStore.getState().loadPhase).toBe('ready')
  })

  it('handleProgress without a phase only updates the percent', () => {
    useSttStore.setState({ loadPhase: 'init' })
    useSttStore.getState().handleProgress(7)
    const state = useSttStore.getState()
    expect(state.progress).toBe(7)
    expect(state.loadPhase).toBe('init')
  })

  it('logs STT events to the console when the debug setting is on', () => {
    settingResource.write('true', SETTINGS_KEYS.STT_DEBUG)
    useSttStore.getState().handleProgress(42, 'model')
    expect(debugSpy).toHaveBeenCalledWith('[stt]', 'progress', { percent: 42, phase: 'model' })
  })

  it('stays silent when the debug setting is off', () => {
    useSttStore.getState().handleProgress(42, 'model')
    expect(debugSpy).not.toHaveBeenCalled()
  })

  it('reset clears the cancelled and loadPhase state', () => {
    setLoadingState()
    useSttStore.getState().stop()
    useSttStore.getState().reset()
    const state = useSttStore.getState()
    expect(state.status).toBe('idle')
    expect(state.cancelled).toBe(false)
    expect(state.loadPhase).toBeNull()
  })
})
