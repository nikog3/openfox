/**
 * Fold Compaction E2E Tests
 *
 * Verifies both compaction strategies end-to-end against the mock LLM:
 * - One-shot: when the conversation fits window - summary budget - output
 *   reserve, a single streaming LLM call summarizes it (current behavior).
 * - Sequential fold: when the one-shot fit would drop more than half the
 *   conversation, the fold summarizes the first half with a non-streaming
 *   call, then produces the final summary from [summary + second half] —
 *   both calls with maxTokens 4096 and reasoning off, no overlap.
 * The result replaces the conversation via the existing context.compacted
 * event flow (summary message + fresh window).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  createTestClient,
  createTestProject,
  createTestServer,
  createProject,
  createSession,
  type TestClient,
  type TestProject,
  type TestServerHandle,
} from './utils/index.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'

interface MockCallLogEntry {
  kind: 'complete' | 'stream'
  maxTokens: number | null
  hasTools: boolean
  toolChoice: string | null
  reasoningEffort: string | null
  messageCount: number
  lastMessageRole: string | null
}

function readCallLog(path: string): MockCallLogEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MockCallLogEntry)
}

function summaryCalls(calls: MockCallLogEntry[]): MockCallLogEntry[] {
  return calls.filter((call) => call.maxTokens === 4096)
}

interface ContextState {
  currentTokens: number
  maxTokens: number
  compactionCount: number
  canCompact: boolean
  dangerZone: boolean
}

// context.compacted is an internal event-store event, never broadcast over
// WS — the observable boundary is the summary message + the incremented
// compactionCount in context.state.
async function waitForCompactionCount(client: TestClient, before: number): Promise<number> {
  await client.waitFor('context.state', (p) => (p as { context: ContextState }).context.compactionCount > before)
  const events = client.allEvents().filter((e) => e.type === 'context.state')
  return (events[events.length - 1]!.payload as { context: ContextState }).context.compactionCount
}

describe('Sequential Fold Compaction', () => {
  // 16384 window -> input budget (16384 - 4096 - 2048) * 2.4 = 24576 chars.
  // 16000 + 3000 + 3000 chars: the one-shot fit would drop the 16000-char
  // message (more than half the wire) -> fold. The first half fits one call,
  // [summary + second half] fits the final call -> exactly two calls.
  const BIG_MESSAGE_CHARS = 16000
  const SMALL_MESSAGE_CHARS = 3000

  let server: TestServerHandle
  let client: TestClient
  let testDir: TestProject
  let controlPath: string
  let callLogPath: string

  beforeAll(async () => {
    server = await createTestServer({ maxContext: 16384 })
    controlPath = join(tmpdir(), `openfox-e2e-mock-control-${randomUUID()}.json`)
    callLogPath = join(tmpdir(), `openfox-e2e-mock-calls-${randomUUID()}.ndjson`)
    writeFileSync(controlPath, JSON.stringify({ callLog: callLogPath }))
    process.env['OPENFOX_MOCK_CONTROL'] = controlPath
  })

  afterAll(async () => {
    await server.close()
    delete process.env['OPENFOX_MOCK_CONTROL']
    await unlink(controlPath).catch(() => {})
    await unlink(callLogPath).catch(() => {})
  })

  beforeEach(async () => {
    client = await createTestClient({ url: server.wsUrl })
    testDir = await createTestProject({ template: 'typescript' })
    const restProject = await createProject(server.url, { name: 'Fold Compaction', workdir: testDir.path })
    const restSession = await createSession(server.url, { projectId: restProject.id })
    await client.send('session.load', { sessionId: restSession.id })
  })

  afterEach(async () => {
    await client.close()
    await testDir.cleanup()
  })

  it('folds in exactly two summary calls and replaces the conversation', async () => {
    await client.send('chat.send', { content: 'B'.repeat(BIG_MESSAGE_CHARS) })
    await client.waitForChatDone()
    await client.send('chat.send', { content: 'S'.repeat(SMALL_MESSAGE_CHARS) })
    await client.waitForChatDone()
    await client.send('chat.send', { content: 'S'.repeat(SMALL_MESSAGE_CHARS) })
    await client.waitForChatDone()

    const beforeCount = client.getContextState()?.compactionCount ?? 0

    const response = await client.send('context.compact', {})
    expect(response.type).toBe('ack')
    const done = await client.waitForChatDone()
    expect(done.reason).toBe('complete')

    const afterCount = await waitForCompactionCount(client, beforeCount)
    expect(afterCount).toBe(beforeCount + 1)

    const events = client.allEvents()
    expect(events.filter((e) => e.type === 'chat.error').length).toBe(0)
    const summaryEvent = events.find(
      (e) =>
        e.type === 'chat.message' &&
        (e.payload as { message: { isCompactionSummary?: boolean } }).message.isCompactionSummary,
    )
    expect(summaryEvent).toBeDefined()
    const summary = (summaryEvent!.payload as { message: { content: string } }).message.content
    expect(summary.length).toBeGreaterThanOrEqual(50)

    const calls = summaryCalls(readCallLog(callLogPath))
    // The fold uses non-streaming complete() calls, never the stream path.
    expect(calls.filter((c) => c.kind === 'complete').length).toBe(2)
    expect(calls.filter((c) => c.kind === 'stream').length).toBe(0)
    for (const call of calls) {
      expect(call.reasoningEffort).toBe('none')
      expect(call.hasTools).toBe(false)
    }
  }, 30000)
})

describe('One-Shot Compaction', () => {
  // 131072 window -> input budget (131072 - 4096 - 2048) * 2.4 = 299827 chars.
  // 100000 + 100000 chars fit with room to spare -> single streaming call.
  const MESSAGE_CHARS = 100000

  let server: TestServerHandle
  let client: TestClient
  let testDir: TestProject
  let controlPath: string
  let callLogPath: string

  beforeAll(async () => {
    server = await createTestServer({ maxContext: 131072 })
    controlPath = join(tmpdir(), `openfox-e2e-mock-control-${randomUUID()}.json`)
    callLogPath = join(tmpdir(), `openfox-e2e-mock-calls-${randomUUID()}.ndjson`)
    writeFileSync(controlPath, JSON.stringify({ callLog: callLogPath }))
    process.env['OPENFOX_MOCK_CONTROL'] = controlPath
  })

  afterAll(async () => {
    await server.close()
    delete process.env['OPENFOX_MOCK_CONTROL']
    await unlink(controlPath).catch(() => {})
    await unlink(callLogPath).catch(() => {})
  })

  beforeEach(async () => {
    client = await createTestClient({ url: server.wsUrl })
    testDir = await createTestProject({ template: 'typescript' })
    const restProject = await createProject(server.url, { name: 'One-Shot Compaction', workdir: testDir.path })
    const restSession = await createSession(server.url, { projectId: restProject.id })
    await client.send('session.load', { sessionId: restSession.id })
  })

  afterEach(async () => {
    await client.close()
    await testDir.cleanup()
  })

  it('summarizes in a single streaming call when the input fits the budget', async () => {
    await client.send('chat.send', { content: 'A'.repeat(MESSAGE_CHARS) })
    await client.waitForChatDone()
    await client.send('chat.send', { content: 'A'.repeat(MESSAGE_CHARS) })
    await client.waitForChatDone()

    const beforeCount = client.getContextState()?.compactionCount ?? 0

    const response = await client.send('context.compact', {})
    expect(response.type).toBe('ack')
    const done = await client.waitForChatDone()
    expect(done.reason).toBe('complete')

    const afterCount = await waitForCompactionCount(client, beforeCount)
    expect(afterCount).toBe(beforeCount + 1)

    const events = client.allEvents()
    expect(events.filter((e) => e.type === 'chat.error').length).toBe(0)

    const calls = summaryCalls(readCallLog(callLogPath))
    expect(calls.length).toBe(1)
    expect(calls[0]!.kind).toBe('stream')
    expect(calls[0]!.reasoningEffort).toBe('none')
  }, 30000)
})
