import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from './openai-types.js'
import { logger } from '../utils/logger.js'
import { ChatHttpClient, DONE, type ChatRequest } from './http-shared.js'
import { countTokensFromResponse } from './tokenize.js'
import { stripVersionPrefix } from './url-utils.js'
import './proxy.js'

export interface HttpClientOptions {
  baseURL: string
  apiKey: string
}

export class OpenAIHttpClient extends ChatHttpClient {
  private baseURL: string
  private apiKey: string

  constructor(options: HttpClientOptions) {
    super()
    this.baseURL = options.baseURL
    this.apiKey = options.apiKey
  }

  protected buildRequest(
    params: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
  ): ChatRequest {
    return {
      url: `${this.baseURL}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(params),
    }
  }

  protected parseNonStreaming(data: unknown): ChatCompletionResponse {
    return data as ChatCompletionResponse
  }

  /**
   * Resolved tokenize endpoint, cached after the first successful call so
   * subsequent measurements skip the probe. llama.cpp serves /tokenize at the
   * server ROOT (not under the OpenAI-compatible /v1 or a custom prefix), so
   * the naive `${baseURL}/tokenize` 404s and the backstop silently falls back
   * to the dense chars/2.4 estimate — under-counting dense content (JSON,
   * base64, minified code) and letting an over-window prompt slip through.
   */
  private tokenizeEndpoint?: string

  private tokenizeCandidates(): string[] {
    const candidates = [`${this.baseURL}/tokenize`]
    const stripped = stripVersionPrefix(this.baseURL)
    if (stripped !== this.baseURL) candidates.push(`${stripped}/tokenize`)
    let origin = ''
    try {
      origin = new URL(this.baseURL).origin
    } catch {
      //
    }
    if (origin) candidates.push(`${origin}/tokenize`)
    return [...new Set(candidates)]
  }

  /** Tokenizing is CPU-bound on the backend; scale the budget with payload size. */
  private tokenizeTimeout(contentLength: number): number {
    return Math.min(60_000, 2_000 + Math.ceil(contentLength / 1_000) * 50)
  }

  async tokenize(content: string): Promise<number | null> {
    const candidates = this.tokenizeEndpoint
      ? [this.tokenizeEndpoint, ...this.tokenizeCandidates().filter((c) => c !== this.tokenizeEndpoint)]
      : this.tokenizeCandidates()
    const timeoutMs = this.tokenizeTimeout(content.length)
    for (const endpoint of candidates) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ content }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) continue
        this.tokenizeEndpoint = endpoint
        return await countTokensFromResponse(response)
      } catch {
        continue
      }
    }
    return null
  }

  protected parseStreamLine(trimmed: string): ChatCompletionChunk | typeof DONE | null {
    if (!trimmed.startsWith('data: ')) return null

    const data = trimmed.slice(6)
    if (data === '[DONE]') return DONE

    try {
      return JSON.parse(data) as ChatCompletionChunk
    } catch (error) {
      logger.warn('Failed to parse SSE chunk', { data, error })
      return null
    }
  }
}
