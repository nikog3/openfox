import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { postJson, readResponseLines, llmDispatcher, llmDispatcherOptions } from './http-shared.js'
import { LLMError } from '../utils/errors.js'
import { fetch as undiciFetch } from 'undici'

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, fetch: vi.fn() }
})

const fetchMock = vi.mocked(undiciFetch) as unknown as Mock

describe('postJson', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('passes the no-timeout undici dispatcher to fetch', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    await postJson('http://localhost:8080/v1/chat/completions', { 'Content-Type': 'application/json' }, '{}')

    // undici defaults are 300s each: with no response headers during a long prefill
    // (llama-server sends none until the first token) the request dies with
    // "fetch failed" before the app-level idle timeout can fire.
    expect(llmDispatcherOptions).toEqual({ headersTimeout: 0, bodyTimeout: 0 })
    const init = fetchMock.mock.calls[0]![1]
    expect(init?.dispatcher).toBe(llmDispatcher)
  })

  it('throws LLMError on non-2xx responses', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('boom', { status: 500 })))

    await expect(postJson('http://x/v1/chat/completions', {}, '{}')).rejects.toThrow(LLMError)
    await expect(postJson('http://x/v1/chat/completions', {}, '{}')).rejects.toThrow('HTTP 500')
  })

  it('forwards the abort signal to fetch', async () => {
    const signal = new AbortController().signal
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    await postJson('http://x/v1/chat/completions', {}, '{}', { signal })

    const init = fetchMock.mock.calls[0]![1]
    expect(init?.signal).toBe(signal)
  })
})

describe('readResponseLines', () => {
  it('yields trimmed non-empty lines from a streaming body', async () => {
    const response = new Response('data: a\n\ndata: b\n\n', { status: 200 })
    const lines: string[] = []
    for await (const line of readResponseLines(response)) {
      lines.push(line)
    }
    expect(lines).toEqual(['data: a', 'data: b'])
  })

  it('throws LLMError when the response has no body', async () => {
    const response = new Response(null, { status: 200 })
    await expect(readResponseLines(response).next()).rejects.toThrow(LLMError)
  })
})
