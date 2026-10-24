import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitDiffFile, GitStatusSync } from '../../shared/protocol.js'
import type { PluginVcsContext } from '../../plugin/index.js'
import { gitSpawnEnv } from './env.js'
import { resolveSafePath } from './safe-path.js'
import { resolveVcsBranch, resolveVcsDiffFiles, resolveVcsModifiedFiles } from '../plugins/vcs-providers.js'

function toVcsContext(cwd: string, context?: { sessionId?: string; projectId?: string }): PluginVcsContext {
  return {
    workdir: cwd,
    ...(context?.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context?.projectId !== undefined ? { projectId: context.projectId } : {}),
  }
}

export function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      env: gitSpawnEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let stdout = ''
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.on('close', (code) => {
      resolve(code === 0 ? stdout : '')
    })
    proc.on('error', () => resolve(''))
  })
}

function gitExitCode(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      env: gitSpawnEnv(),
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    proc.on('close', (code) => resolve(code ?? 1))
    proc.on('error', () => resolve(1))
  })
}

function parsePorcelainLine(line: string): { x: string; y: string; path: string } | null {
  if (line.length < 4) return null
  const x = line[0]!
  const y = line[1]!
  let path = line.slice(3)

  if (x === 'R' || x === 'C') {
    const tabIdx = path.indexOf('\t')
    if (tabIdx >= 0) {
      path = path.slice(tabIdx + 1)
    } else {
      const arrow = path.indexOf(' -> ')
      if (arrow >= 0) path = path.slice(arrow + 4)
    }
  }

  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    try {
      path = JSON.parse(path)
    } catch {
      /* keep raw */
    }
  }

  return { x, y, path }
}

function normalizeNumstatPath(path: string): string {
  const idx = path.indexOf(' => ')
  if (idx >= 0) return path.slice(idx + 4)
  const brace = path.indexOf('{')
  if (brace >= 0) {
    const end = path.indexOf('}', brace)
    if (end > 0) {
      const inner = path.slice(brace + 1, end)
      const innerIdx = inner.indexOf(' => ')
      if (innerIdx >= 0) {
        return inner.slice(innerIdx + 4) + path.slice(end + 1)
      }
    }
  }
  return path
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>()
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const [add, del, ...pathParts] = line.split('\t')
    if (!add || !del) continue
    const path = normalizeNumstatPath(pathParts.join('\t'))
    if (!path) continue
    map.set(path, {
      additions: add === '-' ? 0 : parseInt(add, 10) || 0,
      deletions: del === '-' ? 0 : parseInt(del, 10) || 0,
    })
  }
  return map
}

async function countFileLines(absPath: string): Promise<number> {
  try {
    let newlines = 0
    let bytes = 0
    let endsWithNewline = false
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absPath, { highWaterMark: 64 * 1024 })
      stream.on('data', (chunk: string | Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buf.length
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] === 0x0a) newlines++
        }
        endsWithNewline = buf[buf.length - 1] === 0x0a
      })
      stream.on('end', () => resolve())
      stream.on('error', (err) => reject(err))
    })
    if (bytes === 0) return 0
    return endsWithNewline ? newlines : newlines + 1
  } catch {
    return 0
  }
}

async function nativeGetGitDiffFiles(cwd: string): Promise<GitDiffFile[]> {
  const [statusOut, stagedOut, unstagedOut] = await Promise.all([
    gitOutput(cwd, ['status', '--porcelain', '-uall', '--ignore-submodules=none']),
    gitOutput(cwd, ['diff', '--numstat', '--cached', '--ignore-submodules=none']),
    gitOutput(cwd, ['diff', '--numstat', '--ignore-submodules=none']),
  ])

  const stagedCounts = parseNumstat(stagedOut)
  const unstagedCounts = parseNumstat(unstagedOut)

  const entries = statusOut
    .split('\n')
    .map(parsePorcelainLine)
    .filter((e): e is { x: string; y: string; path: string } => e !== null && e.path !== '')

  const untrackedLines = new Map<string, number>()
  await Promise.all(
    entries
      .filter((e) => e.x === '?' && e.y === '?')
      .map(async (e) => {
        untrackedLines.set(e.path, await countFileLines(join(cwd, e.path)))
      }),
  )

  const files: GitDiffFile[] = []

  for (const { x, y, path } of entries) {
    const untracked = x === '?' && y === '?'
    const staged = !untracked && x !== ' '
    const unstaged = !untracked && y !== ' '

    let status: GitDiffFile['status']
    let additions: number
    let deletions = 0

    if (untracked) {
      status = 'added'
      additions = untrackedLines.get(path) ?? 0
    } else {
      status = x === 'A' || y === 'A' ? 'added' : x === 'D' || y === 'D' ? 'deleted' : 'modified'
      const s = stagedCounts.get(path)
      const u = unstagedCounts.get(path)
      additions = (s?.additions ?? 0) + (u?.additions ?? 0)
      deletions = (s?.deletions ?? 0) + (u?.deletions ?? 0)
    }

    files.push({ path, status, staged, unstaged, untracked, additions, deletions })
  }

  return files
}

