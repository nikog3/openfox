interface GitPushIconProps {
  className?: string
}

export function GitPushIcon({ className = 'w-3.5 h-3.5 text-text-muted' }: GitPushIconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15V3m-5 5 5-5 5 5M4 21h16" />
    </svg>
  )
}
