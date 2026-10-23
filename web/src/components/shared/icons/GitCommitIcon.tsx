interface GitCommitIconProps {
  className?: string
}

export function GitCommitIcon({ className = 'w-3.5 h-3.5 text-text-muted' }: GitCommitIconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx={12} cy={12} r={4} />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2 12h6m8 0h6" />
    </svg>
  )
}
