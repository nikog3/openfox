import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { OpenAIHttpClient } from './http-client.js'

function okResponse(tokenCount: number): Response {
  return new Response(JSON.stringify({ tokens: new Array(tokenCount).fill(0) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function notFoundResponse(): Response {
  return new Response('not found', { status: 404 })
}

describe('OpenAIHttpClient.tokenize endpoint resolution', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('falls back to the server root when the prefixed /tokenize 404s (llama.cpp)', async () => {
    const client = new OpenAIHttpClient({ baseURL: 'http://localhost:8095/proxy/v1', apiKey: 'k' })
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'http://localhost:8095/tokenize') return okResponse(42)
      return notFoundResponse()
    })

    const count = await client.tokenize('hello world')
    expect(count).toBe(42)
    const calledUrls = fetchSpy.mock.calls.map((c: readonly unknown[]) => String(c[0]))
    expect(calledUrls).toContain('http://localhost:8095/tokenize')
  })

  it('uses the prefixed endpoint when it is available (real OpenAI-compatible server)', async () => {
    const client = new OpenAIHttpClient({ baseURL: 'http://api.example.com/v1', apiKey: 'k' })
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'http://api.example.com/v1/tokenize') return okResponse(7)
      return notFoundResponse()
    })

    const count = await client.tokenize('abc')
    expect(count).toBe(7)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('caches the working endpoint and reuses it on the next call', async () => {
    const client = new OpenAIHttpClient({ baseURL: 'http://localhost:8095/proxy/v1', apiKey: 'k' })
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'http://localhost:8095/tokenize') return okResponse(5)
      return notFoundResponse()
    })

    await client.tokenize('first')
    fetchSpy.mockClear()
    await client.tokenize('second')

    const calledUrls = fetchSpy.mock.calls.map((c: readonly unknown[]) => String(c[0]))
    expect(calledUrls[0]).toBe('http://localhost:8095/tokenize')
    expect(calledUrls).toHaveLength(1)
  })

  it('returns null when no endpoint responds successfully', async () => {
    const client = new OpenAIHttpClient({ baseURL: 'http://localhost:8095/proxy/v1', apiKey: 'k' })
    fetchSpy.mockRejectedValue(new Error('network down'))

    const count = await client.tokenize('abc')
    expect(count).toBeNull()
  })
})
