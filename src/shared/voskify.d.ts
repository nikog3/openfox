declare module 'voskify' {
  export class VoskModel {
    constructor(path: string)
    createRecognizer(): {
      acceptWaveform(buffer: Buffer): Promise<boolean>
      getPartialResult(): { partial?: string; text?: string }
      getResult(): { text?: string }
      getFinalResult(): { text?: string }
      free(): void
    }
    free(): void
  }
}
