import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { resolve, join, isAbsolute } from 'node:path'
import { homedir, platform } from 'node:os'
import { logger } from '../utils/logger.js'
import { terminateProcessTree } from '../utils/process-tree.js'
import { isDirectoryEntry } from '../utils/fs.js'
import { gitSpawnEnv } from './env.js'
import type { GitStatusSync } from '../../shared/protocol.js'
import { loadWorkspaceConfig } from './workspace-config.js'
import { getProjectByWorkdir } from '../db/projects.js'

function captureStdout(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const proc = spawn('git', args, { cwd, env: gitSpawnEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    proc.on('close', (code) => resolvePromise(code === 0 ? out : null))
    proc.on('error', () => resolvePromise(null))
  })
}

export function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('git', args, { cwd, env: gitSpawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(stderr.trim() || `git ${args[0]} failed (code ${code})`))
    })
    proc.on('error', (err) => reject(err))
  })
}

export function getServerMode(): 'development' | 'production' {
  return process.env['OPENFOX_DEV'] === 'true' ? 'development' : 'production'
}

export function getGlobalDataDir(): string {
  const mode = getServerMode()
  const suffix = mode === 'development' ? '-dev' : ''
  const home = homedir()
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', `openfox${suffix}`)
    case 'win32':
      return join(process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), `openfox${suffix}`)
    default:
      return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), `openfox${suffix}`)
  }
}

export async function getWorkspacesDir(projectName: string, projectDir: string): Promise<string> {
  const project = getProjectByWorkdir(projectDir)
  if (project?.workspaceRootDir) {
    return isAbsolute(project.workspaceRootDir)
      ? project.workspaceRootDir
      : resolve(projectDir, project.workspaceRootDir)
  }
  return join(getGlobalDataDir(), 'workspaces', projectName)
}

export function getDefaultGlobalWorkspacesDir(projectName: string): string {
  return join(getGlobalDataDir(), 'workspaces', projectName)
}

export function getGitBranch(cwd: string): Promise<string | null> {
  return captureStdout(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r?.trim() ?? null)
}

export interface BranchInfo {
  name: string
  current: boolean
}

export function listBranches(cwd: string): Promise<BranchInfo[]> {
  return captureStdout(cwd, ['branch', '--format', '%(refname:short)%09%(HEAD)']).then((out) => {
    if (!out) return []
    const branches: BranchInfo[] = []
    for (const line of out.trim().split('\n')) {
      if (!line) continue
      const [name, head] = line.split('\t')
      if (name) branches.push({ name, current: head === '*' })
    }
    return branches
  })
}

export function listRemoteBranches(cwd: string): Promise<string[]> {
  return captureStdout(cwd, ['branch', '-r', '--format', '%(refname:short)']).then((out) => {
    if (!out) return []
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((b) => b.trim())
  })
}

/**
 * Count how many commits the workspace's current branch is behind the same
 * branch on origin (the original repo). Returns 0 if up to date, null if the
 * branch doesn't exist on origin or the comparison fails.
 */
export async function getCommitsBehind(cwd: string, branch: string): Promise<number | null> {
  const out = await captureStdout(cwd, ['rev-list', '--count', 'HEAD..origin/' + branch, '--'])
  if (out === null) return null
  const count = parseInt(out.trim(), 10)
  return Number.isNaN(count) ? null : count
}

/** Parse `git rev-list --left-right --count` output ("A B\n") into counts. */
export function parseAheadBehind(out: string): { ahead: number; behind: number } | null {
  const parts = out.trim().split(/\s+/)
  const ahead = parseInt(parts[0] ?? '', 10)
  const behind = parseInt(parts[1] ?? '', 10)
  if (Number.isNaN(ahead) || Number.isNaN(behind)) return null
  return { ahead, behind }
}

/**
 * Compare the HEAD of `headCwd` against the project dir's remote-tracking ref
 * `refs/remotes/origin/<branch>` (the true upstream). Workspaces are
 * --shared clones whose own origin points at the local project repo, so the
 * comparison must run against the project's remote refs. Returns null when
 * HEAD cannot be resolved or the branch has no remote-tracking ref.
 */
export async function getSyncWithUpstream(
  headCwd: string,
  projectDir: string,
  branch: string,
): Promise<GitStatusSync | null> {
  const head = await captureStdout(headCwd, ['rev-parse', 'HEAD'])
  const sha = head?.trim()
  if (!sha) return null
  const out = await captureStdout(projectDir, [
    'rev-list',
    '--left-right',
    '--count',
    `${sha}...refs/remotes/origin/${branch}`,
  ])
  if (out === null) return null
  return parseAheadBehind(out)
}

