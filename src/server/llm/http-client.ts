import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from './openai-types.js'
import { logger } from '../utils/logger.js'
import { ChatHttpClient, DONE, type ChatRequest } from './http-shared.js'
import { countTokensFromResponse } from './tokenize.js'
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

  async tokenize(content: string): Promise<number | null> {
    try {
      const response = await fetch(`${this.baseURL}/tokenize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(2000),
      })
      return countTokensFromResponse(response)
    } catch {
      return null
    }
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
