import type { SttEvent, SttEventListener, SttProvider, SttProviderFactory, SttState } from './types.js'

export class SttService {
  private state: SttState = 'off'
  private provider: SttProvider | null = null
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
    try {
      const provider = await this.factory((text) => {
        this.emit({ type: 'partial', text })
      })
      if (generation !== this.generation) {
        await provider.dispose()
        return
      }
      this.provider = provider
      this.setState('listening')
      for (const chunk of this.pendingAudio) {
        await provider.acceptAudio(chunk)
      }
      this.pendingAudio = []
    } catch (error) {
      if (generation !== this.generation) {
        return
      }
      this.provider = null
      this.pendingAudio = []
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
    this.provider = null
    this.setState('transcribing')
    try {
      const text = await provider.finalize()
      await provider.dispose()
      this.emit({ type: 'final', text })
      this.setState('off')
      return text
    } catch (error) {
      await provider.dispose()
      this.setState('off')
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      return ''
    }
  }

  async dispose(): Promise<void> {
    if (this.provider) {
      await this.provider.dispose()
      this.provider = null
    }
    this.pendingAudio = []
    this.state = 'off'
    this.listeners.clear()
  }
}
