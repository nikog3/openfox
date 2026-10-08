import type { RequestContextMessage } from './request-context.js'

/** Rough token estimate: ~4 chars per token, matching the tool-definition estimate in mcp/manager.ts. */
export const CHARS_PER_TOKEN = 4

/** JSON framing overhead per tool message (role, tool_call_id, content key). */
export const TOOL_MESSAGE_OVERHEAD_TOKENS = 16

export function estimateToolResultTokens(toolMessages: Array<Pick<RequestContextMessage, 'content'>>): number {
  return toolMessages.reduce(
    (sum, message) => sum + TOOL_MESSAGE_OVERHEAD_TOKENS + Math.ceil(message.content.length / CHARS_PER_TOKEN),
    0,
  )
}

const CONTEXT_LENGTH_ERROR_PATTERN = /context\s*length|context_length|context window|prompt (?:is )?too long/i

export function isContextLengthError(message: string | undefined): boolean {
  if (!message) return false
  return CONTEXT_LENGTH_ERROR_PATTERN.test(message)
}

export interface ContextLengthErrorInfo {
  actualTokens?: number
  serverLimit?: number
}

const LLAMA_CONTEXT_SIZE_PATTERN =
  /request\s*\(\s*(\d+)\s*tokens?\s*\)\s*exceeds the available context size\s*\(\s*(\d+)\s*tokens?\s*\)/i
const ANTHROPIC_PROMPT_TOO_LONG_PATTERN = /prompt is too long:?\s*(\d+)\s*tokens?\s*>\s*(\d+)/i
const SGLANG_PROMPT_TOO_LONG_PATTERN = /prompt is too long\s*\(\s*(\d+)\s*tokens?\s*>\s*(\d+)\s*tokens?\s*\)/i
const MAX_CONTEXT_LENGTH_PATTERN = /maximum context length is (\d+)/i
const REQUESTED_TOKENS_PATTERN = /you requested (\d+) tokens/i

export function parseContextLengthError(message: string | undefined): ContextLengthErrorInfo {
  if (!message) return {}

  const info: ContextLengthErrorInfo = {}

  const llama = LLAMA_CONTEXT_SIZE_PATTERN.exec(message)
  if (llama) {
    info.actualTokens = Number(llama[1])
    info.serverLimit = Number(llama[2])
    return info
  }

  const anthropic = ANTHROPIC_PROMPT_TOO_LONG_PATTERN.exec(message)
  if (anthropic) {
    info.actualTokens = Number(anthropic[1])
    info.serverLimit = Number(anthropic[2])
    return info
  }

  const sglang = SGLANG_PROMPT_TOO_LONG_PATTERN.exec(message)
  if (sglang) {
    info.actualTokens = Number(sglang[1])
    info.serverLimit = Number(sglang[2])
    return info
  }

  const limit = MAX_CONTEXT_LENGTH_PATTERN.exec(message)
  const requested = REQUESTED_TOKENS_PATTERN.exec(message)
  if (limit) info.serverLimit = Number(limit[1])
  if (requested) info.actualTokens = Number(requested[1])
  if (limit || requested) return info

  return {}
}
