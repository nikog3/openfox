import { useRef, useState } from 'react'
import { ScrollArea } from '../shared/ScrollArea'
import { PencilIcon } from '../shared/icons'
import { Spinner } from '../shared/Spinner'
import { DiffModal } from './DiffModal'
import { SyncBadge } from './SyncBadge'
import { useT } from '../../hooks/useT'
import { useSetting } from '../../hooks/useSetting'
import { useScopedContext } from '../../stores/session/session-scope'
import { useGitStatus } from '../../hooks/useGitStatus'
import { buildEditorUrl } from '../../lib/editor-link'
import { SETTINGS_KEYS } from '../../lib/resources'
import { truncateMiddle } from '../../lib/path'
import type { GitDiffFile } from '../../stores/session/types'

function FileRow({ file, workdir, onOpen }: { file: GitDiffFile; workdir: string | null; onOpen: () => void }) {
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
    </div>
  )
}

export function GitStatusPanel() {
  const t = useT()
  const { branch, sync, diff } = useGitStatus()
  const { currentSession: session } = useScopedContext()
  const workdir = session?.workspace ?? session?.workdir
  const [diffTarget, setDiffTarget] = useState<{ path: string; staged: boolean } | null>(null)
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
                    onOpen={() => setDiffTarget({ path: file.path, staged: section.staged })}
                  />
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {workdir && diffTarget && (
        <DiffModal
          workdir={workdir}
          path={diffTarget.path}
          staged={diffTarget.staged}
          isOpen
          onClose={() => setDiffTarget(null)}
          files={diff.files}
        />
      )}
    </div>
  )
}
