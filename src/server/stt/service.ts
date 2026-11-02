import { serverT } from '../i18n.js'
import type { SttEvent, SttEventListener, SttProvider, SttProviderFactory, SttState } from './types.js'

const FINALIZE_TIMEOUT_MS = 120_000
const FINALIZE_TIMEOUT_ERROR = 'stt-finalize-timeout'

export class SttService {
  private state: SttState = 'off'
  private provider: SttProvider | null = null
  private providerKey: string | null = null
  private pendingAudio: Buffer[] = []
  private listeners = new Set<SttEventListener>()
  private generation = 0

  constructor(
    private readonly factory: SttProviderFactory,
    private readonly finalizeTimeoutMs: number = FINALIZE_TIMEOUT_MS,
  ) {}

  getState(): SttState {
    return this.state
  }

  subscribe(listener: SttEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(state: SttState): void {
    this.state = state
    this.emit({ type: 'state', state })
  }

  private emit(event: SttEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  async start(): Promise<void> {
    if (this.state === 'loading' || this.state === 'listening') {
      return
    }
    const generation = ++this.generation
    this.setState('loading')
    this.emit({ type: 'progress', percent: null, phase: 'init' })
    try {
      const key = this.factory.configKey()
      let provider: SttProvider
      if (this.provider && this.providerKey === key) {
        provider = this.provider
        await provider.reset()
      } else {
        const old = this.provider
        this.provider = null
        this.providerKey = null
        if (old) {
          await old.dispose()
        }
        provider = await this.factory.create({
          onPartial: (text) => {
            if (this.provider !== provider) return
            this.emit({ type: 'partial', text })
          },
          onActivity: (speaking) => {
            if (this.provider !== provider) return
            this.emit({ type: 'activity', speaking })
          },
          onProgress: (percent, model) =>
            this.emit({ type: 'progress', percent, phase: 'model', ...(model ? { model } : {}) }),
          onFinalizeProgress: (percent) => {
            if (this.provider !== provider) return
            this.emit({ type: 'progress', percent })
          },
        })
      }
      if (generation !== this.generation) {
        if (this.provider !== provider) {
          await provider.dispose()
        }
        return
      }
      this.provider = provider
      this.providerKey = key
      this.emit({ type: 'progress', percent: null, phase: 'ready' })
      this.setState('listening')
      for (const chunk of this.pendingAudio) {
        await provider.acceptAudio(chunk)
      }
      this.pendingAudio = []
    } catch (error) {
      if (generation !== this.generation) {
        return
      }
      const orphan = this.provider
      this.provider = null
      this.providerKey = null
      this.pendingAudio = []
      if (orphan) {
        try {
          await orphan.dispose()
        } catch {
          // a dispose failure must not mask the original error
        }
      }
      this.setState('off')
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async feedAudio(chunk: Buffer): Promise<void> {
    if (this.state === 'loading') {
      this.pendingAudio.push(chunk)
      return
    }
    if (this.state !== 'listening' || !this.provider) {
      return
    }
    await this.provider.acceptAudio(chunk)
  }

  async stop(): Promise<string> {
    const generation = ++this.generation
    if (this.state === 'loading') {
      this.pendingAudio = []
      this.setState('off')
      this.emit({ type: 'final', text: '' })
      return ''
    }
    if (this.state === 'transcribing') {
      // Cancel an in-flight transcription. The abandoned finalize keeps
      // running on its own provider reference, but its events are dropped
      // (generation + provider-identity guards) and the next start() gets a
      // fresh provider.
      this.provider = null
      this.providerKey = null
      this.setState('off')
      this.emit({ type: 'final', text: '' })
      return ''
    }
    if (this.state !== 'listening' || !this.provider) {
      return ''
    }
    const provider = this.provider
    this.setState('transcribing')
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      const text = await new Promise<string>((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(FINALIZE_TIMEOUT_ERROR)), this.finalizeTimeoutMs)
        provider.finalize().then(resolve, reject)
      })
      if (generation !== this.generation) return ''
      this.emit({ type: 'final', text })
      this.setState('off')
      return text
    } catch (error) {
      if (generation !== this.generation) return ''
      this.provider = null
      this.providerKey = null
      try {
        await provider.dispose()
      } catch {
        // a dispose failure must not mask the original error
      }
      this.setState('off')
      this.emit({ type: 'error', message: this.finalizeErrorMessage(error) })
      return ''
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private finalizeErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message === FINALIZE_TIMEOUT_ERROR) {
      return serverT({
        en: 'Transcription timed out, please try again with a shorter recording',
        fr: 'La transcription a dépassé le délai maximum, réessayez avec un enregistrement plus court',
      })
    }
    return error instanceof Error ? error.message : String(error)
  }

  async dispose(): Promise<void> {
    this.generation++
    if (this.provider) {
      await this.provider.dispose()
      this.provider = null
      this.providerKey = null
    }
    this.pendingAudio = []
    this.state = 'off'
    this.listeners.clear()
  }
}
