declare module 'sherpa-onnx-node' {
  export interface Waveform {
    samples: Float32Array
    sampleRate: number
  }

  export interface WhisperModelConfig {
    encoder?: string
    decoder?: string
    language?: string
    task?: string
    tailPaddings?: number
  }

  export interface OfflineModelConfig {
    whisper?: WhisperModelConfig
    tokens?: string
    numThreads?: number
    debug?: number | boolean
  }

  export interface FeatureConfig {
    sampleRate?: number
    featureDim?: number
  }

  export interface OfflineRecognizerConfig {
    featConfig?: FeatureConfig
    modelConfig?: OfflineModelConfig
    decodingMethod?: string
  }

  export interface OfflineRecognizerResult {
    text: string
    lang?: string
    tokens?: string[]
    timestamps?: number[]
    durations?: number[]
  }

  export class OfflineStream {
    acceptWaveform(obj: Waveform): void
    setOption(key: string, value: string): void
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig)
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>
    createStream(hotwords?: string): OfflineStream
    decode(stream: OfflineStream): void
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>
    getResult(stream: OfflineStream): OfflineRecognizerResult
  }
}