export function validateRef(cwd: string, name: string): Promise<void> {
  return runGit(cwd, ['check-ref-format', `refs/heads/${name}`])
}

/**
 * Resolve the default branch for a project directory.
 * Fetches origin to ensure remote refs are up to date, then reads origin/HEAD.
 * Falls back to querying the remote HEAD via ls-remote, then 'main'.
 */
export async function getDefaultBranch(projectDir: string): Promise<string> {
  await runGit(projectDir, ['fetch', 'origin', '--no-tags', '--quiet']).catch(() => {})

  const originHead = await captureStdout(projectDir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  if (originHead) {
    const branch = originHead.trim().replace('refs/remotes/origin/', '')
    if (branch) return branch
  }

  const remoteHead = await captureStdout(projectDir, ['ls-remote', '--symref', 'origin', 'HEAD'])
  if (remoteHead) {
    const match = remoteHead.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m)
    if (match?.[1]) return match[1]
  }

  return 'main'
}

/**
 * Resolve and validate a source branch name for creating a new branch.
 * Ensures the branch exists locally or on the remote, creating a tracking ref if needed.
 * Returns the local ref name that can be used as the source for git checkout -b.
 * @param projectDir - optional project root directory (for upstream remote resolution)
 */
export async function resolveAndValidateSourceBranch(
  cwd: string,
  sourceBranch: string,
  projectDir?: string,
): Promise<string> {
  // Validate the source branch name format first
  await validateRef(cwd, sourceBranch.replace(/^origin\//, ''))

  // fetch to ensure remote refs are up to date
  await runGit(cwd, ['fetch', 'origin', '--no-tags', '--quiet']).catch(() => {})

  // strip optional origin/ prefix to get the branch name
  const branchName = sourceBranch.replace(/^origin\//, '')

  // check if it exists locally
  const localRef = await captureStdout(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branchName])
  if (localRef !== null) return branchName

  // check if it exists on workspace origin
  const remoteRef = await captureStdout(cwd, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + branchName])
  if (remoteRef !== null) {
    // create a local tracking branch from origin without switching cwd's checkout
    await runGit(cwd, ['branch', '--track', branchName, 'origin/' + branchName])
    return branchName
  }

  // check on the project's upstream origin (workspace origin is local with --shared clone)
  if (projectDir) {
    const remoteExists = await captureStdout(projectDir, ['ls-remote', '--heads', 'origin', branchName])
    if (remoteExists !== null && remoteExists.trim() !== '') {
      // Fetch the branch from the project's upstream via its remote-tracking ref
      // In --shared clones, the project dir has the branch as refs/remotes/origin/..., not refs/heads/...
      await runGit(cwd, ['fetch', projectDir, 'refs/remotes/origin/' + branchName + ':refs/heads/' + branchName]).catch(
        async () => {
          // fallback: fetch from upstream then create branch
          await runGit(projectDir, ['fetch', 'origin', branchName])
          await runGit(cwd, ['fetch', projectDir, 'refs/remotes/origin/' + branchName + ':refs/heads/' + branchName])
        },
      )
      return branchName
    }
  }

  throw new Error(
    `Source branch "${sourceBranch}" not found locally or on origin. Use a valid branch name like "main" or "origin/main".`,
  )
}

export function validateWorkspaceName(name: string): void {
  if (!name || typeof name !== 'string') throw new Error('Workspace name is required')
  if (name.includes('/') || name.includes('\\')) throw new Error('Workspace name cannot contain path separators')
  if (name === '.' || name === '..') throw new Error('Workspace name cannot be "." or ".."')
  if (isAbsolute(name)) throw new Error('Workspace name cannot be an absolute path')
  if (name.length > 255) throw new Error('Workspace name is too long')
}

export function checkoutBranch(cwd: string, name: string): Promise<void> {
  return runGit(cwd, ['checkout', name])
}

export function createBranch(cwd: string, name: string, sourceBranch?: string): Promise<void> {
  const args = sourceBranch ? ['checkout', '-b', name, sourceBranch] : ['checkout', '-b', name]
  return runGit(cwd, args)
}

/**
 * Check out a branch that is not present locally in a --shared clone.
 * Shared clones expose the source repo's local branches as origin/* — prefer
 * carrying the real branch (with its commits) over silently forking a fresh
 * one from the current HEAD.
 */
export async function checkoutBranchFromSharedSource(wsPath: string, branch: string): Promise<void> {
  const created = await runGit(wsPath, ['checkout', '-b', branch, `origin/${branch}`]).then(
    () => true,
    () => false,
  )
  if (!created) {
    await runGit(wsPath, ['checkout', '-b', branch])
  }
}

export type WorkspaceSetupStatus = 'running' | 'done' | 'error'

export interface WorkspaceSetupState {
  status: WorkspaceSetupStatus
  command: string
  error?: string
}

const setupStates = new Map<string, WorkspaceSetupState>()
const setupProcesses = new Map<string, ChildProcess>()

export function getWorkspaceSetupStatus(wsPath: string): WorkspaceSetupStatus | null {
  return setupStates.get(wsPath)?.status ?? null
}

export function getWorkspaceSetupState(wsPath: string): WorkspaceSetupState | undefined {
  return setupStates.get(wsPath)
}

export async function killWorkspaceSetup(wsPath: string): Promise<void> {
  setupStates.delete(wsPath)
  const proc = setupProcesses.get(wsPath)
  if (proc) {
    setupProcesses.delete(wsPath)
    await terminateProcessTree(proc).catch(() => {})
  }
}

export async function clearWorkspaceSetupState(): Promise<void> {
  for (const wsPath of [...setupStates.keys()]) {
    await killWorkspaceSetup(wsPath)
  }
}

export function startWorkspaceSetup(wsPath: string, commands: string[]): void {
  if (setupStates.get(wsPath)?.status === 'running') return
  if (commands.length === 0) return

  setupStates.set(wsPath, { status: 'running', command: commands[0] ?? '' })

  const runNext = (index: number): void => {
    if (index >= commands.length) {
      setupStates.set(wsPath, { status: 'done', command: '' })
      return
    }
    const command = commands[index]
    if (!command) return
    logger.info('Running workspace setup command in background', { command, cwd: wsPath })
    const proc = spawn(command, {
      cwd: wsPath,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,
    })
    setupProcesses.set(wsPath, proc)
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 65536) stderr = stderr.slice(-65536)
    })
    proc.on('close', (code) => {
      if (setupProcesses.get(wsPath) !== proc) return
      setupProcesses.delete(wsPath)
      if (code === 0) {
        runNext(index + 1)
      } else {
        const error = stderr.trim() || `command exited with code ${code}`
        setupStates.set(wsPath, { status: 'error', command, error })
        logger.warn('Workspace setup command failed', { command, error })
      }
    })
    proc.on('error', (err) => {
      if (setupProcesses.get(wsPath) !== proc) return
      setupProcesses.delete(wsPath)
      setupStates.set(wsPath, { status: 'error', command, error: String(err) })
      logger.warn('Workspace setup command failed to start', { command, error: String(err) })
    })
  }

  runNext(0)
}

