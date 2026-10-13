#!/usr/bin/env node
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

const DB_NAME = 'sessions.db'
const MERGE_DIRS = ['commands', 'plugins', 'workflows']
const DB_SUFFIXES = ['', '-wal', '-shm']
const DEFAULT_PROD_SERVER = { port: 10369, host: '0.0.0.0', openBrowser: true }

function configDir(mode) {
  const suffix = mode === 'development' ? '-dev' : ''
  const home = homedir()
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', `openfox${suffix}`)
    case 'win32':
      return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), `openfox${suffix}`)
    default:
      return join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), `openfox${suffix}`)
  }
}

function dataDir(mode) {
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

export function resolveDirs() {
  return {
    devConfigDir: configDir('development'),
    prodConfigDir: configDir('production'),
    devDataDir: dataDir('development'),
    prodDataDir: dataDir('production'),
  }
}

function formatTimestamp(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

async function pathExists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function copyDirMerge(src, dest) {
  const copied = []
  if (!(await pathExists(src))) return copied
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      const sub = await copyDirMerge(srcPath, destPath)
      for (const s of sub) copied.push(join(entry.name, s))
    } else if (entry.isFile()) {
      await mkdir(dirname(destPath), { recursive: true })
      await copyFile(srcPath, destPath)
      copied.push(entry.name)
    }
  }
  return copied
}

export async function migrate(opts) {
  const {
    devConfigDir,
    prodConfigDir,
    devDataDir,
    prodDataDir,
    withWorkspaces = false,
    now = () => new Date(),
    log = () => {},
  } = opts

  if (!(await pathExists(devConfigDir))) throw new Error(`Dev config dir not found: ${devConfigDir}`)
  if (!(await pathExists(devDataDir))) throw new Error(`Dev data dir not found: ${devDataDir}`)

  await mkdir(prodConfigDir, { recursive: true })
  await mkdir(prodDataDir, { recursive: true })

  const summary = {
    backupDir: '',
    prodConfigPath: '',
    serverPort: null,
    openBrowser: null,
    migratedKeys: [],
    mergedDirs: {},
    dbCopied: false,
    dbSizeBytes: 0,
    workspacesCopied: false,
    prodAuthPreserved: false,
  }

  // 1. Back up current prod (config + db) to a timestamped dir, so nothing is lost.
  const backupDir = join(prodDataDir, `.backup-${formatTimestamp(now())}`)
  await mkdir(backupDir, { recursive: true })
  summary.backupDir = backupDir
  const prodConfigPath = join(prodConfigDir, 'config.json')
  if (await pathExists(prodConfigPath)) {
    await copyFile(prodConfigPath, join(backupDir, 'config.json'))
  }
  for (const suffix of DB_SUFFIXES) {
    const f = join(prodDataDir, DB_NAME + suffix)
    if (await pathExists(f)) await copyFile(f, join(backupDir, DB_NAME + suffix))
  }
  log(`Backup prod -> ${backupDir}`)

  // 2. Config merge: dev is the base, but keep prod's server + database identity.
  const devConfig = JSON.parse(await readFile(join(devConfigDir, 'config.json'), 'utf8'))
  let prodConfig
  if (await pathExists(prodConfigPath)) {
    prodConfig = JSON.parse(await readFile(prodConfigPath, 'utf8'))
  }
  const newConfig = {
    ...devConfig,
    server: prodConfig?.server ?? DEFAULT_PROD_SERVER,
    database: prodConfig?.database ?? devConfig.database ?? { path: '' },
  }
  await writeFile(prodConfigPath, JSON.stringify(newConfig, null, 2) + '\n')
  summary.prodConfigPath = prodConfigPath
  summary.serverPort = newConfig.server?.port ?? null
  summary.openBrowser = newConfig.server?.openBrowser ?? null
  summary.migratedKeys = Object.keys(devConfig).filter((k) => k !== 'server' && k !== 'database')
  log(`Config merged (kept prod server, port ${summary.serverPort})`)

  // 3. Merge commands/plugins/workflows (dev -> prod, never delete prod-only entries).
  for (const dir of MERGE_DIRS) {
    const copied = await copyDirMerge(join(devConfigDir, dir), join(prodConfigDir, dir))
    summary.mergedDirs[dir] = copied.length
    log(`Merged ${dir}: ${copied.length} file(s)`)
  }

  // 4. auth.json: leave prod's untouched (we never copy or delete it).
  summary.prodAuthPreserved = await pathExists(join(prodConfigDir, 'auth.json'))
  log(`prod auth.json preserved: ${summary.prodAuthPreserved}`)

  // 5. DB: online backup (WAL-safe, works while the dev server is running).
  const devDb = join(devDataDir, DB_NAME)
  if (await pathExists(devDb)) {
    const prodDb = join(prodDataDir, DB_NAME)
    const src = Database(devDb, { readonly: true })
    try {
      await src.backup(prodDb)
    } finally {
      src.close()
    }
    for (const suffix of ['-wal', '-shm']) {
      const stale = join(prodDataDir, DB_NAME + suffix)
      if (await pathExists(stale)) await rm(stale, { force: true })
    }
    summary.dbCopied = true
    summary.dbSizeBytes = (await stat(prodDb)).size
    log(`DB: dev sessions.db -> prod (${summary.dbSizeBytes} bytes)`)
  } else {
    log('DB: no dev sessions.db found, skipped')
  }

  // 6. Workspaces (optional, regenerable git clones).
  if (withWorkspaces) {
    const copied = await copyDirMerge(join(devDataDir, 'workspaces'), join(prodDataDir, 'workspaces'))
    summary.workspacesCopied = copied.length > 0
    log(`Workspaces: ${copied.length} file(s)`)
  }

  return summary
}

function main() {
  const args = process.argv.slice(2)
  const withWorkspaces = args.includes('--with-workspaces')
  const dirs = resolveDirs()
  migrate({ ...dirs, withWorkspaces, log: console.log })
    .then((s) => {
      console.log('\n=== Migration summary ===')
      console.log(`Backup dir   : ${s.backupDir}`)
      console.log(`Prod config  : ${s.prodConfigPath} (server port ${s.serverPort}, openBrowser ${s.openBrowser})`)
      console.log(`Migrated keys: ${s.migratedKeys.join(', ')}`)
      console.log(
        `Merged dirs  : ${Object.entries(s.mergedDirs)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`,
      )
      console.log(`DB copied    : ${s.dbCopied ? `yes (${s.dbSizeBytes} bytes)` : 'no (no dev db)'}`)
      console.log(`Workspaces   : ${s.workspacesCopied ? 'copied' : 'skipped (use --with-workspaces)'}`)
      console.log(`Prod auth    : ${s.prodAuthPreserved ? 'preserved' : 'not present'}`)
      console.log('\nDev folders were left untouched.')
      console.log(
        'Verify: run `npm start` (port 10369) and check config + sessions. Delete the -dev folders manually once satisfied.',
      )
    })
    .catch((err) => {
      console.error('[migrate] FAILED:', err.message)
      process.exit(1)
    })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
