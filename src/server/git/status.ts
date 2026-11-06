import { isGitRepository, getProjectSync } from './workspace.js'
import { getGitDiffFiles } from './diff.js'
import type { ProjectGitStatus } from '../../shared/types.js'

export async function getProjectGitStatus(workdir: string): Promise<ProjectGitStatus | null> {
  try {
    if (!(await isGitRepository(workdir))) return null
    const [sync, diffFiles] = await Promise.all([getProjectSync(workdir), getGitDiffFiles(workdir)])
    return {
      branch: sync.branch,
      ahead: sync.ahead ?? 0,
      behind: sync.behind ?? 0,
      dirtyFiles: diffFiles.length,
    }
  } catch {
    return null
  }
}
