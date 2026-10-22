import { describe, it, expect } from 'vitest'
import {
  DENSE_CHARS_PER_TOKEN,
  TOOL_OUTPUT_WINDOW_FRACTION,
  dynamicToolOutputCap,
  truncateToCap,
  truncationMarker,
} from './output-cap.js'

describe('dynamicToolOutputCap', () => {
  it('caps a small window below the static cap (window × 0.25 × 2.4)', () => {
    // 25k window → 25000 × 0.25 × 2.4 = 15000 bytes, below the 100k static cap
    expect(dynamicToolOutputCap(25_000, 100_000)).toBe(15_000)
  })

  it('keeps the static cap when the window is large enough', () => {
    // 200k window → 120000 bytes, above the 100k static cap → static wins
    expect(dynamicToolOutputCap(200_000, 100_000)).toBe(100_000)
  })

  it('uses the dynamic cap when no static cap is given', () => {
    expect(dynamicToolOutputCap(45_000)).toBe(Math.floor(45_000 * TOOL_OUTPUT_WINDOW_FRACTION * DENSE_CHARS_PER_TOKEN))
  })

  it('never returns a negative cap', () => {
    expect(dynamicToolOutputCap(0, 100_000)).toBe(0)
  })
})

describe('truncateToCap', () => {
  it('returns the output unchanged when it fits', () => {
    const r = truncateToCap('hello', 100)
    expect(r.truncated).toBe(false)
    expect(r.output).toBe('hello')
  })

  it('cuts to the cap and appends the guided marker with original size', () => {
    const long = 'x'.repeat(1000)
    const r = truncateToCap(long, 100)
    expect(r.truncated).toBe(true)
    expect(r.output.length).toBeLessThan(long.length)
    expect(r.output).toContain('100 chars of 1000')
    expect(r.output).toContain('narrower scope')
  })

  it('points the marker at the scratch file when a full output path is given', () => {
    const long = 'x'.repeat(1000)
    const path = '/work/.openfox/scratch/run_command-abc123.txt'
    const r = truncateToCap(long, 100, path)
    expect(r.truncated).toBe(true)
    expect(r.output).toContain(path)
    expect(r.output).toContain('re-read that file')
  })

  it('keeps the generic marker when no full output path is given', () => {
    const long = 'x'.repeat(1000)
    const r = truncateToCap(long, 100, undefined)
    expect(r.output).not.toContain('re-read that file')
  })
})

describe('truncationMarker', () => {
  it('includes the scratch path and a re-read hint when provided', () => {
    const path = '/work/.openfox/scratch/read-def456.txt'
    const marker = truncationMarker(500, 5000, path)
    expect(marker).toContain(path)
    expect(marker).toContain('re-read that file')
    expect(marker).toContain('500 chars of 5000')
  })

  it('stays generic without a path', () => {
    const marker = truncationMarker(500, 5000)
    expect(marker).toContain('narrower scope')
    expect(marker).not.toContain('re-read that file')
  })
})
