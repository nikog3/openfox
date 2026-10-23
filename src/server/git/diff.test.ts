import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGitDiffFiles, formatGitDiffFiles, getGitBranch, getGitSyncInfo, getGitFileDiff } from './diff.js'
import { setPluginVcsProviders, clearPluginVcsProviders } from '../plugins/vcs-providers.js'
import type { PluginVcsProvider } from '../../plugin/index.js'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('./env.js', () => ({
  gitSpawnEnv: () => ({}),
}))

import { spawn } from 'node:child_process'

type MockProc = {
  stdout: { on: (event: string, cb: (d: Buffer) => void) => void }
  stderr: { on: (event: string, cb: (d: Buffer) => void) => void }
  on: (event: string, cb: (...args: unknown[]) => void) => void
}

function makeMockProc(stdout: string, exitCode = 0): MockProc {
  return {
    stdout: {
      on: (event, cb) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from(stdout)), 0)
      },
    },
    stderr: {
      on: () => {},
    },
    on: (event, cb) => {
      if (event === 'close') setTimeout(() => cb(exitCode), 0)
    },
  }
}

function mockGitByArgs(handler: (args: string[]) => { stdout?: string; code?: number }): void {
  vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
    const r = handler(args)
    return makeMockProc(r.stdout ?? '', r.code ?? 0) as unknown as ReturnType<typeof spawn>
  }) as typeof spawn)
}

beforeEach(() => {
  vi.resetAllMocks()
  clearPluginVcsProviders()
})

describe('getGitDiffFiles', () => {
  it('passes --ignore-submodules=none to all git invocations', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockProc('') as unknown as ReturnType<typeof spawn>)
    await getGitDiffFiles('/tmp/project')

    const calls = vi.mocked(spawn).mock.calls
    expect(calls.length).toBe(3)
    for (const call of calls) {
      const args = call[1] as string[]
      expect(args).toContain('--ignore-submodules=none')
    }
  })

  it('classifies staged, unstaged and untracked files from porcelain status', async () => {
    mockGitByArgs((args) => {
      if (args[0] === 'status') return { stdout: 'M  src/a.ts\n M src/b.ts\n?? new.txt\n' }
      if (args[0] === 'diff' && args.includes('--cached')) return { stdout: '5\t3\tsrc/a.ts\n' }
      if (args[0] === 'diff') return { stdout: '1\t1\tsrc/b.ts\n' }
      return {}
    })

    const files = await getGitDiffFiles('/tmp/project')

    expect(files).toContainEqual({
      path: 'src/a.ts',
      status: 'modified',
      staged: true,
      unstaged: false,
      untracked: false,
      additions: 5,
      deletions: 3,
    })
    expect(files).toContainEqual({
      path: 'src/b.ts',
      status: 'modified',
      staged: false,
      unstaged: true,
      untracked: false,
      additions: 1,
      deletions: 1,
    })
    expect(files).toContainEqual({
      path: 'new.txt',
      status: 'added',
      staged: false,
      unstaged: false,
      untracked: true,
      additions: 0,
      deletions: 0,
    })
  })

  it('sums staged and unstaged line counts for the same file', async () => {
    mockGitByArgs((args) => {
      if (args[0] === 'status') return { stdout: 'MM src/a.ts\n' }
      if (args[0] === 'diff' && args.includes('--cached')) return { stdout: '4\t2\tsrc/a.ts\n' }
      if (args[0] === 'diff') return { stdout: '1\t1\tsrc/a.ts\n' }
      return {}
    })

    const files = await getGitDiffFiles('/tmp/project')

    expect(files).toEqual([
      {
        path: 'src/a.ts',
        status: 'modified',
        staged: true,
        unstaged: true,
        untracked: false,
        additions: 5,
        deletions: 3,
      },
    ])
  })

  it('counts lines for untracked files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openfox-git-diff-'))
    try {
      await writeFile(join(dir, 'new.txt'), 'line1\nline2\nline3\n', 'utf8')
      mockGitByArgs((args) => {
        if (args[0] === 'status') return { stdout: '?? new.txt\n' }
        return {}
      })

      const files = await getGitDiffFiles(dir)

      expect(files).toEqual([
        {
          path: 'new.txt',
          status: 'added',
          staged: false,
          unstaged: false,
          untracked: true,
          additions: 3,
          deletions: 0,
        },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not count a trailing newline as an extra line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openfox-git-diff-'))
    try {
      await writeFile(join(dir, 'noeol.txt'), 'line1\nline2', 'utf8')
      mockGitByArgs((args) => {
        if (args[0] === 'status') return { stdout: '?? noeol.txt\n' }
        return {}
      })

      const files = await getGitDiffFiles(dir)

      expect(files[0]?.additions).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('delegates to plugin VCS provider when matched', async () => {
    const mockProvider: PluginVcsProvider = {
      id: 'custom-vcs',
      detect: (ctx) => ctx.workdir === '/tmp/multi-project',
      getDiffFiles: async () => [
        { path: 'repo1/file.ts', status: 'modified' },
        { path: 'repo2/other.ts', status: 'added' },
      ],
    }

    setPluginVcsProviders([{ pluginId: 'test-plugin', provider: mockProvider }])

    const files = await getGitDiffFiles('/tmp/multi-project')
    expect(files).toEqual([
      {
        path: 'repo1/file.ts',
        status: 'modified',
        staged: false,
        unstaged: true,
        untracked: false,
        additions: 0,
        deletions: 0,
      },
      {
        path: 'repo2/other.ts',
        status: 'added',
        staged: false,
        unstaged: true,
        untracked: true,
        additions: 0,
        deletions: 0,
      },
    ])
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })

  it('formats git diff files through VCS provider when matched', async () => {
    const mockProvider: PluginVcsProvider = {
      id: 'custom-vcs',
      detect: () => true,
      getDiffFiles: async () => [{ path: 'pkg/sub.ts', status: 'modified' }],
      formatModifiedFiles: (files) => `Files: ${files.map((f) => f.path).join(', ')}`,
    }

    setPluginVcsProviders([{ pluginId: 'test-plugin', provider: mockProvider }])

    const formatted = await formatGitDiffFiles('/tmp/custom')
    expect(formatted).toBe('Files: pkg/sub.ts')
  })

  it('resolves git branch through VCS provider when matched', async () => {
    const mockProvider: PluginVcsProvider = {
      id: 'custom-vcs',
      detect: () => true,
      getDiffFiles: async () => [],
      getBranch: async () => 'multi (main)',
    }

    setPluginVcsProviders([{ pluginId: 'test-plugin', provider: mockProvider }])

    const branch = await getGitBranch('/tmp/custom')
    expect(branch).toBe('multi (main)')
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })

  it('falls back to native git branch when no VCS provider matches', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockProc('feature-x\n') as unknown as ReturnType<typeof spawn>)

    const branch = await getGitBranch('/tmp/native-repo')
    expect(branch).toBe('feature-x')
    expect(vi.mocked(spawn)).toHaveBeenCalled()
  })
})

