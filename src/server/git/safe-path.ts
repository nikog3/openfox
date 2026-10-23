import { isAbsolute, normalize, relative } from 'node:path'

/**
 * Resolves a repository-relative path inside the workdir.
 * Returns null for absolute paths, NUL bytes, or any path that
 * resolves outside the workdir (e.g. `../x`).
 */
export function resolveSafePath(cwd: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.includes('\0')) return null
  const resolved = normalize(`${cwd}/${path}`)
  const rel = relative(cwd, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return resolved
}
