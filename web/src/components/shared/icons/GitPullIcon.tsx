interface GitPullIconProps {
  className?: string
}

export function GitPullIcon({ className = 'w-3.5 h-3.5 text-text-muted' }: GitPullIconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v12m5-5-5 5-5-5M4 21h16" />
    </svg>
  )
}
