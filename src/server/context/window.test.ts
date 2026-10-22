import { describe, it, expect } from 'vitest'
import { UNKNOWN_CONTEXT_WINDOW } from '../../shared/reasoning-effort.js'
import { CONSERVATIVE_CONTEXT_WINDOW, resolveContextWindow } from './window.js'

describe('resolveContextWindow', () => {
  it('returns the user override when nothing is detected (P1 supreme)', () => {
    const r = resolveContextWindow(25_000, undefined)
    expect(r.window).toBe(25_000)
    expect(r.source).toBe('override')
    expect(r.loweredToDetected).toBe(false)
  })

  it('never RAISES the override when detection is larger', () => {
    const r = resolveContextWindow(25_000, 45_000)
    expect(r.window).toBe(25_000)
    expect(r.source).toBe('override')
    expect(r.loweredToDetected).toBe(false)
  })

  it('lowers the override to a smaller detected window (min downward) and flags it', () => {
    const r = resolveContextWindow(45_000, 25_000)
    expect(r.window).toBe(25_000)
    expect(r.loweredToDetected).toBe(true)
  })

  it('uses the detected window when there is no override (P2)', () => {
    const r = resolveContextWindow(undefined, 131_072)
    expect(r.window).toBe(131_072)
    expect(r.source).toBe('backend')
    expect(r.loweredToDetected).toBe(false)
  })

  it('falls back to the conservative default when nothing is known (P4)', () => {
    const r = resolveContextWindow(undefined, undefined)
    expect(r.window).toBe(CONSERVATIVE_CONTEXT_WINDOW)
    expect(r.source).toBe('default')
  })

  it('treats the unknown placeholder as unset, never as a real window', () => {
    expect(resolveContextWindow(UNKNOWN_CONTEXT_WINDOW, undefined).window).toBe(CONSERVATIVE_CONTEXT_WINDOW)
    expect(resolveContextWindow(undefined, UNKNOWN_CONTEXT_WINDOW).window).toBe(CONSERVATIVE_CONTEXT_WINDOW)
    expect(resolveContextWindow(UNKNOWN_CONTEXT_WINDOW, UNKNOWN_CONTEXT_WINDOW).source).toBe('default')
  })

  it('prefers a real detection over the placeholder stored value', () => {
    const r = resolveContextWindow(UNKNOWN_CONTEXT_WINDOW, 45_000)
    expect(r.window).toBe(45_000)
    expect(r.source).toBe('backend')
  })
})