/**
 * Re-run the setup for a workspace whose previous setup run failed (or whose
 * state was lost). Kills any lingering setup process, then starts a fresh run.
 * Returns true when a new setup run was started.
 */
export async function retryWorkspaceSetup(wsPath: string, projectDir: string): Promise<boolean> {
  const config = await loadWorkspaceConfig(projectDir)
  if (!config?.setup || config.setup.length === 0) return false
  await killWorkspaceSetup(wsPath)
  startWorkspaceSetup(wsPath, config.setup)
  return true
}

/**
 * Re-run background setup after a server restart when a workspace's setup state
 * is unknown (in-memory state is lost) and node_modules is missing.
 * Returns true when a new setup run was started.
 */
export async function resumeWorkspaceSetupIfNeeded(wsPath: string, projectDir: string): Promise<boolean> {
  if (setupStates.has(wsPath)) return false
  const config = await loadWorkspaceConfig(projectDir)
  if (!config?.setup || config.setup.length === 0) return false
  const nodeModules = await statSafe(join(wsPath, 'node_modules'))
  if (nodeModules?.isDirectory()) return false
  startWorkspaceSetup(wsPath, config.setup)
  return true
}

export interface WorkspaceInfo {
  path: string
  name: string
  branch: string | null
  ahead: number | null
  behind: number | null
  setupStatus: WorkspaceSetupStatus | null
  setupError: string | null
}

export async function workspaceExists(projectName: string, name: string, projectDir: string): Promise<boolean> {
  const dir = await getWorkspacesDir(projectName, projectDir)
  const wsPath = resolve(dir, name)
  const st = await statSafe(wsPath)
  if (!st?.isDirectory()) return false
  const gitDir = join(wsPath, '.git')
  const gitSt = await statSafe(gitDir)
  return gitSt?.isDirectory() ?? false
}

