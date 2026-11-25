// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../shared/Markdown', () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}))

import type { Message } from '@shared/types.js'
import { SessionSummaryCard } from './SessionSummaryCard'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '# Session summary\nAll done.',
    timestamp: new Date().toISOString(),
    isStreaming: false,
    metadata: { type: 'session-summary', name: 'Summary', color: '#8b5cf6' },
    ...overrides,
  }
}

afterEach(cleanup)

describe('SessionSummaryCard', () => {
  it('renders the summary label and the markdown content', () => {
    render(<SessionSummaryCard message={makeMessage()} />)
    expect(screen.getByTestId('session-summary-card')).toBeTruthy()
    expect(screen.getByText('Summary')).toBeTruthy()
    const body = screen.getByTestId('session-summary-card').querySelector('.prose')
    expect(body?.textContent?.includes('All done.')).toBe(true)
  })

  it('falls back to the default label when metadata is absent', () => {
    const { metadata: _omitted, ...base } = makeMessage()
    render(<SessionSummaryCard message={base} />)
    expect(screen.getByText('Session summary')).toBeTruthy()
  })

  it('shows a spinner while the message is streaming', () => {
    render(<SessionSummaryCard message={makeMessage({ isStreaming: true })} />)
    const card = screen.getByTestId('session-summary-card')
    expect(card.querySelector('.animate-spin')).toBeTruthy()
  })

  it('does not show a spinner when not streaming', () => {
    render(<SessionSummaryCard message={makeMessage()} />)
    const card = screen.getByTestId('session-summary-card')
    expect(card.querySelector('.animate-spin')).toBeNull()
  })
})
