import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Modal } from '../shared/Modal'
import { ConfirmModal } from '../shared/ConfirmModal'
import { Spinner } from '../shared/Spinner'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ColumnsIcon,
  CopyIcon,
  MinusIcon,
  ReloadIcon,
} from '../shared/icons'
import { useT } from '../../hooks/useT'
import { useResourceWhen } from '../../hooks/useResource'
import { gitFileDiffResource } from '../../lib/resources'
import { authFetch } from '../../lib/api'
import { getLanguageFromPath, highlightCode, useShikiTheme } from '../../lib/syntax-highlighter'
import { truncateMiddle } from '../../lib/path'
import {
  getSplitChangeGroups,
  inlineDiff,
  pairSplitRows,
  parseUnifiedDiff,
  type InlineDiff,
  type InlineRange,
} from '../../lib/diff-utils'
import type { GitDiffFile } from '../../stores/session/types'

type ViewMode = 'split' | 'unified'

interface DiffModalProps {
  workdir: string
  path: string
  staged: boolean
  isOpen: boolean
  onClose: () => void
  files?: GitDiffFile[]
}

function extractShikiLines(html: string, count: number): string[] {
  const inner = html
    .replace(/^<pre[^>]*>/, '')
    .replace(/<\/pre>$/, '')
    .replace(/^<code[^>]*>/, '')
    .replace(/<\/code>$/, '')
  const rawLines = inner.split('\n')
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = rawLines[i] ?? ''
    const m = raw.match(/^<span class="line"[^>]*>([\s\S]*)<\/span>$/)
    out.push(m ? (m[1] ?? '') : raw)
  }
  return out
}

function SidebarFileRow({
  label,
  additions,
  deletions,
  active,
  onClick,
}: {
  label: string
  additions: number
  deletions: number
  active: boolean
  onClick: () => void
}) {
  const hasAdditions = additions > 0
  const hasDeletions = deletions > 0
  return (
    <button
      onClick={onClick}
      title={label}
      data-file={label}
      className={`w-full flex items-center gap-1.5 py-0.5 px-1.5 text-xs min-w-0 rounded ${
        active ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:bg-bg-tertiary/60'
      }`}
    >
      <span className="truncate min-w-0 flex-1 text-left">{truncateMiddle(label, 22)}</span>
      {(hasAdditions || hasDeletions) && (
        <span className="shrink-0 font-mono text-[10px]">
          {hasAdditions && <span className="text-accent-success">+{additions}</span>}
          {hasDeletions && <span className="text-accent-error">-{deletions}</span>}
        </span>
      )}
    </button>
  )
}

