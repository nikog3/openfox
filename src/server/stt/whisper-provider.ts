import type { SttProvider } from './types.js'

const SAMPLE_RATE = 16000
const FEATURE_DIM = 80

interface WhisperStream {
  acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void
}

interface WhisperRecognizer {
  createStream(): WhisperStream
  decode(stream: WhisperStream): void
  getResult(stream: WhisperStream): { text: string }
}

interface SherpaOnnxModule {
  OfflineRecognizer?: new (config: unknown) => WhisperRecognizer
  default?: SherpaOnnxModule
}

function pcmToFloat32(pcm: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(pcm.length / 2))
  for (let i = 0; i < samples.length; i++) {
    samples[i] = pcm.readInt16LE(i * 2) / 32768
  }
  return samples
}

export async function createWhisperProvider(
  encoderPath: string,
  decoderPath: string,
  tokensPath: string,
  language: string,
  _onPartial: (text: string) => void,
): Promise<SttProvider> {
  const mod = (await import('sherpa-onnx-node')) as unknown as SherpaOnnxModule
  const named = 'OfflineRecognizer' in mod ? mod.OfflineRecognizer : undefined
  const OfflineRecognizer = named ?? mod.default?.OfflineRecognizer
  if (!OfflineRecognizer) {
    throw new Error(
      'sherpa-onnx-node: OfflineRecognizer is not available (CJS/ESM interop) — check the installed version',
    )
  }
  const recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: FEATURE_DIM },
    modelConfig: {
      whisper: {
        encoder: encoderPath,
        decoder: decoderPath,
        language: language === 'auto' ? '' : language,
        task: 'transcribe',
        tailPaddings: -1,
      },
      tokens: tokensPath,
      numThreads: 4,
    },
    decodingMethod: 'greedy_search',
  })

  const chunks: Buffer[] = []

  return {
    async acceptAudio(chunk: Buffer): Promise<void> {
      chunks.push(chunk)
    },
    async finalize(): Promise<string> {
      const pcm = Buffer.concat(chunks)
      chunks.length = 0
      if (pcm.length === 0) {
        return ''
      }
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples: pcmToFloat32(pcm), sampleRate: SAMPLE_RATE })
      recognizer.decode(stream)
      const result = recognizer.getResult(stream)
      return (result.text ?? '').trim()
    },
    async dispose(): Promise<void> {
      chunks.length = 0
    },
  }
}
