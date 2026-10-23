import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateCommitMessage } from './commit-message.js'
import type { LLMClientWithModel } from '../llm/client.js'
import type { ProviderManager } from '../provider-manager.js'
import type { LLMCompletionRequest, LLMCompletionResponse } from '../llm/types.js'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('./env.js', () => ({
  gitSpawnEnv: () => ({}),
}))

import { spawn } from 'node:child_process'

type MockProc = {
  stdout: { on: (event: string, cb: (d: Buffer) => void) => void }
  stderr: { on: (event: string, cb: (d: Buffer) => void) => void }
  on: (event: string, cb: (...args: unknown[]) => void) => void
}

function makeMockProc(stdout: string, exitCode = 0): MockProc {
  return {
    stdout: {
      on: (event, cb) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from(stdout)), 0)
      },
    },
    stderr: {
      on: () => {},
    },
    on: (event, cb) => {
      if (event === 'close') setTimeout(() => cb(exitCode), 0)
    },
  }
}

function mockStagedDiff(diff: string): void {
  vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
    if (args[0] === 'diff') return makeMockProc(diff)
    return makeMockProc('')
  }) as typeof spawn)
}

function makeProviderManager(opts: {
  provider?: { id: string } | null
  model?: string | null
  client?: unknown
}): ProviderManager {
  return {
    getActiveProvider: () => opts.provider ?? null,
    getCurrentModel: () => opts.model ?? null,
    createClient: (id: string, model: string) =>
      opts.client && opts.provider?.id === id && opts.model === model ? (opts.client as never) : undefined,
    getModelSettings: () => undefined,
  } as unknown as ProviderManager
}

function makeClient(response: Partial<LLMCompletionResponse> | ((req: LLMCompletionRequest) => never)): {
  client: LLMClientWithModel
  complete: ReturnType<typeof vi.fn>
} {
  const complete = vi.fn((req: LLMCompletionRequest) => {
    if (typeof response === 'function') response(req)
    return Promise.resolve({ content: '', thinkingContent: undefined, ...response })
  })
  const client = { complete } as unknown as LLMClientWithModel
  return { client, complete }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('generateCommitMessage', () => {
  it('returns the LLM message and passes the staged diff to the prompt', async () => {
    const diff = 'diff --git a/a.ts b/a.ts\n+const x = 1'
    mockStagedDiff(diff)
    const { client, complete } = makeClient({ content: 'feat: add x' })

    const result = await generateCommitMessage('/tmp/project', {
      providerManager: makeProviderManager({ provider: { id: 'p1' }, model: 'm1', client }),
      getLLMClient: () => client,
    })

    expect(result).toEqual({ success: true, message: 'feat: add x' })
    expect(complete).toHaveBeenCalledTimes(1)
    const request = complete.mock.calls[0]![0] as LLMCompletionRequest
    expect(request.messages[0]?.content).toContain(diff)
    expect(request.tools).toEqual([])
    expect(request.skipClientReasoningEffort).toBe(true)
  })

  it('strips surrounding quotes from the generated message', async () => {
    mockStagedDiff('+x\n')
    const { client } = makeClient({ content: '"fix: quoted message"' })

    const result = await generateCommitMessage('/tmp/project', {
      providerManager: makeProviderManager({ provider: { id: 'p1' }, model: 'm1', client }),
      getLLMClient: () => client,
    })

    expect(result).toEqual({ success: true, message: 'fix: quoted message' })
  })

  it('falls back to the provider manager client when no client is injected', async () => {
    mockStagedDiff('+x\n')
    const { client, complete } = makeClient({ content: 'chore: x' })

    const result = await generateCommitMessage('/tmp/project', {
      providerManager: makeProviderManager({ provider: { id: 'p1' }, model: 'm1', client }),
    })

    expect(result).toEqual({ success: true, message: 'chore: x' })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('fails when nothing is staged', async () => {
    mockStagedDiff('')

    const result = await generateCommitMessage('/tmp/project', {
      providerManager: makeProviderManager({ provider: { id: 'p1' }, model: 'm1' }),
    })

    expect(result).toEqual({ success: false, error: 'No staged changes to commit' })
  })

  it('fails when no provider or model is configured', async () => {
    mockStagedDiff('+x\n')

    const result = await generateCommitMessage('/tmp/project', {
      providerManager: makeProviderManager({ provider: null, model: null }),
    })

    expect(result).toEqual({ success: false, error: 'No LLM configured' })
  })

  it('fails when the client cannot be created', async () => {
    mockStagedDiff('+x\n')

    const result = await generateCommitMessage('/tmp/project', {
      providerManager: makeProviderManager({ provider: { id: 'p1' }, model: 'm1', client: undefined }),
    })

    expect(result).toEqual({ success: false, error: 'No LLM configured' })
  })

  it('surfaces LLM errors', async () => {
    mockStagedDiff('+x\n')
    const { client } = makeClient(() => {
      throw new Error('model exploded')
    })

    const result = await generateCommitMessage('/tmp/project', {
      providerManager: makeProviderManager({ provider: { id: 'p1' }, model: 'm1', client }),
      getLLMClient: () => client,
    })

    expect(result).toEqual({ success: false, error: 'model exploded' })
  })
})
