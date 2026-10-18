/**
 * Session Name Generator Tests
 *
 * TDD: Write failing tests first, then implement to make them pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  generateSessionName,
  needsNameGeneration,
  generateSessionNameForSession,
  SESSION_NAME_PROMPT,
} from './name-generator.js'
import type { LLMCompletionResponse } from '../llm/types.js'
import type { Session } from '../../shared/types.js'

vi.mock('../runtime-config.js', () => ({
  getRuntimeConfig: vi.fn(),
}))

vi.mock('../utils/session-utils.js', () => ({
  getSessionMessageCount: vi.fn(() => 1),
}))

vi.mock('../db/sessions.js', () => ({
  updateSessionMetadata: vi.fn(),
}))

vi.mock('../db/settings.js', () => ({
  getMaxVisibleItems: vi.fn(() => 100),
}))

vi.mock('../tools/index.js', () => ({
  getPendingQuestionsForSession: vi.fn(() => []),
}))

vi.mock('../events/index.js', () => ({
  combineEventsWithSnapshot: vi.fn((_id: string, _snapshot: unknown, eventsSince: unknown[]) => eventsSince ?? []),
}))

vi.mock('../chat/stream-pure.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat/stream-pure.js')>()
  return {
    ...actual,
    sleepThroughRetryBackoff: vi.fn().mockResolvedValue('waited'),
  }
})

vi.mock('../chat/orchestrator.js', () => ({
  buildRetryPatterns: vi.fn().mockResolvedValue({ retryPatterns: [], maxRetriesPerTurn: 10 }),
}))

vi.mock('../llm/client.js', () => ({
  createLLMClient: vi.fn(),
}))

describe('Session Name Generator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('generateSessionName', () => {
    it('should generate a descriptive name from the user message', async () => {
      // Create mock LLM client
      const mockResponse: LLMCompletionResponse = {
        id: 'test-id',
        content: 'React project setup',
        finishReason: 'stop',
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
      }

      const mockClient = {
        complete: vi.fn().mockResolvedValue(mockResponse),
        getModel: vi.fn().mockReturnValue('test-model'),
        setModel: vi.fn(),
        getProfile: vi.fn(),
        getBackend: vi.fn().mockReturnValue('unknown'),
        setBackend: vi.fn(),
      }

      // Execute
      const result = await generateSessionName({
        userMessage: 'How do I set up a React project?',
        llmClient: mockClient as any,
      })

      // Assert
      expect(result.success).toBe(true)
      expect(result.name).toBe('React project setup')
      expect(result.error).toBeUndefined()
    })

    it('should truncate names longer than 50 characters', async () => {
      const longName = 'A very long session name that definitely exceeds the fifty character limit for session titles'
      const mockResponse: LLMCompletionResponse = {
        id: 'test-id',
        content: longName,
        finishReason: 'stop',
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
        },
      }

      const mockClient = {
        complete: vi.fn().mockResolvedValue(mockResponse),
        getModel: vi.fn().mockReturnValue('test-model'),
        setModel: vi.fn(),
        getProfile: vi.fn(),
        getBackend: vi.fn().mockReturnValue('unknown'),
        setBackend: vi.fn(),
      }

      const result = await generateSessionName({
        userMessage: 'Some question',
        llmClient: mockClient as any,
      })

      expect(result.success).toBe(true)
      expect(result.name?.length).toBeLessThanOrEqual(50)
      expect(result.name?.endsWith('...')).toBe(true)
    })

    it('should return failure for empty or too short names', async () => {
      const mockResponse: LLMCompletionResponse = {
        id: 'test-id',
        content: 'x',
        finishReason: 'stop',
        usage: {
          promptTokens: 10,
          completionTokens: 1,
          totalTokens: 11,
        },
      }

      const mockClient = {
        complete: vi.fn().mockResolvedValue(mockResponse),
        getModel: vi.fn().mockReturnValue('test-model'),
        setModel: vi.fn(),
        getProfile: vi.fn(),
        getBackend: vi.fn().mockReturnValue('unknown'),
        setBackend: vi.fn(),
      }

      const result = await generateSessionName({
        userMessage: 'Test message',
        llmClient: mockClient as any,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('too short')
    })

    it('should handle LLM errors gracefully', async () => {
      const mockClient = {
        complete: vi.fn().mockRejectedValue(new Error('LLM connection failed')),
        getModel: vi.fn().mockReturnValue('test-model'),
        setModel: vi.fn(),
        getProfile: vi.fn(),
        getBackend: vi.fn().mockReturnValue('unknown'),
        setBackend: vi.fn(),
      }

      const result = await generateSessionName({
        userMessage: 'Test message',
        llmClient: mockClient as any,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('LLM connection failed')
    })

    it('should use the provided LLM client', async () => {
      const mockResponse: LLMCompletionResponse = {
        id: 'test-id',
        content: 'Test name',
        finishReason: 'stop',
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
      }

      const mockClient = {
        complete: vi.fn().mockResolvedValue(mockResponse),
        getModel: vi.fn().mockReturnValue('custom-model'),
        setModel: vi.fn(),
        getProfile: vi.fn(),
        getBackend: vi.fn().mockReturnValue('custom-backend'),
        setBackend: vi.fn(),
      }

      await generateSessionName({
        userMessage: 'Test message',
        llmClient: mockClient as any,
      })

      // Verify the mock client's complete method was called
      expect(mockClient.complete).toHaveBeenCalled()
      const callArgs = (mockClient.complete as any).mock.calls[0][0]
      expect(callArgs.messages).toBeDefined()
      expect(callArgs.messages[0].role).toBe('user')
    })
  })

  describe('needsNameGeneration', () => {
    it('should return true when session has no title', () => {
      expect(needsNameGeneration(null, 1)).toBe(true)
      expect(needsNameGeneration('', 1)).toBe(true)
      expect(needsNameGeneration(undefined, 1)).toBe(true)
    })

    it('should return true for default session titles', () => {
      expect(needsNameGeneration('Session 1', 1)).toBe(true)
      expect(needsNameGeneration('Session 42', 1)).toBe(true)
      expect(needsNameGeneration('Session 100', 1)).toBe(true)
    })

    it('should return false for custom titles', () => {
      expect(needsNameGeneration('My custom session', 1)).toBe(false)
      expect(needsNameGeneration('React project setup', 1)).toBe(false)
    })

    it('should return false if more than one message has been sent', () => {
      expect(needsNameGeneration(null, 2)).toBe(false)
      expect(needsNameGeneration('Session 1', 5)).toBe(false)
    })

    it('should return true for first message with default title', () => {
      expect(needsNameGeneration('Session 1', 1)).toBe(true)
    })
  })

  describe('model settings forwarding', () => {
    function createMockClient(response: LLMCompletionResponse) {
      return {
        complete: vi.fn().mockResolvedValue(response),
        getModel: vi.fn().mockReturnValue('test-model'),
        setModel: vi.fn(),
        getProfile: vi.fn(),
        getBackend: vi.fn().mockReturnValue('unknown'),
        setBackend: vi.fn(),
      }
    }

    const defaultResponse: LLMCompletionResponse = {
      id: 'test-id',
      content: 'React setup',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }

    it('should not pass reasoningEffort by default', async () => {
      const mockClient = createMockClient(defaultResponse)

      await generateSessionName({
        userMessage: 'How do I set up React?',
        llmClient: mockClient as any,
      })

      const callArgs = (mockClient.complete as any).mock.calls[0][0]
      expect(callArgs.reasoningEffort).toBeUndefined()
    })

    it('should pass modelSettings to the LLM client', async () => {
      const mockClient = createMockClient(defaultResponse)
      const modelSettings = {
        temperature: 0.7,
        chatTemplateKwargs: { enable_thinking: false },
      }

      await generateSessionName({
        userMessage: 'How do I set up React?',
        llmClient: mockClient as any,
        modelSettings,
      })

      const callArgs = (mockClient.complete as any).mock.calls[0][0]
      expect(callArgs.modelSettings).toEqual(modelSettings)
    })

    it('should pass queryParams in modelSettings', async () => {
      const mockClient = createMockClient(defaultResponse)
      const modelSettings = {
        queryParams: { disable_thinking: true },
      }

      await generateSessionName({
        userMessage: 'How do I set up React?',
        llmClient: mockClient as any,
        modelSettings,
      })

      const callArgs = (mockClient.complete as any).mock.calls[0][0]
      expect(callArgs.modelSettings).toEqual(modelSettings)
    })

    it('should fall back to thinkingContent when content is empty', async () => {
      const mockClient = createMockClient({
        ...defaultResponse,
        content: '',
        thinkingContent: 'React project setup',
      })

      const result = await generateSessionName({
        userMessage: 'How do I set up React?',
        llmClient: mockClient as any,
      })

      expect(result.success).toBe(true)
      expect(result.name).toBe('React project setup')
    })

    it('should fall back to thinkingContent when content is null-like', async () => {
      const mockClient = createMockClient({
        ...defaultResponse,
        content: '',
        thinkingContent: 'Fix auth bug',
      })

      const result = await generateSessionName({
        userMessage: 'Fix the authentication bug',
        llmClient: mockClient as any,
      })

      expect(result.success).toBe(true)
      expect(result.name).toBe('Fix auth bug')
    })

    it('should return failure when both content and thinkingContent are empty', async () => {
      const mockClient = createMockClient({
        ...defaultResponse,
        content: '',
      })

      const result = await generateSessionName({
        userMessage: 'Test message',
        llmClient: mockClient as any,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('too short')
    })
  })

  describe('generateSessionNameForSession', () => {
    it('should skip name generation when disableAutoSessionTitle is true', async () => {
      const { getRuntimeConfig } = await import('../runtime-config.js')
      ;(getRuntimeConfig as any).mockReturnValue({ disableAutoSessionTitle: true })

      const sessionManager = {
        getSession: vi.fn().mockReturnValue({ id: 'test', metadata: { title: null } } as unknown as Session),
      }
      const providerManager = {
        getProviders: vi.fn().mockReturnValue([]),
        getCurrentModel: vi.fn().mockReturnValue(null),
      }
      const broadcastForSession = vi.fn()
      const eventStore = { getEvents: vi.fn().mockReturnValue([]), append: vi.fn() }

      await generateSessionNameForSession('test-session', 'Hello world', {
        sessionManager: sessionManager as any,
        providerManager: providerManager as any,
        broadcastForSession,
        eventStore: eventStore as any,
      })

      expect(broadcastForSession).not.toHaveBeenCalled()
      expect(eventStore.append).not.toHaveBeenCalled()
    })

    it('includes the active workflow execution in the session.state broadcast so a paused user step is never wiped', async () => {
      const { getRuntimeConfig } = await import('../runtime-config.js')
      ;(getRuntimeConfig as any).mockReturnValue({ disableAutoSessionTitle: false })

      const waitingExec = {
        id: 'exec-1',
        sessionId: 'test-session',
        workflowId: 'default',
        workflowName: 'Build & Verify',
        status: 'waiting',
        currentStepId: 'choose-workspace',
        currentStepName: 'Choose workspace',
        stepOutput: {},
        params: {},
        pendingChoices: [{ id: 'yes', label: 'Yes', goto: '' }],
      }
      const session = {
        id: 'test-session',
        messages: [],
        metadata: { title: 'Session 1' },
      } as unknown as Session
      const sessionManager = {
        getSession: vi.fn().mockReturnValue(session),
        getDisplayWorkflowExecution: vi.fn().mockReturnValue(waitingExec),
        resolveEffectiveProviderModel: vi.fn(() => ({
          providerId: (session as any).providerId ?? null,
          model: (session as any).providerModel ?? null,
        })),
      }
      const client = {
        complete: vi.fn().mockResolvedValue({
          id: 'test-id',
          content: 'Nice title',
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }),
      }
      const broadcastForSession = vi.fn()
      const eventStore = {
        getEventsSinceSnapshot: vi.fn().mockReturnValue({ snapshot: undefined, events: [] }),
        append: vi.fn(),
      }

      await generateSessionNameForSession('test-session', 'Hello', {
        sessionManager: sessionManager as any,
        providerManager: {
          getProviders: vi.fn().mockReturnValue([]),
          getCurrentModel: vi.fn().mockReturnValue(null),
        } as any,
        broadcastForSession,
        eventStore: eventStore as any,
        getLLMClient: () => client as any,
      })

      const stateMsg = broadcastForSession.mock.calls
        .map((c: any[]) => c[1])
        .find((m: any) => m?.type === 'session.state')
      expect(stateMsg).toBeDefined()
      expect(stateMsg.payload.activeWorkflowExecution).toEqual(waitingExec)
    })

    it('uses the session provider client instead of mutating the active provider client', async () => {
      const { getRuntimeConfig } = await import('../runtime-config.js')
      ;(getRuntimeConfig as any).mockReturnValue({ disableAutoSessionTitle: false })

      const session = {
        id: 'test-session',
        providerId: 'lm-studio',
        providerModel: 'google/gemma-4-12b-qat',
        metadata: { title: 'Session 1' },
      } as unknown as Session
      const activeClient = {
        complete: vi.fn(),
        setModel: vi.fn(),
      }
      const sessionClient = {
        complete: vi.fn().mockResolvedValue({
          id: 'test-id',
          content: '',
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }),
      }
      const getLLMClientForProvider = vi.fn().mockReturnValue(sessionClient)
      const sessionManager = {
        getSession: vi.fn().mockReturnValue(session),
        resolveEffectiveProviderModel: vi.fn(() => ({
          providerId: (session as any).providerId ?? null,
          model: (session as any).providerModel ?? null,
        })),
      }
      const providerManager = {
        getProviders: vi.fn().mockReturnValue([
          {
            id: 'lm-studio',
            url: 'http://localhost:1234/v1',
            models: [{ id: 'google/gemma-4-12b-qat' }],
          },
        ]),
        getCurrentModel: vi.fn().mockReturnValue('gpt-5.6'),
        getModelSettings: vi.fn().mockReturnValue(undefined),
        resolveModelEffort: vi.fn(() => undefined),
      }

      await generateSessionNameForSession('test-session', 'Hello world', {
        sessionManager: sessionManager as any,
        providerManager: providerManager as any,
        broadcastForSession: vi.fn(),
        eventStore: { getEvents: vi.fn().mockReturnValue([]), append: vi.fn() } as any,
        getLLMClient: () => activeClient as any,
        getLLMClientForProvider,
      })

      expect(getLLMClientForProvider).toHaveBeenCalledWith('lm-studio', 'google/gemma-4-12b-qat')
      expect(sessionClient.complete).toHaveBeenCalledOnce()
      expect(activeClient.setModel).not.toHaveBeenCalled()
      expect(activeClient.complete).not.toHaveBeenCalled()
    })
  })

  describe('generateSessionNameForSession — progress & retry', () => {
    async function getSleepMock() {
      const { sleepThroughRetryBackoff } = await import('../chat/stream-pure.js')
      return sleepThroughRetryBackoff as ReturnType<typeof vi.fn>
    }

    function makeSession() {
      return {
        id: 'test-session',
        messages: [],
        metadata: { title: 'Session 1' },
      } as unknown as Session
    }

    function makeDeps(client: { complete: ReturnType<typeof vi.fn> }) {
      const session = makeSession()
      const sessionManager = {
        getSession: vi.fn().mockReturnValue(session),
        getDisplayWorkflowExecution: vi.fn().mockReturnValue(null),
        resolveEffectiveProviderModel: vi.fn(() => ({
          providerId: (session as { providerId?: string }).providerId ?? null,
          model: (session as { providerModel?: string }).providerModel ?? null,
        })),
      }
      const providerManager = {
        getProviders: vi.fn().mockReturnValue([]),
        getCurrentModel: vi.fn().mockReturnValue(null),
        getModelSettings: vi.fn().mockReturnValue(undefined),
      }
      return {
        sessionManager: sessionManager as any,
        providerManager: providerManager as any,
        broadcastForSession: vi.fn(),
        eventStore: { getEvents: vi.fn().mockReturnValue([]), append: vi.fn() } as any,
        getLLMClient: () => client as any,
      }
    }

    function nameGeneratingCalls(broadcastForSession: ReturnType<typeof vi.fn>) {
      return broadcastForSession.mock.calls
        .map((c: unknown[]) => c[1] as { type: string; payload?: Record<string, unknown> } | undefined)
        .filter((m) => m?.type === 'session.name_generating')
        .map((m) => m!.payload!)
    }

    const successResponse = {
      id: 'test-id',
      content: 'Nice title',
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }

    beforeEach(async () => {
      const { getRuntimeConfig } = await import('../runtime-config.js')
      ;(getRuntimeConfig as any).mockReturnValue({ disableAutoSessionTitle: false })
    })

    it('broadcasts naming start and finish around a successful attempt', async () => {
      const client = { complete: vi.fn().mockResolvedValue(successResponse) }
      const deps = makeDeps(client)

      await generateSessionNameForSession('test-session', 'Hello world', deps)

      const payloads = nameGeneratingCalls(deps.broadcastForSession)
      expect(payloads[0]).toEqual({ active: true, attempt: 1, maxAttempts: 10 })
      expect(payloads[payloads.length - 1]).toEqual({ active: false })
      expect(client.complete).toHaveBeenCalledOnce()
    })

    it('retries failed attempts with the shared LLM retry policy, reporting each attempt and backoff', async () => {
      const sleep = await getSleepMock()
      const client = {
        complete: vi
          .fn()
          .mockRejectedValueOnce(new Error('boom 1'))
          .mockRejectedValueOnce(new Error('boom 2'))
          .mockResolvedValueOnce(successResponse),
      }
      const deps = makeDeps(client)
      const signal = new AbortController().signal

      await generateSessionNameForSession('test-session', 'Hello world', deps, signal)

      expect(client.complete).toHaveBeenCalledTimes(3)
      const payloads = nameGeneratingCalls(deps.broadcastForSession)
      expect(payloads[0]).toEqual({ active: true, attempt: 1, maxAttempts: 10 })
      expect(payloads[1]).toEqual({ active: true, attempt: 2, maxAttempts: 10, retryInMs: 1000 })
      expect(payloads[2]).toEqual({ active: true, attempt: 3, maxAttempts: 10, retryInMs: 5000 })
      expect(payloads[payloads.length - 1]).toEqual({ active: false })

      expect(sleep).toHaveBeenNthCalledWith(1, 1000, 'test-session', signal)
      expect(sleep).toHaveBeenNthCalledWith(2, 5000, 'test-session', signal)
    })

    it('gives up after maxRetriesPerTurn failures and reports finish', async () => {
      const { buildRetryPatterns } = await import('../chat/orchestrator.js')
      ;(buildRetryPatterns as any).mockResolvedValueOnce({ retryPatterns: [], maxRetriesPerTurn: 2 })

      const client = { complete: vi.fn().mockRejectedValue(new Error('always fails')) }
      const deps = makeDeps(client)

      await generateSessionNameForSession('test-session', 'Hello world', deps)

      expect(client.complete).toHaveBeenCalledTimes(2)
      const payloads = nameGeneratingCalls(deps.broadcastForSession)
      expect(payloads[0]).toEqual({ active: true, attempt: 1, maxAttempts: 2 })
      expect(payloads[1]).toEqual({ active: true, attempt: 2, maxAttempts: 2, retryInMs: 1000 })
      expect(payloads[payloads.length - 1]).toEqual({ active: false })
      ;(buildRetryPatterns as any).mockResolvedValue({ retryPatterns: [], maxRetriesPerTurn: 10 })
    })

    it('stops retrying when the abort signal fires during the backoff', async () => {
      const sleep = await getSleepMock()
      ;(sleep as any).mockResolvedValueOnce('aborted')

      const client = { complete: vi.fn().mockRejectedValue(new Error('boom')) }
      const deps = makeDeps(client)

      await generateSessionNameForSession('test-session', 'Hello world', deps, new AbortController().signal)

      expect(client.complete).toHaveBeenCalledTimes(1)
      const payloads = nameGeneratingCalls(deps.broadcastForSession)
      expect(payloads[payloads.length - 1]).toEqual({ active: false })
    })

    it('passes the caller signal through unchanged (no hardcoded 120s timeout)', async () => {
      const client = { complete: vi.fn().mockResolvedValue(successResponse) }
      const deps = makeDeps(client)
      const signal = new AbortController().signal

      await generateSessionNameForSession('test-session', 'Hello world', deps, signal)

      const callArgs = (client.complete as any).mock.calls[0][0]
      expect(callArgs.signal).toBe(signal)
    })

    it('passes the configured LLM idle timeout to the fallback client', async () => {
      const { getRuntimeConfig } = await import('../runtime-config.js')
      ;(getRuntimeConfig as any).mockReturnValue({ disableAutoSessionTitle: false, llm: { idleTimeout: 300_000 } })
      const { createLLMClient } = await import('../llm/client.js')

      const fallbackClient = {
        complete: vi.fn().mockResolvedValue(successResponse),
        setModel: vi.fn(),
      }
      ;(createLLMClient as any).mockReturnValue(fallbackClient)

      const session = {
        id: 'test-session',
        providerId: 'lm-studio',
        providerModel: 'some-model',
        metadata: { title: 'Session 1' },
      } as unknown as Session
      const sessionManager = {
        getSession: vi.fn().mockReturnValue(session),
        resolveEffectiveProviderModel: vi.fn(() => ({
          providerId: (session as { providerId?: string }).providerId ?? null,
          model: (session as { providerModel?: string }).providerModel ?? null,
        })),
      }
      const providerManager = {
        getProviders: vi
          .fn()
          .mockReturnValue([{ id: 'lm-studio', url: 'http://localhost:1234/v1', models: [{ id: 'some-model' }] }]),
        getCurrentModel: vi.fn().mockReturnValue('some-model'),
        getModelSettings: vi.fn().mockReturnValue(undefined),
      }

      await generateSessionNameForSession('test-session', 'Hello world', {
        sessionManager: sessionManager as any,
        providerManager: providerManager as any,
        broadcastForSession: vi.fn(),
        eventStore: { getEvents: vi.fn().mockReturnValue([]), append: vi.fn() } as any,
      })

      expect(createLLMClient).toHaveBeenCalledWith(
        expect.objectContaining({
          llm: expect.objectContaining({ baseUrl: 'http://localhost:1234/v1', idleTimeout: 300_000 }),
        }),
        'unknown',
      )
      expect(fallbackClient.complete).toHaveBeenCalledOnce()
    })

    it('generateSessionName passes the caller signal through unchanged', async () => {
      const mockClient = {
        complete: vi.fn().mockResolvedValue({
          id: 'test-id',
          content: 'React setup',
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }),
        getModel: vi.fn().mockReturnValue('test-model'),
        setModel: vi.fn(),
        getProfile: vi.fn(),
        getBackend: vi.fn().mockReturnValue('unknown'),
        setBackend: vi.fn(),
      }
      const signal = new AbortController().signal

      await generateSessionName({
        userMessage: 'How do I set up React?',
        llmClient: mockClient as any,
        signal,
      })

      const callArgs = (mockClient.complete as any).mock.calls[0][0]
      expect(callArgs.signal).toBe(signal)
    })
  })

  describe('SESSION_NAME_PROMPT', () => {
    it('should be ultra-lightweight with no project context', () => {
      // Verify the prompt is minimal and doesn't contain project-related keywords
      // Note: We check the actual prompt content, not comments
      expect(SESSION_NAME_PROMPT).not.toContain('project_id')
      expect(SESSION_NAME_PROMPT).not.toContain('workdir')
      expect(SESSION_NAME_PROMPT).not.toContain('project context')
      expect(SESSION_NAME_PROMPT).not.toContain('system instructions')

      // Should contain name generation instructions
      expect(SESSION_NAME_PROMPT).toContain('Generate')
      expect(SESSION_NAME_PROMPT).toContain('session name')
      expect(SESSION_NAME_PROMPT).toContain('50 characters')
    })
  })
})
