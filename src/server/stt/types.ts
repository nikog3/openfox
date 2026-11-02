export type SttState = 'off' | 'loading' | 'listening' | 'transcribing'

export interface SttProvider {
  acceptAudio(chunk: Buffer): Promise<void>
  finalize(): Promise<string>
  reset(): Promise<void>
  dispose(): Promise<void>
}

export interface SttProviderHooks {
  onPartial: (text: string) => void
  onActivity: (speaking: boolean) => void
  onProgress: (percent: number, model?: string) => void
  onFinalizeProgress?: (percent: number) => void
}

export interface SttProviderFactory {
  configKey(): string
  create(hooks: SttProviderHooks): Promise<SttProvider>
}

export type SttProgressPhase = 'init' | 'model' | 'ready'

export type SttEvent =
  | { type: 'state'; state: SttState }
  | { type: 'partial'; text: string }
  | { type: 'activity'; speaking: boolean }
  | { type: 'progress'; percent: number | null; phase?: SttProgressPhase; model?: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }

export type SttEventListener = (event: SttEvent) => void
