import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import Database from 'better-sqlite3'
import { migrate, resolveDirs } from './migrate-dev-to-prod.mjs'

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function makeDb(path: string, rows: string[]): void {
  const db = Database(path)
  db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY, name TEXT)')
  const ins = db.prepare('INSERT INTO sessions (name) VALUES (?)')
  for (const r of rows) ins.run(r)
  db.close()
}

let devConfigDir: string
let devDataDir: string
let prodConfigDir: string
let prodDataDir: string
let roots: string[] = []

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'ofx-mig-'))
  roots.push(d)
  return d
}

function opts(withWorkspaces = false) {
  return {
    devConfigDir,
    prodConfigDir,
    devDataDir,
    prodDataDir,
    withWorkspaces,
    now: () => new Date('2026-01-02T03:04:05Z'),
  }
}

beforeEach(async () => {
  const base = await tmp()
  devConfigDir = join(base, 'config-dev')
  devDataDir = join(base, 'data-dev')
  prodConfigDir = join(base, 'config-prod')
  prodDataDir = join(base, 'data-prod')
  await mkdir(devConfigDir, { recursive: true })
  await mkdir(devDataDir, { recursive: true })
})

afterEach(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
  roots = []
})

describe('resolveDirs', () => {
  it('derives dev dirs from prod dirs with a -dev suffix', () => {
    const d = resolveDirs()
    expect(basename(d.devConfigDir)).toBe(`${basename(d.prodConfigDir)}-dev`)
    expect(basename(d.devDataDir)).toBe(`${basename(d.prodDataDir)}-dev`)
  })
})

