import { describe, it, expect, vi } from 'vitest'
import {
  selectPrefillSlot,
  computePrefillSnapshot,
  startPrefillProgressPolling,
  estimatePromptTokens,
  fetchKnownTaskIds,
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

describe('selectPrefillSlot with known task ids', () => {
  const taskSlot = (id: number, prompt: number, processed: number, idTask: number): SlotInfo => ({
    id,
    is_processing: true,
    n_prompt_tokens: prompt,
    n_prompt_tokens_processed: processed,
    id_task: idTask,
  })

  it('picks the slot with a fresh task even when two busy slots are size-ambiguous', () => {
    const slots = [taskSlot(0, 40000, 1000, 100), taskSlot(1, 42000, 1000, 101)]
    // Without identity these two are indistinguishable (40k vs 42k, 15% guard).
    expect(selectPrefillSlot(slots, 40000)).toBeNull()
    // Task 100 predates the request → slot 1 (task 101) is ours.
    expect(selectPrefillSlot(slots, 40000, new Set([100]))?.id).toBe(1)
  })

  it('returns null when every busy slot carries a known task', () => {
    const slots = [taskSlot(0, 40000, 1000, 100), taskSlot(1, 42000, 1000, 101)]
    expect(selectPrefillSlot(slots, 40000, new Set([100, 101]))).toBeNull()
  })

  it('disambiguates several fresh tasks with the size heuristic', () => {
    const slots = [taskSlot(0, 40000, 1000, 100), taskSlot(1, 80000, 1000, 101), taskSlot(2, 41000, 1000, 102)]
    // Tasks 101 and 102 are fresh; slot 2 (41k) is closest to 40k.
    expect(selectPrefillSlot(slots, 40000, new Set([100]))?.id).toBe(2)
  })

  it('falls back to the size heuristic when slots do not report id_task', () => {
    const slots = [busySlot(0, 40000, 1000), busySlot(1, 80000, 1000)]
    expect(selectPrefillSlot(slots, 40000, new Set([100]))?.id).toBe(0)
  })

  it('does not adopt a single fresh slot whose size is far from the estimate', () => {
    const slots = [taskSlot(0, 40000, 1000, 100), taskSlot(1, 90000, 2000, 101)]
    expect(selectPrefillSlot(slots, 40000, new Set([100]))).toBeNull()
  })

  it('adopts a single fresh slot whose size is within the tolerance band', () => {
    const slots = [taskSlot(0, 40000, 1000, 100), taskSlot(1, 48000, 2000, 101)]
    expect(selectPrefillSlot(slots, 40000, new Set([100]))?.id).toBe(1)
  })

  it('adopts no fresh slot when all fresh sizes are outside the tolerance band', () => {
    const slots = [taskSlot(0, 40000, 1000, 100), taskSlot(1, 90000, 2000, 101), taskSlot(2, 95000, 2000, 102)]
    expect(selectPrefillSlot(slots, 40000, new Set([100]))).toBeNull()
  })
})

describe('selectPrefillSlot with claimed task ids', () => {
  const taskSlot = (id: number, prompt: number, processed: number, idTask: number): SlotInfo => ({
    id,
    is_processing: true,
    n_prompt_tokens: prompt,
    n_prompt_tokens_processed: processed,
    id_task: idTask,
  })

  it('excludes tasks claimed by other pollers from the fresh set', () => {
    const slots = [taskSlot(0, 41000, 1000, 101), taskSlot(1, 42000, 1000, 102)]
    // Both tasks are fresh, but task 101 is claimed by another poller → slot 1 is ours.
    expect(selectPrefillSlot(slots, 41000, new Set([100]), new Set([101]))?.id).toBe(1)
  })

  it('returns null when the only fresh task is claimed', () => {
    const slots = [taskSlot(0, 40000, 1000, 100), taskSlot(1, 48000, 2000, 101)]
    expect(selectPrefillSlot(slots, 40000, new Set([100]), new Set([101]))).toBeNull()
  })
})

describe('fetchKnownTaskIds', () => {
  it('returns the set of task ids reported by the engine', async () => {
    const fetchImpl = (async () =>
      Response.json([
        { id: 0, is_processing: true, n_prompt_tokens: 100, n_prompt_tokens_processed: 50, id_task: 41 },
        { id: 1, is_processing: false, n_prompt_tokens: 0, n_prompt_tokens_processed: 0, id_task: 42 },
      ])) as unknown as typeof fetch
    const ids = await fetchKnownTaskIds('http://localhost:8080/v1', undefined, fetchImpl)
    expect(ids).toEqual(new Set([41, 42]))
  })

  it('returns null when the /slots endpoint fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    expect(await fetchKnownTaskIds('http://localhost:8080', undefined, fetchImpl)).toBeNull()
  })

  it('returns null when the build does not report id_task', async () => {
    const fetchImpl = (async () =>
      Response.json([
        { id: 0, is_processing: false, n_prompt_tokens: 0, n_prompt_tokens_processed: 0 },
      ])) as unknown as typeof fetch
    expect(await fetchKnownTaskIds('http://localhost:8080', undefined, fetchImpl)).toBeNull()
  })

  it('returns null for a non-array payload', async () => {
    const fetchImpl = (async () => Response.json({ error: 'not found' })) as unknown as typeof fetch
    expect(await fetchKnownTaskIds('http://localhost:8080', undefined, fetchImpl)).toBeNull()
  })

  it('returns null when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    // Mirrors real fetch: an aborted signal rejects the request.
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new Error('aborted')
      return Response.json([
        { id: 0, is_processing: false, n_prompt_tokens: 0, n_prompt_tokens_processed: 0, id_task: 41 },
      ])
    }) as unknown as typeof fetch
    expect(await fetchKnownTaskIds('http://localhost:8080', controller.signal, fetchImpl)).toBeNull()
  })

  it('aborts the /slots fetch through the passed signal', async () => {
    const controller = new AbortController()
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })) as unknown as typeof fetch
    const pending = fetchKnownTaskIds('http://localhost:8080', controller.signal, fetchImpl)
    controller.abort()
    expect(await pending).toBeNull()
  })

  it('gives up on a hung /slots endpoint after the snapshot timeout', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
      })) as unknown as typeof fetch
    const start = Date.now()
    expect(await fetchKnownTaskIds('http://localhost:8080', undefined, fetchImpl)).toBeNull()
    // The snapshot is an optimization, never a blocker for the LLM call.
    expect(Date.now() - start).toBeLessThan(5000)
  })
})

