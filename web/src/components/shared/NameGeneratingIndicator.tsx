import { useState, useEffect } from 'react'
import { useT } from '../../hooks/useT'
import type { NameGeneratingState } from '../../stores/session/types'

/** Live pill shown while the agent names a session, including backoff countdown on retry. */
export function NameGeneratingIndicator({ state }: { state: NameGeneratingState }) {
  const t = useT()
  const [receivedAt, setReceivedAt] = useState(Date.now())
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    setReceivedAt(Date.now())
  }, [state.retryInMs, state.attempt])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])

  const remainingSec =
    state.retryInMs !== undefined ? Math.max(0, Math.ceil((state.retryInMs - (now - receivedAt)) / 1000)) : 0
  const suffix =
    state.retryInMs !== undefined
      ? t({ en: ' — next try in {{count}}s', fr: ' — prochain essai dans {{count}}s' }, { count: remainingSec })
      : ''

  return (
    <span className="flex items-center gap-1.5 text-xs text-text-secondary">
      <span className="w-2 h-2 rounded-full bg-accent-primary animate-pulse" />
      <span>
        {t({ en: 'Naming session', fr: 'Nomination de la session' })}
        {state.maxAttempts > 0
          ? t({ en: ' (attempt {{a}}/{{m}})', fr: ' (essai {{a}}/{{m}})' }, { a: state.attempt, m: state.maxAttempts })
          : ''}
        {suffix}
      </span>
    </span>
  )
}
