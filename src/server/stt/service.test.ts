import { describe, it, expect, vi } from 'vitest'
import { SttService } from './service.js'
import type { SttEvent, SttProvider, SttProviderFactory, SttProviderHooks } from './types.js'

function createMockProvider(
  options: {
    finalText?: string
    finalizeError?: Error
  } = {},
): SttProvider & {
  acceptAudio: ReturnType<typeof vi.fn>
  finalize: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
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
    reset: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  }
}

function createFactory(createImpl: (hooks: SttProviderHooks) => Promise<SttProvider>, key = 'a'): SttProviderFactory {
  return {
    configKey: () => key,
    create: createImpl,
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
    const service = new SttService(createFactory(async () => createMockProvider()))
    expect(service.getState()).toBe('off')
  })

  it('transitions off -> loading -> listening on start', async () => {
    const provider = createMockProvider()
    const service = createService(createFactory(async () => provider))
    await service.start()
    expect(service.getState()).toBe('listening')
    const states = service.events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state)
    expect(states).toEqual(['loading', 'listening'])
  })

  it('ignores start while already listening', async () => {
    let factoryCalls = 0
    const service = createService(
      createFactory(async () => {
        factoryCalls++
        return createMockProvider()
      }),
    )
    await service.start()
    await service.start()
    expect(factoryCalls).toBe(1)
  })

  it('feeds audio to provider while listening', async () => {
    const provider = createMockProvider()
    const service = createService(createFactory(async () => provider))
    await service.start()
    const chunk = Buffer.from([1, 2, 3, 4])
    await service.feedAudio(chunk)
    expect(provider.acceptAudio).toHaveBeenCalledWith(chunk)
  })

  it('queues audio while loading and flushes it when listening', async () => {
    const provider = createMockProvider()
    let resolveFactory!: (p: SttProvider) => void
    const service = createService(
      createFactory(
        () =>
          new Promise((resolve) => {
            resolveFactory = resolve
          }),
      ),
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
    const service = createService(createFactory(async () => provider))
    await service.feedAudio(Buffer.from([1]))
    expect(provider.acceptAudio).not.toHaveBeenCalled()
  })

  it('emits partial events from the provider', async () => {
    const service = createService(
      createFactory(async (hooks) => {
        const provider = createMockProvider()
        return {
          ...provider,
          acceptAudio: vi.fn(async () => {
            hooks.onPartial('bonjour')
          }),
        }
      }),
    )
    await service.start()
    await service.feedAudio(Buffer.from([1]))
    const partials = service.events.filter((e) => e.type === 'partial')
    expect(partials).toEqual([{ type: 'partial', text: 'bonjour' }])
  })

  it('emits activity and progress events from the provider', async () => {
    const service = createService(
      createFactory(async (hooks) => {
        const provider = createMockProvider()
        return {
          ...provider,
          acceptAudio: vi.fn(async () => {
            hooks.onActivity(true)
            hooks.onProgress(42)
          }),
        }
      }),
    )
    await service.start()
    await service.feedAudio(Buffer.from([1]))
    expect(service.events).toContainEqual({ type: 'activity', speaking: true })
    expect(service.events).toContainEqual({ type: 'progress', percent: 42, phase: 'model' })
  })

  it('emits init and ready phase progress events around provider creation', async () => {
    const service = createService(createFactory(async () => createMockProvider()))
    await service.start()
    const progress = service.events.filter((e) => e.type === 'progress')
    expect(progress).toEqual([
      { type: 'progress', percent: null, phase: 'init' },
      { type: 'progress', percent: null, phase: 'ready' },
    ])
  })

  it('can start again after a cancelled load', async () => {
    let calls = 0
    let resolveFirst!: (p: SttProvider) => void
    const service = createService({
      configKey: () => 'a',
      create: async () => {
        calls++
        if (calls === 1) {
          return new Promise<SttProvider>((resolve) => {
            resolveFirst = resolve
          })
        }
        return createMockProvider()
      },
    })
    const startPromise = service.start()
    await service.stop()
    expect(service.getState()).toBe('off')
    resolveFirst(createMockProvider())
    await startPromise
    expect(service.getState()).toBe('off')
    await service.start()
    expect(service.getState()).toBe('listening')
  })

  it('dispose while loading cancels the in-progress start and disposes the provider', async () => {
    let resolveFactory!: (p: SttProvider) => void
    const service = createService(
      createFactory(
        () =>
          new Promise<SttProvider>((resolve) => {
            resolveFactory = resolve
          }),
      ),
    )
    const startPromise = service.start()
    expect(service.getState()).toBe('loading')
    await service.dispose()
    expect(service.getState()).toBe('off')
    const provider = createMockProvider()
    resolveFactory(provider)
    await startPromise
    expect(service.getState()).toBe('off')
    expect(provider.dispose).toHaveBeenCalledTimes(1)
  })

  it('stop returns final text, emits final then state off, and keeps the provider warm', async () => {
    const provider = createMockProvider({ finalText: 'bonjour le monde' })
    const service = createService(createFactory(async () => provider))
    await service.start()
    const text = await service.stop()
    expect(text).toBe('bonjour le monde')
    expect(service.getState()).toBe('off')
    expect(provider.finalize).toHaveBeenCalledTimes(1)
    expect(provider.dispose).not.toHaveBeenCalled()
    const tail = service.events.slice(-2)
    expect(tail[0]).toEqual({ type: 'final', text: 'bonjour le monde' })
    expect(tail[1]).toEqual({ type: 'state', state: 'off' })
  })

  it('stop when not listening returns empty string', async () => {
    const service = createService(createFactory(async () => createMockProvider()))
    const text = await service.stop()
    expect(text).toBe('')
  })

  it('stop while loading aborts the in-progress start and emits empty final', async () => {
    let resolveFactory!: (p: SttProvider) => void
    const service = createService(
      createFactory(
        () =>
          new Promise<SttProvider>((resolve) => {
            resolveFactory = resolve
          }),
      ),
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

  it('reuses the warm provider when the config is unchanged', async () => {
    let createCalls = 0
    let provider = createMockProvider()
    const service = createService(
      createFactory(async () => {
        createCalls++
        return provider
      }),
    )
    await service.start()
    await service.stop()
    await service.start()
    expect(createCalls).toBe(1)
    expect(provider.reset).toHaveBeenCalledTimes(1)
    expect(provider.dispose).not.toHaveBeenCalled()
    expect(service.getState()).toBe('listening')
  })

  it('disposes the old provider when the config changes', async () => {
    let key = 'a'
    let createCalls = 0
    const providers: SttProvider[] = []
    const service = createService({
      configKey: () => key,
      create: async () => {
        createCalls++
        const p = createMockProvider()
        providers.push(p)
        return p
      },
    })
    await service.start()
    await service.stop()
    key = 'b'
    await service.start()
    expect(createCalls).toBe(2)
    expect(providers).toHaveLength(2)
    expect(providers[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(service.getState()).toBe('listening')
  })

  it('start failure emits error and returns to off', async () => {
    const service = createService(
      createFactory(async () => {
        throw new Error('model download failed')
      }),
    )
    await service.start()
    expect(service.getState()).toBe('off')
    const errors = service.events.filter((e) => e.type === 'error')
    expect(errors).toEqual([{ type: 'error', message: 'model download failed' }])
  })

  it('stop failure emits error, disposes the provider, and returns to off', async () => {
    const provider = createMockProvider({ finalizeError: new Error('finalize failed') })
    const service = createService(createFactory(async () => provider))
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
    const service = new SttService(createFactory(async () => createMockProvider()))
    const unsubscribe = service.subscribe(listener)
    unsubscribe()
    service.subscribe((e) => {
      void e
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('dispose clears provider and listeners', async () => {
    const provider = createMockProvider()
    const service = createService(createFactory(async () => provider))
    await service.start()
    await service.dispose()
    expect(provider.dispose).toHaveBeenCalledTimes(1)
    expect(service.getState()).toBe('off')
  })
})