export async function listWorkspaces(projectName: string, projectDir: string): Promise<WorkspaceInfo[]> {
  const dir = await getWorkspacesDir(projectName, projectDir)
  try {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir, { withFileTypes: true })
    const names = (
      await Promise.all(entries.map(async (entry) => ((await isDirectoryEntry(dir, entry)) ? entry.name : null)))
    ).filter((name): name is string => name !== null)
    const workspaces = await Promise.all(
      names.map(async (name) => {
        const wsPath = resolve(dir, name)
        const branch = await getGitBranch(wsPath)
        const sync = branch ? await getSyncWithUpstream(wsPath, projectDir, branch) : null
        const state = getWorkspaceSetupState(wsPath)
        return {
          path: wsPath,
          name,
          branch,
          ahead: sync?.ahead ?? null,
          behind: sync?.behind ?? null,
          setupStatus: state?.status ?? null,
          setupError: state?.status === 'error' ? (state.error ?? null) : null,
        }
      }),
    )
    return workspaces.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export interface ProjectSyncInfo {
  branch: string | null
  ahead: number | null
  behind: number | null
}

/** Sync state of the project repo itself (for the "original" workspace row). */
export async function getProjectSync(projectDir: string): Promise<ProjectSyncInfo> {
  const branch = await getGitBranch(projectDir)
  const sync = branch ? await getSyncWithUpstream(projectDir, projectDir, branch) : null
  return {
    branch,
    ahead: sync?.ahead ?? null,
    behind: sync?.behind ?? null,
  }
}

const refreshingRemoteRefs = new Set<string>()

/**
 * Fire-and-forget fetch so the project's remote-tracking refs stay fresh;
 * ahead/behind counts read on the next workspace list are then accurate.
 */
export function refreshRemoteRefs(projectDir: string): void {
  if (refreshingRemoteRefs.has(projectDir)) return
  refreshingRemoteRefs.add(projectDir)
  void runGit(projectDir, ['fetch', 'origin', '--prune', '--quiet'])
    .catch(() => {})
    .finally(() => {
      refreshingRemoteRefs.delete(projectDir)
    })
}

export interface WorkspaceResult {
  path: string
  name: string
}

export async function ensureWorkspace(
  projectDir: string,
  name: string,
  projectName: string,
  branch?: string,
  sourceBranch?: string,
): Promise<WorkspaceResult> {
  const workspacesDir = await getWorkspacesDir(projectName, projectDir)
  const wsPath = resolve(workspacesDir, name)

  await mkdir(workspacesDir, { recursive: true })

  const existing = await statSafe(wsPath)
  if (existing?.isDirectory()) {
    const gitDir = join(wsPath, '.git')
    const gitStat = await statSafe(gitDir)
    if (!gitStat?.isDirectory()) {
      throw new Error('Existing path is not a valid workspace: ' + wsPath)
    }
    logger.info('Workspace directory already exists, reusing', { path: wsPath })
  } else {
    await runGit(projectDir, ['clone', '--shared', projectDir, wsPath])
  }

  const st = await statSafe(wsPath)
  if (!st?.isDirectory()) {
    throw new Error('Failed to clone workspace')
  }

  // If a specific branch was requested, check it out
  if (branch) {
    await validateRef(wsPath, branch)
    await runGit(wsPath, ['checkout', branch]).catch(async () => {
      try {
        if (sourceBranch) {
          const sb = await resolveAndValidateSourceBranch(wsPath, sourceBranch, projectDir)
          await runGit(wsPath, ['checkout', '-b', branch, sb])
        } else {
          await checkoutBranchFromSharedSource(wsPath, branch)
        }
      } catch (innerErr) {
        throw new Error(
          `Failed to create branch "${branch}" in workspace: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
        )
      }
    })
  }

  const config = await loadWorkspaceConfig(projectDir)
  if (config?.setup && config.setup.length > 0) {
    logger.info('Starting workspace setup in background', { cwd: wsPath, commands: config.setup })
    startWorkspaceSetup(wsPath, config.setup)
  }

  return { path: wsPath, name }
}

export async function deleteWorkspace(projectName: string, name: string, projectDir: string): Promise<void> {
  const dir = await getWorkspacesDir(projectName, projectDir)
  const wsPath = resolve(dir, name)
  const st = await statSafe(wsPath)
  if (!st?.isDirectory()) {
    throw new Error(`Workspace "${name}" does not exist`)
  }
  await killWorkspaceSetup(wsPath)
  await rm(wsPath, { recursive: true, force: true, maxRetries: 3 })
  logger.info('Deleted workspace', { projectName, name, path: wsPath })
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises')
  try {
    const st = await stat(join(cwd, '.git'))
    if (st.isDirectory()) return true
  } catch {
    // .git doesn't exist or can't be read — fall through to rev-parse
  }
  const result = await captureStdout(cwd, ['rev-parse', '--git-dir'])
  return result !== null
}

async function statSafe(p: string): Promise<{ isDirectory: () => boolean } | null> {
  try {
    const { stat } = await import('node:fs/promises')
    return await stat(p)
  } catch {
    return null
  }
}
