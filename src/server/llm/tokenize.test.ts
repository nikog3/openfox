import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIHttpClient } from './http-client.js'
import { OllamaHttpClient } from './ollama-native.js'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAIHttpClient.tokenize', () => {
  const client = new OpenAIHttpClient({ baseURL: 'http://localhost:8080', apiKey: 'test-key' })

  it('returns the token count from the /tokenize endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { tokens: [1, 2, 3, 4, 5] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.tokenize('hello world')).resolves.toBe(5)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://localhost:8080/tokenize')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ content: 'hello world' })
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key')
  })

  it('returns null when the endpoint is unsupported (404)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.tokenize('hello')).resolves.toBeNull()
  })

  it('returns null for a malformed response (no tokens array)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { tokens: 'nope' }))
      .mockResolvedValueOnce(jsonResponse(200, { foo: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.tokenize('hello')).resolves.toBeNull()
    await expect(client.tokenize('hello')).resolves.toBeNull()
  })

  it('returns null on network errors', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('connection refused'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.tokenize('hello')).resolves.toBeNull()
  })
})

describe('OllamaHttpClient.tokenize', () => {
  const client = new OllamaHttpClient({ baseURL: 'http://localhost:11434' })

  it('returns the token count from /api/tokenize with the model', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { tokens: [10, 20, 30] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.tokenize('hello world', 'qwen3')).resolves.toBe(3)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://localhost:11434/api/tokenize')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'qwen3', prompt: 'hello world' })
  })

  it('returns null when no model is provided', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.tokenize('hello world')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null on 404 and malformed responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.tokenize('hello', 'qwen3')).resolves.toBeNull()
    await expect(client.tokenize('hello', 'qwen3')).resolves.toBeNull()
  })

  it('returns null on network errors', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('connection refused'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.tokenize('hello', 'qwen3')).resolves.toBeNull()
  })
})
