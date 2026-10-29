/**
 * Mock LLM Client for E2E Tests
 *
 * Provides deterministic LLM responses for testing the system without
 * depending on real LLM inference. Use this to test:
 * - Tool execution workflows
 * - Session state management
 * - Criteria/plan/verifier workflows
 * - Error handling
 * - Concurrency
 *
 * The mock allows you to specify expected tool calls for given prompts.
 */

import { appendFileSync } from 'node:fs'
import type { LLMClientWithModel } from '../../src/server/llm/client.js'
import type { LLMCompletionRequest, LLMCompletionResponse, LLMStreamEvent } from '../../src/server/llm/types.js'
import type { ToolCall } from '../../src/shared/types.js'
import type { Backend } from '../../src/server/llm/backend.js'
import { getModelProfile, type ModelProfile } from '../../src/server/llm/profiles.js'
import { logger } from '../../src/server/utils/logger.js'

// Deterministic compaction summary: matches COMPACTION_PROMPT's structure and
// is always >= MIN_COMPACTION_SUMMARY_LENGTH (50 chars) so the summary is
// accepted. Must never trigger tool calls.
const COMPACTION_SUMMARY = [
  '## Summary',
  '1. What was done: processed the conversation history.',
  '2. File modifications: none.',
  '3. Errors encountered and resolved: none.',
  '4. Current progress: all prior tasks completed.',
  '5. Technical decisions: keep summaries concise and structured.',
  '6. Persisting requirements: none.',
  '7. Next steps: continue from this summary.',
  '8. User request: none active.',
  '9. Working data: none.',
].join('\n')

function isCompactionPrompt(prompt: string): boolean {
  return /tasked with summarizing conversations for continuation/i.test(prompt)
}

// Appends one ndjson line per LLM call when OPENFOX_MOCK_CONTROL points at a
// control file with a `callLog` path. Never throws — logging must not break
// a test run.
function appendCallLog(request: LLMCompletionRequest, kind: 'complete' | 'stream'): void {
  const control = process.env['OPENFOX_MOCK_CONTROL']
  if (!control) return
  try {
    const parsed = JSON.parse(control) as { callLog?: string }
    if (!parsed.callLog) return
    const lastMessage = request.messages[request.messages.length - 1]
    const toolChoice = request.toolChoice
    appendFileSync(
      parsed.callLog,
      JSON.stringify({
        kind,
        maxTokens: request.maxTokens ?? null,
        hasTools: (request.tools?.length ?? 0) > 0,
        toolChoice: typeof toolChoice === 'string' ? toolChoice : toolChoice ? toolChoice.function.name : null,
        reasoningEffort: request.reasoningEffort ?? null,
        messageCount: request.messages.length,
        lastMessageRole: lastMessage?.role ?? null,
      }) + '\n',
    )
  } catch {
    // Ignore logging failures
  }
}

// ============================================================================
// Mock Configuration
// ============================================================================

export interface MockLLMConfig {
  /** Model name to report (default: 'mock-model') */
  model?: string
  /** Backend to report (default: 'mock') */
  backend?: string
  /** Default thinking content to return */
  thinkingContent?: string
  /** Default response content when no tool calls match */
  defaultResponse?: string
  /** Delay between streaming chunks in ms (default: 0 for fast tests) */
  streamDelayMs?: number
}

export interface MockLLMClient extends LLMClientWithModel {
  /** Add or override tool call rules for specific tests */
  addRules(newRules: MockToolCallRule[]): void
  /** Clear all rules and restore defaults */
  resetRules(): void
  /** Set exact rules (replaces all rules) */
  setRules(newRules: MockToolCallRule[]): void
}

export interface MockToolCallRule {
  /** Prompt text or keyword to match (case-insensitive includes) */
  promptMatch: string | RegExp
  /** Tool calls to return when prompt matches */
  toolCalls: Array<{
    name: string
    arguments: Record<string, unknown>
    id?: string
  }>
  /** Optional response content after tool calls */
  response?: string
  /** Optional thinking content */
  thinking?: string
}

// ============================================================================
// Mock LLM Client Implementation
// ============================================================================

