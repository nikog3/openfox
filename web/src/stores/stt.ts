import { create } from 'zustand'
import { wsClient } from '../lib/ws'
import { startAudioCapture, type AudioCaptureHandle } from '../lib/audio-capture'

export type SttStatus = 'idle' | 'loading' | 'listening' | 'transcribing'

interface SttStore {
  status: SttStatus
  partialText: string
  finalText: string | null
  error: string | null
  sessionId: string | null
  start: (sessionId: string) => Promise<void>
  stop: () => void
  handlePartial: (text: string) => void
  handleFinal: (text: string) => void
  handleError: (message: string) => void
  handleState: (state: 'off' | 'loading' | 'listening' | 'transcribing') => void
  reset: () => void
}

let captureHandle: AudioCaptureHandle | null = null

export const useSttStore = create<SttStore>()((set, get) => ({
  status: 'idle',
  partialText: '',
  finalText: null,
  error: null,
  sessionId: null,

  start: async (sessionId: string) => {
    if (get().status !== 'idle') return
    set({ status: 'loading', partialText: '', finalText: null, error: null, sessionId })

    try {
      captureHandle = await startAudioCapture((samples) => {
        const base64 = btoa(String.fromCharCode(...new Uint8Array(samples.buffer)))
        try {
          wsClient.send('stt.audio_chunk', { sessionId, chunk: base64 })
        } catch {
          void 0
        }
      })
      wsClient.send('stt.start', { sessionId })
      set({ status: 'loading' })
    } catch (err) {
      if (captureHandle) {
        captureHandle.stop()
        captureHandle = null
      }
      set({
        status: 'idle',
        sessionId: null,
        error: err instanceof Error ? err.message : 'Failed to start audio capture',
      })
    }
  },

  stop: () => {
    const { sessionId, status } = get()
    if (status === 'idle') return
    if (sessionId) {
      try {
        wsClient.send('stt.stop', { sessionId })
      } catch {
        void 0
      }
    }
    if (captureHandle) {
      captureHandle.stop()
      captureHandle = null
    }
    set({ status: 'transcribing' })
  },

  handlePartial: (text: string) => {
    set({ partialText: text })
  },

  handleFinal: (text: string) => {
    set({ finalText: text, partialText: '', status: 'idle', sessionId: null })
    if (captureHandle) {
      captureHandle.stop()
      captureHandle = null
    }
  },

  handleError: (message: string) => {
    set({ error: message, status: 'idle', sessionId: null })
    if (captureHandle) {
      captureHandle.stop()
      captureHandle = null
    }
  },

  handleState: (state: 'off' | 'loading' | 'listening' | 'transcribing') => {
    if (state === 'off') return
    set({ status: state })
  },

  reset: () => {
    if (captureHandle) {
      captureHandle.stop()
      captureHandle = null
    }
    set({ status: 'idle', partialText: '', finalText: null, error: null, sessionId: null })
  },
}))
