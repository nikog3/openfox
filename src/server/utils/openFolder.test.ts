import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('node:os', () => ({ platform: vi.fn() }))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { platform } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { openFolder, resolveOpenFolderWorkdir } from './openFolder.js'

type ExecFileCallback = (err: NodeJS.ErrnoException | null, stdout?: string, stderr?: string) => void

function mockExecFileSuccess(): void {
  vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
    cb(null)
    return undefined
  }) as unknown as typeof execFile)
}

function mockExecFileFailure(code: number | string, message: string): void {
  vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
    cb(Object.assign(new Error(message), { code }) as NodeJS.ErrnoException)
    return undefined
  }) as unknown as typeof execFile)
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('openFolder', () => {
  it('creates the target directory recursively, then opens it with the platform opener', async () => {
    vi.mocked(platform).mockReturnValue('linux')
    mockExecFileSuccess()

    await openFolder('/tmp/some/dir')

    expect(mkdir).toHaveBeenCalledWith('/tmp/some/dir', { recursive: true })
    expect(execFile).toHaveBeenCalledWith('xdg-open', ['/tmp/some/dir'], { timeout: 5000 }, expect.any(Function))
  })

  it('uses explorer on Windows', async () => {
    vi.mocked(platform).mockReturnValue('win32')
    mockExecFileSuccess()

    await openFolder('C:\\some\\dir')

    expect(execFile).toHaveBeenCalledWith('explorer', ['C:\\some\\dir'], { timeout: 5000 }, expect.any(Function))
  })

  it('ignores explorer exit code 1 on Windows', async () => {
    vi.mocked(platform).mockReturnValue('win32')
    mockExecFileFailure(1, 'explorer exited with code 1')

    await expect(openFolder('C:\\some\\dir')).resolves.toBeUndefined()
  })

  it('rethrows non-1 exit codes on Windows', async () => {
    vi.mocked(platform).mockReturnValue('win32')
    mockExecFileFailure(2, 'explorer exited with code 2')

    await expect(openFolder('C:\\some\\dir')).rejects.toThrow('explorer exited with code 2')
  })

  it('rethrows string error codes on Windows (e.g. ENOENT)', async () => {
    vi.mocked(platform).mockReturnValue('win32')
    mockExecFileFailure('ENOENT', 'spawn explorer ENOENT')

    await expect(openFolder('C:\\some\\dir')).rejects.toThrow('spawn explorer ENOENT')
  })

  it('rethrows failures on Linux', async () => {
    vi.mocked(platform).mockReturnValue('linux')
    mockExecFileFailure(1, 'xdg-open failed')

    await expect(openFolder('/tmp/dir')).rejects.toThrow('xdg-open failed')
  })
})

describe('resolveOpenFolderWorkdir', () => {
  it('returns the workspace path for a session of the project', () => {
    expect(resolveOpenFolderWorkdir('/proj', { projectId: 'p1', workdir: '/proj', workspace: '/ws/p1' }, 'p1')).toBe(
      '/ws/p1',
    )
  })

  it('returns the project workdir for a session on the original repo', () => {
    expect(resolveOpenFolderWorkdir('/proj', { projectId: 'p1', workdir: '/proj' }, 'p1')).toBe('/proj')
  })

  it('returns the project workdir when no session is given', () => {
    expect(resolveOpenFolderWorkdir('/proj', null, 'p1')).toBe('/proj')
  })

  it('returns the project workdir for a session of another project', () => {
    expect(resolveOpenFolderWorkdir('/proj', { projectId: 'p2', workdir: '/proj', workspace: '/ws/p2' }, 'p1')).toBe(
      '/proj',
    )
  })
})
