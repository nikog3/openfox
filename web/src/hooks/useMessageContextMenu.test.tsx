// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMessageContextMenu } from './useMessageContextMenu'
import type { Message, MessageStats } from '@shared/types.js'

vi.mock('./useT', () => ({
  useT: () => (obj: { en: string; fr: string }) => obj.en,
}))

vi.mock('./usePlugins', () => ({
  usePlugins: () => ({ plugins: [], contributions: { actions: [] }, loading: false, error: null, refresh: vi.fn() }),
}))

vi.mock('./useLocalizedString', () => ({
  useLocalizedString: () => (value: { en: string; fr: string }) => value.en,
}))

function makeMessage(stats?: Partial<MessageStats>): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'hello',
    timestamp: '2026-11-08T12:00:00.000Z',
    ...(stats ? { stats: stats as MessageStats } : {}),
  }
}

function labels(message: Message): string[] {
  const { result } = renderHook(() => useMessageContextMenu(message, vi.fn(), vi.fn()))
  return result.current.map((item) => item.label)
}

describe('useMessageContextMenu', () => {
  it('shows no request id line when the message has no stats', () => {
    const items = labels(makeMessage())
    expect(items.some((label) => label.startsWith('Request #'))).toBe(false)
  })

  it('shows the request id with slot and task when both are known', () => {
    const items = labels(
      makeMessage({
        llmCalls: [
          {
            providerId: 'p',
            providerName: 'vLLM',
            backend: 'vllm',
            model: 'm',
            callIndex: 1,
            promptTokens: 100,
            completionTokens: 50,
            ttft: 0.5,
            completionTime: 2,
            prefillSpeed: 200,
            generationSpeed: 25,
            totalTime: 2.5,
            slotId: 2,
            taskId: 1337,
          },
        ],
      }),
    )
    expect(items).toContain('Request #2 · task 1337')
  })

  it('shows the request id with slot only when the task id is unknown', () => {
    const items = labels(
      makeMessage({
        llmCalls: [
          {
            providerId: 'p',
            providerName: 'vLLM',
            backend: 'vllm',
            model: 'm',
            callIndex: 1,
            promptTokens: 100,
            completionTokens: 50,
            ttft: 0.5,
            completionTime: 2,
            prefillSpeed: 200,
            generationSpeed: 25,
            totalTime: 2.5,
            slotId: 3,
          },
        ],
      }),
    )
    expect(items).toContain('Request #3')
  })

  it('uses the first call carrying a slot id when the turn has multiple LLM calls', () => {
    const items = labels(
      makeMessage({
        llmCalls: [
          {
            providerId: 'p',
            providerName: 'vLLM',
            backend: 'vllm',
            model: 'm',
            callIndex: 1,
            promptTokens: 100,
            completionTokens: 50,
            ttft: 0.5,
            completionTime: 2,
            prefillSpeed: 200,
            generationSpeed: 25,
            totalTime: 2.5,
          },
          {
            providerId: 'p',
            providerName: 'vLLM',
            backend: 'vllm',
            model: 'm',
            callIndex: 2,
            promptTokens: 120,
            completionTokens: 60,
            ttft: 0.4,
            completionTime: 1.5,
            prefillSpeed: 300,
            generationSpeed: 40,
            totalTime: 1.9,
            slotId: 4,
            taskId: 42,
          },
        ],
      }),
    )
    expect(items).toContain('Request #4 · task 42')
    expect(items.filter((label) => label.startsWith('Request #'))).toHaveLength(1)
  })
})
