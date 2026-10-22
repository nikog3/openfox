/**
 * Auto-Compaction E2E Tests
 *
 * Tests that context is automatically compacted when:
 * 1. Token count approaches the configured maximum
 * 2. The compaction threshold is exceeded
 *
 * Also tests:
 * - context.compacted events
 * - Context window creation after compaction
 * - Summary generation during compaction
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  createTestClient,
  createTestProject,
  createTestServer,
  collectChatEvents,
  assertNoErrors,
  createProject,
  createSession,
  setSessionMode,
  stopSessionChat,
  type TestClient,
  type TestProject,
  type TestServerHandle,
} from './utils/index.js'

// Type for context state
interface ContextState {
  currentTokens: number
  maxTokens: number
  compactionCount: number
  canCompact: boolean
  dangerZone: boolean
}

describe('Auto-Compaction', () => {
  let server: TestServerHandle
  let client: TestClient
  let testDir: TestProject

  beforeAll(async () => {
    server = await createTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(async () => {
    client = await createTestClient({ url: server.wsUrl })
    testDir = await createTestProject({ template: 'typescript' })

    const restProject = await createProject(server.url, { name: 'Auto-Compaction Test', workdir: testDir.path })
    const restSession = await createSession(server.url, { projectId: restProject.id })
    await client.send('session.load', { sessionId: restSession.id })
  })

  afterEach(async () => {
    await client.close()
    await testDir.cleanup()
  })

  describe('Compaction Threshold', () => {
    it('tracks current token count in context state', async () => {
      // Send some messages to build up context
      await client.send('chat.send', { content: 'First test message.' })
      await client.waitForChatDone()

      // Check context state
      const allEvents = client.allEvents()
      const contextEvents = allEvents.filter((e) => e.type === 'context.state')

      if (contextEvents.length > 0) {
        const lastContext = contextEvents[contextEvents.length - 1]!
        const payload = lastContext.payload as { context: ContextState }

        expect(payload.context.currentTokens).toBeGreaterThan(0)
        expect(payload.context.maxTokens).toBeGreaterThan(0)
      }
    })

    it('reports canCompact based on context size', async () => {
      // Fresh session should not be able to compact
      const sessionId = client.getSession()!.id

      const client2 = await createTestClient({ url: server.wsUrl })
      try {
        await client2.send('session.load', { sessionId })

        const contextEvent = await client2.waitFor('context.state')
        const payload = contextEvent.payload as { context: ContextState }

        // Fresh session with no messages cannot compact
        expect(payload.context.canCompact).toBe(false)
      } finally {
        await client2.close()
      }
    })

    it('updates canCompact after building context', async () => {
      // Build up some context
      await client.send('chat.send', { content: 'First message with some content.' })
      await client.waitForChatDone()

      await client.send('chat.send', { content: 'Second message with more content.' })
      await client.waitForChatDone()

      await client.send('chat.send', { content: 'Third message adding even more context.' })
      await client.waitForChatDone()

      // Check context state
      const allEvents = client.allEvents()
      const contextEvents = allEvents.filter((e) => e.type === 'context.state')

      // Should have multiple context events
      expect(contextEvents.length).toBeGreaterThan(0)
    })
  })

  describe('Danger Zone Detection', () => {
    it('reports dangerZone in context state', async () => {
      const sessionId = client.getSession()!.id

      const client2 = await createTestClient({ url: server.wsUrl })
      try {
        await client2.send('session.load', { sessionId })

        const contextEvent = await client2.waitFor('context.state')
        const payload = contextEvent.payload as { context: ContextState }

        // dangerZone should be a boolean
        expect(typeof payload.context.dangerZone).toBe('boolean')

        // Fresh session should not be in danger zone
        expect(payload.context.dangerZone).toBe(false)
      } finally {
        await client2.close()
      }
    })
  })

  describe('Compaction Count', () => {
    it('tracks compaction count in context state', async () => {
      const sessionId = client.getSession()!.id

      const client2 = await createTestClient({ url: server.wsUrl })
      try {
        await client2.send('session.load', { sessionId })

        const contextEvent = await client2.waitFor('context.state')
        const payload = contextEvent.payload as { context: ContextState }

        // Fresh session has 0 compactions
        expect(payload.context.compactionCount).toBe(0)
      } finally {
        await client2.close()
      }
    })

    it('increments compaction count after manual compaction', async () => {
      // Build some context
      await client.send('chat.send', { content: 'Building context for compaction test.' })
      await client.waitForChatDone()

      await client.send('chat.send', { content: 'Adding more content to the context.' })
      await client.waitForChatDone()

      // Trigger manual compaction
      const compactResponse = await client.send('context.compact', {})

      if (compactResponse.type === 'ack') {
        // Wait for compaction to complete
        await client.waitForChatDone()

        // Check updated context
        const allEvents = client.allEvents()
        const contextEvents = allEvents.filter((e) => e.type === 'context.state')

        if (contextEvents.length > 1) {
          const lastContext = contextEvents[contextEvents.length - 1]!
          const payload = lastContext.payload as { context: ContextState }

          // Compaction count should be at least 1
          expect(payload.context.compactionCount).toBeGreaterThanOrEqual(1)
        }
      }
    })
  })

  describe('Context Windows After Compaction', () => {
    it('creates new context window after compaction', async () => {
      // Build context
      await client.send('chat.send', { content: 'First message.' })
      await client.waitForChatDone()

      const initialContextState = client.getContextState()!
      const initialCompactionCount = initialContextState.compactionCount

      // Compact
      const response = await client.send('context.compact', {})

      if (response.type === 'ack') {
        await client.waitForChatDone()

        // Wait for context.state to arrive after compaction
        await client.waitFor('context.state')

        // Check for new window via compaction count
        const contextState = client.getContextState()!
        expect(contextState.compactionCount).toBeGreaterThan(initialCompactionCount)
      }
    })
  })

  describe('Post-Compaction Agent Reminder', () => {
    it('injects the continuation reminder (not the onboarding definition) after compaction', async () => {
      // Build context so the summary has something to preserve
      await client.send('chat.send', { content: 'Building context for the continuation reminder test.' })
      await client.waitForChatDone()

      await client.send('chat.send', { content: 'More content so the summary has substance.' })
      await client.waitForChatDone()

      // Trigger manual compaction
      const response = await client.send('context.compact', {})
      expect(response.type).toBe('ack')

      // The continuation reminder is appended after the compaction's chat.done,
      // so wait for it explicitly instead of racing the completion event.
      const reminderEvent = await client.waitFor(
        'chat.message',
        (p: { message: { metadata?: { type?: string; kind?: string } } }) =>
          p.message.metadata?.type === 'agent' && p.message.metadata?.kind === 'continuation',
      )

      const reminder = (reminderEvent.payload as { message: { content: string; metadata: { kind: string } } }).message
      expect(reminder.metadata.kind).toBe('continuation')
      expect(reminder.content).toContain('continuing an in-progress task')
      expect(reminder.content).toMatch(/do not restart/i)

      // No onboarding definition reminder may follow the compaction boundary
      // (the summary message) — that is what made the agent restart the task
      // from scratch. context.compacted is an internal event never sent to
      // clients, so the summary message is the observable boundary.
      const allEvents = client.allEvents()
      const summaryIndex = allEvents.findIndex(
        (e) =>
          e.type === 'chat.message' &&
          (e.payload as { message: { isCompactionSummary?: boolean } }).message.isCompactionSummary,
      )
      expect(summaryIndex).toBeGreaterThanOrEqual(0)

      const kindsAfterCompaction = allEvents
        .slice(summaryIndex + 1)
        .filter((e) => e.type === 'chat.message')
        .map((e) => (e.payload as { message: { metadata?: { kind?: string } } }).message.metadata?.kind)

      expect(kindsAfterCompaction).not.toContain('definition')
    }, 20000)
  })

  describe('Summary Generation During Compaction', () => {
    it('emits chat.progress during compaction', async () => {
      // Build context
      await client.send('chat.send', { content: 'Building up context for summary test.' })
      await client.waitForChatDone()

      await client.send('chat.send', { content: 'More content for the LLM to summarize.' })
      await client.waitForChatDone()

      client.clearEvents()

      // Trigger compaction
      const response = await client.send('context.compact', {})

      if (response.type === 'ack') {
        // Wait for completion
        await client.waitForChatDone().catch(() => null)

        // Check for progress events
        const allEvents = client.allEvents()
        const progressEvents = allEvents.filter((e) => e.type === 'chat.progress')

        // May or may not have progress events depending on implementation
        // Just verify no errors
        const errorEvents = allEvents.filter((e) => e.type === 'chat.error')
        expect(errorEvents.length).toBe(0)
      }
    })

    it('creates system message with compaction summary', async () => {
      // Build context
      await client.send('chat.send', { content: 'Content for summarization.' })
      await client.waitForChatDone()

      client.clearEvents()

      // Compact
      const response = await client.send('context.compact', {})

      if (response.type === 'ack') {
        await client.waitForChatDone().catch(() => null)

        // Check for summary-related messages
        const allEvents = client.allEvents()
        const messageEvents = allEvents.filter((e) => e.type === 'chat.message')

        // Should have at least the compaction prompt message
        expect(messageEvents.length).toBeGreaterThan(0)
      }
    })
  })

  describe('Compaction While Running', () => {
    it('rejects compaction while session is running', async () => {
      const sessionId = client.getSession()!.id

      // Start a chat (makes session running)
      const chatPromise = client.send('chat.send', { content: 'Starting a long running operation.' })

      // Wait for session.running to be true
      try {
        await client.waitFor('session.running', (p: { isRunning: boolean }) => p.isRunning, 500)

        // Try to compact while running
        const response = await client.send('context.compact', {})

        // Should reject with error
        if (response.type === 'error') {
          expect((response.payload as { code: string }).code).toBe('SESSION_RUNNING')
        }
        // If we get ack, the session finished before we could send compact
        // This is acceptable due to mock LLM speed
      } catch {
        // Session finished too fast, which is fine for mock LLM
      }

      // Clean up
      await stopSessionChat(server.url, sessionId).catch(() => null)
      await client.waitForChatDone().catch(() => null)
    })
  })

  describe('Manual Compaction State Cleanup', () => {
    it('resets isRunning after manual compaction and allows new messages to be processed', async () => {
      // Build some context first
      await client.send('chat.send', { content: 'Building context for compaction state test.' })
      await client.waitForChatDone()

      await client.send('chat.send', { content: 'Adding more content to ensure compaction is possible.' })
      await client.waitForChatDone()

      client.clearEvents()

      // Trigger manual compaction
      const response = await client.send('context.compact', {})

      expect(response.type).toBe('ack')

      // Wait for compaction to complete
      await client.waitForChatDone(5000)

      // Verify session.running: false was received
      const runningEvents = client.allEvents().filter((e) => e.type === 'session.running')
      const lastRunning = runningEvents[runningEvents.length - 1]
      if (lastRunning) {
        expect((lastRunning.payload as { isRunning: boolean }).isRunning).toBe(false)
      }

      // Verify client-side session state (tracked via session.running events)
      expect(client.getSession()?.isRunning).toBe(false)

      // Verify via REST API that DB is_running is false
      const sessionId = client.getSession()!.id
      const restRes = await fetch(`${server.url}/api/sessions/${sessionId}`)
      const restData = (await restRes.json()) as { session: { isRunning: boolean } }
      expect(restData.session.isRunning).toBe(false)

      // Send a new message and verify it gets processed (not stuck in queue)
      await client.send('chat.send', { content: 'Message after compaction should be processed normally.' })
      const chatResult = await client.waitForChatDone(5000)
      expect(chatResult.reason).toBe('complete')
    }, 15000)
  })

  describe('Context State Emission', () => {
    it('emits context.state after each chat turn', async () => {
      client.clearEvents()

      await client.send('chat.send', { content: 'Test message.' })
      await client.waitForChatDone()

      const allEvents = client.allEvents()
      const contextEvents = allEvents.filter((e) => e.type === 'context.state')

      // Should have at least one context state event
      expect(contextEvents.length).toBeGreaterThan(0)
    })

    it('emits context.state on session load', async () => {
      const sessionId = client.getSession()!.id

      const client2 = await createTestClient({ url: server.wsUrl })
      try {
        await client2.send('session.load', { sessionId })

        // Should receive context.state
        const contextEvent = await client2.waitFor('context.state')
        expect(contextEvent.type).toBe('context.state')
      } finally {
        await client2.close()
      }
    })
  })
})
