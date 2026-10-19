import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { getSttModelDir, getSttModelMarkerPath, ensureSttModel, STT_MODEL_NAME } from './model.js'

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function mockFetchForZip(zipPath: string): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: string | URL | Request) => {
    const data = await readFile(zipPath)
    return new Response(data, { status: 200 })
  })
}

describe('stt model', () => {
  let baseDir: string

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'openfox-stt-'))
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await rm(baseDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(join(baseDir, 'stt'), { recursive: true, force: true }).catch(() => {})
  })

  function writeNestedZip(zipPath: string): void {
    const zip = new AdmZip()
    zip.addFile(`${STT_MODEL_NAME}/am/final.mdl`, Buffer.from('model-data'))
    zip.addFile(`${STT_MODEL_NAME}/conf/model.conf`, Buffer.from('conf'))
    zip.writeZip(zipPath)
  }

  function writeFlatZip(zipPath: string): void {
    const zip = new AdmZip()
    zip.addFile('am/final.mdl', Buffer.from('model-data'))
    zip.addFile('conf/model.conf', Buffer.from('conf'))
    zip.writeZip(zipPath)
  }

  it('computes the model directory under stt/', () => {
    const dir = getSttModelDir(baseDir)
    expect(dir).toBe(join(baseDir, 'stt', STT_MODEL_NAME))
    expect(getSttModelMarkerPath(dir)).toBe(join(dir, 'am/final.mdl'))
  })

  it('extracts a zip with a nested root folder', async () => {
    const zipPath = join(baseDir, 'nested.zip')
    writeNestedZip(zipPath)
    mockFetchForZip(zipPath)
    const modelDir = await ensureSttModel(baseDir, 'https://fake.local/nested.zip')
    expect(modelDir).toBe(getSttModelDir(baseDir))
    expect(await fileExists(getSttModelMarkerPath(modelDir))).toBe(true)
    expect(await fileExists(join(modelDir, 'conf/model.conf'))).toBe(true)
    expect(await fileExists(join(baseDir, 'stt', `${STT_MODEL_NAME}.work`))).toBe(false)
  })

  it('extracts a zip with files at the root', async () => {
    const zipPath = join(baseDir, 'flat.zip')
    writeFlatZip(zipPath)
    mockFetchForZip(zipPath)
    const modelDir = await ensureSttModel(baseDir, 'https://fake.local/flat.zip')
    expect(await fileExists(getSttModelMarkerPath(modelDir))).toBe(true)
    expect(await fileExists(join(modelDir, 'conf/model.conf'))).toBe(true)
  })

  it('reuses an already extracted model without fetching', async () => {
    const modelDir = getSttModelDir(baseDir)
    await mkdir(join(modelDir, 'am'), { recursive: true })
    await writeFile(join(modelDir, 'am/final.mdl'), 'existing')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }))
    const dir = await ensureSttModel(baseDir)
    expect(dir).toBe(modelDir)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws when the marker is missing after extraction', async () => {
    const zipPath = join(baseDir, 'empty.zip')
    const zip = new AdmZip()
    zip.addFile('unrelated.txt', Buffer.from('hello'))
    zip.writeZip(zipPath)
    mockFetchForZip(zipPath)
    await expect(ensureSttModel(baseDir, 'https://fake.local/empty.zip')).rejects.toThrow(/final\.mdl/)
    expect(await fileExists(getSttModelDir(baseDir))).toBe(false)
  })

  it('propagates download failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 404, statusText: 'Not Found' }))
    await expect(ensureSttModel(baseDir, 'https://fake.local/missing.zip')).rejects.toThrow(/404/)
  })
})
