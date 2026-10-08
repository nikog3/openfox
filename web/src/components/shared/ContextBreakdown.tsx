import { useT } from '../../hooks/useT'
import { formatTokens } from '../../lib/format-stats'

export interface ContextBreakdownValues {
  ctxWindow?: number
  currentTokens?: number
  estimatedResultTokens?: number
  reserveTokens?: number
  availableTokens?: number
  actualTokens?: number
  serverLimit?: number
}

export interface ContextBreakdownItem {
  label: { en: string; fr: string }
  value: number
}

export function buildContextBreakdownItems(values: ContextBreakdownValues): ContextBreakdownItem[] {
  const items: ContextBreakdownItem[] = []
  if (values.ctxWindow !== undefined) items.push({ label: { en: 'Window', fr: 'Fenêtre' }, value: values.ctxWindow })
  if (values.currentTokens !== undefined)
    items.push({ label: { en: 'Used', fr: 'Utilisé' }, value: values.currentTokens })
  if (values.estimatedResultTokens !== undefined)
    items.push({ label: { en: 'Tool (est.)', fr: 'Outil (est.)' }, value: values.estimatedResultTokens })
  if (values.reserveTokens !== undefined)
    items.push({ label: { en: 'Output reserve', fr: 'Réserve sortie' }, value: values.reserveTokens })
  if (values.availableTokens !== undefined)
    items.push({ label: { en: 'Available', fr: 'Disponible' }, value: values.availableTokens })
  if (values.actualTokens !== undefined)
    items.push({ label: { en: 'Actual request', fr: 'Request réelle' }, value: values.actualTokens })
  if (values.serverLimit !== undefined)
    items.push({ label: { en: 'Server limit', fr: 'Limite serveur' }, value: values.serverLimit })
  return items
}

export function numOrNull(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function ContextBreakdown({ items, className }: { items: ContextBreakdownItem[]; className?: string }) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <span className={className}>
      {items.map((item) => (
        <span key={item.label.en} className="mr-2">
          {t(item.label)} {formatTokens(item.value)}
        </span>
      ))}
    </span>
  )
}
