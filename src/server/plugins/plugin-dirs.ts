import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/** True for a real directory, or a symlink resolving to one. */
export async function isDirectoryEntry(entry: Dirent, entryPath: string): Promise<boolean> {
  return (
    entry.isDirectory() ||
    (entry.isSymbolicLink() && ((await stat(entryPath).catch(() => undefined))?.isDirectory() ?? false))
  )
}

/** Package directories of a scoped `@scope` package directory. */
export async function scopedPackageDirs(entryPath: string, skipHidden = false): Promise<string[]> {
  const scoped = await readdir(entryPath, { withFileTypes: true }).catch(() => [])
  const directories: string[] = []
  for (const child of scoped) {
    if (skipHidden && child.name.startsWith('.')) continue
    const childPath = join(entryPath, child.name)
    if (await isDirectoryEntry(child, childPath)) directories.push(childPath)
  }
  return directories
}
