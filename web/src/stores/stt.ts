import { create } from 'zustand'
import { t } from '@shared/i18n/index.js'
import { wsClient } from '../lib/ws'
import {
  startAudioCapture,
  bytesToBase64,
  CaptureError,
  type AudioCaptureHandle,
  type CaptureErrorCode,
} from '../lib/audio-capture'
import { readSetting, SETTINGS_KEYS } from '../lib/resources'

export type SttStatus = 'idle' | 'loading' | 'listening' | 'transcribing'
export type SttLoadPhase = 'init' | 'model' | 'ready'

function isDebugEnabled(): boolean {
  return readSetting(SETTINGS_KEYS.STT_DEBUG) === 'true'
}

function logStt(message: string, extra?: unknown): void {
  if (!isDebugEnabled()) return
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.debug('[stt]', message, extra)
  } else {
    // eslint-disable-next-line no-console
    console.debug('[stt]', message)
  }
}

interface SttStore {
  status: SttStatus
  partialText: string
  finalText: string | null
  error: string | null
  sessionId: string | null
  level: number
  speaking: boolean
  progress: number | null
  loadPhase: SttLoadPhase | null
  loadingModel: string | null
  startedAt: number | null
  cancelled: boolean
  captureError: CaptureErrorCode | null
  downloadProgress: number | null
  downloadModel: string | null
  downloadError: string | null
  downloaded: boolean | null
  deletingModel: boolean
  deleted: boolean | null
  transcribingSince: number | null
  start: (sessionId: string) => Promise<void>
  stop: () => void
  handlePartial: (text: string) => void
  handleFinal: (text: string) => void
  handleError: (message: string) => void
  handleState: (state: 'off' | 'loading' | 'listening' | 'transcribing') => void
  handleActivity: (speaking: boolean) => void
  handleProgress: (percent: number | null, phase?: SttLoadPhase, model?: string) => void
  startModelDownload: (model: string) => void
  handleDownloadProgress: (percent: number, model?: string) => void
  handleModelDownloaded: (ok: boolean, error?: string) => void
  clearDownloadResult: () => void
  deleteModel: (model: string) => void
  handleModelDeleted: (ok: boolean, error?: string) => void
  clearDeleteResult: () => void
  reset: () => void
}

let captureHandle: AudioCaptureHandle | null = null

const clearedFields = {
  partialText: '',
  finalText: null,
  error: null,
  level: 0,
  speaking: false,
  progress: null,
  loadingModel: null,
  cancelled: false,
  captureError: null,
}

function computeLevel(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]! / 32768
    sum += v * v
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 4)
}

