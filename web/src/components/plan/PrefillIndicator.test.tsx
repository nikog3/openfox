// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PrefillIndicator } from './PrefillIndicator'

describe('PrefillIndicator', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows the token count and elapsed time only when nothing is measurable (minimal tier)', () => {
    render(<PrefillIndicator prefill={{ messageId: 'm1', contextTokens: 40000, startedAt: Date.now() - 1200 }} />)
    expect(screen.getByTestId('prefill-indicator')).toBeTruthy()
    expect(document.body.textContent).toContain('40 000')
    expect(document.body.textContent).not.toContain('%')
  })

  it('shows an estimated percent (≈) when a prefill speed is known', () => {
    render(
      <PrefillIndicator
        prefill={{ messageId: 'm1', contextTokens: 40000, startedAt: Date.now() - 1000 }}
        lastPrefillSpeed={20000}
      />,
    )
    // 40000 / 20000 = 2s total, 1s elapsed → ≈50%
    const text = document.body.textContent ?? ''
    expect(text).toContain('≈')
    expect(text).toContain('50%')
    expect(text).toContain('1s left')
  })

  it('shows the warm-cache increment in the label when tokenIncrement is known', () => {
    render(
      <PrefillIndicator
        prefill={{ messageId: 'm1', contextTokens: 40000, startedAt: Date.now() - 1200 }}
        tokenIncrement={800}
      />,
    )
    expect(document.body.textContent).toContain('Prefilling 800 of 40 000 tokens')
  })

  it('keeps the full-context label when tokenIncrement is zero', () => {
    render(
      <PrefillIndicator
        prefill={{ messageId: 'm1', contextTokens: 40000, startedAt: Date.now() - 1200 }}
        tokenIncrement={0}
      />,
    )
    expect(document.body.textContent).toContain('Prefilling 40 000 tokens')
  })

  it('prefers engine-measured progress over the estimate, without the ≈ marker', () => {
    render(
      <PrefillIndicator
        prefill={{
          messageId: 'm1',
          contextTokens: 40000,
          startedAt: Date.now() - 1000,
          promptTokens: 40000,
          processedTokens: 30000,
          percent: 75,
          etaSeconds: 1,
          speedTps: 10000,
        }}
        lastPrefillSpeed={20000}
      />,
    )
    const text = document.body.textContent ?? ''
    expect(text).toContain('75%')
    expect(text).toContain('1s left')
    expect(text).not.toContain('≈75')
  })

  it('shows the engine-reported prompt size when the tracked context is 0 (first call)', () => {
    render(
      <PrefillIndicator
        prefill={{
          messageId: 'm1',
          contextTokens: 0,
          startedAt: Date.now() - 1200,
          promptTokens: 41234,
          processedTokens: 38000,
          percent: 92,
        }}
      />,
    )
    const text = document.body.textContent ?? ''
    expect(text).toContain('41 234')
    expect(text).toContain('92%')
  })
})
