interface ArrowDownIconProps {
  className?: string
}

export function ArrowDownIcon({ className = 'w-3.5 h-3.5 text-text-muted' }: ArrowDownIconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7-7 7-7-7" />
    </svg>
  )
}
