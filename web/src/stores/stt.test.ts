// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { wsSendMock, startAudioCaptureMock, wsStatusHandlers } = vi.hoisted(() => ({
  wsSendMock: vi.fn(() => 'message-id'),
  startAudioCaptureMock: vi.fn(async () => ({ stop: vi.fn() })),
  wsStatusHandlers: [] as Array<(status: string) => void>,
}))

vi.mock('../lib/ws', () => ({
  wsClient: {
    send: wsSendMock,
    subscribe: vi.fn(() => () => undefined),
    onStatusChange: (handler: (status: string) => void) => {
      wsStatusHandlers.push(handler)
    },
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

  it('handleProgress tracks the model label and keeps it on subsequent updates', () => {
    useSttStore.getState().handleProgress(42, 'model', 'whisper small')
    expect(useSttStore.getState().loadingModel).toBe('whisper small')
    useSttStore.getState().handleProgress(55, 'model')
    expect(useSttStore.getState().loadingModel).toBe('whisper small')
  })

  it('handleDownloadProgress tracks the model label', () => {
    useSttStore.getState().handleDownloadProgress(12, 'vosk large')
    const state = useSttStore.getState()
    expect(state.downloadProgress).toBe(12)
    expect(state.downloadModel).toBe('vosk large')
  })

  it('handleFinal clears the loading model label', () => {
    useSttStore.setState({ status: 'listening', sessionId: 'sess-1', cancelled: false, loadingModel: 'whisper small' })
    useSttStore.getState().handleFinal('bonjour')
    expect(useSttStore.getState().loadingModel).toBeNull()
  })

  it('handleModelDownloaded clears the download model label', () => {
    useSttStore.getState().handleDownloadProgress(12, 'vosk large')
    useSttStore.getState().handleModelDownloaded(true)
    const state = useSttStore.getState()
    expect(state.downloadModel).toBeNull()
    expect(state.downloaded).toBe(true)
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

  it('stop while transcribing marks the in-flight transcription as cancelled', () => {
    useSttStore.setState({ status: 'transcribing', sessionId: 'sess-1', cancelled: false, startedAt: Date.now() })
    useSttStore.getState().stop()
    const state = useSttStore.getState()
    expect(state.status).toBe('transcribing')
    expect(state.cancelled).toBe(true)
    expect(wsSendMock).toHaveBeenCalledWith('stt.stop', { sessionId: 'sess-1' })
  })

  it('ignores the final text after a cancelled transcription', () => {
    useSttStore.setState({ status: 'transcribing', sessionId: 'sess-1', cancelled: false })
    useSttStore.getState().stop()
    useSttStore.getState().handleFinal('bonjour')
    const state = useSttStore.getState()
    expect(state.status).toBe('idle')
    expect(state.finalText).toBeNull()
  })

  it('handleState off resets a stuck transcribing state and keeps the final text', () => {
    useSttStore.setState({ status: 'transcribing', sessionId: 'sess-1', partialText: 'bon', finalText: 'keep me' })
    useSttStore.getState().handleState('off')
    const state = useSttStore.getState()
    expect(state.status).toBe('idle')
    expect(state.sessionId).toBeNull()
    expect(state.partialText).toBe('')
    expect(state.finalText).toBe('keep me')
    expect(state.progress).toBeNull()
  })

  it('handleState off is a no-op when idle', () => {
    useSttStore.setState({ finalText: 'keep me' })
    useSttStore.getState().handleState('off')
    const state = useSttStore.getState()
    expect(state.status).toBe('idle')
    expect(state.finalText).toBe('keep me')
  })

  it('resets an in-flight dictation when the websocket reconnects', () => {
    useSttStore.setState({ status: 'transcribing', sessionId: 'sess-1', partialText: 'bon' })
    for (const handler of wsStatusHandlers) handler('connected')
    const state = useSttStore.getState()
    expect(state.status).toBe('idle')
    expect(state.sessionId).toBeNull()
    expect(state.partialText).toBe('')
  })

  it('leaves an idle dictation untouched on websocket reconnect', () => {
    useSttStore.setState({ finalText: 'keep me' })
    for (const handler of wsStatusHandlers) handler('connected')
    const state = useSttStore.getState()
    expect(state.status).toBe('idle')
    expect(state.finalText).toBe('keep me')
  })
})
