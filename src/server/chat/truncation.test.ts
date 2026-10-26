import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LLMCompletionResponse, LLMStreamEvent } from '../llm/types.js'
import { consumeStreamGenerator, createChatDoneEvent, streamLLMPure } from './stream-pure.js'

function createMockClient(events: LLMStreamEvent[]) {
  return {
    complete: async () => {
      throw new Error('Not implemented')
    },
    getModel: () => 'test-model',
    getProfile: () => ({}) as never,
    getBackend: () => 'unknown' as const,
    getBaseUrl: () => '',
    setBackend: () => {},
    setModel: () => {},
    stream: async function* () {
      for (const event of events) {
        yield event
      }
    },
  }
}

describe('finishReason propagation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('propagates finishReason "length" through PureStreamResult', async () => {
    const response: LLMCompletionResponse = {
      id: 'resp-1',
      content: 'This response was truncated because ',
      finishReason: 'length',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    }

    const client = createMockClient([
      { type: 'text_delta', content: 'This response was truncated because ' },
      { type: 'done', response },
    ])

    const gen = streamLLMPure({
      messageId: 'msg-1',
      systemPrompt: 'system',
      llmClient: client,
      messages: [{ role: 'user', content: 'hello' }],
    })

    const result = await consumeStreamGenerator(gen, () => {})

    expect(result.finishReason).toBe('length')
    expect(result.content).toBe('This response was truncated because ')
  })

  it('propagates finishReason "stop" through PureStreamResult', async () => {
    const response: LLMCompletionResponse = {
      id: 'resp-2',
      content: 'Complete answer.',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    }

    const client = createMockClient([
      { type: 'text_delta', content: 'Complete answer.' },
      { type: 'done', response },
    ])

    const gen = streamLLMPure({
      messageId: 'msg-2',
      systemPrompt: 'system',
      llmClient: client,
      messages: [{ role: 'user', content: 'hello' }],
    })

    const result = await consumeStreamGenerator(gen, () => {})

    expect(result.finishReason).toBe('stop')
  })

  it('propagates finishReason "tool_calls" through PureStreamResult', async () => {
    const response: LLMCompletionResponse = {
      id: 'resp-3',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'test.ts' } }],
      finishReason: 'tool_calls',
      usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
    }

    const client = createMockClient([
      { type: 'tool_call_delta', index: 0, name: 'read_file' },
      { type: 'tool_call_delta', index: 0, arguments: '{"path":"test.ts"}' },
      { type: 'done', response },
    ])

    const gen = streamLLMPure({
      messageId: 'msg-3',
      systemPrompt: 'system',
      llmClient: client,
      messages: [{ role: 'user', content: 'read file' }],
    })

    const result = await consumeStreamGenerator(gen, () => {})

    expect(result.finishReason).toBe('tool_calls')
  })

  it('defaults finishReason to "stop" when stream is aborted with no result', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = createMockClient([])

    const gen = streamLLMPure({
      messageId: 'msg-4',
      systemPrompt: 'system',
      llmClient: client,
      messages: [{ role: 'user', content: 'hello' }],
      signal: controller.signal,
    })

    const result = await consumeStreamGenerator(gen, () => {})

    expect(result.aborted).toBe(true)
    expect(result.finishReason).toBe('stop')
  })

  it('propagates finishReason "length" with thinking content', async () => {
    const response: LLMCompletionResponse = {
      id: 'resp-5',
      content: '',
      thinkingContent: 'I was thinking very deeply about this and ',
      finishReason: 'length',
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    }

    const client = createMockClient([
      { type: 'thinking_delta', content: 'I was thinking very deeply about this and ' },
      { type: 'done', response },
    ])

    const gen = streamLLMPure({
      messageId: 'msg-5',
      systemPrompt: 'system',
      llmClient: client,
      messages: [{ role: 'user', content: 'think hard' }],
    })

    const result = await consumeStreamGenerator(gen, () => {})

    expect(result.finishReason).toBe('length')
    expect(result.thinkingContent).toBe('I was thinking very deeply about this and ')
  })
})

describe('createChatDoneEvent with truncated reason', () => {
  it('creates chat.done event with truncated reason', () => {
    const event = createChatDoneEvent('msg-1', 'truncated')
    expect(event).toEqual({
      type: 'chat.done',
      data: { messageId: 'msg-1', reason: 'truncated' },
    })
  })

  it('creates chat.done event with complete reason', () => {
    const event = createChatDoneEvent('msg-2', 'complete')
    expect(event).toEqual({
      type: 'chat.done',
      data: { messageId: 'msg-2', reason: 'complete' },
    })
  })
})
