import { describe, it, expect, vi } from 'vitest'
import {
  selectPrefillSlot,
  computePrefillSnapshot,
  startPrefillProgressPolling,
  estimatePromptTokens,
  type SlotInfo,
} from './prefill-progress.js'

const busySlot = (id: number, prompt: number, processed: number, cache = 0): SlotInfo => ({
  id,
  is_processing: true,
  n_prompt_tokens: prompt,
  n_prompt_tokens_processed: processed,
  n_prompt_tokens_cache: cache,
})

describe('estimatePromptTokens', () => {
  it('returns 0 for an empty prompt', () => {
    expect(estimatePromptTokens([])).toBe(0)
  })

  it('estimates from message content at ~4 chars per token', () => {
    expect(estimatePromptTokens([{ role: 'user', content: 'a'.repeat(400) }])).toBe(100)
  })

  it('includes the system prompt', () => {
    const withSystem = estimatePromptTokens([{ role: 'user', content: 'a'.repeat(400) }], 'b'.repeat(800))
    expect(withSystem).toBe(300)
  })

  it('includes thinking content and tool calls', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'c'.repeat(40),
        thinkingContent: 'd'.repeat(40),
        toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'e'.repeat(80) } }],
      },
    ]
    // 40 + 40 + (name 9 + JSON 91) = 180 chars -> 45 tokens
    expect(estimatePromptTokens(messages)).toBe(45)
  })

  it('rounds up fractional tokens', () => {
    expect(estimatePromptTokens([{ role: 'user', content: 'x'.repeat(1) }])).toBe(1)
  })
})

describe('selectPrefillSlot', () => {
  it('returns null when no slot is busy', () => {
    const slots = [
      { id: 0, is_processing: false, n_prompt_tokens: 40000, n_prompt_tokens_processed: 0 },
      { id: 1, is_processing: true, n_prompt_tokens: 40000, n_prompt_tokens_processed: 40000 },
    ]
    expect(selectPrefillSlot(slots, 40000)).toBeNull()
  })

  it('returns the single busy slot', () => {
    const slots = [busySlot(0, 40000, 1000), busySlot(1, 40000, 40000)]
    expect(selectPrefillSlot(slots, 40000)?.id).toBe(0)
  })

  it('picks the busy slot closest to the expected prompt size', () => {
    const slots = [busySlot(0, 40000, 1000), busySlot(1, 80000, 1000)]
    expect(selectPrefillSlot(slots, 40000)?.id).toBe(0)
    expect(selectPrefillSlot(slots, 80000)?.id).toBe(1)
  })

  it('returns null when two busy slots are indistinguishable (ambiguity guard)', () => {
    const slots = [busySlot(0, 40000, 1000), busySlot(1, 42000, 1000)]
    expect(selectPrefillSlot(slots, 40000)).toBeNull()
  })

  it('keeps a slot busy while its rolling engine total lags the known total', () => {
    const slots = [busySlot(0, 1536, 1152)]
    expect(selectPrefillSlot(slots, 9620)?.id).toBe(0)
  })

  it('treats a slot as done when processed reaches the known total even if the engine total lags', () => {
    const slots = [busySlot(0, 9216, 9620)]
    expect(selectPrefillSlot(slots, 9620)).toBeNull()
  })

  it('treats a KV-cached warm slot as busy when the cache does not cover the prompt', () => {
    const slots = [busySlot(0, 2464, 0, 2460)]
    expect(selectPrefillSlot(slots, 2464)?.id).toBe(0)
  })

  it('treats a fully-cached slot as done (not busy)', () => {
    const slots = [busySlot(0, 2464, 0, 2464)]
    expect(selectPrefillSlot(slots, 2464)).toBeNull()
  })
})

describe('computePrefillSnapshot', () => {
  it('computes percent from processed over the known total', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 20000), 40000, undefined, Date.now())
    expect(snapshot).toEqual({ promptTokens: 40000, processedTokens: 20000, percent: 50 })
  })

  it('ignores the rolling engine total and measures over the known total', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 1536, 1152), 9620, undefined, Date.now())
    expect(snapshot.promptTokens).toBe(9620)
    expect(snapshot.processedTokens).toBe(1152)
    expect(snapshot.percent).toBe(12)
  })

  it('reports the real prompt size while the engine total is still a rolling window', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 3456, 3070), 34560, undefined, Date.now())
    expect(snapshot.promptTokens).toBe(34560)
    expect(snapshot.processedTokens).toBe(3070)
    expect(snapshot.percent).toBe(9)
  })

  it('caps percent at 100 and clamps processed to the known work', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 1536, 2000), 1000, undefined, Date.now())
    expect(snapshot.processedTokens).toBe(1000)
    expect(snapshot.percent).toBe(100)
  })

  it('falls back to the engine total when no known total is available', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 20000), 0, undefined, Date.now())
    expect(snapshot).toEqual({ promptTokens: 40000, processedTokens: 20000, percent: 50 })
  })

  it('computes percent over the uncached work on a warm prefill', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 1620, 1152, 8000), 9620, undefined, Date.now())
    expect(snapshot.promptTokens).toBe(9620)
    expect(snapshot.processedTokens).toBe(1152)
    expect(snapshot.percent).toBe(71)
  })

  it('derives live speed and eta from the delta over the real remaining work', () => {
    const prev = { processedTokens: 6040, at: 1000 }
    const snapshot = computePrefillSnapshot(busySlot(0, 6424, 6140), 34560, prev, 2000)
    expect(snapshot.speedTps).toBe(100)
    expect(snapshot.etaSeconds).toBe(285)
  })

  it('never reports a 0s ETA while work remains', () => {
    const prev = { processedTokens: 39000, at: 1000 }
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 39900), 40000, prev, 2000)
    expect(snapshot.speedTps).toBe(900)
    expect(snapshot.etaSeconds).toBe(1)
  })

  it('carries no speed/eta on the first poll or when nothing advanced', () => {
    expect(computePrefillSnapshot(busySlot(0, 40000, 1000), 40000, undefined, 1000).speedTps).toBeUndefined()
    const stalled = computePrefillSnapshot(busySlot(0, 40000, 1000), 40000, { processedTokens: 1000, at: 1000 }, 2000)
    expect(stalled.speedTps).toBeUndefined()
    expect(stalled.etaSeconds).toBeUndefined()
  })
})

