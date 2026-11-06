import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getProjectGitStatus } from './status.js'
import type { GitDiffFile } from '../../shared/protocol.js'

vi.mock('./workspace.js', () => ({
  isGitRepository: vi.fn(),
  getProjectSync: vi.fn(),
}))

vi.mock('./diff.js', () => ({
  getGitDiffFiles: vi.fn(),
}))

import { isGitRepository, getProjectSync } from './workspace.js'
import { getGitDiffFiles } from './diff.js'

const WORKDIR = '/tmp/project'

function diffFile(overrides: Partial<GitDiffFile> = {}): GitDiffFile {
  return {
    path: 'a.ts',
    status: 'modified',
    staged: false,
    unstaged: true,
    untracked: false,
    additions: 1,
    deletions: 0,
    ...overrides,
  }
}

describe('getProjectGitStatus', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns null when the workdir is not a git repository', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(false)
    await expect(getProjectGitStatus(WORKDIR)).resolves.toBeNull()
    expect(getProjectSync).not.toHaveBeenCalled()
    expect(getGitDiffFiles).not.toHaveBeenCalled()
  })

  it('returns a clean status for a git repository with no changes', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(true)
    vi.mocked(getProjectSync).mockResolvedValue({ branch: 'main', ahead: 0, behind: 0 })
    vi.mocked(getGitDiffFiles).mockResolvedValue([])
    await expect(getProjectGitStatus(WORKDIR)).resolves.toEqual({
      branch: 'main',
      ahead: 0,
      behind: 0,
      dirtyFiles: 0,
    })
  })

  it('counts dirty files and maps null ahead/behind to 0', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(true)
    vi.mocked(getProjectSync).mockResolvedValue({ branch: 'main', ahead: null, behind: null })
    vi.mocked(getGitDiffFiles).mockResolvedValue([diffFile(), diffFile({ path: 'b.ts' })])
    await expect(getProjectGitStatus(WORKDIR)).resolves.toEqual({
      branch: 'main',
      ahead: 0,
      behind: 0,
      dirtyFiles: 2,
    })
  })

  it('reports ahead/behind counts and the current branch', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(true)
    vi.mocked(getProjectSync).mockResolvedValue({ branch: 'dev', ahead: 2, behind: 3 })
    vi.mocked(getGitDiffFiles).mockResolvedValue([])
    await expect(getProjectGitStatus(WORKDIR)).resolves.toEqual({
      branch: 'dev',
      ahead: 2,
      behind: 3,
      dirtyFiles: 0,
    })
  })

  it('returns null when a git operation throws', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(true)
    vi.mocked(getProjectSync).mockRejectedValue(new Error('git failed'))
    vi.mocked(getGitDiffFiles).mockResolvedValue([])
    await expect(getProjectGitStatus(WORKDIR)).resolves.toBeNull()
  })
})
