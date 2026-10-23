import { describe, it, expect, vi, beforeEach } from 'vitest'
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitStage, gitUnstage, gitDiscard, gitCommit, gitPush, gitPull } from './actions.js'

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

function makeMockProc(stdout = '', stderr = '', exitCode = 0): MockProc {
  return {
    stdout: {
      on: (event, cb) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from(stdout)), 0)
      },
    },
    stderr: {
      on: (event, cb) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from(stderr)), 0)
      },
    },
    on: (event, cb) => {
      if (event === 'close') setTimeout(() => cb(exitCode), 0)
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('gitStage', () => {
  it('runs git add with the given paths', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockProc() as unknown as ReturnType<typeof spawn>)

    const result = await gitStage('/tmp/project', ['a.ts', 'b.ts'])

    expect(result).toEqual({ success: true })
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[]
    expect(args).toEqual(['add', '--', 'a.ts', 'b.ts'])
  })

  it('surfaces git errors', async () => {
    vi.mocked(spawn).mockReturnValue(
      makeMockProc('', 'fatal: pathspec did not match', 1) as unknown as ReturnType<typeof spawn>,
    )

    const result = await gitStage('/tmp/project', ['nope.ts'])

    expect(result.success).toBe(false)
    expect(result.error).toContain('pathspec')
  })
})

describe('gitUnstage', () => {
  it('runs git restore --staged with the given paths', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockProc() as unknown as ReturnType<typeof spawn>)

    const result = await gitUnstage('/tmp/project', ['a.ts'])

    expect(result).toEqual({ success: true })
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[]
    expect(args).toEqual(['restore', '--staged', '--', 'a.ts'])
  })
})

describe('gitDiscard', () => {
  it('restores tracked files from HEAD', async () => {
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      if (args[0] === 'cat-file') return makeMockProc()
      return makeMockProc()
    }) as typeof spawn)

    const result = await gitDiscard('/tmp/project', ['a.ts'])

    expect(result).toEqual({ success: true })
    const restoreCall = vi.mocked(spawn).mock.calls.find((c) => (c[1] as string[])[0] === 'restore')
    expect(restoreCall?.[1] as string[]).toEqual(['restore', '--staged', '--worktree', '--source=HEAD', '--', 'a.ts'])
  })

  it('removes files that are not in HEAD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openfox-git-actions-'))
    try {
      const filePath = join(dir, 'new.txt')
      await writeFile(filePath, 'data\n', 'utf8')
      vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
        if (args[0] === 'cat-file') return makeMockProc('', '', 1)
        return makeMockProc()
      }) as typeof spawn)

      const result = await gitDiscard(dir, ['new.txt'])

      expect(result).toEqual({ success: true })
      await expect(access(filePath)).rejects.toThrow()
      const restoreCall = vi.mocked(spawn).mock.calls.find((c) => (c[1] as string[])[0] === 'restore')
      expect(restoreCall).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects paths that escape the workdir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openfox-git-actions-'))
    const outside = join(dir, '..', 'outside.txt')
    await writeFile(outside, 'keep me\n', 'utf8')
    try {
      vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
        if (args[0] === 'cat-file') return makeMockProc('', '', 1)
        return makeMockProc()
      }) as typeof spawn)

      const result = await gitDiscard(dir, ['../outside.txt'])

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid path')
      await expect(stat(outside)).resolves.toBeDefined()
    } finally {
      await rm(outside, { force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects absolute paths', async () => {
    const absPath = process.platform === 'win32' ? 'C:\\evil\\file.txt' : '/etc/passwd'

    const result = await gitDiscard('/tmp/project', [absPath])

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid path')
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })
})

describe('gitCommit', () => {
  it('commits with the given message', async () => {
    vi.mocked(spawn).mockReturnValue(
      makeMockProc('[main abc1234] message\n 1 file changed') as unknown as ReturnType<typeof spawn>,
    )

    const result = await gitCommit('/tmp/project', 'my commit')

    expect(result.success).toBe(true)
    expect(result.output).toContain('abc1234')
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[]
    expect(args).toEqual(['commit', '-m', 'my commit'])
  })

  it('maps "nothing to commit" to a clean error', async () => {
    vi.mocked(spawn).mockReturnValue(
      makeMockProc('', 'nothing to commit, working tree clean', 1) as unknown as ReturnType<typeof spawn>,
    )

    const result = await gitCommit('/tmp/project', 'msg')

    expect(result).toEqual({ success: false, error: 'nothing to commit' })
  })
})

describe('gitPush', () => {
  it('runs git push', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockProc('To origin\n') as unknown as ReturnType<typeof spawn>)

    const result = await gitPush('/tmp/project')

    expect(result.success).toBe(true)
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[]
    expect(args).toEqual(['push'])
  })

  it('falls back to push -u <remote> <branch> when there is no upstream', async () => {
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      if (args[0] === 'push') {
        if (args.includes('-u')) return makeMockProc('To origin\n')
        return makeMockProc('', 'fatal: The current branch feature has no upstream branch.', 1)
      }
      if (args[0] === 'rev-parse') return makeMockProc('feature\n')
      if (args[0] === 'remote') return makeMockProc('origin\n')
      return makeMockProc()
    }) as typeof spawn)

    const result = await gitPush('/tmp/project')

    expect(result.success).toBe(true)
    const upstreamCall = vi
      .mocked(spawn)
      .mock.calls.find((c) => (c[1] as string[])[0] === 'push' && (c[1] as string[]).includes('-u'))
    expect(upstreamCall?.[1]).toEqual(['push', '-u', 'origin', 'feature'])
  })

  it('uses the single configured remote when it is not named origin', async () => {
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      if (args[0] === 'push') {
        if (args.includes('-u')) return makeMockProc('To github\n')
        return makeMockProc('', 'fatal: The current branch main has no upstream branch.', 1)
      }
      if (args[0] === 'rev-parse') return makeMockProc('main\n')
      if (args[0] === 'remote') return makeMockProc('github\n')
      return makeMockProc()
    }) as typeof spawn)

    const result = await gitPush('/tmp/project')

    expect(result.success).toBe(true)
    const upstreamCall = vi
      .mocked(spawn)
      .mock.calls.find((c) => (c[1] as string[])[0] === 'push' && (c[1] as string[]).includes('-u'))
    expect(upstreamCall?.[1]).toEqual(['push', '-u', 'github', 'main'])
  })
})

describe('gitPull', () => {
  it('runs git pull --ff-only', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockProc('Already up to date.\n') as unknown as ReturnType<typeof spawn>)

    const result = await gitPull('/tmp/project')

    expect(result.success).toBe(true)
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[]
    expect(args).toEqual(['pull', '--ff-only'])
  })

  it('surfaces ff-only conflicts', async () => {
    vi.mocked(spawn).mockReturnValue(
      makeMockProc('', 'fatal: Not possible to fast-forward', 1) as unknown as ReturnType<typeof spawn>,
    )

    const result = await gitPull('/tmp/project')

    expect(result.success).toBe(false)
    expect(result.error).toContain('fast-forward')
  })
})