describe('computePrefillSnapshot', () => {
  it('computes percent from processed over the known total', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 20000), 40000, [], Date.now())
    expect(snapshot).toEqual({ promptTokens: 40000, processedTokens: 20000, percent: 50, slotId: 0, cachedTokens: 0 })
  })

  it('ignores the rolling engine total and measures over the known total', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 1536, 1152), 9620, [], Date.now())
    expect(snapshot.promptTokens).toBe(9620)
    expect(snapshot.processedTokens).toBe(1152)
    expect(snapshot.percent).toBe(12)
  })

  it('reports the real prompt size while the engine total is still a rolling window', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 3456, 3070), 34560, [], Date.now())
    expect(snapshot.promptTokens).toBe(34560)
    expect(snapshot.processedTokens).toBe(3070)
    expect(snapshot.percent).toBe(9)
  })

  it('caps percent at 100 and clamps processed to the real work', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 1536, 2000), 1000, [], Date.now())
    // The engine total (1536) exceeds the stale expected size (1000) → the
    // denominator is the engine total, and processed is clamped to it.
    expect(snapshot.processedTokens).toBe(1536)
    expect(snapshot.percent).toBe(100)
  })

  it('measures a warm call over the engine total when the expected size is stale', () => {
    // The expected size tracks the PREVIOUS call's context (1000), while the
    // current request is 5000 tokens with 4000 served from the KV cache: the
    // real work is 1000 uncached tokens, not the collapsed expected - cache.
    const snapshot = computePrefillSnapshot(busySlot(0, 5000, 500, 4000), 1000, [], Date.now())
    expect(snapshot.promptTokens).toBe(5000)
    expect(snapshot.processedTokens).toBe(500)
    expect(snapshot.percent).toBe(50)
    expect(snapshot.cachedTokens).toBe(4000)
  })

  it('falls back to the engine total when no known total is available', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 20000), 0, [], Date.now())
    expect(snapshot).toEqual({ promptTokens: 40000, processedTokens: 20000, percent: 50, slotId: 0, cachedTokens: 0 })
  })

  it('computes percent over the uncached work on a warm prefill', () => {
    const snapshot = computePrefillSnapshot(busySlot(0, 1620, 1152, 8000), 9620, [], Date.now())
    expect(snapshot.promptTokens).toBe(9620)
    expect(snapshot.processedTokens).toBe(1152)
    expect(snapshot.percent).toBe(71)
  })

  it('derives live speed and eta from the delta over the real remaining work', () => {
    const samples = [
      { processedTokens: 6040, at: 1000 },
      { processedTokens: 6140, at: 2000 },
    ]
    const snapshot = computePrefillSnapshot(busySlot(0, 6424, 6140), 34560, samples, 2000)
    expect(snapshot.speedTps).toBe(100)
    expect(snapshot.etaSeconds).toBe(285)
  })

  it('never reports a 0s ETA while work remains', () => {
    const samples = [
      { processedTokens: 39000, at: 1000 },
      { processedTokens: 39900, at: 2000 },
    ]
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 39900), 40000, samples, 2000)
    expect(snapshot.speedTps).toBe(900)
    expect(snapshot.etaSeconds).toBe(1)
  })

  it('carries no speed/eta on the first poll or when nothing advanced', () => {
    expect(computePrefillSnapshot(busySlot(0, 40000, 1000), 40000, [], 1000).speedTps).toBeUndefined()
    const stalled = computePrefillSnapshot(busySlot(0, 40000, 1000), 40000, [{ processedTokens: 1000, at: 1000 }], 2000)
    expect(stalled.speedTps).toBeUndefined()
    expect(stalled.etaSeconds).toBeUndefined()
  })

  it('carries the tracked slot identity and the KV cache split when the engine reports them', () => {
    const snapshot = computePrefillSnapshot(
      {
        id: 1,
        is_processing: true,
        n_prompt_tokens: 40000,
        n_prompt_tokens_processed: 20000,
        n_prompt_tokens_cache: 35000,
        id_task: 15247,
      },
      40000,
      [],
      Date.now(),
    )
    expect(snapshot.slotId).toBe(1)
    expect(snapshot.taskId).toBe(15247)
    expect(snapshot.cachedTokens).toBe(35000)
  })

  it('leaves task id and cache undefined when the engine does not report them', () => {
    const snapshot = computePrefillSnapshot(
      { id: 0, is_processing: true, n_prompt_tokens: 40000, n_prompt_tokens_processed: 20000 },
      40000,
      [],
      Date.now(),
    )
    expect(snapshot.slotId).toBe(0)
    expect(snapshot.taskId).toBeUndefined()
    expect(snapshot.cachedTokens).toBeUndefined()
  })

  it('derives the speed from the oldest sample inside the window only', () => {
    const samples = [
      { processedTokens: 5000, at: 3000 },
      { processedTokens: 8000, at: 4000 },
    ]
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 8000), 40000, samples, 4000)
    expect(snapshot.speedTps).toBe(3000)
  })

  it('ignores samples older than the live-speed window', () => {
    const samples = [
      { processedTokens: 1000, at: 0 },
      { processedTokens: 8000, at: 4000 },
    ]
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 8000), 40000, samples, 4000)
    expect(snapshot.speedTps).toBeUndefined()
  })

  it('follows the recent tranche for the live speed while the average stays cumulative', () => {
    // First observation 4s ago (cumulative average), window baseline 1s ago
    // (live speed): a slow start must not drag the live speed down.
    const first = { processedTokens: 0, at: 0 }
    const samples = [first, { processedTokens: 4000, at: 3000 }, { processedTokens: 8000, at: 4000 }]
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 8000), 40000, samples, 4000, first)
    expect(snapshot.speedTps).toBe(4000)
    expect(snapshot.avgTps).toBe(2000)
  })

  it('computes the cumulative average speed over the work done since the first observation', () => {
    const first = { processedTokens: 0, at: 1000 }
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 10000), 40000, [first], 5000, first)
    expect(snapshot.avgTps).toBe(2500)
  })

  it('ignores the KV-cached head when averaging a warm prefill', () => {
    const first = { processedTokens: 1152, at: 1000 }
    const snapshot = computePrefillSnapshot(busySlot(0, 1620, 2000, 800), 9620, [first], 2000, first)
    expect(snapshot.avgTps).toBe(848)
  })

  it('leaves the average speed undefined before any work is done', () => {
    const first = { processedTokens: 0, at: 1000 }
    const snapshot = computePrefillSnapshot(busySlot(0, 40000, 0), 40000, [first], 5000, first)
    expect(snapshot.avgTps).toBeUndefined()
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
        // The engine total rolls behind the processed count (lagging build).
        return Response.json([busySlot(0, Math.max(0, processed - 384), processed)])
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

  it('tracks the fresh-task slot among two busy slots (identity, not size)', async () => {
    vi.useFakeTimers()
    try {
      let processed = 0
      const fetchImpl = (async () =>
        Response.json([
          { id: 0, is_processing: true, n_prompt_tokens: 40000, n_prompt_tokens_processed: 5000, id_task: 100 },
          {
            id: 1,
            is_processing: true,
            n_prompt_tokens: 41000,
            n_prompt_tokens_processed: (processed += 10250),
            id_task: 101,
          },
        ])) as unknown as typeof fetch
      const onProgress = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1',
        expectedPromptTokens: 41000,
        knownTaskIds: new Set([100]),
        onProgress,
        fetchImpl,
        intervalMs: 100,
      })
      await vi.advanceTimersByTimeAsync(100)
      // Slot 1 (our fresh task) at 10250/41000 = 25% — not slot 0's numbers,
      // even though slot 0's size (40k) is closer to the 41k estimate.
      expect(onProgress).toHaveBeenCalledTimes(1)
      expect(onProgress.mock.calls[0]?.[0].percent).toBe(25)
      expect(onProgress.mock.calls[0]?.[0].processedTokens).toBe(10250)
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

  it('two simultaneous pollers each track their own task (no cross-adoption)', async () => {
    vi.useFakeTimers()
    try {
      const slots = [
        { id: 0, is_processing: true, n_prompt_tokens: 56720, n_prompt_tokens_processed: 1000, id_task: 24 },
        { id: 1, is_processing: true, n_prompt_tokens: 26974, n_prompt_tokens_processed: 500, id_task: 25 },
      ]
      const fetchImpl = (async () => Response.json(slots)) as unknown as typeof fetch
      const known = new Set([23])
      const a = vi.fn()
      const b = vi.fn()
      const stopA = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:9101/v1',
        expectedPromptTokens: 56720,
        knownTaskIds: known,
        onProgress: a,
        fetchImpl,
        intervalMs: 100,
      })
      const stopB = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:9102/v1',
        expectedPromptTokens: 26974,
        knownTaskIds: known,
        onProgress: b,
        fetchImpl,
        intervalMs: 100,
      })
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(100)
      }
      expect(a).toHaveBeenCalledTimes(4)
      expect(b).toHaveBeenCalledTimes(4)
      expect(a.mock.calls[0]?.[0].slotId).toBe(0)
      expect(a.mock.calls[0]?.[0].taskId).toBe(24)
      expect(b.mock.calls[0]?.[0].slotId).toBe(1)
      expect(b.mock.calls[0]?.[0].taskId).toBe(25)
      stopA()
      stopB()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps polling without emitting while only a neighbor task is visible', async () => {
    vi.useFakeTimers()
    try {
      let landed = false
      const fetchImpl = (async () =>
        Response.json(
          landed
            ? [
                {
                  id: 0,
                  is_processing: true,
                  n_prompt_tokens: 56720,
                  n_prompt_tokens_processed: 1000,
                  id_task: 24,
                },
                {
                  id: 1,
                  is_processing: true,
                  n_prompt_tokens: 26974,
                  n_prompt_tokens_processed: 500,
                  id_task: 25,
                },
              ]
            : [
                {
                  id: 0,
                  is_processing: true,
                  n_prompt_tokens: 56720,
                  n_prompt_tokens_processed: 1000,
                  id_task: 24,
                },
                { id: 1, is_processing: false, n_prompt_tokens: 0, n_prompt_tokens_processed: 0, id_task: 23 },
              ],
        )) as unknown as typeof fetch
      const onProgress = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:9103/v1',
        expectedPromptTokens: 26974,
        knownTaskIds: new Set([23]),
        onProgress,
        fetchImpl,
        intervalMs: 100,
      })
      // The own request has not landed yet: the only fresh task (56k) does
      // not match the 26.9k estimate → no adoption, no emission.
      await vi.advanceTimersByTimeAsync(300)
      expect(onProgress).not.toHaveBeenCalled()
      landed = true
      await vi.advanceTimersByTimeAsync(100)
      expect(onProgress).toHaveBeenCalledTimes(1)
      expect(onProgress.mock.calls[0]?.[0].taskId).toBe(25)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the claimed task when the poller stops', async () => {
    vi.useFakeTimers()
    try {
      const slots = [
        { id: 0, is_processing: true, n_prompt_tokens: 56720, n_prompt_tokens_processed: 1000, id_task: 24 },
      ]
      const fetchImpl = (async () => Response.json(slots)) as unknown as typeof fetch
      const known = new Set([23])
      const first = vi.fn()
      const stopFirst = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:9104/v1',
        expectedPromptTokens: 56720,
        knownTaskIds: known,
        onProgress: first,
        fetchImpl,
        intervalMs: 100,
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(first).toHaveBeenCalledTimes(1)
      stopFirst()
      // After the first poller stops, a new poller for the same server can
      // adopt the same task again (the next call of the same session).
      const second = vi.fn()
      const stopSecond = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:9104/v1',
        expectedPromptTokens: 56720,
        knownTaskIds: known,
        onProgress: second,
        fetchImpl,
        intervalMs: 100,
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(second).toHaveBeenCalledTimes(1)
      expect(second.mock.calls[0]?.[0].taskId).toBe(24)
      stopSecond()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the engine-measured result when the tracked slot finishes', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const fetchImpl = (async () => {
        calls += 1
        return Response.json([busySlot(0, 10000, calls === 1 ? 5000 : 10000)])
      }) as unknown as typeof fetch
      const onProgress = vi.fn()
      const onComplete = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1',
        expectedPromptTokens: 10000,
        onProgress,
        onComplete,
        fetchImpl,
        intervalMs: 100,
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(onProgress).toHaveBeenCalledTimes(1)
      expect(onComplete).not.toHaveBeenCalled()

      // The tracked slot left the busy set: the measured result is reported
      // once, with the completion estimated at the midpoint between the last
      // busy sample (t=100) and this poll (t=200).
      await vi.advanceTimersByTimeAsync(100)
      expect(onComplete).toHaveBeenCalledTimes(1)
      expect(onComplete.mock.calls[0]?.[0]).toEqual({ processedTokens: 10000, prefillTimeMs: 150 })
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not report completion for a slot it never tracked', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = (async () => Response.json([busySlot(0, 10000, 10000)])) as unknown as typeof fetch
      const onProgress = vi.fn()
      const onComplete = vi.fn()
      const stop = startPrefillProgressPolling({
        serverBaseUrl: 'http://localhost:8080/v1',
        expectedPromptTokens: 10000,
        onProgress,
        onComplete,
        fetchImpl,
        intervalMs: 100,
      })
      await vi.advanceTimersByTimeAsync(500)
      // A slot already done on the first poll belongs to a neighbor session —
      // it is never tracked, so it never completes.
      expect(onProgress).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
