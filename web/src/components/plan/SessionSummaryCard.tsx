import { memo } from 'react'
import type { Message } from '@shared/types.js'
import { Markdown } from '../shared/Markdown'
import { Spinner } from '../shared/Spinner'
import { TasksIcon } from '../shared/icons'
import { hexToRgba } from '../../lib/colors'
import { useT } from '../../hooks/useT'

interface SessionSummaryCardProps {
  message: Message
}

export const SessionSummaryCard = memo(function SessionSummaryCard({ message }: SessionSummaryCardProps) {
  const t = useT()
  const isStreaming = message.isStreaming ?? false
  const color = message.metadata?.color ?? '#8b5cf6'

  return (
    <div
      data-testid="session-summary-card"
      className="feed-item rounded p-3 border"
      style={{ borderColor: hexToRgba(color, 0.3), backgroundColor: hexToRgba(color, 0.08) }}
    >
      <div className="flex items-center gap-2 mb-2">
        {isStreaming ? (
          <span style={{ color }}>
            <Spinner size="sm" />
          </span>
        ) : (
          <span style={{ color }}>
            <TasksIcon className="w-4 h-4" />
          </span>
        )}
        <span className="text-sm font-medium" style={{ color }}>
          {message.metadata?.name ?? t({ en: 'Session summary', fr: 'Résumé de session' })}
        </span>
      </div>
      {message.content && (
        <div className="prose prose-sm prose-invert max-w-none feed-item">
          <Markdown content={message.content} isStreaming={isStreaming} />
        </div>
      )}
    </div>
  )
})
