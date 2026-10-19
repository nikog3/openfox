export type SttState = 'off' | 'loading' | 'listening' | 'transcribing'

export interface SttProvider {
  acceptAudio(chunk: Buffer): Promise<void>
  finalize(): Promise<string>
  dispose(): Promise<void>
}

export type SttProviderFactory = (onPartial: (text: string) => void) => Promise<SttProvider>

export type SttEvent =
  | { type: 'state'; state: SttState }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }

export type SttEventListener = (event: SttEvent) => void
