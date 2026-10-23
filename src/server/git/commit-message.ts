import type { LLMClientWithModel } from '../llm/client.js'
import type { LLMMessage } from '../llm/types.js'
import type { ProviderManager } from '../provider-manager.js'
import { logger } from '../utils/logger.js'
import { gitOutput } from './diff.js'

const MAX_DIFF_CHARS = 40000

const COMMIT_MESSAGE_PROMPT = `Write a git commit message for the staged changes below.
Follow Conventional Commits style (e.g. "feat: add ...", "fix: ...").
First line (subject) max 72 characters. Add a short body only if it adds value.
Return ONLY the commit message, nothing else.

Staged changes:
{diff}`

export interface GenerateCommitMessageDeps {
  providerManager: ProviderManager
  getLLMClient?: () => LLMClientWithModel
}

export interface GenerateCommitMessageResult {
  success: boolean
  message?: string
  error?: string
}

function getStagedDiff(cwd: string): Promise<string> {
  return gitOutput(cwd, ['diff', '--cached'])
}

export async function generateCommitMessage(
  cwd: string,
  deps: GenerateCommitMessageDeps,
): Promise<GenerateCommitMessageResult> {
  const stagedDiff = (await getStagedDiff(cwd)).trim()
  if (!stagedDiff) {
    return { success: false, error: 'No staged changes to commit' }
  }

  const { providerManager } = deps
  const activeProvider = providerManager.getActiveProvider()
  const model = providerManager.getCurrentModel()
  if (!activeProvider || !model) {
    return { success: false, error: 'No LLM configured' }
  }

  const client = deps.getLLMClient?.() ?? providerManager.createClient(activeProvider.id, model)
  if (!client) {
    return { success: false, error: 'No LLM configured' }
  }

  const diff =
    stagedDiff.length > MAX_DIFF_CHARS ? stagedDiff.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)' : stagedDiff
  const prompt = COMMIT_MESSAGE_PROMPT.replace('{diff}', diff)
  const modelSettings = providerManager.getModelSettings(activeProvider.id, model, 'non-thinking')

  try {
    const response = await client.complete({
      messages: [{ role: 'user', content: prompt } as LLMMessage],
      tools: [],
      ...(modelSettings ? { modelSettings } : {}),
      skipClientReasoningEffort: true,
    })
    let message = (response.content || response.thinkingContent || '').trim()
    if ((message.startsWith('"') && message.endsWith('"')) || (message.startsWith("'") && message.endsWith("'"))) {
      message = message.slice(1, -1).trim()
    }
    if (!message) {
      return { success: false, error: 'Generated commit message is empty' }
    }
    return { success: true, message }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to generate commit message'
    logger.debug('Commit message generation error', { error: errorMessage })
    return { success: false, error: errorMessage }
  }
}
