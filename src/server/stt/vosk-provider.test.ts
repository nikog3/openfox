import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  acceptReturns: [] as boolean[],
  partialResults: [] as string[],
  segmentResults: [] as string[],
  finalText: 'bonjour le monde',
  freedRecognizer: 0,
  freedModel: 0,
}

const mockRecognizer = {
  acceptWaveform: vi.fn(async () => state.acceptReturns.shift() ?? false),
  getPartialResult: vi.fn(() => ({ partial: state.partialResults.shift() ?? '' })),
  getResult: vi.fn(() => ({ text: state.segmentResults.shift() ?? '' })),
  getFinalResult: vi.fn(() => ({ text: state.finalText })),
  free: vi.fn(() => {
    state.freedRecognizer++
  }),
}

const mockModel = {
  createRecognizer: vi.fn(() => mockRecognizer),
  free: vi.fn(() => {
    state.freedModel++
  }),
}

vi.mock('voskify', () => ({
  VoskModel: vi.fn(function (this: unknown) {
    return mockModel
  }),
}))

import { createVoskProvider } from './vosk-provider.js'

describe('createVoskProvider', () => {
  beforeEach(() => {
    state.acceptReturns = []
    state.partialResults = []
    state.segmentResults = []
    state.finalText = 'bonjour le monde'
    state.freedRecognizer = 0
    state.freedModel = 0
    vi.clearAllMocks()
  })

  it('loads the model and creates a recognizer', async () => {
    const provider = await createVoskProvider('/fake/model', () => {})
    expect(provider).toBeDefined()
    expect(mockModel.createRecognizer).toHaveBeenCalledTimes(1)
  })

  it('emits cumulative partial results across chunks', async () => {
    const partials: string[] = []
    const provider = await createVoskProvider('/fake/model', (t) => partials.push(t))
    state.acceptReturns = [false, false, false]
    state.partialResults = ['bonjour', 'bonjour le', 'bonjour le monde']
    await provider.acceptAudio(Buffer.from([1, 2, 3]))
    await provider.acceptAudio(Buffer.from([4, 5]))
    await provider.acceptAudio(Buffer.from([6, 7]))
    expect(partials).toEqual(['bonjour', 'bonjour le', 'bonjour le monde'])
  })

  it('accumulates committed segments when acceptWaveform finalizes', async () => {
    const partials: string[] = []
    const provider = await createVoskProvider('/fake/model', (t) => partials.push(t))
    state.acceptReturns = [true, false]
    state.segmentResults = ['premier segment']
    state.partialResults = ['deuxième']
    state.finalText = 'deuxième'
    await provider.acceptAudio(Buffer.from([1]))
    await provider.acceptAudio(Buffer.from([2]))
    expect(partials).toEqual(['premier segment deuxième'])
    const text = await provider.finalize()
    expect(text).toBe('premier segment deuxième')
  })

  it('finalize returns full text and frees resources', async () => {
    const provider = await createVoskProvider('/fake/model', () => {})
    state.acceptReturns = [false]
    state.partialResults = ['bonjour']
    await provider.acceptAudio(Buffer.from([1]))
    const text = await provider.finalize()
    expect(text).toBe('bonjour le monde')
    expect(state.freedRecognizer).toBe(1)
    expect(state.freedModel).toBe(1)
  })

  it('finalize returns empty string when nothing recognized', async () => {
    const provider = await createVoskProvider('/fake/model', () => {})
    state.finalText = '   '
    const text = await provider.finalize()
    expect(text).toBe('')
  })

  it('does not emit empty partials', async () => {
    const partials: string[] = []
    const provider = await createVoskProvider('/fake/model', (t) => partials.push(t))
    state.acceptReturns = [false]
    state.partialResults = ['   ']
    await provider.acceptAudio(Buffer.from([1]))
    expect(partials).toEqual([])
  })

  it('dispose frees resources', async () => {
    const provider = await createVoskProvider('/fake/model', () => {})
    await provider.dispose()
    expect(state.freedRecognizer).toBe(1)
    expect(state.freedModel).toBe(1)
  })
})