export const useSttStore = create<SttStore>()((set, get) => ({
  status: 'idle',
  partialText: '',
  finalText: null,
  error: null,
  sessionId: null,
  level: 0,
  speaking: false,
  progress: null,
  loadPhase: null,
  loadingModel: null,
  startedAt: null,
  cancelled: false,
  captureError: null,
  downloadProgress: null,
  downloadModel: null,
  downloadError: null,
  downloaded: null,
  deletingModel: false,
  deleted: null,
  transcribingSince: null,

  start: async (sessionId: string) => {
    if (get().status !== 'idle') return
    logStt('start', { sessionId })
    set({
      ...clearedFields,
      status: 'loading',
      sessionId,
      loadPhase: 'init',
      startedAt: Date.now(),
    })

    try {
      captureHandle = await startAudioCapture((samples) => {
        set({ level: computeLevel(samples) })
        const base64 = bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
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
        level: 0,
        speaking: false,
        progress: null,
        loadPhase: null,
        loadingModel: null,
        startedAt: null,
        error:
          err instanceof Error
            ? err.message
            : t({ en: 'Failed to start audio capture', fr: 'Échec de la capture audio' }),
        captureError: err instanceof CaptureError ? err.code : 'unknown',
      })
      logStt('start failed', { sessionId })
    }
  },

  stop: () => {
    const { sessionId, status, startedAt } = get()
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
    if (status === 'loading') {
      const elapsedMs = startedAt ? Date.now() - startedAt : null
      set({
        status: 'idle',
        sessionId: null,
        level: 0,
        speaking: false,
        progress: null,
        loadPhase: null,
        loadingModel: null,
        startedAt: null,
        transcribingSince: null,
        cancelled: true,
      })
      logStt('cancelled during load', { elapsedMs })
      return
    }
    if (status === 'transcribing') {
      set({ cancelled: true })
      logStt('cancel during transcription')
      return
    }
    set({ status: 'transcribing', transcribingSince: Date.now() })
    logStt('stop')
  },

  handlePartial: (text: string) => {
    set({ partialText: text })
    logStt('partial', { text })
  },

  handleFinal: (text: string) => {
    if (get().cancelled) {
      set({
        partialText: '',
        status: 'idle',
        sessionId: null,
        level: 0,
        speaking: false,
        progress: null,
        loadPhase: null,
        loadingModel: null,
        startedAt: null,
        transcribingSince: null,
        cancelled: false,
      })
      logStt('final ignored (cancelled)', { text })
      if (captureHandle) {
        captureHandle.stop()
        captureHandle = null
      }
      return
    }
    set({
      finalText: text,
      partialText: '',
      status: 'idle',
      sessionId: null,
      level: 0,
      speaking: false,
      progress: null,
      loadPhase: null,
      loadingModel: null,
      startedAt: null,
      transcribingSince: null,
      cancelled: false,
    })
    logStt('final', { text })
    if (captureHandle) {
      captureHandle.stop()
      captureHandle = null
    }
  },

  handleError: (message: string) => {
    set({
      error: message,
      status: 'idle',
      sessionId: null,
      level: 0,
      speaking: false,
      progress: null,
      loadPhase: null,
      loadingModel: null,
      startedAt: null,
      transcribingSince: null,
      cancelled: false,
    })
    logStt('error', { message })
    if (captureHandle) {
      captureHandle.stop()
      captureHandle = null
    }
  },

  handleState: (state: 'off' | 'loading' | 'listening' | 'transcribing') => {
    if (state === 'off') {
      if (get().status === 'idle') return
      // The server dropped the session (timeout, cancel, dispose). Recover a
      // stuck client — finalText is kept on purpose so its insertion effect
      // does not re-run.
      set({
        status: 'idle',
        sessionId: null,
        partialText: '',
        level: 0,
        speaking: false,
        progress: null,
        loadPhase: null,
        loadingModel: null,
        startedAt: null,
        transcribingSince: null,
        cancelled: false,
      })
      logStt('state off (reset)')
      return
    }
    logStt('state', { state })
    if (state === 'transcribing' && get().status !== 'transcribing') {
      set({ status: state, transcribingSince: Date.now() })
      return
    }
    set({ status: state })
  },

  handleActivity: (speaking: boolean) => {
    set({ speaking })
  },

  handleProgress: (percent: number | null, phase?: SttLoadPhase, model?: string) => {
    if (phase) {
      set({ progress: percent, loadPhase: phase, ...(model ? { loadingModel: model } : {}) })
    } else {
      set({ progress: percent })
    }
    logStt('progress', { percent, phase, model })
  },

  startModelDownload: (model: string) => {
    logStt('model download start', { model })
    set({ downloadProgress: 0, downloadModel: null, downloadError: null, downloaded: null })
    try {
      wsClient.send('stt.download_model', { model })
    } catch {
      set({
        downloadProgress: null,
        downloadModel: null,
        downloadError: t({ en: 'Model download failed', fr: 'Échec du téléchargement du modèle' }),
      })
    }
  },

  handleDownloadProgress: (percent: number, model?: string) => {
    set({ downloadProgress: percent, ...(model ? { downloadModel: model } : {}) })
  },

  handleModelDownloaded: (ok, error) => {
    logStt('model downloaded', { ok, error })
    if (ok) {
      set({ downloaded: true, downloadProgress: null, downloadModel: null, downloadError: null })
    } else {
      set({
        downloaded: false,
        downloadProgress: null,
        downloadModel: null,
        downloadError: error ?? t({ en: 'Model download failed', fr: 'Échec du téléchargement du modèle' }),
      })
    }
  },

  clearDownloadResult: () => {
    set({ downloaded: null })
  },

  deleteModel: (model: string) => {
    logStt('model delete start', { model })
    set({ deletingModel: true, downloadError: null })
    try {
      wsClient.send('stt.delete_model', { model })
    } catch {
      set({
        deletingModel: false,
        downloadError: t({ en: 'Model deletion failed', fr: 'Échec de la suppression du modèle' }),
      })
    }
  },

  handleModelDeleted: (ok, error) => {
    logStt('model deleted', { ok, error })
    if (ok) {
      set({
        deletingModel: false,
        deleted: true,
        downloadError: null,
        downloadProgress: null,
        downloadModel: null,
        downloaded: null,
      })
    } else {
      set({
        deletingModel: false,
        deleted: false,
        downloadError: error ?? t({ en: 'Model deletion failed', fr: 'Échec de la suppression du modèle' }),
      })
    }
  },

  clearDeleteResult: () => {
    set({ deleted: null })
  },

  reset: () => {
    if (captureHandle) {
      captureHandle.stop()
      captureHandle = null
    }
    set({
      ...clearedFields,
      status: 'idle',
      sessionId: null,
      loadPhase: null,
      startedAt: null,
      transcribingSince: null,
    })
  },
}))

// A WS reconnect means the server state is unknown (a stuck transcription was
// lost with the socket). Reset any in-flight dictation so the UI is usable.
wsClient.onStatusChange((status) => {
  if (status === 'connected' && useSttStore.getState().status !== 'idle') {
    useSttStore.getState().reset()
  }
})
