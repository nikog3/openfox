import type { SttProvider } from './types.js'

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

export function createVoskProvider(modelPath: string, onPartial: (text: string) => void): Promise<SttProvider> {
  return import('voskify').then(({ VoskModel }) => {
    const model: VoskModel = new (VoskModel as new (path: string) => VoskModel)(modelPath)
    const recognizer = model.createRecognizer()
    let committed = ''

    const appendCommitted = (segment: string): void => {
      const seg = (segment ?? '').trim()
      if (!seg) {
        return
      }
      committed = committed ? `${committed} ${seg}` : seg
    }

    return {
      async acceptAudio(chunk: Buffer): Promise<void> {
        const isFinal = await recognizer.acceptWaveform(chunk)
        if (isFinal) {
          const result = recognizer.getResult()
          appendCommitted(result.text ?? '')
          return
        }
        const result = recognizer.getPartialResult()
        const partial = (result.partial ?? result.text ?? '').trim()
        if (partial) {
          onPartial(committed ? `${committed} ${partial}` : partial)
        }
      },
      async finalize(): Promise<string> {
        const result = recognizer.getFinalResult()
        appendCommitted(result.text ?? '')
        const text = committed
        recognizer.free()
        model.free()
        return text
      },
      async dispose(): Promise<void> {
        recognizer.free()
        model.free()
      },
    }
  })
}
