import { useT } from '../hooks/useT'
import { CheckIcon } from './shared/icons'
import type { ProjectGitStatus } from '@shared/types.js'

const BADGE_BASE = 'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium shrink-0'

export function ProjectGitBadge({ gitStatus }: { gitStatus?: ProjectGitStatus | null }) {
  const t = useT()
  if (!gitStatus) {
    return (
      <span
        className={`${BADGE_BASE} border-border text-text-muted`}
        title={t({ en: 'Not a git repository', fr: 'Dépôt git absent' })}
      >
        {t({ en: 'no git', fr: 'pas de git' })}
      </span>
    )
  }
  const { branch, ahead, behind, dirtyFiles } = gitStatus
  const state = behind > 0 ? 'behind' : dirtyFiles > 0 ? 'dirty' : ahead > 0 ? 'ahead' : 'clean'
  const colors = {
    clean: 'border-emerald-400/30 text-emerald-400',
    ahead: 'border-accent-primary/30 text-accent-primary',
    dirty: 'border-amber-400/30 text-amber-400',
    behind: 'border-accent-error/30 text-accent-error',
  }
  const tooltipParts: string[] = []
  if (branch) tooltipParts.push(branch)
  if (dirtyFiles > 0)
    tooltipParts.push(t({ en: '{{count}} modified', fr: '{{count}} modifié(s)' }, { count: dirtyFiles }))
  if (ahead > 0) tooltipParts.push(t({ en: '{{count}} ahead', fr: '{{count}} en avance' }, { count: ahead }))
  if (behind > 0) tooltipParts.push(t({ en: '{{count}} behind', fr: '{{count}} en retard' }, { count: behind }))
  return (
    <span className={`${BADGE_BASE} ${colors[state]}`} title={tooltipParts.join(' · ')}>
      {state === 'clean' && <CheckIcon className="w-3 h-3" />}
      {branch ?? t({ en: 'detached', fr: 'détaché' })}
      {dirtyFiles > 0 && (
        <>
          {' · '}
          {dirtyFiles}
        </>
      )}
      {behind > 0 && (
        <>
          {' · '}↓{behind}
        </>
      )}
      {ahead > 0 && behind === 0 && (
        <>
          {' · '}↑{ahead}
        </>
      )}
    </span>
  )
}
