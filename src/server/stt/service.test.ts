import { describe, it, expect, vi } from 'vitest'
import { SttService } from './service.js'
import type { SttEvent, SttProvider, SttProviderFactory } from './types.js'

function createMockProvider(
  options: {
    finalText?: string
    finalizeError?: Error
  } = {},
): SttProvider & {
  acceptAudio: ReturnType<typeof vi.fn>
  finalize: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
} {
  return {
    acceptAudio: vi.fn(async (chunk: Buffer) => {
      void chunk
    }),
    finalize: vi.fn(async () => {
      if (options.finalizeError) {
        throw options.finalizeError
      }
      return options.finalText ?? ''
    }),
    dispose: vi.fn(async () => {}),
  }
}

function createService(factory: SttProviderFactory): SttService & { events: SttEvent[] } {
  const events: SttEvent[] = []
  const service = new SttService(factory)
  service.subscribe((event) => {
    events.push(event)
  })
  return Object.assign(service, { events })
}

describe('SttService', () => {
  it('starts in off state', () => {
    const service = new SttService(async () => createMockProvider())
    expect(service.getState()).toBe('off')
  })

  it('transitions off -> loading -> listening on start', async () => {
    const provider = createMockProvider()
    const service = createService(async () => provider)
    await service.start()
    expect(service.getState()).toBe('listening')
    const states = service.events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state)
    expect(states).toEqual(['loading', 'listening'])
  })

  it('ignores start while already listening', async () => {
    let factoryCalls = 0
    const service = createService(async () => {
      factoryCalls++
      return createMockProvider()
    })
    await service.start()
    await service.start()
    expect(factoryCalls).toBe(1)
  })

  it('feeds audio to provider while listening', async () => {
    const provider = createMockProvider()
    const service = createService(async () => provider)
    await service.start()
    const chunk = Buffer.from([1, 2, 3, 4])
    await service.feedAudio(chunk)
    expect(provider.acceptAudio).toHaveBeenCalledWith(chunk)
  })

  it('queues audio while loading and flushes it when listening', async () => {
    const provider = createMockProvider()
    let resolveFactory!: (p: SttProvider) => void
    const service = createService(
      () =>
        new Promise((resolve) => {
          resolveFactory = resolve
        }),
    )
    const startPromise = service.start()
    expect(service.getState()).toBe('loading')
    const chunk1 = Buffer.from([1])
    const chunk2 = Buffer.from([2])
    await service.feedAudio(chunk1)
    await service.feedAudio(chunk2)
    resolveFactory(provider)
    await startPromise
    expect(provider.acceptAudio).toHaveBeenCalledTimes(2)
    expect(provider.acceptAudio).toHaveBeenNthCalledWith(1, chunk1)
    expect(provider.acceptAudio).toHaveBeenNthCalledWith(2, chunk2)
  })

  it('ignores audio when off', async () => {
    const provider = createMockProvider()
    const service = createService(async () => provider)
    await service.feedAudio(Buffer.from([1]))
    expect(provider.acceptAudio).not.toHaveBeenCalled()
  })

  it('emits partial events from the provider', async () => {
    const service = createService(async (onPartial) => {
      const provider = createMockProvider()
      return {
        ...provider,
        acceptAudio: vi.fn(async () => {
          onPartial('bonjour')
        }),
      }
    })
    await service.start()
    await service.feedAudio(Buffer.from([1]))
    const partials = service.events.filter((e) => e.type === 'partial')
    expect(partials).toEqual([{ type: 'partial', text: 'bonjour' }])
  })

  it('stop returns final text and emits final then state off', async () => {
    const provider = createMockProvider({ finalText: 'bonjour le monde' })
    const service = createService(async () => provider)
    await service.start()
    const text = await service.stop()
    expect(text).toBe('bonjour le monde')
    expect(service.getState()).toBe('off')
    expect(provider.finalize).toHaveBeenCalledTimes(1)
    expect(provider.dispose).toHaveBeenCalledTimes(1)
    const tail = service.events.slice(-2)
    expect(tail[0]).toEqual({ type: 'final', text: 'bonjour le monde' })
    expect(tail[1]).toEqual({ type: 'state', state: 'off' })
  })

  it('stop when not listening returns empty string', async () => {
    const service = createService(async () => createMockProvider())
    const text = await service.stop()
    expect(text).toBe('')
  })

  it('stop while loading aborts the in-progress start and emits empty final', async () => {
    let resolveFactory!: (p: SttProvider) => void
    const service = createService(
      () =>
        new Promise<SttProvider>((resolve) => {
          resolveFactory = resolve
        }),
    )
    const startPromise = service.start()
    expect(service.getState()).toBe('loading')
    const text = await service.stop()
    expect(text).toBe('')
    expect(service.getState()).toBe('off')
    const finals = service.events.filter((e) => e.type === 'final')
    expect(finals).toEqual([{ type: 'final', text: '' }])
    const provider = createMockProvider()
    resolveFactory(provider)
    await startPromise
    expect(service.getState()).toBe('off')
    expect(provider.dispose).toHaveBeenCalledTimes(1)
    expect(provider.acceptAudio).not.toHaveBeenCalled()
  })

  it('start failure emits error and returns to off', async () => {
    const service = createService(async () => {
      throw new Error('model download failed')
    })
    await service.start()
    expect(service.getState()).toBe('off')
    const errors = service.events.filter((e) => e.type === 'error')
    expect(errors).toEqual([{ type: 'error', message: 'model download failed' }])
  })

  it('stop failure emits error and returns to off', async () => {
    const provider = createMockProvider({ finalizeError: new Error('finalize failed') })
    const service = createService(async () => provider)
    await service.start()
    const text = await service.stop()
    expect(text).toBe('')
    expect(service.getState()).toBe('off')
    expect(provider.dispose).toHaveBeenCalledTimes(1)
    const errors = service.events.filter((e) => e.type === 'error')
    expect(errors).toEqual([{ type: 'error', message: 'finalize failed' }])
  })

  it('unsubscribe removes the listener', () => {
    const listener = vi.fn()
    const service = new SttService(async () => createMockProvider())
    const unsubscribe = service.subscribe(listener)
    unsubscribe()
    service.subscribe((e) => {
      void e
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('dispose clears provider and listeners', async () => {
    const provider = createMockProvider()
    const service = createService(async () => provider)
    await service.start()
    await service.dispose()
    expect(provider.dispose).toHaveBeenCalledTimes(1)
    expect(service.getState()).toBe('off')
  })
})
