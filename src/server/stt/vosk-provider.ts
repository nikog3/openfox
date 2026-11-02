import type { SttProvider, SttProviderHooks } from './types.js'

interface VoskRecognizer {
  acceptWaveform(buffer: Buffer): Promise<boolean>
  getPartialResult(): { partial?: string; text?: string }
  getResult(): { text?: string }
  getFinalResult(): { text?: string }
  free(): void
}

interface VoskModel {
  createRecognizer(): VoskRecognizer
  free(): void
}

export function createVoskProvider(modelPath: string, hooks: SttProviderHooks): Promise<SttProvider> {
  return import('voskify').then(({ VoskModel }) => {
    const model: VoskModel = new (VoskModel as new (path: string) => VoskModel)(modelPath)
    let recognizer = model.createRecognizer()
    let committed = ''

    const appendCommitted = (segment: string): void => {
      const seg = (segment ?? '').trim()
      if (!seg) {
        return
      }
      committed = committed ? `${committed} ${seg}` : seg
    }

    const resetRecognizer = (): void => {
      recognizer.free()
      recognizer = model.createRecognizer()
      committed = ''
    }

    return {
      async acceptAudio(chunk: Buffer): Promise<void> {
        const isFinal = await recognizer.acceptWaveform(chunk)
        if (isFinal) {
          const result = recognizer.getResult()
          appendCommitted(result.text ?? '')
          hooks.onActivity(false)
          return
        }
        const result = recognizer.getPartialResult()
        const partial = (result.partial ?? result.text ?? '').trim()
        if (partial) {
          hooks.onPartial(committed ? `${committed} ${partial}` : partial)
        }
        hooks.onActivity(Boolean(partial))
      },
      async finalize(): Promise<string> {
        const result = recognizer.getFinalResult()
        appendCommitted(result.text ?? '')
        const text = committed
        resetRecognizer()
        hooks.onActivity(false)
        return text
      },
      async reset(): Promise<void> {
        resetRecognizer()
        hooks.onActivity(false)
      },
      async dispose(): Promise<void> {
        recognizer.free()
        model.free()
      },
    }
  })
}