export async function getGitDiffFiles(
  cwd: string,
  context?: { sessionId?: string; projectId?: string },
): Promise<GitDiffFile[]> {
  const pluginDiffFiles = await resolveVcsDiffFiles(toVcsContext(cwd, context))

  if (pluginDiffFiles !== null) {
    return pluginDiffFiles.map((file) => ({
      path: file.path,
      status: file.status,
      staged: false,
      unstaged: true,
      untracked: file.status === 'added',
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    }))
  }

  return nativeGetGitDiffFiles(cwd)
}

export async function formatGitDiffFiles(
  cwd: string,
  context?: { sessionId?: string; projectId?: string },
): Promise<string> {
  const pluginFormatted = await resolveVcsModifiedFiles(toVcsContext(cwd, context))

  if (pluginFormatted !== null) {
    return pluginFormatted
  }

  const files = await getGitDiffFiles(cwd, context)
  if (files.length === 0) return '(none)'
  return files.map((f) => `- ${f.path} (${f.status})`).join('\n')
}

export function nativeGetGitBranch(cwd: string): Promise<string | null> {
  return gitOutput(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).then((out) => {
    const trimmed = out.trim()
    return trimmed ? trimmed : null
  })
}

export async function getGitBranch(
  cwd: string,
  context?: { sessionId?: string; projectId?: string },
): Promise<string | null> {
  const pluginBranch = await resolveVcsBranch(toVcsContext(cwd, context))

  if (pluginBranch !== undefined) {
    return pluginBranch
  }

  return nativeGetGitBranch(cwd)
}

/** Commits ahead of / behind the upstream. Null when the branch has no upstream. */
export async function getGitSyncInfo(cwd: string): Promise<GitStatusSync | null> {
  const stdout = await gitOutput(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
  const parts = stdout.trim().split(/\s+/)
  const ahead = parseInt(parts[0] ?? '', 10)
  const behind = parseInt(parts[1] ?? '', 10)
  if (Number.isNaN(ahead) || Number.isNaN(behind)) return null
  return { ahead, behind }
}

/**
 * Unified diff of a single file. `staged` selects the index view
 * (`git diff --cached -- <path>`), otherwise the working-tree view
 * (`git diff -- <path>`). Files not in HEAD (untracked) get a synthesized
 * addition-only diff. Throws for paths that exist neither in HEAD nor on disk.
 */
export async function getGitFileDiff(cwd: string, path: string, staged = false): Promise<string> {
  if (resolveSafePath(cwd, path) === null) {
    throw new Error(`Invalid path: ${path}`)
  }
  const inHead = await gitExitCode(cwd, ['cat-file', '-e', `HEAD:${path}`])

  if (inHead !== 0) {
    if (staged) {
      const cached = await gitOutput(cwd, ['diff', '--cached', '--', path])
      if (cached.trim()) return cached
    }
    try {
      const content = await readFile(join(cwd, path), 'utf8')
      const lines = content.replace(/\n$/, '').split('\n')
      const header = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`
      return header + lines.map((l) => `+${l}`).join('\n')
    } catch {
      throw new Error(`File not found: ${path}`)
    }
  }

  return gitOutput(cwd, staged ? ['diff', '--cached', '--', path] : ['diff', '--', path])
}
