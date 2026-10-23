import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { gitSpawnEnv } from './env.js'
import { nativeGetGitBranch } from './diff.js'
import { resolveSafePath } from './safe-path.js'

export interface GitActionResult {
  success: boolean
  error?: string
  output?: string
}

function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      env: gitSpawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      resolve({ code: 1, stdout: '', stderr: 'git command timed out' })
    }, timeoutMs)

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: 1, stdout: '', stderr: err.message })
    })
  })
}

function toError(stderr: string, stdout: string): string {
  const raw = (stderr || stdout).trim()
  return raw || 'git command failed'
}

function fail(stderr: string, stdout: string): GitActionResult {
  return { success: false, error: toError(stderr, stdout) }
}

export async function gitStage(cwd: string, paths: string[]): Promise<GitActionResult> {
  const r = await runGit(cwd, ['add', '--', ...paths])
  return r.code === 0 ? { success: true } : fail(r.stderr, r.stdout)
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<GitActionResult> {
  const r = await runGit(cwd, ['restore', '--staged', '--', ...paths])
  return r.code === 0 ? { success: true } : fail(r.stderr, r.stdout)
}

/**
 * Discard all local changes for the given paths (back to HEAD state).
 * Files that do not exist in HEAD (new / untracked) are removed from disk.
 */
export async function gitDiscard(cwd: string, paths: string[]): Promise<GitActionResult> {
  for (const path of paths) {
    const safePath = resolveSafePath(cwd, path)
    if (!safePath) {
      return { success: false, error: `Invalid path: ${path}` }
    }

    const inHead = await runGit(cwd, ['cat-file', '-e', `HEAD:${path}`])

    if (inHead.code !== 0) {
      try {
        await rm(safePath, { recursive: true, force: true })
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : `Failed to remove ${path}` }
      }
      continue
    }

    const r = await runGit(cwd, ['restore', '--staged', '--worktree', '--source=HEAD', '--', path])
    if (r.code !== 0) {
      return fail(r.stderr, r.stdout)
    }
  }

  return { success: true }
}

export async function gitCommit(cwd: string, message: string): Promise<GitActionResult> {
  const r = await runGit(cwd, ['commit', '-m', message])
  if (r.code !== 0) {
    const combined = `${r.stderr} ${r.stdout}`.toLowerCase()
    if (combined.includes('nothing to commit')) {
      return { success: false, error: 'nothing to commit' }
    }
    return fail(r.stderr, r.stdout)
  }
  return { success: true, output: r.stdout.trim() }
}

async function listRemotes(cwd: string): Promise<string[]> {
  const r = await runGit(cwd, ['remote'])
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function gitPush(cwd: string): Promise<GitActionResult> {
  let r = await runGit(cwd, ['push'], 120_000)
  if (r.code !== 0 && r.stderr.includes('no upstream')) {
    const branch = await nativeGetGitBranch(cwd)
    if (!branch) return fail(r.stderr, r.stdout)
    const remotes = await listRemotes(cwd)
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]
    if (!remote) return fail(r.stderr, r.stdout)
    r = await runGit(cwd, ['push', '-u', remote, branch], 120_000)
  }
  return r.code === 0 ? { success: true, output: r.stdout.trim() } : fail(r.stderr, r.stdout)
}

export async function gitPull(cwd: string): Promise<GitActionResult> {
  const r = await runGit(cwd, ['pull', '--ff-only'], 120_000)
  return r.code === 0 ? { success: true, output: r.stdout.trim() } : fail(r.stderr, r.stdout)
}
