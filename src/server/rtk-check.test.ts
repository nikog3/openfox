import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { ServerHandle } from './context.js'
import type { LlmBackend } from '../shared/types.js'

vi.mock('./llm/http-client.js', () => ({
  OpenAIHttpClient: class MockOpenAIHttpClient {
    constructor(_config: { baseURL: string; apiKey: string }) {}
    createChatCompletion = vi.fn()
    createChatCompletionStream = vi.fn()
  },
}))

function testConfig() {
  return {
    llm: {
      baseUrl: 'http://localhost:8000',
      model: 'test-model',
      timeout: 300000,
      idleTimeout: 300000,
      backend: 'vllm' as LlmBackend,
    },
    context: { maxTokens: 200000, compactionThreshold: 0.85, compactionTarget: 0.6 },
    agent: { maxIterations: 10, maxConsecutiveFailures: 3, toolTimeout: 300000 },
    server: { port: 0, host: '127.0.0.1' },
    database: { path: ':memory:' },
    mode: 'test' as const,
    workdir: '/tmp',
  }
}

describe('GET /api/tools/rtk-check', () => {
  let handle: ServerHandle
  let port: number

  beforeAll(async () => {
    const { createServerHandle } = await import('./index.js')
    handle = await createServerHandle(testConfig())
    ;({ port } = await handle.start(0))
  }, 30_000)

  afterAll(async () => {
    await handle?.close()
  })

  it('responds with a boolean availability flag and nothing else', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tools/rtk-check`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { available?: unknown }
    expect(typeof data.available).toBe('boolean')
    expect(data).toEqual({ available: data.available })
  }, 15_000)

  it('reports the same availability as the shell tool probe', async () => {
    const { probeRtkAvailability } = await import('./tools/shell.js')
    const res = await fetch(`http://127.0.0.1:${port}/api/tools/rtk-check`)
    const data = (await res.json()) as { available: boolean }
    expect(data.available).toBe(await probeRtkAvailability())
  }, 15_000)
})
