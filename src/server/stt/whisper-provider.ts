import type { SttProvider } from './types.js'

const SAMPLE_RATE = 16000
const FEATURE_DIM = 80
const VAD_WINDOW_SIZE = 512
const VAD_MIN_SPEECH_DURATION = 0.25
const VAD_MIN_SILENCE_DURATION = 0.5
const VAD_MAX_SPEECH_DURATION = 5
const VAD_BUFFER_SECONDS = 300

interface WhisperStream {
  acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void
}

interface WhisperResult {
  text: string
}

interface WhisperRecognizer {
  createStream(): WhisperStream
  decodeAsync(stream: WhisperStream): Promise<WhisperResult>
}

interface WhisperRecognizerCtor {
  createAsync(config: unknown): Promise<WhisperRecognizer>
}

interface SpeechSegment {
  start: number
  samples: Float32Array
}

interface WhisperVad {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(): SpeechSegment | null
  pop(): SpeechSegment | null
  clear(): void
}

interface WhisperVadCtor {
  new (config: unknown, bufferSizeInSeconds: number): WhisperVad
}

interface SherpaOnnxModule {
  OfflineRecognizer?: WhisperRecognizerCtor
  Vad?: WhisperVadCtor
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
  vadModelPath: string,
  onPartial: (text: string) => void,
): Promise<SttProvider> {
  const mod = (await import('sherpa-onnx-node')) as unknown as SherpaOnnxModule
  const namedRecognizer = 'OfflineRecognizer' in mod ? mod.OfflineRecognizer : undefined
  const namedVad = 'Vad' in mod ? mod.Vad : undefined
  const OfflineRecognizer = namedRecognizer ?? mod.default?.OfflineRecognizer
  const Vad = namedVad ?? mod.default?.Vad
  if (!OfflineRecognizer?.createAsync || !Vad) {
    throw new Error(
      'sherpa-onnx-node: OfflineRecognizer.createAsync and Vad are not available (CJS/ESM interop) — check the installed version',
    )
  }

  const recognizer = await OfflineRecognizer.createAsync({
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

  const vad = new Vad(
    {
      sileroVad: {
        model: vadModelPath,
        threshold: 0.5,
        minSpeechDuration: VAD_MIN_SPEECH_DURATION,
        minSilenceDuration: VAD_MIN_SILENCE_DURATION,
        maxSpeechDuration: VAD_MAX_SPEECH_DURATION,
        windowSize: VAD_WINDOW_SIZE,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
    },
    VAD_BUFFER_SECONDS,
  )

  const audioParts: Float32Array[] = []
  let fedSamples = 0
  let emittedSamples = 0
  let committed = ''
  let decodeChain: Promise<void> = Promise.resolve()

  function appendCommitted(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    committed = committed ? `${committed} ${trimmed}` : trimmed
    onPartial(committed)
  }

  function decodeSegment(samples: Float32Array): Promise<void> {
    const task = decodeChain
      .then(() => {
        const stream = recognizer.createStream()
        stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
        return recognizer.decodeAsync(stream)
      })
      .then((result) => {
        appendCommitted(result.text)
      })
    decodeChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  async function drainSegments(): Promise<void> {
    let pending: Promise<void> | null = null
    while (!vad.isEmpty()) {
      const segment = vad.front()
      if (!segment) break
      vad.pop()
      emittedSamples += segment.samples.length
      pending = decodeSegment(segment.samples)
    }
    if (pending) {
      await pending
    }
  }

  function tailSamples(): Float32Array | null {
    const pending = fedSamples - emittedSamples
    if (pending <= 0) return null
    const out = new Float32Array(pending)
    let offset = pending
    for (let i = audioParts.length - 1; i >= 0 && offset > 0; i--) {
      const part = audioParts[i]!
      const take = Math.min(part.length, offset)
      out.set(part.subarray(part.length - take), offset - take)
      offset -= take
    }
    return out
  }

  return {
    async acceptAudio(chunk: Buffer): Promise<void> {
      const samples = pcmToFloat32(chunk)
      audioParts.push(samples)
      fedSamples += samples.length
      vad.acceptWaveform(samples)
      await drainSegments()
    },
    async finalize(): Promise<string> {
      await decodeChain
      await drainSegments()
      const tail = tailSamples()
      if (tail) {
        const stream = recognizer.createStream()
        stream.acceptWaveform({ samples: tail, sampleRate: SAMPLE_RATE })
        const result = await recognizer.decodeAsync(stream)
        appendCommitted(result.text)
      }
      const text = committed
      audioParts.length = 0
      fedSamples = 0
      emittedSamples = 0
      committed = ''
      return text
    },
    async dispose(): Promise<void> {
      audioParts.length = 0
      fedSamples = 0
      emittedSamples = 0
      committed = ''
      vad.clear()
      decodeChain = Promise.resolve()
    },
  }
}