describe('migrate', () => {
  it('migrates dev config but keeps the prod server identity (port 10369)', async () => {
    const devCfg = {
      providers: { A: { id: 'A' } },
      activeProviderId: 'A',
      server: { port: 10469, host: '0.0.0.0', openBrowser: false },
      database: { path: '' },
      logging: { level: 'debug' },
    }
    const prodCfg = {
      providers: { B: { id: 'B' } },
      activeProviderId: 'B',
      server: { port: 10369, host: '0.0.0.0', openBrowser: true },
      database: { path: '' },
    }
    await writeFile(join(devConfigDir, 'config.json'), JSON.stringify(devCfg))
    await mkdir(prodConfigDir, { recursive: true })
    await writeFile(join(prodConfigDir, 'config.json'), JSON.stringify(prodCfg))

    const s = await migrate(opts())
    const out = JSON.parse(await readFile(join(prodConfigDir, 'config.json'), 'utf8'))
    expect(out.providers).toEqual(devCfg.providers)
    expect(out.activeProviderId).toBe('A')
    expect(out.logging).toEqual(devCfg.logging)
    expect(out.server).toEqual({ port: 10369, host: '0.0.0.0', openBrowser: true })
    expect(out.database).toEqual({ path: '' })
    expect(s.serverPort).toBe(10369)
  })

  it('falls back to the prod default server when prod has no server block', async () => {
    await writeFile(
      join(devConfigDir, 'config.json'),
      JSON.stringify({ providers: { A: {} }, server: { port: 10469 } }),
    )
    await mkdir(prodConfigDir, { recursive: true })
    await writeFile(join(prodConfigDir, 'config.json'), JSON.stringify({ providers: { B: {} } }))

    const s = await migrate(opts())
    const out = JSON.parse(await readFile(join(prodConfigDir, 'config.json'), 'utf8'))
    expect(out.server).toEqual({ port: 10369, host: '0.0.0.0', openBrowser: true })
    expect(s.serverPort).toBe(10369)
  })

  it('never touches prod auth.json', async () => {
    await writeFile(join(devConfigDir, 'config.json'), JSON.stringify({ server: { port: 10469 } }))
    await mkdir(prodConfigDir, { recursive: true })
    await writeFile(join(prodConfigDir, 'config.json'), JSON.stringify({ server: { port: 10369 } }))
    await writeFile(join(prodConfigDir, 'auth.json'), '{"token":"secret-prod"}')

    const s = await migrate(opts())
    expect(await readFile(join(prodConfigDir, 'auth.json'), 'utf8')).toBe('{"token":"secret-prod"}')
    expect(s.prodAuthPreserved).toBe(true)
  })

  it('merges commands/plugins/workflows without deleting prod-only entries', async () => {
    await writeFile(join(devConfigDir, 'config.json'), JSON.stringify({}))
    await mkdir(join(devConfigDir, 'commands'), { recursive: true })
    await writeFile(join(devConfigDir, 'commands', 'cmd1.json'), '{}')
    await mkdir(join(devConfigDir, 'plugins', 'p1'), { recursive: true })
    await writeFile(join(devConfigDir, 'plugins', 'p1', 'index.js'), 'x')
    await mkdir(join(devConfigDir, 'workflows'), { recursive: true })
    await writeFile(join(devConfigDir, 'workflows', 'w1.workflow.json'), '{}')

    await mkdir(join(prodConfigDir, 'commands'), { recursive: true })
    await writeFile(join(prodConfigDir, 'commands', 'cmd2.json'), '{}')

    const s = await migrate(opts())
    expect(await readFile(join(prodConfigDir, 'commands', 'cmd1.json'), 'utf8')).toBe('{}')
    expect(await readFile(join(prodConfigDir, 'plugins', 'p1', 'index.js'), 'utf8')).toBe('x')
    expect(await readFile(join(prodConfigDir, 'workflows', 'w1.workflow.json'), 'utf8')).toBe('{}')
    expect(await readFile(join(prodConfigDir, 'commands', 'cmd2.json'), 'utf8')).toBe('{}')
    expect(s.mergedDirs).toEqual({ commands: 1, plugins: 1, workflows: 1 })
  })

  it('backs up dev sessions.db to prod (WAL-safe)', async () => {
    await writeFile(join(devConfigDir, 'config.json'), JSON.stringify({}))
    makeDb(join(devDataDir, 'sessions.db'), ['alpha', 'beta'])

    const s = await migrate(opts())
    expect(s.dbCopied).toBe(true)
    const prodDb = Database(join(prodDataDir, 'sessions.db'), { readonly: true })
    const rows = prodDb.prepare('SELECT name FROM sessions ORDER BY name').all() as { name: string }[]
    prodDb.close()
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'beta'])
  })

  it('leaves the dev folders untouched', async () => {
    await writeFile(
      join(devConfigDir, 'config.json'),
      JSON.stringify({ providers: { A: {} }, server: { port: 10469 } }),
    )
    makeDb(join(devDataDir, 'sessions.db'), ['one'])
    const devCfgBefore = await readFile(join(devConfigDir, 'config.json'), 'utf8')
    const devDbBefore = (await stat(join(devDataDir, 'sessions.db'))).size

    await migrate(opts())

    expect(await readFile(join(devConfigDir, 'config.json'), 'utf8')).toBe(devCfgBefore)
    expect((await stat(join(devDataDir, 'sessions.db'))).size).toBe(devDbBefore)
  })

  it('creates a timestamped prod backup holding the original prod config + db', async () => {
    await writeFile(join(devConfigDir, 'config.json'), JSON.stringify({ server: { port: 10469 } }))
    await mkdir(prodConfigDir, { recursive: true })
    await writeFile(
      join(prodConfigDir, 'config.json'),
      JSON.stringify({ server: { port: 10369 }, marker: 'prod-original' }),
    )
    makeDb(join(devDataDir, 'sessions.db'), ['x'])
    await mkdir(prodDataDir, { recursive: true })
    makeDb(join(prodDataDir, 'sessions.db'), ['old-prod-row'])

    await migrate(opts())

    const entries = await readdir(prodDataDir)
    const backup = entries.find((e) => e.startsWith('.backup-'))
    expect(backup).toBeTruthy()
    const backedConfig = JSON.parse(await readFile(join(prodDataDir, `${backup}/config.json`), 'utf8'))
    expect(backedConfig.marker).toBe('prod-original')
    const backedDb = Database(join(prodDataDir, `${backup}/sessions.db`), { readonly: true })
    const rows = backedDb.prepare('SELECT name FROM sessions').all() as { name: string }[]
    backedDb.close()
    expect(rows.map((r) => r.name)).toEqual(['old-prod-row'])
  })

  it('is idempotent (safe to re-run)', async () => {
    await writeFile(
      join(devConfigDir, 'config.json'),
      JSON.stringify({ providers: { A: {} }, server: { port: 10469 } }),
    )
    makeDb(join(devDataDir, 'sessions.db'), ['keep'])

    await migrate(opts())
    await migrate(opts())

    const out = JSON.parse(await readFile(join(prodConfigDir, 'config.json'), 'utf8'))
    expect(out.server.port).toBe(10369)
    expect(out.providers).toEqual({ A: {} })
    const db = Database(join(prodDataDir, 'sessions.db'), { readonly: true })
    const rows = db.prepare('SELECT name FROM sessions').all() as { name: string }[]
    db.close()
    expect(rows.map((r) => r.name)).toEqual(['keep'])
  })

  it('copies workspaces only when --with-workspaces is set', async () => {
    await writeFile(join(devConfigDir, 'config.json'), JSON.stringify({}))
    await mkdir(join(devDataDir, 'workspaces', 'ws1'), { recursive: true })
    await writeFile(join(devDataDir, 'workspaces', 'ws1', 'README.md'), 'hello')

    const s1 = await migrate(opts(false))
    expect(s1.workspacesCopied).toBe(false)
    expect(await pathExists(join(prodDataDir, 'workspaces', 'ws1', 'README.md'))).toBe(false)

    const s2 = await migrate(opts(true))
    expect(s2.workspacesCopied).toBe(true)
    expect(await readFile(join(prodDataDir, 'workspaces', 'ws1', 'README.md'), 'utf8')).toBe('hello')
  })

  it('throws when the dev config dir is missing', async () => {
    const o = opts()
    o.devConfigDir = join(devConfigDir, 'does-not-exist')
    await expect(migrate(o)).rejects.toThrow(/Dev config dir not found/)
  })
})
