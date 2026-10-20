import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = {
  results: [] as string[],
  accepted: [] as Float32Array[],
  decodeCount: 0,
  vadAccepted: [] as Float32Array[],
  vadQueue: [] as { start: number; samples: Float32Array }[],
}

const mockStream = {
  acceptWaveform: vi.fn((obj: { samples: Float32Array }) => {
    state.accepted.push(obj.samples)
  }),
}

const mockRecognizer = {
  createStream: vi.fn(() => mockStream),
  decodeAsync: vi.fn(async () => {
    state.decodeCount++
    return { text: state.results.shift() ?? '' }
  }),
}

const OfflineRecognizerMock = {
  createAsync: vi.fn(async (_config: unknown) => mockRecognizer),
}

const VadMock = vi.fn(function () {
  return {
    acceptWaveform: vi.fn((samples: Float32Array) => {
      state.vadAccepted.push(samples)
    }),
    isEmpty: vi.fn(() => state.vadQueue.length === 0),
    front: vi.fn(() => state.vadQueue[0]),
    pop: vi.fn(() => state.vadQueue.shift()),
    clear: vi.fn(() => {
      state.vadQueue = []
    }),
  }
})

vi.mock('sherpa-onnx-node', () => ({
  OfflineRecognizer: OfflineRecognizerMock,
  Vad: VadMock,
}))

import { createWhisperProvider } from './whisper-provider.js'

const ENCODER = '/models/base-encoder.int8.onnx'
const DECODER = '/models/base-decoder.int8.onnx'
const TOKENS = '/models/base-tokens.txt'
const VAD = '/models/silero_vad.onnx'

function resetState(): void {
  state.results = []
  state.accepted = []
  state.decodeCount = 0
  state.vadAccepted = []
  state.vadQueue = []
  OfflineRecognizerMock.createAsync.mockClear()
  mockRecognizer.createStream.mockClear()
  mockRecognizer.decodeAsync.mockClear()
  VadMock.mockClear()
}

beforeEach(resetState)

function pcmBuffer(sampleCount: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2)
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(1000, i * 2)
  }
  return buf
}

async function makeProvider(onPartial: (text: string) => void = () => {}) {
  return createWhisperProvider(ENCODER, DECODER, TOKENS, 'fr', VAD, onPartial)
}

describe('createWhisperProvider (live VAD + async decode)', () => {
  it('creates the recognizer with the whisper model config', async () => {
    await makeProvider()
    expect(OfflineRecognizerMock.createAsync).toHaveBeenCalledTimes(1)
    expect(OfflineRecognizerMock.createAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: expect.objectContaining({
          whisper: expect.objectContaining({
            encoder: ENCODER,
            decoder: DECODER,
            language: 'fr',
            task: 'transcribe',
          }),
          tokens: TOKENS,
        }),
        decodingMethod: 'greedy_search',
      }),
    )
  })

  it('maps auto language to an empty string', async () => {
    await createWhisperProvider(ENCODER, DECODER, TOKENS, 'auto', VAD, () => {})
    const config = OfflineRecognizerMock.createAsync.mock.calls[0]?.[0] as {
      modelConfig: { whisper: { language: string } }
    }
    expect(config.modelConfig.whisper.language).toBe('')
  })

  it('creates the VAD with dictation tuning and a long buffer', async () => {
    await makeProvider()
    expect(VadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sileroVad: expect.objectContaining({
          model: VAD,
          threshold: 0.5,
          minSpeechDuration: 0.25,
          minSilenceDuration: 0.5,
          maxSpeechDuration: 5,
          windowSize: 512,
        }),
        sampleRate: 16000,
      }),
      300,
    )
  })

  it('feeds 16kHz float32 samples to the VAD', async () => {
    const provider = await makeProvider()
    const pcm = Buffer.alloc(8)
    pcm.writeInt16LE(0, 0)
    pcm.writeInt16LE(16384, 2)
    pcm.writeInt16LE(-16384, 4)
    pcm.writeInt16LE(32767, 6)
    await provider.acceptAudio(pcm)
    expect(state.vadAccepted).toEqual([new Float32Array([0, 0.5, -0.5, 32767 / 32768])])
  })

  it('decodes completed VAD segments and emits partials', async () => {
    const partials: string[] = []
    const provider = await makeProvider((text) => partials.push(text))
    state.results = ['bonjour']
    state.vadQueue = [{ start: 0, samples: new Float32Array(1024) }]
    await provider.acceptAudio(pcmBuffer(1024))
    expect(partials).toEqual(['bonjour'])
    expect(state.decodeCount).toBe(1)
  })

  it('accumulates segment texts with a space between them', async () => {
    const partials: string[] = []
    const provider = await makeProvider((text) => partials.push(text))
    state.results = ['bonjour', 'le monde']
    state.vadQueue = [
      { start: 0, samples: new Float32Array(512) },
      { start: 1024, samples: new Float32Array(512) },
    ]
    await provider.acceptAudio(pcmBuffer(1024))
    expect(partials).toEqual(['bonjour', 'bonjour le monde'])
  })

  it('ignores empty segment results', async () => {
    const partials: string[] = []
    const provider = await makeProvider((text) => partials.push(text))
    state.results = ['   ']
    state.vadQueue = [{ start: 0, samples: new Float32Array(512) }]
    await provider.acceptAudio(pcmBuffer(512))
    expect(partials).toEqual([])
  })

  it('finalize returns the committed text when nothing is pending', async () => {
    const provider = await makeProvider()
    state.results = ['bonjour']
    state.vadQueue = [{ start: 0, samples: new Float32Array(1024) }]
    await provider.acceptAudio(pcmBuffer(1024))
    const text = await provider.finalize()
    expect(text).toBe('bonjour')
    expect(state.decodeCount).toBe(1)
  })

  it('finalize decodes trailing audio not emitted by the VAD', async () => {
    const provider = await makeProvider()
    state.results = ['la queue']
    await provider.acceptAudio(pcmBuffer(4800))
    const text = await provider.finalize()
    expect(text).toBe('la queue')
    const tail = state.accepted[0]
    expect(tail?.length).toBe(4800)
    expect(tail?.[0]).toBeCloseTo(1000 / 32768)
    expect(state.decodeCount).toBe(1)
  })

  it('finalize decodes short trailing utterances the VAD did not emit', async () => {
    const provider = await makeProvider()
    state.results = ['ok']
    await provider.acceptAudio(pcmBuffer(1000))
    const text = await provider.finalize()
    expect(text).toBe('ok')
    expect(state.decodeCount).toBe(1)
  })

  it('finalize returns empty for no audio', async () => {
    const provider = await makeProvider()
    const text = await provider.finalize()
    expect(text).toBe('')
    expect(state.decodeCount).toBe(0)
  })

  it('finalize resets the buffer for the next dictation', async () => {
    const provider = await makeProvider()
    state.results = ['premier']
    await provider.acceptAudio(pcmBuffer(4800))
    expect(await provider.finalize()).toBe('premier')
    state.results = ['second']
    await provider.acceptAudio(pcmBuffer(4800))
    expect(await provider.finalize()).toBe('second')
  })

  it('dispose clears pending audio', async () => {
    const provider = await makeProvider()
    await provider.acceptAudio(pcmBuffer(4800))
    await provider.dispose()
    expect(await provider.finalize()).toBe('')
    expect(state.decodeCount).toBe(0)
  })
})
