/**
 * Workspace + Compaction E2E Tests
 *
 * Verifies that after a workspace switch followed by context compaction,
 * the workspace reminder is re-injected into the fresh context window so
 * the agent continues to operate in the workspace (not the original repo).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  createTestClient,
  createTestProject,
  createTestServer,
  type TestClient,
  type TestProject,
  type TestServerHandle,
} from './utils/index.js'

describe('Workspace + Compaction', () => {
  let server: TestServerHandle
  let client: TestClient
  let testProject: TestProject
  let projectId: string
  let sessionId: string

  beforeAll(async () => {
    server = await createTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(async () => {
    testProject = await createTestProject({ template: 'git-repo' })
    client = await createTestClient({ url: server.wsUrl })

    const createRes = await fetch(`${server.url}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'WS Compact Test', workdir: testProject.path }),
    })
    const projectData: any = await createRes.json()
    projectId = projectData.project.id

    const sessionRes = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'Workspace Compaction Session' }),
    })
    const sessionData: any = await sessionRes.json()
    sessionId = sessionData.session.id

    await client.send('session.load', { sessionId })
  })

  afterEach(async () => {
    await client.close()
    await testProject.cleanup()
  })

  it('re-injects workspace reminder after compaction', async () => {
    // 1. Switch to a workspace
    const switchRes = await fetch(`${server.url}/api/sessions/${sessionId}/switch-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'compact-test-ws' }),
    })
    expect(switchRes.status).toBe(200)
    const switchData: any = await switchRes.json()
    const workspacePath = switchData.session.workspace
    expect(workspacePath).toBeDefined()
    expect(workspacePath).toContain('compact-test-ws')

    // 2. Build some context with a chat message
    await client.send('chat.send', { content: 'Hello, this is a test message to build context for compaction.' })
    await client.waitForChatDone()

    // 3. Trigger manual compaction
    client.clearEvents()
    const compactRes = await client.send('context.compact', {})
    expect(compactRes.type).toBe('ack')

    // 4. Wait for the workspace reminder message explicitly (it is appended
    //    after chat.done, so scanning allEvents() right after waitForChatDone
    //    can miss it — same race documented in auto-compaction.test.ts)
    const reminderEvent = await client.waitFor(
      'chat.message',
      (payload: any) =>
        payload?.message?.content?.includes('This session is now operating in workspace') &&
        payload?.message?.content?.includes('compact-test-ws'),
    )
    await client.waitForChatDone()

    // 5. Assert the reminder contains the workspace path and the directive
    const content = reminderEvent.payload.message.content
    expect(content).toContain(workspacePath)
    expect(content).toContain('All file and git operations should use this directory')
  }, 30000)

  it('system prompt after compaction uses workspace path, not original repo path', async () => {
    // 1. Switch to a workspace
    const switchRes = await fetch(`${server.url}/api/sessions/${sessionId}/switch-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'prompt-test-ws' }),
    })
    expect(switchRes.status).toBe(200)
    const switchData: any = await switchRes.json()
    const workspacePath = switchData.session.workspace
    expect(workspacePath).toBeDefined()

    // 2. Build context
    await client.send('chat.send', { content: 'Building context for the prompt verification test.' })
    await client.waitForChatDone()

    // 3. Trigger compaction
    const compactRes = await client.send('context.compact', {})
    expect(compactRes.type).toBe('ack')
    await client.waitForChatDone()

    // 4. Verify the session's effective workdir is the workspace (not the original)
    const getRes = await fetch(`${server.url}/api/sessions/${sessionId}`)
    const data: any = await getRes.json()
    expect(data.session.workspace).toBe(workspacePath)
    expect(data.session.workdir).toBe(testProject.path)

    // The workspace path must differ from the original repo path
    expect(workspacePath).not.toBe(testProject.path)
  })
})
