import { memo, useEffect, useState } from 'react'
import { useT } from '../../hooks/useT'
import { usePageVisible } from '../../hooks/usePageVisible'
import { formatTime, formatTokens } from '../../lib/format-stats'
import { estimatePrefill } from '../../lib/prefill-estimate'
import { Spinner } from '../shared/Spinner'
import type { PrefillState } from '../../stores/session/types'

interface PrefillIndicatorProps {
  prefill: PrefillState
  /** Measured prefill speed of the most recent LLM call (tokens/sec), for estimation. */
  lastPrefillSpeed?: number
  /** Tokens added since the previous call (warm-cache incremental work), when known. */
  tokenIncrement?: number
}

/**
 * Live "prefilling" indicator shown between the request being sent and the
 * first token arriving. Three tiers: engine-measured progress (llama.cpp
 * /slots), an estimate projected from the last measured prefill speed, or
 * just the token count and elapsed time when nothing is measurable.
 */
export const PrefillIndicator = memo(function PrefillIndicator({
  prefill,
  lastPrefillSpeed,
  tokenIncrement,
}: PrefillIndicatorProps) {
  const t = useT()
  const visible = usePageVisible()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [visible])

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

  return (
    <div
      className="flex items-center gap-2.5 text-xs text-text-secondary bg-secondary/60 rounded-full px-3 py-1.5"
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
    </div>
  )
})
