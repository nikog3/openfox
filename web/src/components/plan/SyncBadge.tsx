import { ArrowDownIcon, ArrowUpIcon } from '../shared/icons'
import type { GitStatusSync } from '@shared/protocol.js'

export function SyncBadge({ sync, className = '' }: { sync: GitStatusSync; className?: string }) {
  if (sync.ahead === 0 && sync.behind === 0) return null
  return (
    <span className={`flex items-center shrink-0 text-text-muted font-mono ${className}`}>
      {sync.ahead > 0 && (
        <span className="flex items-center gap-0.5">
          <ArrowUpIcon className="w-3 h-3" />
          {sync.ahead}
        </span>
      )}
      {sync.behind > 0 && (
        <span className="flex items-center gap-0.5">
          <ArrowDownIcon className="w-3 h-3" />
          {sync.behind}
        </span>
      )}
    </span>
  )
}
