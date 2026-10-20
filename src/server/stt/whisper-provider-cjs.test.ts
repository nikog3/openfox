import { describe, it, expect, vi } from 'vitest'

const state = {
  results: ['bonjour le monde'],
}

const mockStream = {
  acceptWaveform: vi.fn(),
}

const mockRecognizer = {
  createStream: vi.fn(() => mockStream),
  decodeAsync: vi.fn(async () => ({ text: state.results.shift() ?? '' })),
}

const OfflineRecognizerMock = {
  createAsync: vi.fn(async () => mockRecognizer),
}

const VadMock = vi.fn(function () {
  return {
    acceptWaveform: vi.fn(),
    isEmpty: vi.fn(() => true),
    front: vi.fn(),
    pop: vi.fn(),
    clear: vi.fn(),
  }
})

vi.mock('sherpa-onnx-node', () => ({
  default: {
    OfflineRecognizer: OfflineRecognizerMock,
    Vad: VadMock,
  },
}))

import { createWhisperProvider } from './whisper-provider.js'

const ENCODER = '/models/base-encoder.int8.onnx'
const DECODER = '/models/base-decoder.int8.onnx'
const TOKENS = '/models/base-tokens.txt'
const VAD = '/models/silero_vad.onnx'

describe('createWhisperProvider (CJS default-only export shape)', () => {
  it('resolves OfflineRecognizer from the default export and transcribes audio', async () => {
    const provider = await createWhisperProvider(ENCODER, DECODER, TOKENS, 'fr', VAD, () => {})
    expect(OfflineRecognizerMock.createAsync).toHaveBeenCalledTimes(1)
    expect(OfflineRecognizerMock.createAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: expect.objectContaining({
          whisper: expect.objectContaining({
            encoder: ENCODER,
            decoder: DECODER,
            language: 'fr',
          }),
        }),
      }),
    )
    const pcm = Buffer.alloc(9600)
    pcm.writeInt16LE(16384, 0)
    await provider.acceptAudio(pcm)
    const text = await provider.finalize()
    expect(text).toBe('bonjour le monde')
  })
})
