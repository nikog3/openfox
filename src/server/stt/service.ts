import type { SttEvent, SttEventListener, SttProvider, SttProviderFactory, SttState } from './types.js'

export class SttService {
  private state: SttState = 'off'
  private provider: SttProvider | null = null
  private providerKey: string | null = null
  private pendingAudio: Buffer[] = []
  private listeners = new Set<SttEventListener>()
  private generation = 0

  constructor(private readonly factory: SttProviderFactory) {}

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
          onPartial: (text) => this.emit({ type: 'partial', text }),
          onActivity: (speaking) => this.emit({ type: 'activity', speaking }),
          onProgress: (percent) => this.emit({ type: 'progress', percent, phase: 'model' }),
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
    this.generation++
    if (this.state === 'loading') {
      this.pendingAudio = []
      this.setState('off')
      this.emit({ type: 'final', text: '' })
      return ''
    }
    if (this.state !== 'listening' || !this.provider) {
      return ''
    }
    const provider = this.provider
    this.setState('transcribing')
    try {
      const text = await provider.finalize()
      this.emit({ type: 'final', text })
      this.setState('off')
      return text
    } catch (error) {
      this.provider = null
      this.providerKey = null
      await provider.dispose()
      this.setState('off')
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      return ''
    }
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
