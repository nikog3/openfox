import { useEffect, useState } from 'react'
import { useScopedContext, useScopedPaneState } from '../stores/session/session-scope'
import type { GitDiffFile, GitStatusSync } from '@shared/protocol.js'

interface UseGitStatusResult {
  branch: string | null
  sync: GitStatusSync | null
  diff: {
    files: GitDiffFile[]
    loading: boolean
    error: string | null
  }
}

export function useGitStatus(): UseGitStatusResult {
  const { sessionId, currentSession } = useScopedContext()
  const gitStatus = useScopedPaneState(
    sessionId,
    (pane) => pane.gitStatus,
    (state) => state.gitStatus,
    null,
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (currentSession?.workdir) {
      setLoading(false)
    }
  }, [currentSession?.workdir])

  return {
    branch: gitStatus?.branch ?? null,
    sync: gitStatus?.sync ?? null,
    diff: {
      files: gitStatus?.diff?.files ?? [],
      loading,
      error: null,
    },
  }
}