export function createMockLLMClient(config: MockLLMConfig = {}): MockLLMClient {
  const model = config.model ?? 'mock-model'
  const backend = config.backend ?? 'unknown'
  const profile = getModelProfile(model)
  const defaultResponse = config.defaultResponse ?? 'I completed the task.'
  const defaultThinking = config.thinkingContent ?? ''
  const streamDelayMs = config.streamDelayMs ?? 0 // Default to 0 for fast tests

  // Default rules - can be extended by tests
  const defaultRules: MockToolCallRule[] = [
    {
      promptMatch: /read.*file/i,
      toolCalls: [{ name: 'read_file', arguments: { path: 'src/index.ts' } }],
      response: 'I read the file.',
    },
    {
      promptMatch: /glob|find.*file/i,
      toolCalls: [{ name: 'glob', arguments: { pattern: '**/*.ts' } }],
      response: 'I found the files.',
    },
    {
      promptMatch: /Create the file.*then.*complete/i,
      toolCalls: [
        { name: 'write_file', arguments: { path: 'src/utils.ts', content: 'export const x = 1' } },
        { name: 'session_metadata', arguments: { action: 'update', key: 'criteria', id: '0', status: 'completed' } },
      ],
      response: 'I created the file and completed the criterion.',
    },
    {
      promptMatch: /write.*file|create.*file/i,
      toolCalls: [
        {
          name: 'write_file',
          arguments: { path: 'src/newfile.ts', content: 'export const x = 1' },
        },
      ],
      response: 'I wrote the file.',
    },
    {
      promptMatch: /run.*command|execute.*shell/i,
      toolCalls: [{ name: 'run_command', arguments: { command: 'echo "test"' } }],
      response: 'I ran the command.',
    },
    {
      promptMatch: /add.*criterion/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'add',
            key: 'criteria',
            description: 'Test criterion',
          },
        },
      ],
      response: 'I added the criterion.',
    },
    {
      promptMatch: /Add criterion ID "emit-test"/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'add',
            key: 'criteria',
            id: 'emit-test',
            description: 'Testing events',
          },
        },
      ],
      response: 'I added the criterion.',
    },
    {
      promptMatch: /Add criterion ID "get-test"/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'add',
            key: 'criteria',
            id: 'get-test',
            description: 'For testing get',
          },
        },
      ],
      response: 'I added the criterion.',
    },
    {
      promptMatch: /Add criterion ID "update-me"/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'add',
            key: 'criteria',
            id: 'update-me',
            description: 'Original description',
          },
        },
      ],
      response: 'I added the criterion.',
    },
    {
      promptMatch: /Add criterion ID "remove-me"/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'add',
            key: 'criteria',
            id: 'remove-me',
            description: 'Will be removed',
          },
        },
      ],
      response: 'I added the criterion.',
    },
    {
      promptMatch: /Add criterion ID "persist-test"/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'add',
            key: 'criteria',
            id: 'persist-test',
            description: 'Persistence test',
          },
        },
      ],
      response: 'I added the criterion.',
    },
    {
      promptMatch: /Add criterion ID "file-created"/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'add',
            key: 'criteria',
            id: 'file-created',
            description: 'A new file utils.ts exists',
          },
        },
      ],
      response: 'I added the criterion.',
    },
    {
      promptMatch: /Add criterion ID "edit-direct"/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'add',
            key: 'criteria',
            id: 'edit-direct',
            description: 'Initial',
          },
        },
      ],
      response: 'I added the criterion.',
    },
    {
      promptMatch: /Add criterion ID "trivial-pass"/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'add',
            key: 'criteria',
            id: 'trivial-pass',
            description: 'Trivial pass criterion',
          },
        },
      ],
      response: 'I added the criterion.',
    },
    {
      promptMatch: /grep|search/i,
      toolCalls: [{ name: 'grep', arguments: { pattern: 'export', path: 'src' } }],
      response: 'I searched for the pattern.',
    },
    // Git tool rules
    {
      promptMatch: /git.*status|use.*git.*tool/i,
      toolCalls: [{ name: 'git', arguments: { command: 'git status' } }],
      response: 'I checked the git status.',
    },
    {
      promptMatch: /git diff/i,
      toolCalls: [{ name: 'git', arguments: { command: 'git diff' } }],
      response: 'I checked the git diff.',
    },
    {
      promptMatch: /git log/i,
      toolCalls: [{ name: 'git', arguments: { command: 'git log --oneline -5' } }],
      response: 'I checked the git log.',
    },
    {
      promptMatch: /git branch/i,
      toolCalls: [{ name: 'git', arguments: { command: 'git branch' } }],
      response: 'I listed the branches.',
    },
    {
      promptMatch: /git reset.*hard/i,
      toolCalls: [{ name: 'git', arguments: { command: 'git reset --hard HEAD' } }],
      response: 'I tried to reset.',
    },
    // Ask user tool rules - must come BEFORE generic rules to match first
    {
      promptMatch: /framework.*prefer/i,
      toolCalls: [{ name: 'ask_user', arguments: { question: 'Which framework would you prefer?' } }],
      response: 'I asked about framework preference.',
    },
    // Ask user with confirm type (must be before generic ask rules)
    {
      promptMatch: /confirm.*question/i,
      toolCalls: [{ name: 'ask_user', arguments: { question: 'Do you approve?', type: 'confirm' } }],
      response: 'I asked a confirm question.',
    },
    // Ask user with choice type (must be before generic ask rules)
    {
      promptMatch: /choose.*option/i,
      toolCalls: [
        {
          name: 'ask_user',
          arguments: {
            question: 'Which option do you prefer?',
            type: 'choice',
            options: ['Option A', 'Option B', 'Option C'],
          },
        },
      ],
      response: 'I asked a choice question.',
    },
    {
      promptMatch: /ask.*user|ask.*question|clarif/i,
      toolCalls: [{ name: 'ask_user', arguments: { question: 'What would you like me to do?' } }],
      response: 'I asked the user.',
    },
    {
      promptMatch: /confirm.*with.*user/i,
      toolCalls: [{ name: 'ask_user', arguments: { question: 'Should I proceed with this action?' } }],
      response: 'I asked for confirmation.',
    },
    // Path security test rules - writing outside workdir
    {
      promptMatch: /write.*\/tmp\/outside/i,
      toolCalls: [{ name: 'write_file', arguments: { path: '/tmp/outside/test.txt', content: 'test content' } }],
      response: 'I wrote to the path.',
    },
    {
      promptMatch: /write.*\/etc\/passwd/i,
      toolCalls: [{ name: 'write_file', arguments: { path: '/etc/passwd', content: 'malicious' } }],
      response: 'I tried to write.',
    },
    {
      promptMatch: /write.*home.*secret/i,
      toolCalls: [{ name: 'write_file', arguments: { path: '/home/test/secret.txt', content: 'secret' } }],
      response: 'I wrote to home.',
    },
    // Generic /home/test writes for path security approval flow tests
    {
      promptMatch: /write.*\/home\/test\/approved/i,
      toolCalls: [{ name: 'write_file', arguments: { path: '/home/test/approved.txt', content: 'approved' } }],
      response: 'I wrote to the approved path.',
    },
    {
      promptMatch: /write.*\/home\/test\/denied/i,
      toolCalls: [{ name: 'write_file', arguments: { path: '/home/test/denied.txt', content: 'denied' } }],
      response: 'I wrote to the denied path.',
    },
    {
      promptMatch: /write.*\/home\/test\/first/i,
      toolCalls: [{ name: 'write_file', arguments: { path: '/home/test/first.txt', content: 'first' } }],
      response: 'I wrote the first file.',
    },
    {
      promptMatch: /write.*\/home\/test\/second/i,
      toolCalls: [{ name: 'write_file', arguments: { path: '/home/test/second.txt', content: 'second' } }],
      response: 'I wrote the second file.',
    },
    // Sensitive file detection rules
    {
      promptMatch: /write.*\.env\b/i,
      toolCalls: [{ name: 'write_file', arguments: { path: '.env', content: 'SECRET=value' } }],
      response: 'I wrote to .env.',
    },
    {
      promptMatch: /write.*credentials\.json/i,
      toolCalls: [{ name: 'write_file', arguments: { path: 'credentials.json', content: '{"key": "secret"}' } }],
      response: 'I wrote credentials.',
    },
    {
      promptMatch: /read.*\.env\b/i,
      toolCalls: [{ name: 'read_file', arguments: { path: '.env' } }],
      response: 'I read the .env file.',
    },
    // Run command outside workdir
    {
      promptMatch: /run.*command.*\/etc/i,
      toolCalls: [{ name: 'run_command', arguments: { command: 'cat /etc/hosts', workdir: '/etc' } }],
      response: 'I ran the command.',
    },
    {
      promptMatch: /run.*cat.*secret/i,
      toolCalls: [{ name: 'run_command', arguments: { command: 'cat ~/.ssh/id_rsa' } }],
      response: 'I tried to cat the file.',
    },
    // Edit file with syntax error (for LSP diagnostics)
    {
      promptMatch: /write.*syntax.*error/i,
      toolCalls: [
        {
          name: 'write_file',
          arguments: { path: 'src/broken.ts', content: 'export const x: number = "not a number"' },
        },
      ],
      response: 'I wrote the file with an error.',
    },
    // Get criteria (for planner)
    {
      promptMatch: /get.*criteria|show.*criteria|list.*criteria/i,
      toolCalls: [{ name: 'session_metadata', arguments: { action: 'get', key: 'criteria' } }],
      response: 'Here are the criteria.',
    },
    // Complete criterion + step done (for workflow builder steps)
    {
      promptMatch: /complete.*criterion|mark.*complete|complete_criterion|fulfil.*criteria|Complete the first/i,
      toolCalls: [
        { name: 'session_metadata', arguments: { action: 'update', key: 'criteria', id: '0', status: 'completed' } },
        { name: 'step_done', arguments: {} },
      ],
      response: 'I completed the criterion and finished the step.',
    },
    // Pass criterion (for verifier workflow)
    {
      promptMatch: /pass.*criterion|pass_criterion|Pass the first/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: { action: 'update', key: 'criteria', id: '0', status: 'passed', reason: 'Verified' },
        },
        { name: 'step_done', arguments: {} },
      ],
      response: 'I passed the criterion.',
    },
    // Step done only (for generic workflow steps)
    {
      promptMatch: /call step_done|step_done\(\)|Once you're done/i,
      toolCalls: [{ name: 'step_done', arguments: {} }],
      response: 'I am done with this step.',
    },
    // Verifier sub-agent workflow (for builder mode)
    {
      promptMatch: /launch.*runner|runner.*launch|start.*verification|verify.*implementation|call.*verifier/i,
      toolCalls: [
        {
          name: 'call_sub_agent',
          arguments: {
            subAgentType: 'verifier',
            prompt: 'Verify completed criteria against implementation',
          },
        },
        {
          name: 'session_metadata',
          arguments: { action: 'update', key: 'criteria', id: '0', status: 'passed', reason: 'Verified' },
        },
      ],
      thinking: 'Starting the verifier to check implementation against criteria.',
      response: 'I launched the verifier.',
    },
    // Verifier sub-agent internal prompt (when verifier actually runs)
    {
      promptMatch: /Verify.*criterion.*NEEDS VERIFICATION/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: { action: 'update', key: 'criteria', id: '0', status: 'passed', reason: 'Verified successfully' },
        },
        { name: 'return_value', arguments: { summary: 'Verified criterion.' } },
      ],
      response: 'Verified the criterion.',
    },
    {
      promptMatch: /Verify.*verify-fail/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'update',
            key: 'criteria',
            id: '0',
            status: 'failed',
            reason: 'Verification failed for this criterion',
          },
        },
        { name: 'return_value', arguments: { summary: 'Verification failed.' } },
      ],
      response: 'Verification completed with failures.',
    },
    // Update criterion
    {
      promptMatch: /update.*criterion|update_criterion/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'update',
            key: 'criteria',
            id: '0',
            description: 'Updated description',
          },
        },
      ],
      response: 'I updated the criterion.',
    },
    // Remove criterion
    {
      promptMatch: /remove.*criterion|remove_criterion/i,
      toolCalls: [
        {
          name: 'session_metadata',
          arguments: {
            action: 'remove',
            key: 'criteria',
            id: '0',
          },
        },
      ],
      response: 'I removed the criterion.',
    },
  ]

  let rules: MockToolCallRule[] = [...defaultRules]

  function matchPrompt(prompt: string): MockToolCallRule | undefined {
    return rules.find((rule) => {
      if (rule.promptMatch instanceof RegExp) {
        return rule.promptMatch.test(prompt)
      }
      return prompt.toLowerCase().includes(rule.promptMatch.toLowerCase())
    })
  }

  return {
    getModel() {
      return model
    },

    setModel(newModel: string) {
      logger.debug('Mock LLM: switching model', { from: model, to: newModel })
    },

    getProfile() {
      return profile
    },

    getBackend() {
      return backend as Backend
    },

    getBaseUrl() {
      return ''
    },

    setBackend(newBackend: Backend) {
      logger.debug('Mock LLM: switching backend', { from: backend, to: newBackend })
    },

    async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
      // Extract user message content
      const userMessage = request.messages.filter((m) => m.role === 'user').pop()
      const prompt = userMessage?.content ?? ''

      appendCallLog(request, 'complete')

      logger.debug('Mock LLM complete', { prompt: prompt.slice(0, 100) })

      // Check if abort signal was triggered
      if (request.signal?.aborted) {
        throw new Error('Aborted')
      }

      // Compaction summary calls: deterministic, no tool calls, always
      // long enough to pass MIN_COMPACTION_SUMMARY_LENGTH.
      if (isCompactionPrompt(prompt)) {
        return {
          id: `mock-${Date.now()}`,
          content: COMPACTION_SUMMARY,
          thinkingContent: defaultThinking,
          toolCalls: [],
          finishReason: 'stop',
          usage: {
            promptTokens: Math.ceil(prompt.length / 4),
            completionTokens: Math.ceil(COMPACTION_SUMMARY.length / 4),
            totalTokens: 0,
          },
        }
      }

      // Match prompt to rule
      const rule = matchPrompt(prompt)

      if (rule) {
        const toolCalls: ToolCall[] = rule.toolCalls.map((tc, idx) => ({
          id: tc.id ?? `mock-tc-${Date.now()}-${idx}`,
          name: tc.name,
          arguments: tc.arguments,
        }))

        return {
          id: `mock-${Date.now()}`,
          content: rule.response ?? defaultResponse,
          thinkingContent: rule.thinking ?? defaultThinking,
          toolCalls,
          finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          usage: {
            promptTokens: Math.ceil(prompt.length / 4),
            completionTokens: Math.ceil((rule.response ?? defaultResponse).length / 4),
            totalTokens: 0,
          },
        }
      }

      // No rule matched - return default response
      return {
        id: `mock-${Date.now()}`,
        content: defaultResponse,
        thinkingContent: defaultThinking,
        toolCalls: [],
        finishReason: 'stop',
        usage: {
          promptTokens: Math.ceil(prompt.length / 4),
          completionTokens: Math.ceil(defaultResponse.length / 4),
          totalTokens: 0,
        },
      }
    },

    async *stream(request: LLMCompletionRequest): AsyncIterable<LLMStreamEvent> {
      // Extract user message content
      const userMessage = request.messages.filter((m) => m.role === 'user').pop()
      const prompt = userMessage?.content ?? ''

      appendCallLog(request, 'stream')

      logger.debug('Mock LLM stream', { prompt: prompt.slice(0, 100) })

      // Check if abort signal was triggered
      if (request.signal?.aborted) {
        throw new Error('Aborted')
      }

      // Compaction summary calls stream a deterministic summary, no tools.
      const isCompaction = isCompactionPrompt(prompt)
      const rule = isCompaction ? undefined : matchPrompt(prompt)

      const toolCalls: ToolCall[] =
        rule?.toolCalls.map((tc, idx) => ({
          id: tc.id ?? `mock-tc-${Date.now()}-${idx}`,
          name: tc.name,
          arguments: tc.arguments,
        })) ?? []

      const responseContent = isCompaction ? COMPACTION_SUMMARY : (rule?.response ?? defaultResponse)
      const thinking = rule?.thinking ?? defaultThinking

      // Stream thinking first if present
      if (thinking) {
        const chunks = thinking.split(' ')
        for (const chunk of chunks) {
          yield { type: 'thinking_delta', content: chunk + ' ' }
          if (streamDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, streamDelayMs))
          }
        }
      }

      // Stream tool calls
      for (let idx = 0; idx < toolCalls.length; idx++) {
        const tc = toolCalls[idx]!
        yield {
          type: 'tool_call_delta',
          index: idx,
          id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        }
      }

      // Stream response content
      if (responseContent) {
        const chunks = responseContent.split(' ')
        for (const chunk of chunks) {
          yield { type: 'text_delta', content: chunk + ' ' }
          if (streamDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, streamDelayMs))
          }
        }
      }

      // Yield final result
      yield {
        type: 'done',
        response: {
          id: `mock-${Date.now()}`,
          content: responseContent,
          thinkingContent: thinking,
          toolCalls,
          finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          usage: {
            promptTokens: Math.ceil(prompt.length / 4),
            completionTokens: Math.ceil(responseContent.length / 4),
            totalTokens: 0,
          },
        },
      }
    },

    /**
     * Add or override tool call rules for specific tests
     */
    addRules(newRules: MockToolCallRule[]) {
      rules = [...rules, ...newRules]
    },

    /**
     * Clear all rules and restore defaults
     */
    resetRules() {
      rules = [...defaultRules]
    },

    /**
     * Set exact rules (replaces all rules)
     */
    setRules(newRules: MockToolCallRule[]) {
      rules = newRules
    },
  }
}
