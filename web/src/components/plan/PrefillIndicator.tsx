import { memo, useEffect, useRef, useState } from 'react'
import { useT } from '../../hooks/useT'
import { usePageVisible } from '../../hooks/usePageVisible'
import { formatTime, formatTokens } from '../../lib/format-stats'
import { estimatePrefill } from '../../lib/prefill-estimate'
import { InfoIcon } from '../shared/icons'
import { Spinner } from '../shared/Spinner'
import type { PrefillState } from '../../stores/session/types'

interface PrefillIndicatorProps {
  prefill: PrefillState
  /** Measured prefill speed of the most recent LLM call (tokens/sec), for estimation. */
  lastPrefillSpeed?: number
  /** Tokens added since the previous call (warm-cache incremental work), when known. */
  tokenIncrement?: number
}

/** One label/value row of the prefill details panel. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary font-mono">{value}</span>
    </div>
  )
}

/**
 * Live "prefilling" indicator shown between the request being sent and the
 * first token arriving. Three tiers: engine-measured progress (llama.cpp
 * /slots), an estimate projected from the last measured prefill speed, or
 * just the token count and elapsed time when nothing is measurable. When the
 * engine measures the progress, an info icon opens a details panel with
 * everything the server knows about the in-flight call (slot/task identity,
 * KV cache split, speed, ETA).
 */
export const PrefillIndicator = memo(function PrefillIndicator({
  prefill,
  lastPrefillSpeed,
  tokenIncrement,
}: PrefillIndicatorProps) {
  const t = useT()
  const visible = usePageVisible()
  const [now, setNow] = useState(() => Date.now())
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [visible])

  useEffect(() => {
    if (!detailsOpen) return
    const handler = (event: MouseEvent) => {
      if (detailsRef.current && !detailsRef.current.contains(event.target as Node)) {
        setDetailsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [detailsOpen])

  const elapsedMs = now - prefill.startedAt
  // The engine's own prompt size is the most accurate total — it covers the
  // first call of a session, where the tracked context size is still 0.
  const promptTokens = prefill.promptTokens ?? prefill.contextTokens
  const estimate = estimatePrefill({
    contextTokens: promptTokens,
    ...(tokenIncrement !== undefined ? { tokenIncrement } : {}),
    ...(lastPrefillSpeed !== undefined ? { lastPrefillSpeed } : {}),
    elapsedMs,
  })
  // Engine-measured progress wins; the estimate only fills the gaps.
  const percent = prefill.percent ?? estimate.percent
  const etaSeconds = prefill.etaSeconds ?? estimate.etaSeconds
  const estimated = percent !== undefined && prefill.percent === undefined
  const elapsedSec = elapsedMs / 1000
  // Engine-measured data exists (slot identity known) — the details panel is
  // only useful then.
  const measured = prefill.slotId !== undefined

  return (
    <div
      className="relative flex items-center gap-2.5 text-xs text-text-secondary bg-secondary/60 rounded-full px-3 py-1.5"
      data-testid="prefill-indicator"
    >
      <Spinner size="sm" />
      <span>
        {tokenIncrement !== undefined && tokenIncrement > 0
          ? t(
              {
                en: 'Prefilling {{increment}} of {{tokens}} tokens',
                fr: 'Préfill — {{increment}} sur {{tokens}} tokens',
              },
              { increment: formatTokens(tokenIncrement), tokens: formatTokens(promptTokens) },
            )
          : t(
              { en: 'Prefilling {{tokens}} tokens', fr: 'Préfill — {{tokens}} tokens' },
              { tokens: formatTokens(promptTokens) },
            )}
      </span>
      {measured && (
        <span className="text-text-muted font-mono" data-testid="prefill-slot-id">
          #{prefill.slotId}
        </span>
      )}
      {percent !== undefined && (
        <span className="flex items-center gap-1.5">
          <span className="w-20 h-1 rounded-full bg-bg-primary overflow-hidden">
            <span
              className="block h-full bg-accent-primary transition-[width] duration-200"
              style={{ width: `${percent}%` }}
            />
          </span>
          <span>
            {estimated && t({ en: '≈', fr: '≈' })}
            {t({ en: '{{percent}}%', fr: '{{percent}} %' }, { percent })}
          </span>
        </span>
      )}
      {etaSeconds !== undefined && (
        <span>
          {estimated
            ? t({ en: '≈ {{time}} left', fr: '≈ {{time}} restants' }, { time: formatTime(etaSeconds, false) })
            : t({ en: '{{time}} left', fr: '{{time}} restants' }, { time: formatTime(etaSeconds, false) })}
        </span>
      )}
      <span className="text-text-muted">{formatTime(elapsedSec, false)}</span>
      {measured && (
        <div ref={detailsRef} className="relative">
          <button
            type="button"
            data-testid="prefill-details-toggle"
            onClick={() => setDetailsOpen((open) => !open)}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label={t({ en: 'Prefill details', fr: 'Détails du préfill' })}
          >
            <InfoIcon className="w-3.5 h-3.5" />
          </button>
          {detailsOpen && (
            <div
              data-testid="prefill-details-panel"
              className="absolute top-full right-0 mt-2 z-50 bg-bg-secondary border border-border rounded-lg shadow-xl p-3 flex flex-col gap-1.5 text-xs w-52"
            >
              <DetailRow label={t({ en: 'Slot', fr: 'Slot' })} value={`#${prefill.slotId}`} />
              {prefill.taskId !== undefined && (
                <DetailRow label={t({ en: 'Task', fr: 'Tâche' })} value={String(prefill.taskId)} />
              )}
              <DetailRow label={t({ en: 'Prompt total', fr: 'Total prompt' })} value={formatTokens(promptTokens)} />
              {prefill.cachedTokens !== undefined && (
                <DetailRow label={t({ en: 'KV cache', fr: 'KV cache' })} value={formatTokens(prefill.cachedTokens)} />
              )}
              {prefill.processedTokens !== undefined && (
                <DetailRow
                  label={t({ en: 'Processed', fr: 'Traités' })}
                  value={formatTokens(prefill.processedTokens)}
                />
              )}
              {prefill.speedTps !== undefined && (
                <DetailRow
                  label={t({ en: 'Speed', fr: 'Vitesse' })}
                  value={t({ en: '{{speed}} t/s', fr: '{{speed}} t/s' }, { speed: formatTokens(prefill.speedTps) })}
                />
              )}
              {prefill.avgTps !== undefined && (
                <DetailRow
                  label={t({ en: 'Avg speed', fr: 'Vitesse moyenne' })}
                  value={t({ en: '{{speed}} t/s', fr: '{{speed}} t/s' }, { speed: formatTokens(prefill.avgTps) })}
                />
              )}
              {prefill.etaSeconds !== undefined && (
                <DetailRow label={t({ en: 'ETA', fr: 'ETA' })} value={formatTime(prefill.etaSeconds, false)} />
              )}
              {prefill.contextTokens > 0 && (
                <DetailRow label={t({ en: 'Context', fr: 'Contexte' })} value={formatTokens(prefill.contextTokens)} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
