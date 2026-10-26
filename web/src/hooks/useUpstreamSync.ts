import { useResourceWhen } from './useResource'
import { workspacesResource } from '../lib/resources'
import type { GitStatusSync } from '@shared/protocol.js'

export function toSync(ahead: number | null, behind: number | null): GitStatusSync | null {
  return ahead !== null && behind !== null ? { ahead, behind } : null
}

export function useUpstreamSync(workspaceName: string, projectId: string): GitStatusSync | null {
  const { data } = useResourceWhen(Boolean(projectId), workspacesResource, projectId)
  if (!data) return null
  if (!workspaceName || workspaceName === 'original') return toSync(data.main.ahead, data.main.behind)
  const ws = data.workspaces.find((w) => w.name === workspaceName)
  return ws ? toSync(ws.ahead, ws.behind) : null
}
