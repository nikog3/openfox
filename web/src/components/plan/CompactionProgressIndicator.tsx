import { memo } from 'react'
import { useT } from '../../hooks/useT'
import { Spinner } from '../shared/Spinner'
import type { CompactionProgressState } from '../../stores/session/types'

interface CompactionProgressIndicatorProps {
  compaction: CompactionProgressState
}

/**
 * Live context-compaction indicator shown while a sequential fold summarizes
 * the conversation in steps (no single LLM stream is in flight, so the
 * prefill indicator is absent). Shows the current step over the estimated
 * total, a progress bar and the elapsed time.
 */
export const CompactionProgressIndicator = memo(function CompactionProgressIndicator({
  compaction,
}: CompactionProgressIndicatorProps) {
  const t = useT()

  const current = Math.min(compaction.step, compaction.totalSteps)
  const percent = Math.min(100, Math.round((current / compaction.totalSteps) * 100))

  return (
    <div
      className="flex items-center gap-2.5 text-xs text-text-secondary bg-secondary/60 rounded-full px-3 py-1.5"
      data-testid="compaction-progress-indicator"
    >
      <Spinner size="sm" />
      <span>
        {t(
          {
            en: 'Compacting context — step {{step}} of {{total}}',
            fr: 'Compaction du contexte — étape {{step}} sur {{total}}',
          },
          { step: current, total: compaction.totalSteps },
        )}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-20 h-1 rounded-full bg-bg-primary overflow-hidden">
          <span
            className="block h-full bg-accent-primary transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        </span>
        <span className="font-mono">{t({ en: '{{percent}}%', fr: '{{percent}} %' }, { percent })}</span>
      </span>
    </div>
  )
})
