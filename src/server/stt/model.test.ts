import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import {
  getSttModelDir,
  getSttModelMarkerPath,
  ensureSttModel,
  downloadFile,
  downloadPercent,
  deleteVoskModel,
  resolveVoskModelSize,
  getVoskModelStatus,
  STT_VOSK_MODELS,
} from './model.js'

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
    zip.addFile(`${STT_VOSK_MODELS.small.name}/am/final.mdl`, Buffer.from('model-data'))
    zip.addFile(`${STT_VOSK_MODELS.small.name}/conf/model.conf`, Buffer.from('conf'))
    zip.writeZip(zipPath)
  }

  function writeFlatZip(zipPath: string): void {
    const zip = new AdmZip()
    zip.addFile('am/final.mdl', Buffer.from('model-data'))
    zip.addFile('conf/model.conf', Buffer.from('conf'))
    zip.writeZip(zipPath)
  }

  it('computes the model directory under stt/', () => {
    const dir = getSttModelDir(baseDir, 'small')
    expect(dir).toBe(join(baseDir, 'stt', STT_VOSK_MODELS.small.name))
    expect(getSttModelMarkerPath(dir)).toBe(join(dir, 'am/final.mdl'))
    expect(getSttModelDir(baseDir, 'large')).toBe(join(baseDir, 'stt', STT_VOSK_MODELS.large.name))
  })

  it('resolves the vosk model size with a small default', () => {
    expect(resolveVoskModelSize('small')).toBe('small')
    expect(resolveVoskModelSize('large')).toBe('large')
    expect(resolveVoskModelSize(undefined)).toBe('small')
    expect(resolveVoskModelSize(null)).toBe('small')
    expect(resolveVoskModelSize('')).toBe('small')
    expect(resolveVoskModelSize('huge')).toBe('small')
  })

  it('reports the vosk model status for each size', async () => {
    const small = await getVoskModelStatus(baseDir, 'small')
    expect(small).toEqual({
      size: 'small',
      file: STT_VOSK_MODELS.small.name,
      bytes: STT_VOSK_MODELS.small.bytes,
      downloaded: false,
    })
    const modelDir = getSttModelDir(baseDir, 'small')
    await mkdir(join(modelDir, 'am'), { recursive: true })
    await writeFile(join(modelDir, 'am/final.mdl'), 'existing')
    expect((await getVoskModelStatus(baseDir, 'small')).downloaded).toBe(true)
    expect((await getVoskModelStatus(baseDir, 'large')).downloaded).toBe(false)
  })

  it('extracts a zip with a nested root folder', async () => {
    const zipPath = join(baseDir, 'nested.zip')
    writeNestedZip(zipPath)
    mockFetchForZip(zipPath)
    const modelDir = await ensureSttModel(baseDir, 'small')
    expect(modelDir).toBe(getSttModelDir(baseDir, 'small'))
    expect(await fileExists(getSttModelMarkerPath(modelDir))).toBe(true)
    expect(await fileExists(join(modelDir, 'conf/model.conf'))).toBe(true)
    expect(await fileExists(join(baseDir, 'stt', `${STT_VOSK_MODELS.small.name}.work`))).toBe(false)
  })

  it('extracts a zip with files at the root', async () => {
    const zipPath = join(baseDir, 'flat.zip')
    writeFlatZip(zipPath)
    mockFetchForZip(zipPath)
    const modelDir = await ensureSttModel(baseDir, 'small')
    expect(await fileExists(getSttModelMarkerPath(modelDir))).toBe(true)
    expect(await fileExists(join(modelDir, 'conf/model.conf'))).toBe(true)
  })

  it('reuses an already extracted model without fetching', async () => {
    const modelDir = getSttModelDir(baseDir, 'small')
    await mkdir(join(modelDir, 'am'), { recursive: true })
    await writeFile(join(modelDir, 'am/final.mdl'), 'existing')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }))
    const dir = await ensureSttModel(baseDir, 'small')
    expect(dir).toBe(modelDir)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws when the marker is missing after extraction', async () => {
    const zipPath = join(baseDir, 'empty.zip')
    const zip = new AdmZip()
    zip.addFile('unrelated.txt', Buffer.from('hello'))
    zip.writeZip(zipPath)
    mockFetchForZip(zipPath)
    await expect(ensureSttModel(baseDir, 'small')).rejects.toThrow(/final\.mdl/)
    expect(await fileExists(getSttModelDir(baseDir, 'small'))).toBe(false)
  })

  it('propagates download failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 404, statusText: 'Not Found' }))
    await expect(ensureSttModel(baseDir, 'large')).rejects.toThrow(/404/)
  })

  it('reports download progress with the total size when known', async () => {
    const progress: Array<[number, number | null]> = []
    const data = new Uint8Array(10)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(data, { status: 200, headers: { 'content-length': String(data.byteLength) } }),
    )
    const dest = join(baseDir, 'progress.bin')
    await downloadFile('https://fake.local/file', dest, (received, total) => {
      progress.push([received, total])
    })
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1]).toEqual([10, 10])
  })

  it('reports a null total when the response has no content-length', async () => {
    const progress: Array<[number, number | null]> = []
    const data = new Uint8Array(4)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const response = new Response(data)
      response.headers.delete('content-length')
      return response
    })
    const dest = join(baseDir, 'progress-nolength.bin')
    await downloadFile('https://fake.local/file', dest, (received, total) => {
      progress.push([received, total])
    })
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1]).toEqual([4, null])
  })

  it('computes the download percentage from received and total bytes', () => {
    expect(downloadPercent(50, 100)).toBe(50)
    expect(downloadPercent(100, 100)).toBe(100)
    expect(downloadPercent(150, 100)).toBe(100)
    expect(downloadPercent(0, 100)).toBe(0)
    expect(downloadPercent(50, null)).toBe(null)
    expect(downloadPercent(50, 0)).toBe(null)
  })

  it('reports the model download progress as a 0-100 percent', async () => {
    const zipPath = join(baseDir, 'nested-pct.zip')
    writeNestedZip(zipPath)
    const data = await readFile(zipPath)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(data, { status: 200, headers: { 'content-length': String(data.length) } }),
    )
    const percents: number[] = []
    await ensureSttModel(baseDir, 'small', (p) => percents.push(p))
    expect(percents.length).toBeGreaterThan(0)
    for (const p of percents) {
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(100)
    }
    expect(percents[percents.length - 1]).toBe(100)
  })

  it('deletes a downloaded vosk model', async () => {
    const modelDir = getSttModelDir(baseDir, 'small')
    await mkdir(join(modelDir, 'am'), { recursive: true })
    await writeFile(join(modelDir, 'am/final.mdl'), 'model-data')
    expect(await fileExists(modelDir)).toBe(true)
    await deleteVoskModel(baseDir, 'small')
    expect(await fileExists(modelDir)).toBe(false)
  })

  it('is a no-op when the vosk model is not downloaded', async () => {
    await expect(deleteVoskModel(baseDir, 'large')).resolves.toBeUndefined()
  })
})