export function DiffModal({ workdir, path, staged, isOpen, onClose, files }: DiffModalProps) {
  const t = useT()
  const [view, setView] = useState<ViewMode>('split')
  const [activeGroup, setActiveGroup] = useState(-1)
  const [copied, setCopied] = useState(false)
  const [oldLines, setOldLines] = useState<string[] | null>(null)
  const [newLines, setNewLines] = useState<string[] | null>(null)
  const [activePath, setActivePath] = useState(path)
  const [activeStaged, setActiveStaged] = useState(staged)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const { data, loading, error } = useResourceWhen(isOpen, gitFileDiffResource, workdir, activePath, activeStaged)
  const theme = useShikiTheme()
  const diff = data?.diff ?? ''
  const lang = useMemo(() => getLanguageFromPath(activePath), [activePath])

  const rows = useMemo(() => parseUnifiedDiff(diff), [diff])
  const splitRows = useMemo(() => pairSplitRows(rows), [rows])
  const groups = useMemo(() => getSplitChangeGroups(splitRows), [splitRows])

  const oldText = useMemo(() => splitRows.map((sr) => sr.old?.content ?? '').join('\n'), [splitRows])
  const newText = useMemo(() => splitRows.map((sr) => sr.new?.content ?? '').join('\n'), [splitRows])

  useEffect(() => {
    setActiveGroup(-1)
    setCopied(false)
    setResetError(null)
  }, [activePath, activeStaged, isOpen])

  const handleResetConfirm = async () => {
    setConfirmReset(false)
    setResetError(null)
    setResetting(true)
    try {
      const res = await authFetch('/api/git/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workdir }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null
        setResetError(err?.error ?? t({ en: 'Failed to reset changes', fr: 'Échec de la réinitialisation' }))
        return
      }
      onClose()
    } catch {
      setResetError(t({ en: 'Failed to reset changes', fr: 'Échec de la réinitialisation' }))
    } finally {
      setResetting(false)
    }
  }

  useEffect(() => {
    if (!isOpen || splitRows.length === 0) {
      setOldLines(null)
      setNewLines(null)
      return
    }
    let cancelled = false
    void Promise.all([highlightCode(oldText, lang, theme), highlightCode(newText, lang, theme)]).then(
      ([oldHtml, newHtml]) => {
        if (cancelled) return
        setOldLines(extractShikiLines(oldHtml, splitRows.length))
        setNewLines(extractShikiLines(newHtml, splitRows.length))
      },
    )
    return () => {
      cancelled = true
    }
  }, [isOpen, oldText, newText, lang, theme, splitRows.length])

  const inlineMap = useMemo(() => {
    const map: (InlineDiff | null)[] = new Array(splitRows.length).fill(null)
    for (let i = 0; i < splitRows.length; i++) {
      const sr = splitRows[i]!
      if (sr.old && sr.new && sr.old.type !== 'context' && sr.new.type !== 'context') {
        map[i] = inlineDiff(sr.old.content, sr.new.content)
      }
    }
    return map
  }, [splitRows])

  const unifiedRows = useMemo(() => {
    const out: { idx: number; side: 'old' | 'new' }[] = []
    for (let i = 0; i < splitRows.length; i++) {
      const sr = splitRows[i]!
      if (sr.old) out.push({ idx: i, side: 'old' })
      if (sr.new) out.push({ idx: i, side: 'new' })
    }
    return out
  }, [splitRows])

  const groupedFiles = useMemo(() => {
    if (!files) return null
    return [
      {
        key: 'staged',
        label: t({ en: 'Staged', fr: 'Staged' }),
        items: files.filter((f) => f.staged).map((f) => ({ file: f, staged: true })),
      },
      {
        key: 'unstaged',
        label: t({ en: 'Unstaged', fr: 'Unstaged' }),
        items: files.filter((f) => f.unstaged).map((f) => ({ file: f, staged: false })),
      },
      {
        key: 'untracked',
        label: t({ en: 'Untracked', fr: 'Non suivis' }),
        items: files.filter((f) => f.untracked).map((f) => ({ file: f, staged: false })),
      },
    ].filter((g) => g.items.length > 0)
  }, [files, t])

  const scrollRowIntoView = (splitIdx: number) => {
    bodyRef.current?.querySelector(`[data-split="${splitIdx}"]`)?.scrollIntoView({ block: 'center' })
  }

  const goNext = () => {
    if (groups.length === 0) return
    const next = activeGroup < 0 ? 0 : (activeGroup + 1) % groups.length
    setActiveGroup(next)
    scrollRowIntoView(groups[next]!.startRow)
  }

  const goPrev = () => {
    if (groups.length === 0) return
    const prev = activeGroup <= 0 ? groups.length - 1 : activeGroup - 1
    setActiveGroup(prev)
    scrollRowIntoView(groups[prev]!.startRow)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'j') {
      e.preventDefault()
      goNext()
    } else if (e.key === 'k') {
      e.preventDefault()
      goPrev()
    }
  }

  useEffect(() => {
    if (isOpen) bodyRef.current?.focus()
  }, [isOpen, diff])

  const copyDiff = async () => {
    if (!diff) return
    try {
      await navigator.clipboard.writeText(diff)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const renderContent = (content: string, lineHtml: string | undefined, ranges: InlineRange[] | undefined) => {
    if (ranges && ranges.length > 0) {
      const parts: ReactNode[] = []
      let pos = 0
      ranges.forEach((r, idx) => {
        if (r.start > pos) parts.push(content.slice(pos, r.start))
        parts.push(
          <span key={idx} className="bg-accent-primary/30 rounded-[1px]">
            {content.slice(r.start, r.end)}
          </span>,
        )
        pos = r.end
      })
      if (pos < content.length) parts.push(content.slice(pos))
      return <>{parts}</>
    }
    if (lineHtml) {
      return <span dangerouslySetInnerHTML={{ __html: lineHtml }} />
    }
    return <>{content}</>
  }

  const renderSplit = () =>
    splitRows.map((sr, i) => {
      const oldRemoved = sr.old?.type === 'removed'
      const newAdded = sr.new?.type === 'added'
      const oldBg = oldRemoved ? 'bg-accent-error/10' : sr.old == null ? 'bg-bg-tertiary/40' : ''
      const newBg = newAdded ? 'bg-accent-success/10' : sr.new == null ? 'bg-bg-tertiary/40' : ''
      const inline = inlineMap[i] ?? null
      return (
        <div key={i} data-split={i} className="flex text-xs font-mono leading-5">
          <div className={`flex-1 min-w-0 flex ${oldBg}`}>
            <span className="w-10 shrink-0 text-right pr-2 text-text-muted select-none">{sr.old?.oldLine ?? ''}</span>
            <pre className="flex-1 min-w-0 overflow-hidden whitespace-pre">
              {sr.old ? renderContent(sr.old.content, oldLines?.[i], inline?.oldRanges) : ''}
            </pre>
          </div>
          <div className={`flex-1 min-w-0 flex ${newBg}`}>
            <span className="w-10 shrink-0 text-right pr-2 text-text-muted select-none">{sr.new?.newLine ?? ''}</span>
            <pre className="flex-1 min-w-0 overflow-hidden whitespace-pre">
              {sr.new ? renderContent(sr.new.content, newLines?.[i], inline?.newRanges) : ''}
            </pre>
          </div>
        </div>
      )
    })

  const renderUnified = () =>
    unifiedRows.map(({ idx, side }, ui) => {
      const sr = splitRows[idx]!
      const row = (side === 'old' ? sr.old : sr.new) as NonNullable<typeof sr.old>
      const marker = row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' '
      const bg = row.type === 'added' ? 'bg-accent-success/10' : row.type === 'removed' ? 'bg-accent-error/10' : ''
      const inline = inlineMap[idx] ?? null
      const ranges = side === 'old' ? inline?.oldRanges : inline?.newRanges
      const lineHtml = side === 'old' ? oldLines?.[idx] : newLines?.[idx]
      return (
        <div key={ui} data-split={idx} className={`flex text-xs font-mono leading-5 ${bg}`}>
          <span className="w-8 shrink-0 text-right pr-2 text-text-muted select-none">{row.oldLine ?? ''}</span>
          <span className="w-8 shrink-0 text-right pr-2 text-text-muted select-none opacity-60">
            {row.newLine ?? ''}
          </span>
          <span className="w-4 shrink-0 text-center text-text-muted">{marker}</span>
          <pre className="flex-1 min-w-0 overflow-hidden whitespace-pre">
            {renderContent(row.content, lineHtml, ranges)}
          </pre>
        </div>
      )
    })

  const toolbar = (
    <div className="flex items-center gap-1.5">
      <div className="flex rounded border border-border overflow-hidden">
        <button
          onClick={() => setView('split')}
          className={`flex items-center gap-1 px-2 py-1 text-xs ${
            view === 'split' ? 'bg-bg-tertiary text-text-primary' : 'text-text-muted hover:text-text-secondary'
          }`}
          aria-label={t({ en: 'Split view', fr: 'Vue séparée' })}
        >
          <ColumnsIcon className="w-3.5 h-3.5" />
          {t({ en: 'Split', fr: 'Séparé' })}
        </button>
        <button
          onClick={() => setView('unified')}
          className={`flex items-center gap-1 px-2 py-1 text-xs border-l border-border ${
            view === 'unified' ? 'bg-bg-tertiary text-text-primary' : 'text-text-muted hover:text-text-secondary'
          }`}
          aria-label={t({ en: 'Unified view', fr: 'Vue unifiée' })}
        >
          <MinusIcon className="w-3.5 h-3.5" />
          {t({ en: 'Unified', fr: 'Unifié' })}
        </button>
      </div>
      {groups.length > 0 && (
        <div className="flex items-center gap-0.5">
          <button
            onClick={goPrev}
            className="p-1 rounded text-text-muted hover:text-text-secondary hover:bg-bg-tertiary"
            aria-label={t({ en: 'Previous change', fr: 'Changement précédent' })}
          >
            <ChevronUpIcon className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs font-mono text-text-muted min-w-[2.5rem] text-center" data-testid="change-counter">
            {activeGroup + 1}/{groups.length}
          </span>
          <button
            onClick={goNext}
            className="p-1 rounded text-text-muted hover:text-text-secondary hover:bg-bg-tertiary"
            aria-label={t({ en: 'Next change', fr: 'Changement suivant' })}
          >
            <ChevronDownIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      <button
        onClick={() => {
          setResetError(null)
          setConfirmReset(true)
        }}
        disabled={resetting}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-accent-error hover:border-accent-error/40 hover:bg-bg-tertiary transition-colors disabled:opacity-50"
        aria-label={t({ en: 'Reset all changes', fr: 'Tout réinitialiser' })}
      >
        <ReloadIcon className="w-3.5 h-3.5" />
        {t({ en: 'Reset', fr: 'Réinitialiser' })}
      </button>
      <button
        onClick={() => void copyDiff()}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-text-secondary hover:bg-bg-tertiary transition-colors"
        aria-label={t({ en: 'Copy diff', fr: 'Copier le diff' })}
      >
        {copied ? <CheckIcon className="w-3.5 h-3.5 text-accent-success" /> : <CopyIcon className="w-3.5 h-3.5" />}
        {copied ? t({ en: 'Copied', fr: 'Copié' }) : t({ en: 'Copy', fr: 'Copier' })}
      </button>
    </div>
  )

  const diffContent =
    loading && !data ? (
      <div className="flex items-center justify-center py-8">
        <Spinner />
      </div>
    ) : error && !data ? (
      <p className="text-sm text-accent-error">{t({ en: 'Failed to load diff', fr: 'Échec du chargement du diff' })}</p>
    ) : splitRows.length === 0 ? (
      <p className="text-sm text-text-muted text-center py-8">{t({ en: 'No changes', fr: 'Aucun changement' })}</p>
    ) : (
      <div
        ref={bodyRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="h-full rounded border border-border overflow-auto outline-none focus:ring-1 focus:ring-accent-primary"
      >
        {view === 'split' ? renderSplit() : renderUnified()}
      </div>
    )

  const body = (
    <div className="flex flex-col h-[60vh]">
      {resetError && (
        <div className="mb-2 text-xs text-accent-error bg-accent-error/10 border border-accent-error/30 rounded px-2 py-1">
          {resetError}
        </div>
      )}
      <div className="flex flex-1 min-h-0">
        {groupedFiles && (
          <div className="w-56 shrink-0 border-r border-border flex flex-col min-h-0">
            <div className="flex-1 overflow-auto p-1 space-y-2">
              {groupedFiles.map((group) => (
                <div key={group.key}>
                  <div className="px-1.5 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-text-muted">
                    {group.label}
                    <span className="font-mono">({group.items.length})</span>
                  </div>
                  {group.items.map((item) => (
                    <SidebarFileRow
                      key={`${group.key}-${item.file.path}-${item.staged}`}
                      label={item.file.path}
                      additions={item.file.additions}
                      deletions={item.file.deletions}
                      active={activePath === item.file.path && activeStaged === item.staged}
                      onClick={() => {
                        setActivePath(item.file.path)
                        setActiveStaged(item.staged)
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex-1 min-w-0 p-3 flex flex-col min-h-0">{diffContent}</div>
      </div>
    </div>
  )

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={<span className="font-mono text-base">{activePath}</span>}
        size={groupedFiles ? '2xl' : 'xl'}
        headerRight={toolbar}
      >
        {body}
      </Modal>
      <ConfirmModal
        isOpen={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => void handleResetConfirm()}
        title={t({ en: 'Reset all changes?', fr: 'Tout réinitialiser ?' })}
        message={t({
          en: 'All changes in the repository will be discarded: staged and unstaged changes are reset to the last commit, and untracked files are deleted. This cannot be undone.',
          fr: 'Toutes les modifications du dépôt seront annulées : les changements staged et unstaged sont réinitialisés au dernier commit, et les fichiers non suivis sont supprimés. Cette action est irréversible.',
        })}
        confirmLabel={t({ en: 'Reset all', fr: 'Tout réinitialiser' })}
        confirmVariant="danger"
        disabled={resetting}
      />
    </>
  )
}
