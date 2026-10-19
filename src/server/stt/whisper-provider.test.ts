import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  recognizedText: 'bonjour le monde',
  accepted: [] as { samples: Float32Array; sampleRate: number }[],
  decodeCount: 0,
  streamCount: 0,
}

const mockStream = {
  acceptWaveform: vi.fn((obj: { samples: Float32Array; sampleRate: number }) => {
    state.accepted.push(obj)
  }),
}

const mockRecognizer = {
  createStream: vi.fn(() => {
    state.streamCount++
    return mockStream
  }),
  decode: vi.fn(() => {
    state.decodeCount++
  }),
  getResult: vi.fn(() => ({ text: state.recognizedText })),
}

const OfflineRecognizerMock = vi.fn(function (this: unknown) {
  return mockRecognizer
})

vi.mock('sherpa-onnx-node', () => ({
  OfflineRecognizer: OfflineRecognizerMock,
}))

import { createWhisperProvider } from './whisper-provider.js'

const ENCODER = '/models/base-encoder.int8.onnx'
const DECODER = '/models/base-decoder.int8.onnx'
const TOKENS = '/models/base-tokens.txt'

describe('createWhisperProvider', () => {
  beforeEach(() => {
    state.recognizedText = 'bonjour le monde'
    state.accepted = []
    state.decodeCount = 0
    state.streamCount = 0
    vi.clearAllMocks()
  })

  it('creates the offline recognizer with the whisper model config', async () => {
    await createWhisperProvider(ENCODER, DECODER, TOKENS, 'fr', () => {})
    expect(OfflineRecognizerMock).toHaveBeenCalledWith({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: {
          encoder: ENCODER,
          decoder: DECODER,
          language: 'fr',
          task: 'transcribe',
          tailPaddings: -1,
        },
        tokens: TOKENS,
        numThreads: 4,
      },
      decodingMethod: 'greedy_search',
    })
  })

  it('maps the auto language to an empty string for auto-detection', async () => {
    await createWhisperProvider(ENCODER, DECODER, TOKENS, 'auto', () => {})
    expect(OfflineRecognizerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: expect.objectContaining({
          whisper: expect.objectContaining({ language: '' }),
        }),
      }),
    )
  })

  it('finalize converts PCM to float32 samples and returns trimmed text', async () => {
    const provider = await createWhisperProvider(ENCODER, DECODER, TOKENS, 'fr', () => {})
    const pcm = Buffer.alloc(8)
    pcm.writeInt16LE(0, 0)
    pcm.writeInt16LE(16384, 2)
    pcm.writeInt16LE(-16384, 4)
    pcm.writeInt16LE(32767, 6)
    await provider.acceptAudio(pcm)
    state.recognizedText = '  bonjour le monde  '
    const text = await provider.finalize()
    expect(text).toBe('bonjour le monde')
    expect(state.decodeCount).toBe(1)
    expect(state.accepted).toHaveLength(1)
    expect(state.accepted[0]?.sampleRate).toBe(16000)
    expect(Array.from(state.accepted[0]?.samples ?? [])).toEqual([0, 0.5, -0.5, 32767 / 32768])
  })

  it('finalize returns empty string without decoding when no audio was fed', async () => {
    const provider = await createWhisperProvider(ENCODER, DECODER, TOKENS, 'fr', () => {})
    const text = await provider.finalize()
    expect(text).toBe('')
    expect(state.decodeCount).toBe(0)
    expect(state.streamCount).toBe(0)
  })

  it('finalize drops previous audio after each call', async () => {
    const provider = await createWhisperProvider(ENCODER, DECODER, TOKENS, 'fr', () => {})
    await provider.acceptAudio(Buffer.alloc(4))
    await provider.finalize()
    state.accepted.length = 0
    await provider.acceptAudio(Buffer.alloc(4))
    await provider.finalize()
    expect(state.accepted).toHaveLength(1)
  })

  it('dispose clears pending audio', async () => {
    const provider = await createWhisperProvider(ENCODER, DECODER, TOKENS, 'fr', () => {})
    await provider.acceptAudio(Buffer.alloc(4))
    await provider.dispose()
    const text = await provider.finalize()
    expect(text).toBe('')
    expect(state.decodeCount).toBe(0)
  })
})
