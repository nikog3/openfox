import { Router } from 'express'
import { readdir, stat } from 'node:fs/promises'
import { resolve, join, dirname, basename } from 'node:path'
import { isDirectoryEntry } from '../utils/fs.js'
import { serverT } from '../i18n.js'

const DRIVES_LEVEL = 'drives:'
const DRIVE_ROOT_RE = /^[a-zA-Z]:[\\/]?$/

function isDriveRoot(p: string): boolean {
  return process.platform === 'win32' && DRIVE_ROOT_RE.test(p)
}

async function listDriveRoots(): Promise<Array<{ name: string; path: string }>> {
  if (process.platform !== 'win32') return []
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
  const roots = await Promise.all(
    letters.map(async (letter) => {
      const path = `${letter}:\\`
      try {
        await stat(path)
        return { name: `${letter}:`, path }
      } catch {
        return null
      }
    }),
  )
  return roots.filter((r): r is { name: string; path: string } => r !== null)
}

export function createDirectoryRoutes(): Router {
  const router = Router()

  const DEFAULT_BASE_PATH = process.cwd()

  router.get('/', async (req, res) => {
    const path = (req.query['path'] as string) || DEFAULT_BASE_PATH

    try {
      if (path === DRIVES_LEVEL && process.platform === 'win32') {
        res.json({
          current: DRIVES_LEVEL,
          parent: null,
          directories: await listDriveRoots(),
          basename: '',
        })
        return
      }

      const resolvedPath = resolve(path)
      const entries = await readdir(resolvedPath, { withFileTypes: true })
      const dirs = await Promise.all(
        entries.map(async (entry) =>
          (await isDirectoryEntry(resolvedPath, entry))
            ? { name: entry.name, path: join(resolvedPath, entry.name) }
            : null,
        ),
      )
      const directories = dirs
        .filter((d): d is { name: string; path: string } => d !== null)
        .sort((a, b) => a.name.localeCompare(b.name))

      const parent = dirname(resolvedPath)
      const hasParent = parent !== resolvedPath

      res.json({
        current: resolvedPath,
        parent: isDriveRoot(resolvedPath) ? DRIVES_LEVEL : hasParent ? parent : null,
        directories,
        basename: basename(resolvedPath),
      })
    } catch {
      res.status(400).json({
        error: serverT({ en: 'Cannot read directory', fr: 'Impossible de lire le répertoire' }),
        current: DEFAULT_BASE_PATH,
        parent: null,
        directories: [],
        basename: basename(DEFAULT_BASE_PATH),
      })
    }
  })

  return router
}
