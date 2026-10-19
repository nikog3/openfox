import { describe, it, expect, vi } from 'vitest'

const state = {
  recognizedText: 'bonjour le monde',
}

const mockStream = {
  acceptWaveform: vi.fn(),
}

const mockRecognizer = {
  createStream: vi.fn(() => mockStream),
  decode: vi.fn(),
  getResult: vi.fn(() => ({ text: state.recognizedText })),
}

const OfflineRecognizerMock = vi.fn(function (this: unknown) {
  return mockRecognizer
})

vi.mock('sherpa-onnx-node', () => ({
  default: {
    OfflineRecognizer: OfflineRecognizerMock,
  },
}))

import { createWhisperProvider } from './whisper-provider.js'

const ENCODER = '/models/base-encoder.int8.onnx'
const DECODER = '/models/base-decoder.int8.onnx'
const TOKENS = '/models/base-tokens.txt'

describe('createWhisperProvider (CJS default-only export shape)', () => {
  it('resolves OfflineRecognizer from the default export and transcribes audio', async () => {
    const provider = await createWhisperProvider(ENCODER, DECODER, TOKENS, 'fr', () => {})
    expect(OfflineRecognizerMock).toHaveBeenCalledTimes(1)
    expect(OfflineRecognizerMock).toHaveBeenCalledWith(
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
    const pcm = Buffer.alloc(4)
    pcm.writeInt16LE(16384, 0)
    pcm.writeInt16LE(-16384, 2)
    await provider.acceptAudio(pcm)
    state.recognizedText = '  bonjour le monde  '
    const text = await provider.finalize()
    expect(text).toBe('bonjour le monde')
  })
})
