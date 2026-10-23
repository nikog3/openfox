import { GitCommitIcon, GitPullIcon, GitPushIcon, ThinkingIcon } from '../shared/icons'
import { Spinner } from '../shared/Spinner'
import { useT } from '../../hooks/useT'

export interface CommitAreaFeedback {
  type: 'success' | 'error'
  message: string
}

export interface CommitAreaProps {
  message: string
  onMessageChange: (value: string) => void
  onCommit: () => Promise<void>
  onGenerate: () => void
  onPush: () => void
  onPull: () => void
  busy: string | null
  feedback: CommitAreaFeedback | null
  stagedCount: number
  pushDisabled: boolean
  pullDisabled: boolean
  className?: string
}

export function CommitArea({
  message,
  onMessageChange,
  onCommit,
  onGenerate,
  onPush,
  onPull,
  busy,
  feedback,
  stagedCount,
  pushDisabled,
  pullDisabled,
  className = '',
}: CommitAreaProps) {
  const t = useT()
  return (
    <div className={`space-y-1.5 ${className}`}>
      <div className="flex gap-1.5">
        <textarea
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder={t({ en: 'Commit message…', fr: 'Message de commit…' })}
          rows={2}
          className="flex-1 min-h-0 px-2 py-1 text-xs rounded bg-bg-tertiary border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-primary resize-none"
        />
        <button
          onClick={() => void onGenerate()}
          disabled={busy !== null || stagedCount === 0}
          className="self-start p-1.5 rounded border border-border text-text-muted hover:text-text-secondary hover:bg-bg-tertiary disabled:opacity-50 transition-colors"
          aria-label={t({ en: 'Generate commit message', fr: 'Générer le message de commit' })}
        >
          {busy === 'commit-message' ? <Spinner /> : <ThinkingIcon className="w-3.5 h-3.5" />}
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => void onCommit()}
          disabled={busy !== null || message.trim() === '' || stagedCount === 0}
          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-accent-primary text-white disabled:opacity-50 transition-opacity hover:opacity-90"
        >
          {busy === 'commit' ? <Spinner /> : <GitCommitIcon className="w-3.5 h-3.5" />}
          {t({ en: 'Commit', fr: 'Commit' })}
        </button>
        <button
          onClick={() => void onPush()}
          disabled={pushDisabled || busy !== null}
          className="p-1.5 rounded bg-bg-tertiary text-text-secondary hover:bg-bg-secondary disabled:opacity-50 transition-colors"
          aria-label={t({ en: 'Push', fr: 'Push' })}
        >
          {busy === 'push' ? <Spinner /> : <GitPushIcon className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={() => void onPull()}
          disabled={pullDisabled || busy !== null}
          className="p-1.5 rounded bg-bg-tertiary text-text-secondary hover:bg-bg-secondary disabled:opacity-50 transition-colors"
          aria-label={t({ en: 'Pull', fr: 'Pull' })}
        >
          {busy === 'pull' ? <Spinner /> : <GitPullIcon className="w-3.5 h-3.5" />}
        </button>
      </div>
      {feedback && (
        <p className={`text-xs ${feedback.type === 'error' ? 'text-accent-error' : 'text-accent-success'}`}>
          {feedback.message}
        </p>
      )}
    </div>
  )
}