describe('startPrefillProgressPolling', () => {
  it('emits progress snapshots while the slot advances and stops at completion', async () => {
    vi.useFakeTimers()
    try {
      let processed = 0
      const fetchImpl = (async () =>
        Response.json([busySlot(0, 40000, (processed += 10000))])) as unknown as typeof fetch
      const onProgress = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1',
        expectedPromptTokens: 40000,
        onProgress,
        fetchImpl,
        intervalMs: 100,
      })

      await vi.advanceTimersByTimeAsync(100)
      expect(onProgress).toHaveBeenCalledTimes(1)
      expect(onProgress.mock.calls[0]?.[0].percent).toBe(25)

      await vi.advanceTimersByTimeAsync(100)
      expect(onProgress).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(100)
      expect(onProgress).toHaveBeenCalledTimes(3)

      // Prefill complete: the slot leaves the busy set, no further snapshots
      // are emitted — the agent loop stops the poller on the first token.
      await vi.advanceTimersByTimeAsync(1000)
      expect(onProgress).toHaveBeenCalledTimes(3)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('measures progress over the known total while the engine total rolls', async () => {
    vi.useFakeTimers()
    try {
      let processed = 0
      const fetchImpl = (async () => {
        processed += 2405
        return Response.json([busySlot(0, processed + 384, processed)])
      }) as unknown as typeof fetch
      const onProgress = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1',
        expectedPromptTokens: 9620,
        onProgress,
        fetchImpl,
        intervalMs: 100,
      })

      for (let i = 1; i <= 3; i++) {
        await vi.advanceTimersByTimeAsync(100)
        expect(onProgress).toHaveBeenCalledTimes(i)
        expect(onProgress.mock.calls[i - 1]?.[0].promptTokens).toBe(9620)
      }
      expect(onProgress.mock.calls[0]?.[0].percent).toBe(25)
      expect(onProgress.mock.calls[1]?.[0].percent).toBe(50)
      expect(onProgress.mock.calls[2]?.[0].percent).toBe(75)

      // Work done (processed >= known total): the slot leaves the busy set,
      // no further snapshots — the agent loop stops the poller on the first
      // token.
      await vi.advanceTimersByTimeAsync(1000)
      expect(onProgress).toHaveBeenCalledTimes(3)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits nothing for a fully-cached warm slot (prefill is done without compute)', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = (async () => Response.json([busySlot(0, 2464, 0, 2464)])) as unknown as typeof fetch
      const onProgress = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1',
        expectedPromptTokens: 2464,
        onProgress,
        fetchImpl,
        intervalMs: 100,
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(onProgress).not.toHaveBeenCalled()
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tracks a warm prefill over the uncached remainder and stops when the work is done', async () => {
    vi.useFakeTimers()
    try {
      let processed = 0
      const fetchImpl = (async () =>
        Response.json([busySlot(0, 87442, (processed += 650), 86142)])) as unknown as typeof fetch
      const onProgress = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1',
        expectedPromptTokens: 87442,
        onProgress,
        fetchImpl,
        intervalMs: 100,
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(onProgress).toHaveBeenCalledTimes(1)
      expect(onProgress.mock.calls[0]?.[0].percent).toBe(50)

      // Work done (processed >= total - cache): the slot leaves the busy
      // set, no further snapshots — the agent loop stops the poller on
      // the first token.
      await vi.advanceTimersByTimeAsync(500)
      expect(onProgress).toHaveBeenCalledTimes(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('requests the /slots endpoint on the version-stripped server root', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () => Response.json([busySlot(0, 40000, 40000)])) as unknown as typeof fetch
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1/',
        expectedPromptTokens: 40000,
        onProgress: () => {},
        fetchImpl,
        intervalMs: 100,
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8080/slots', expect.anything())
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits nothing when the ambiguity guard triggers', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = (async () =>
        Response.json([busySlot(0, 40000, 1000), busySlot(1, 41000, 1000)])) as unknown as typeof fetch
      const onProgress = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1',
        expectedPromptTokens: 40000,
        onProgress,
        fetchImpl,
        intervalMs: 100,
      })
      await vi.advanceTimersByTimeAsync(300)
      expect(onProgress).not.toHaveBeenCalled()
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops after consecutive poll failures (silent degradation)', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch
      const onProgress = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1',
        expectedPromptTokens: 40000,
        onProgress,
        fetchImpl,
        intervalMs: 100,
        maxConsecutiveFailures: 3,
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(onProgress).not.toHaveBeenCalled()
      expect(fetchImpl).toHaveBeenCalledTimes(3)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops immediately on abort', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const fetchImpl = (async () => Response.json([busySlot(0, 40000, 1000)])) as unknown as typeof fetch
      const onProgress = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1',
        expectedPromptTokens: 40000,
        onProgress,
        fetchImpl,
        intervalMs: 100,
        signal: controller.signal,
      })
      controller.abort()
      stop()
      await vi.advanceTimersByTimeAsync(500)
      expect(onProgress).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