describe('getGitSyncInfo', () => {
  it('parses ahead/behind from rev-list --left-right --count', async () => {
    mockGitByArgs((args) => {
      if (args[0] === 'rev-list') return { stdout: '3\t2\n' }
      return {}
    })

    const sync = await getGitSyncInfo('/tmp/project')
    expect(sync).toEqual({ ahead: 2, behind: 3 })
  })

  it('returns null when the branch has no upstream', async () => {
    mockGitByArgs(() => ({ stdout: '', code: 1 }))

    const sync = await getGitSyncInfo('/tmp/project')
    expect(sync).toBeNull()
  })
})

describe('getGitFileDiff', () => {
  it('returns the working-tree diff for tracked files by default', async () => {
    mockGitByArgs((args) => {
      if (args[0] === 'cat-file') return { code: 0 }
      if (args[0] === 'diff' && !args.includes('--cached')) {
        return { stdout: 'diff --git a/src/a.ts b/src/a.ts\n+added line\n' }
      }
      return {}
    })

    const diff = await getGitFileDiff('/tmp/project', 'src/a.ts')
    expect(diff).toBe('diff --git a/src/a.ts b/src/a.ts\n+added line\n')
    const diffCall = vi.mocked(spawn).mock.calls.find((c) => (c[1] as string[])[0] === 'diff')
    expect(diffCall?.[1]).toEqual(['diff', '--', 'src/a.ts'])
  })

  it('returns the index diff when staged is true', async () => {
    mockGitByArgs((args) => {
      if (args[0] === 'cat-file') return { code: 0 }
      if (args[0] === 'diff' && args.includes('--cached')) {
        return { stdout: 'diff --git a/src/a.ts b/src/a.ts\n+staged line\n' }
      }
      return {}
    })

    const diff = await getGitFileDiff('/tmp/project', 'src/a.ts', true)
    expect(diff).toBe('diff --git a/src/a.ts b/src/a.ts\n+staged line\n')
    const diffCall = vi.mocked(spawn).mock.calls.find((c) => (c[1] as string[])[0] === 'diff')
    expect(diffCall?.[1]).toEqual(['diff', '--cached', '--', 'src/a.ts'])
  })

  it('synthesizes an addition-only diff for untracked files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openfox-git-diff-'))
    try {
      await writeFile(join(dir, 'new.txt'), 'alpha\nbeta\n', 'utf8')
      mockGitByArgs((args) => {
        if (args[0] === 'cat-file') return { code: 1 }
        return {}
      })

      const diff = await getGitFileDiff(dir, 'new.txt')
      expect(diff).toBe('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('prefers the index diff for staged view of files added to the index', async () => {
    mockGitByArgs((args) => {
      if (args[0] === 'cat-file') return { code: 1 }
      if (args[0] === 'diff' && args.includes('--cached')) {
        return { stdout: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+indexed\n' }
      }
      return {}
    })

    const diff = await getGitFileDiff('/tmp/project', 'new.txt', true)
    expect(diff).toBe('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+indexed\n')
  })

  it('throws for paths missing from HEAD and disk', async () => {
    mockGitByArgs((args) => {
      if (args[0] === 'cat-file') return { code: 1 }
      return {}
    })

    await expect(getGitFileDiff('/tmp/project', 'missing.txt')).rejects.toThrow('File not found: missing.txt')
  })

  it('rejects paths that escape the workdir', async () => {
    await expect(getGitFileDiff('/tmp/project', '../outside.txt')).rejects.toThrow('Invalid path')
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })
})
