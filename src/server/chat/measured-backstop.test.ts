import { describe, it, expect, vi } from 'vitest'
import {
  applyMeasuredBackstop,
  computeMaxTokens,
  measureToolMessages,
  OUTPUT_RESERVE_TOKENS,
  MAX_BACKSTOP_ITERATIONS,
} from './measured-backstop.js'
import { DENSE_CHARS_PER_TOKEN } from '../tools/output-cap.js'

describe('computeMaxTokens (hard invariant)', () => {
  it('is window - measured_prompt - 2048', () => {
    expect(computeMaxTokens(45_000, 12_000)).toBe(45_000 - 12_000 - 2048)
  })
  it('floors at 256 when the prompt leaves little room', () => {
    expect(computeMaxTokens(45_000, 44_000)).toBe(256)
  })
  it('floors at 256 even when the prompt exceeds the window', () => {
    expect(computeMaxTokens(25_000, 30_000)).toBe(256)
  })
})

describe('measureToolMessages (dense 2.4 fallback, not 4)', () => {
  it('uses the dense 2.4 ratio when there is no tokenizer', async () => {
    // 240 chars → ceil(240 / 2.4) = 100 tokens, + 16 framing overhead
    expect(await measureToolMessages([{ content: 'x'.repeat(240) }])).toBe(100 + 16)
  })
  it('is denser than the chars/4 budget estimate', () => {
    expect(DENSE_CHARS_PER_TOKEN).toBeLessThan(4)
  })
  it('uses the backend tokenizer when available', async () => {
    const tokenize = vi.fn(async () => 7)
    expect(await measureToolMessages([{ content: 'x'.repeat(240) }], tokenize)).toBe(7 + 16)
    expect(tokenize).toHaveBeenCalledWith('x'.repeat(240), undefined)
  })
  it('falls back to the dense ratio when the tokenizer returns null', async () => {
    const tokenize = vi.fn(async () => null)
    expect(await measureToolMessages([{ content: 'x'.repeat(240) }], tokenize)).toBe(100 + 16)
  })
})

describe('applyMeasuredBackstop', () => {
  it('does not truncate when the prompt already fits', async () => {
    const r = await applyMeasuredBackstop({
      toolMessages: [{ content: 'x'.repeat(1000) }],
      usedTokens: 1000,
      contextWindow: 45_000,
    })
    expect(r.truncated).toBe(false)
    expect(r.contents[0]).toBe('x'.repeat(1000))
    expect(r.maxTokens).toBe(Math.max(256, 45_000 - r.measuredPromptTokens - OUTPUT_RESERVE_TOKENS))
  })

  it('incident: 25k window, 2× 100k tool results → final prompt fits the window', async () => {
    const r = await applyMeasuredBackstop({
      toolMessages: [{ content: 'a'.repeat(100_000) }, { content: 'b'.repeat(100_000) }],
      usedTokens: 2000,
      contextWindow: 25_000,
    })
    expect(r.truncated).toBe(true)
    expect(r.measuredPromptTokens + OUTPUT_RESERVE_TOKENS).toBeLessThanOrEqual(25_000)
    expect(r.maxTokens).toBeGreaterThanOrEqual(256)
    expect(r.contents[0]!.length).toBeLessThan(100_000)
    expect(r.contents[1]!.length).toBeLessThan(100_000)
  })

  it('re-measures with the tokenizer after each truncation pass', async () => {
    const tokenize = vi.fn(async (content: string) => Math.ceil(content.length / 2))
    const r = await applyMeasuredBackstop({
      toolMessages: [{ content: 'x'.repeat(100_000) }],
      usedTokens: 1000,
      contextWindow: 25_000,
      tokenize,
    })
    expect(tokenize).toHaveBeenCalled()
    expect(r.measuredPromptTokens + OUTPUT_RESERVE_TOKENS).toBeLessThanOrEqual(25_000)
  })

  it('bounds truncation to MAX_BACKSTOP_ITERATIONS re-measure passes', async () => {
    const tokenize = vi.fn(async (content: string) => Math.ceil(content.length / 1))
    const r = await applyMeasuredBackstop({
      toolMessages: [{ content: 'x'.repeat(1_000_000) }],
      usedTokens: 1000,
      contextWindow: 25_000,
      tokenize,
    })
    // At most 1 initial measure + MAX_BACKSTOP_ITERATIONS re-measures (1 message each)
    expect(tokenize.mock.calls.length).toBeLessThanOrEqual(1 + MAX_BACKSTOP_ITERATIONS)
    expect(tokenize).toHaveBeenCalled()
    expect(r.measuredPromptTokens + OUTPUT_RESERVE_TOKENS).toBeLessThanOrEqual(25_000)
  })
})
