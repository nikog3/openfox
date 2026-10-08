import { describe, it, expect } from 'vitest'
import {
  estimateToolResultTokens,
  isContextLengthError,
  parseContextLengthError,
  CHARS_PER_TOKEN,
  TOOL_MESSAGE_OVERHEAD_TOKENS,
} from './token-budget.js'

describe('estimateToolResultTokens', () => {
  it('returns 0 for no tool messages', () => {
    expect(estimateToolResultTokens([])).toBe(0)
  })

  it('estimates content tokens plus per-message overhead', () => {
    const content = 'a'.repeat(CHARS_PER_TOKEN * 10)
    expect(estimateToolResultTokens([{ content }])).toBe(TOOL_MESSAGE_OVERHEAD_TOKENS + 10)
  })

  it('rounds partial token buckets up per message', () => {
    expect(estimateToolResultTokens([{ content: 'abc' }])).toBe(TOOL_MESSAGE_OVERHEAD_TOKENS + 1)
    expect(estimateToolResultTokens([{ content: 'abcde' }])).toBe(TOOL_MESSAGE_OVERHEAD_TOKENS + 2)
  })

  it('sums estimates across multiple tool messages', () => {
    const a = 'a'.repeat(CHARS_PER_TOKEN * 5)
    const b = 'b'.repeat(CHARS_PER_TOKEN * 7)
    expect(estimateToolResultTokens([{ content: a }, { content: b }])).toBe(2 * TOOL_MESSAGE_OVERHEAD_TOKENS + 12)
  })
})

describe('isContextLengthError', () => {
  it('detects OpenAI-style maximum context length errors', () => {
    expect(
      isContextLengthError(
        "HTTP 400: This model's maximum context length is 128000 tokens. However, you requested 130000 tokens (120000 in the messages, 10000 in the completion).",
      ),
    ).toBe(true)
  })

  it('detects context window and context_length markers', () => {
    expect(isContextLengthError('context window exceeded')).toBe(true)
    expect(isContextLengthError('context_length is too long')).toBe(true)
  })

  it('detects prompt-too-long framing', () => {
    expect(isContextLengthError('Prompt is too long (12345 tokens > 8192 tokens)')).toBe(true)
  })

  it('does not match generic token errors without context framing', () => {
    expect(isContextLengthError('too many tokens')).toBe(false)
    expect(isContextLengthError('maximum output tokens exceeded')).toBe(false)
  })

  it('returns false for unrelated errors and empty input', () => {
    expect(isContextLengthError('Connection refused')).toBe(false)
    expect(isContextLengthError('HTTP 500: internal server error')).toBe(false)
    expect(isContextLengthError(undefined)).toBe(false)
    expect(isContextLengthError('')).toBe(false)
  })
})

describe('parseContextLengthError', () => {
  it('extracts actual and limit from llama.cpp context size errors', () => {
    expect(
      parseContextLengthError('request (154020 tokens) exceeds the available context size (150016 tokens)'),
    ).toEqual({ actualTokens: 154020, serverLimit: 150016 })
  })

  it('extracts actual and limit from OpenAI/vLLM maximum context length errors', () => {
    expect(
      parseContextLengthError(
        "HTTP 400: This model's maximum context length is 128000 tokens. However, you requested 130000 tokens (120000 in the messages, 10000 in the completion).",
      ),
    ).toEqual({ actualTokens: 130000, serverLimit: 128000 })
  })

  it('extracts actual and limit from Anthropic prompt-too-long errors', () => {
    expect(parseContextLengthError('prompt is too long: 12345 tokens > 8192 max tokens')).toEqual({
      actualTokens: 12345,
      serverLimit: 8192,
    })
  })

  it('extracts actual and limit from sglang prompt-too-long errors', () => {
    expect(parseContextLengthError('prompt is too long (12345 tokens > 8192 tokens)')).toEqual({
      actualTokens: 12345,
      serverLimit: 8192,
    })
  })

  it('returns only the available number when the other is missing', () => {
    expect(parseContextLengthError("This model's maximum context length is 128000 tokens.")).toEqual({
      serverLimit: 128000,
    })
  })

  it('returns an empty object for unknown messages', () => {
    expect(parseContextLengthError('too many tokens')).toEqual({})
    expect(parseContextLengthError('Connection refused')).toEqual({})
    expect(parseContextLengthError('')).toEqual({})
    expect(parseContextLengthError(undefined)).toEqual({})
  })
})
