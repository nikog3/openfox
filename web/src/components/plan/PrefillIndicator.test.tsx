// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('shows the info toggle only when the engine measures progress (slot id known)', () => {
    render(<PrefillIndicator prefill={{ messageId: 'm1', contextTokens: 40000, startedAt: Date.now() - 1000 }} />)
    expect(screen.queryByTestId('prefill-details-toggle')).toBeNull()

    render(
      <PrefillIndicator
        prefill={{
          messageId: 'm1',
          contextTokens: 40000,
          startedAt: Date.now() - 1000,
          promptTokens: 40000,
          processedTokens: 30000,
          percent: 75,
          slotId: 1,
        }}
      />,
    )
    expect(screen.getByTestId('prefill-details-toggle')).toBeTruthy()
  })

  it('shows the tracked slot id in the main line without opening the details panel', () => {
    render(
      <PrefillIndicator
        prefill={{
          messageId: 'm1',
          contextTokens: 40000,
          startedAt: Date.now() - 1000,
          promptTokens: 40000,
          processedTokens: 30000,
          percent: 75,
          slotId: 1,
        }}
      />,
    )
    expect(screen.getByTestId('prefill-slot-id').textContent).toBe('#1')
    expect(screen.queryByTestId('prefill-details-panel')).toBeNull()
  })

  it('hides the slot id in the main line when the engine does not measure progress', () => {
    render(<PrefillIndicator prefill={{ messageId: 'm1', contextTokens: 40000, startedAt: Date.now() - 1200 }} />)
    expect(screen.queryByTestId('prefill-slot-id')).toBeNull()
  })

  it('shows the tracked slot id in the main line without opening the details panel', () => {
    render(
      <PrefillIndicator
        prefill={{
          messageId: 'm1',
          contextTokens: 40000,
          startedAt: Date.now() - 1000,
          promptTokens: 40000,
          processedTokens: 30000,
          percent: 75,
          slotId: 1,
        }}
      />,
    )
    expect(screen.getByTestId('prefill-slot-id').textContent).toBe('#1')
    expect(screen.queryByTestId('prefill-details-panel')).toBeNull()
  })

  it('hides the slot id in the main line when the engine does not measure progress', () => {
    render(<PrefillIndicator prefill={{ messageId: 'm1', contextTokens: 40000, startedAt: Date.now() - 1200 }} />)
    expect(screen.queryByTestId('prefill-slot-id')).toBeNull()
  })

  it('toggles the details panel on click and lists the tracked slot identity', () => {
    render(
      <PrefillIndicator
        prefill={{
          messageId: 'm1',
          contextTokens: 40000,
          startedAt: Date.now() - 1000,
          promptTokens: 40000,
          processedTokens: 30000,
          percent: 75,
          speedTps: 120,
          etaSeconds: 150,
          cachedTokens: 35000,
          slotId: 1,
          taskId: 15247,
        }}
      />,
    )
    const toggle = screen.getByTestId('prefill-details-toggle')
    expect(screen.queryByTestId('prefill-details-panel')).toBeNull()

    fireEvent.click(toggle)
    const panel = screen.getByTestId('prefill-details-panel')
    const text = panel.textContent ?? ''
    expect(text).toContain('#1')
    expect(text).toContain('15247')
    expect(text).toContain('35 000')
    expect(text).toContain('30 000')

    fireEvent.click(toggle)
    expect(screen.queryByTestId('prefill-details-panel')).toBeNull()
  })

  it('shows both the live and the average prefill speed in the details panel', () => {
    render(
      <PrefillIndicator
        prefill={{
          messageId: 'm1',
          contextTokens: 40000,
          startedAt: Date.now() - 1000,
          promptTokens: 40000,
          processedTokens: 30000,
          percent: 75,
          speedTps: 120,
          avgTps: 85,
          slotId: 1,
        }}
      />,
    )
    fireEvent.click(screen.getByTestId('prefill-details-toggle'))
    const text = screen.getByTestId('prefill-details-panel').textContent ?? ''
    expect(text).toContain('Speed')
    expect(text).toContain('120 t/s')
    expect(text).toContain('Avg speed')
    expect(text).toContain('85 t/s')
  })

  it('omits the average speed row when the engine did not report it', () => {
    render(
      <PrefillIndicator
        prefill={{
          messageId: 'm1',
          contextTokens: 40000,
          startedAt: Date.now() - 1000,
          promptTokens: 40000,
          processedTokens: 30000,
          percent: 75,
          speedTps: 120,
          slotId: 1,
        }}
      />,
    )
    fireEvent.click(screen.getByTestId('prefill-details-toggle'))
    const text = screen.getByTestId('prefill-details-panel').textContent ?? ''
    expect(text).toContain('120 t/s')
    expect(text).not.toContain('Avg speed')
  })

  it('omits detail rows for values the engine did not report', () => {
    render(
      <PrefillIndicator
        prefill={{
          messageId: 'm1',
          contextTokens: 40000,
          startedAt: Date.now() - 1000,
          promptTokens: 40000,
          processedTokens: 30000,
          percent: 75,
          slotId: 0,
        }}
      />,
    )
    fireEvent.click(screen.getByTestId('prefill-details-toggle'))
    const text = screen.getByTestId('prefill-details-panel').textContent ?? ''
    expect(text).toContain('#0')
    expect(text).not.toContain('15247')
  })
})
