import { useRef, useState } from 'react'
import { ScrollArea } from '../shared/ScrollArea'
import { ConfirmModal } from '../shared/ConfirmModal'
import { CheckIcon, GitCommitIcon, MinusIcon, PencilIcon, PlusIcon, TrashIcon } from '../shared/icons'
import { Spinner } from '../shared/Spinner'
import { DiffModal } from './DiffModal'
import { SyncBadge } from './SyncBadge'
import { useT } from '../../hooks/useT'
import { useSetting } from '../../hooks/useSetting'
import { useScopedContext } from '../../stores/session/session-scope'
import { useGitStatus } from '../../hooks/useGitStatus'
import { authFetch } from '../../lib/api'
import { buildEditorUrl } from '../../lib/editor-link'
import { SETTINGS_KEYS } from '../../lib/resources'
import { truncateMiddle } from '../../lib/path'
import type { GitDiffFile } from '../../stores/session/types'

interface GitActionResult {
  success: boolean
  error?: string
  output?: string
  message?: string
}

type GitOp = 'stage' | 'unstage' | 'discard' | 'commit' | 'commit-message' | 'push' | 'pull'

function FileRow({
  file,
  workdir,
  busy,
  onToggle,
  onDiscard,
  onOpen,
}: {
  file: GitDiffFile
  workdir: string | null
  busy: boolean
  onToggle: () => void
  onDiscard: () => void
  onOpen: () => void
}) {
  const t = useT()
  const showEditorLink = useSetting(SETTINGS_KEYS.DISPLAY_SHOW_OPEN_IN_EDITOR).value === 'true'
  const vscodeRemotePrefix = useSetting(SETTINGS_KEYS.VSCODE_REMOTE_PREFIX).value
  const statusColor =
    file.status === 'added'
      ? 'text-accent-success'
      : file.status === 'deleted'
        ? 'text-accent-error'
        : 'text-text-secondary'
  const hasAdditions = file.additions > 0
  const hasDeletions = file.deletions > 0
  return (
    <div className="group flex items-center gap-1.5 py-0.5 text-xs min-w-0 rounded px-1 hover:bg-bg-tertiary">
      <button
        onClick={onToggle}
        disabled={busy}
        className="shrink-0 flex items-center justify-center disabled:opacity-50"
        aria-label={
          file.staged
            ? t({ en: 'Unstage {{path}}', fr: 'Déstager {{path}}' }, { path: file.path })
            : t({ en: 'Stage {{path}}', fr: 'Stager {{path}}' }, { path: file.path })
        }
      >
        {file.staged && !file.unstaged ? (
          <CheckIcon className="w-3.5 h-3.5 text-accent-success" />
        ) : file.staged ? (
          <MinusIcon className="w-3.5 h-3.5 text-text-muted" />
        ) : (
          <span className="block w-3.5 h-3.5 border border-border rounded-sm" />
        )}
      </button>
      <button onClick={onOpen} className={`truncate min-w-0 ${statusColor}`} title={file.path}>
        {truncateMiddle(file.path, 28)}
      </button>
      {(hasAdditions || hasDeletions) && (
        <span className="shrink-0 font-mono text-[10px]">
          {hasAdditions && <span className="text-accent-success">+{file.additions}</span>}
          {hasDeletions && <span className="text-accent-error">-{file.deletions}</span>}
        </span>
      )}
      {showEditorLink && workdir && (
        <a
          href={buildEditorUrl(file.path, undefined, workdir, vscodeRemotePrefix)}
          className="shrink-0 p-0.5 rounded text-text-muted hover:text-accent-primary opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label={t(
            { en: 'Open {{path}} in editor', fr: 'Ouvrir {{path}} dans l’éditeur' },
            {
              path: file.path,
            },
          )}
        >
          <PencilIcon className="w-3.5 h-3.5" />
        </a>
      )}
      <button
        onClick={onDiscard}
        disabled={busy}
        className="shrink-0 p-0.5 rounded text-text-muted hover:text-accent-error opacity-0 group-hover:opacity-100 disabled:opacity-0 transition-opacity"
        aria-label={t(
          { en: 'Discard changes in {{path}}', fr: 'Abandonner les changements de {{path}}' },
          {
            path: file.path,
          },
        )}
      >
        <TrashIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export function GitStatusPanel() {
  const t = useT()
  const { branch, sync, diff } = useGitStatus()
  const { currentSession: session } = useScopedContext()
  const workdir = session?.workspace ?? session?.workdir
  const [diffTarget, setDiffTarget] = useState<{ path: string; staged: boolean } | null>(null)
  const [discardTarget, setDiscardTarget] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState<GitOp | null>(null)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [listHeight, setListHeight] = useState(150)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  if (diff.loading) {
    return (
      <div className="mt-3">
        <div className="flex items-center gap-1.5 text-xs text-text-muted">
          <Spinner size="sm" />
          <span>{t({ en: 'Checking changes...', fr: 'Vérification des changements…' })}</span>
        </div>
      </div>
    )
  }

  if (diff.files.length === 0) {
    return (
      <div className="mt-3">
        <p className="text-xs text-text-muted text-center">{t({ en: 'No changes', fr: 'Aucun changement' })}</p>
      </div>
    )
  }

  const stagedFiles = diff.files.filter((f) => f.staged)
  const unstagedFiles = diff.files.filter((f) => f.unstaged)
  const untrackedFiles = diff.files.filter((f) => f.untracked)

  const sections = [
    { key: 'staged', label: t({ en: 'Staged', fr: 'Staged' }), files: stagedFiles, staged: true },
    { key: 'unstaged', label: t({ en: 'Unstaged', fr: 'Unstaged' }), files: unstagedFiles, staged: false },
    { key: 'untracked', label: t({ en: 'Untracked', fr: 'Non suivis' }), files: untrackedFiles, staged: false },
  ].filter((s) => s.files.length > 0)

  const stageAllPaths = Array.from(new Set(diff.files.filter((f) => f.unstaged || f.untracked).map((f) => f.path)))

  const callGit = async (op: GitOp, body: Record<string, unknown>, successMessage?: string): Promise<boolean> => {
    if (!workdir) return false
    setBusy(op)
    setFeedback(null)
    try {
      const res = await authFetch(`/api/git/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workdir, ...body }),
      })
      const data = (await res.json()) as GitActionResult
      if (!res.ok || !data.success) {
        setFeedback({ type: 'error', message: data.error ?? t({ en: 'Operation failed', fr: 'Échec de l’opération' }) })
        return false
      }
      if (op === 'commit-message') {
        setCommitMessage(data.message ?? '')
      } else if (successMessage) {
        setFeedback({ type: 'success', message: successMessage })
      }
      return true
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : t({ en: 'Operation failed', fr: 'Échec de l’opération' }),
      })
      return false
    } finally {
      setBusy(null)
    }
  }

  const doCommit = async () => {
    const ok = await callGit('commit', { message: commitMessage.trim() }, t({ en: 'Committed', fr: 'Commit effectué' }))
    if (ok) {
      setCommitMessage('')
      setDiffTarget(null)
    }
  }

  const onHandlePointerDown = (e: React.PointerEvent) => {
    dragRef.current = { startY: e.clientY, startHeight: listHeight }
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const maxH = Math.round(window.innerHeight * 0.6)
      const next = Math.min(maxH, Math.max(100, drag.startHeight + (drag.startY - ev.clientY)))
      setListHeight(next)
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        {branch && <span className="text-text-secondary font-medium truncate">{branch}</span>}
        {sync && <SyncBadge sync={sync} className="gap-1.5" />}
        <span className="ml-auto shrink-0 text-text-muted">
          {stagedFiles.length} {t({ en: 'staged', fr: 'staged' })} · {unstagedFiles.length}{' '}
          {t({ en: 'unstaged', fr: 'unstaged' })}
          {untrackedFiles.length > 0 ? ` · ${untrackedFiles.length} ${t({ en: 'untracked', fr: 'non suivis' })}` : ''}
        </span>
        {stageAllPaths.length > 0 && (
          <button
            onClick={() => void callGit('stage', { paths: stageAllPaths })}
            disabled={busy !== null}
            className="shrink-0 p-1 rounded border border-border text-text-muted hover:text-text-secondary hover:bg-bg-tertiary disabled:opacity-50 transition-colors"
            title={t({ en: 'Stage all changes', fr: 'Stager tous les changements' })}
            aria-label={t({ en: 'Stage all changes', fr: 'Stager tous les changements' })}
          >
            {busy === 'stage' ? <Spinner size="sm" /> : <PlusIcon className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        data-testid="git-list-resize"
        onPointerDown={onHandlePointerDown}
        className="h-1 cursor-row-resize bg-border rounded hover:bg-accent-primary transition-colors"
      />

      <div data-testid="git-list" className="overflow-hidden" style={{ height: listHeight }}>
        <ScrollArea className="h-full">
          <div className="pr-1 space-y-0.5">
            {sections.map((section) => (
              <div key={section.key}>
                <div className="flex items-center gap-1 px-1 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-text-muted">
                  {section.label}
                  <span className="font-mono">({section.files.length})</span>
                </div>
                {section.files.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    workdir={workdir ?? null}
                    busy={busy !== null}
                    onToggle={() => void callGit(file.staged ? 'unstage' : 'stage', { paths: [file.path] })}
                    onDiscard={() => setDiscardTarget(file.path)}
                    onOpen={() => setDiffTarget({ path: file.path, staged: section.staged })}
                  />
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      <div className="pt-1.5 border-t border-border">
        <button
          onClick={() => {
            const first = stagedFiles[0]
            if (first) setDiffTarget({ path: first.path, staged: true })
          }}
          disabled={stagedFiles.length === 0}
          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-accent-primary text-white disabled:opacity-50 transition-opacity hover:opacity-90"
          aria-label={t({ en: 'Commit', fr: 'Commit' })}
        >
          <GitCommitIcon className="w-3.5 h-3.5" />
          {t({ en: 'Commit', fr: 'Commit' })}
          {stagedFiles.length > 0 && (
            <span className="min-w-4 h-4 px-1 flex items-center justify-center rounded-full bg-white/20 text-[10px] font-mono">
              {stagedFiles.length}
            </span>
          )}
        </button>
      </div>

      {workdir && diffTarget && (
        <DiffModal
          workdir={workdir}
          path={diffTarget.path}
          staged={diffTarget.staged}
          isOpen
          onClose={() => setDiffTarget(null)}
          files={diff.files}
          commit={{
            message: commitMessage,
            onMessageChange: setCommitMessage,
            onCommit: doCommit,
            onGenerate: () => void callGit('commit-message', {}),
            onPush: () => void callGit('push', {}, t({ en: 'Pushed', fr: 'Push effectué' })),
            onPull: () => void callGit('pull', {}, t({ en: 'Pulled', fr: 'Pull effectué' })),
            busy,
            feedback,
            stagedCount: stagedFiles.length,
            pushDisabled: branch === null,
            pullDisabled: sync === null,
          }}
        />
      )}

      <ConfirmModal
        isOpen={discardTarget !== null}
        onClose={() => setDiscardTarget(null)}
        onConfirm={() => {
          const target = discardTarget
          setDiscardTarget(null)
          if (target) void callGit('discard', { paths: [target] })
        }}
        title={t({ en: 'Discard changes', fr: 'Abandonner les changements' })}
        message={
          discardTarget
            ? t(
                {
                  en: 'Discard local changes in {{path}}? This cannot be undone.',
                  fr: 'Abandonner les changements locaux de {{path}} ? Cette action est irréversible.',
                },
                { path: discardTarget },
              )
            : ''
        }
        confirmLabel={t({ en: 'Discard', fr: 'Abandonner' })}
        confirmVariant="danger"
      />
    </div>
  )
}
