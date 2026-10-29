/**
 * Context Self-Healing E2E Tests
 *
 * When the backend reports a real context limit in a context-length error
 * (e.g. llama.cpp "exceeds the available context size (Y tokens)"), the
 * effective session window is lowered to Y and the in-flight turn recovers.
 * The cap persists across client reconnects, never raises the window, and
 * is cleared by a user context-window override (PUT provider).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  createTestClient,
  createTestProject,
  createProject,
  createSession,
  type TestClient,
  type TestProject,
} from './utils/index.js'
import type { ServerHandle } from '../src/server/context.js'
import { loadGlobalConfig, saveGlobalConfig, type GlobalConfig } from '../src/cli/config.js'
import type { Config } from '../src/shared/types.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'

const TEST_MODE = 'test'
const PROVIDER_ID = 'test-self-healing-provider'
const MODEL_ID = 'test-self-healing-model'
const CONTEXT_WINDOW = 128000
const DISCOVERED_CAP = 8000
const RESET_WINDOW = 96000

interface ContextState {
  currentTokens: number
  maxTokens: number
  compactionCount: number
  canCompact: boolean
  dangerZone: boolean
}

function contextStateMaxTokens(events: Array<{ type: string; payload: unknown }>): number[] {
  return events
    .filter((e) => e.type === 'context.state')
    .map((e) => (e.payload as { context: ContextState }).context.maxTokens)
}

describe('Context Self-Healing', () => {
  let server: ServerHandle
  let project: TestProject
  let serverUrl: string
  let configPath: string
  let controlPath: string

  beforeAll(async () => {
    configPath = join(tmpdir(), `openfox-e2e-config-${randomUUID()}.json`)
    controlPath = join(tmpdir(), `openfox-e2e-mock-control-${randomUUID()}.json`)
    writeFileSync(controlPath, JSON.stringify({}))

    const globalConfig = await loadGlobalConfig(TEST_MODE, configPath)
    const updatedConfig: GlobalConfig = {
      ...globalConfig,
      // The session-name generator fires an LLM complete() on the first user
      // message (before the turn), which would consume the injected
      // context-error budget. Disable it so the budget reaches the main turn.
      disableAutoSessionTitle: true,
      providers: [
        {
          id: PROVIDER_ID,
          name: 'Test Self-Healing Provider',
          url: 'http://localhost:11434',
          backend: 'ollama',
          models: [{ id: MODEL_ID, contextWindow: CONTEXT_WINDOW, source: 'user' as const }],
          isActive: true,
          createdAt: new Date().toISOString(),
        },
        ...(globalConfig.providers?.filter((p) => p.id !== PROVIDER_ID) ?? []),
      ],
      defaultModelSelection: `${PROVIDER_ID}/${MODEL_ID}`,
      activeProviderId: PROVIDER_ID,
    }
    await saveGlobalConfig(TEST_MODE, updatedConfig, configPath)

    // The mock LLM must be enabled before the server module loads, so the
    // handle is imported dynamically (same trick as e2e/utils/server-factory).
    process.env['OPENFOX_MOCK_LLM'] = 'true'
    process.env['OPENFOX_MOCK_CONTROL'] = controlPath

    const { createServerHandle } = await import('../src/server/index.js')
    const config: Config = {
      providers: updatedConfig.providers,
      defaultModelSelection: updatedConfig.defaultModelSelection,
      activeProviderId: updatedConfig.activeProviderId,
      globalConfigPath: configPath,
      llm: {
        baseUrl: 'http://localhost:11434/v1',
        model: MODEL_ID,
        backend: 'ollama',
        timeout: 120000,
        idleTimeout: 300000,
      },
      context: { maxTokens: CONTEXT_WINDOW, compactionThreshold: 0.8, compactionTarget: 0.5 },
      agent: { maxIterations: 50, maxConsecutiveFailures: 3, toolTimeout: 120000 },
      server: { port: 0, host: '127.0.0.1', openBrowser: false },
      database: { path: '' },
      logging: { level: 'error' },
      mode: TEST_MODE,
      disableAutoSessionTitle: true,
      workdir: process.cwd(),
    }

    server = await createServerHandle(config)
    const { port } = await server.start(0)
    serverUrl = `http://127.0.0.1:${port}`
  }, 30000)

  afterAll(async () => {
    await server.close()
    delete process.env['OPENFOX_MOCK_CONTROL']
    delete process.env['OPENFOX_MOCK_LLM']
    await unlink(configPath).catch(() => {})
    await unlink(controlPath).catch(() => {})
  })

  beforeEach(async () => {
    project = await createTestProject({ template: 'typescript' })
  })

  afterEach(async () => {
    await project.cleanup()
  })

  async function createLoadedSession(client: TestClient): Promise<string> {
    const restProject = await createProject(serverUrl, { name: 'Self-Healing Test', workdir: project.path })
    const restSession = await createSession(serverUrl, { projectId: restProject.id })
    await fetch(`${serverUrl}/api/sessions/${restSession.id}/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: PROVIDER_ID, model: MODEL_ID }),
    })
    await client.send('session.load', { sessionId: restSession.id })
    return restSession.id
  }

  function injectContextError(serverLimit: number, calls = 1): void {
    writeFileSync(
      controlPath,
      JSON.stringify({
        contextError: `Request (150000 tokens) exceeds the available context size (${serverLimit} tokens)`,
        contextErrorCalls: calls,
      }),
    )
  }

  it('reports the configured window before any discovery', async () => {
    const client = await createTestClient({ url: `${serverUrl}/ws` })
    try {
      await createLoadedSession(client)
      const event = await client.waitFor('context.state')
      expect((event.payload as { context: ContextState }).context.maxTokens).toBe(CONTEXT_WINDOW)
    } finally {
      await client.close()
    }
  })

  it('lowers the effective window to the backend-reported limit and heals the turn', async () => {
    const client = await createTestClient({ url: `${serverUrl}/ws` })
    try {
      await createLoadedSession(client)
      // Auto session titles are disabled (see beforeAll) so the name
      // generator's LLM call cannot consume the failure budget.
      injectContextError(DISCOVERED_CAP)
      await client.send('chat.send', { content: 'This turn must survive a context-length error.' })
      const done = await client.waitForChatDone()
      expect(done.reason).toBe('complete')
      expect(contextStateMaxTokens(client.allEvents())).toContain(DISCOVERED_CAP)
    } finally {
      await client.close()
    }
  })

  it('persists the discovered cap across client reconnects', async () => {
    const discoverer = await createTestClient({ url: `${serverUrl}/ws` })
    const sessionId = await createLoadedSession(discoverer)
    injectContextError(DISCOVERED_CAP)
    await discoverer.send('chat.send', { content: 'Discover the cap.' })
    await discoverer.waitForChatDone()
    await discoverer.close()

    const reconnected = await createTestClient({ url: `${serverUrl}/ws` })
    try {
      await reconnected.send('session.load', { sessionId })
      const event = await reconnected.waitFor('context.state')
      expect((event.payload as { context: ContextState }).context.maxTokens).toBe(DISCOVERED_CAP)
    } finally {
      await reconnected.close()
    }
  })

  it('never raises an existing cap when the backend reports a larger limit', async () => {
    const client = await createTestClient({ url: `${serverUrl}/ws` })
    try {
      await createLoadedSession(client)
      injectContextError(DISCOVERED_CAP)
      await client.send('chat.send', { content: 'Discover the cap first.' })
      await client.waitForChatDone()

      injectContextError(120000)
      await client.send('chat.send', { content: 'This error reports a larger limit.' })
      const done = await client.waitForChatDone()
      expect(done.reason).toBe('complete')

      const maxTokens = contextStateMaxTokens(client.allEvents())
      expect(maxTokens).toContain(DISCOVERED_CAP)
      expect(maxTokens).not.toContain(120000)
    } finally {
      await client.close()
    }
  })

  it('clears the cap when the user updates the model context window', async () => {
    const client = await createTestClient({ url: `${serverUrl}/ws` })
    await createLoadedSession(client)
    injectContextError(DISCOVERED_CAP)
    await client.send('chat.send', { content: 'Discover the cap first.' })
    await client.waitForChatDone()
    await client.close()

    const response = await fetch(`${serverUrl}/api/providers/${PROVIDER_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: [{ id: MODEL_ID, contextWindow: RESET_WINDOW }] }),
    })
    expect(response.ok).toBe(true)

    const reconnected = await createTestClient({ url: `${serverUrl}/ws` })
    try {
      await createLoadedSession(reconnected)
      const event = await reconnected.waitFor('context.state')
      expect((event.payload as { context: ContextState }).context.maxTokens).toBe(RESET_WINDOW)
    } finally {
      await reconnected.close()
    }
  })
})
