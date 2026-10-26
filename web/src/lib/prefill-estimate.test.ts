import { describe, it, expect } from 'vitest'
import { estimatePrefill } from './prefill-estimate'

describe('estimatePrefill', () => {
  it('returns no estimate when no speed is known (first call of a session)', () => {
    expect(estimatePrefill({ contextTokens: 40000, elapsedMs: 500 })).toEqual({})
    expect(estimatePrefill({ contextTokens: 40000, lastPrefillSpeed: 0, elapsedMs: 500 })).toEqual({})
    expect(estimatePrefill({ contextTokens: 40000, lastPrefillSpeed: -5, elapsedMs: 500 })).toEqual({})
  })

  it('projects the full context over the known speed (cold call, no increment)', () => {
    const estimate = estimatePrefill({ contextTokens: 40000, lastPrefillSpeed: 20000, elapsedMs: 1000 })
    // 40000 / 20000 = 2s total, 1s elapsed → 50%, 1s left
    expect(estimate).toEqual({ percent: 50, etaSeconds: 1 })
  })

  it('uses the incremental token count as the work size on a warm cache', () => {
    const estimate = estimatePrefill({
      contextTokens: 40000,
      tokenIncrement: 2000,
      lastPrefillSpeed: 20000,
      elapsedMs: 50,
    })
    // 2000 / 20000 = 0.1s total, 0.05s elapsed → 50%
    expect(estimate.percent).toBe(50)
    expect(estimate.etaSeconds).toBe(0)
  })

  it('caps the increment at the context size', () => {
    const estimate = estimatePrefill({
      contextTokens: 1000,
      tokenIncrement: 5000,
      lastPrefillSpeed: 1000,
      elapsedMs: 500,
    })
    // work = min(5000, 1000) = 1000 → 1s total, 0.5s elapsed → 50%, 0.5s left
    expect(estimate).toEqual({ percent: 50, etaSeconds: 1 })
  })

  it('never reports 100% — the first token is the truth', () => {
    const estimate = estimatePrefill({ contextTokens: 1000, lastPrefillSpeed: 100, elapsedMs: 60000 })
    expect(estimate.percent).toBe(99)
    expect(estimate.etaSeconds).toBe(0)
  })

  it('never reports a negative eta', () => {
    const estimate = estimatePrefill({ contextTokens: 40000, lastPrefillSpeed: 20000, elapsedMs: 10000 })
    expect(estimate.etaSeconds).toBe(0)
  })
})
