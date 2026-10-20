import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getVadModelDir,
  getVadModelPath,
  getVadModelStatus,
  ensureVadModel,
  VAD_MODEL_NAME,
  VAD_MODEL_BYTES,
} from './vad-model.js'

describe('vad model', () => {
  let baseDir: string

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'openfox-stt-vad-'))
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await rm(baseDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(join(baseDir, 'stt'), { recursive: true, force: true }).catch(() => {})
  })

  it('keeps the model file under the vad directory', () => {
    expect(getVadModelPath(baseDir)).toBe(join(getVadModelDir(baseDir), VAD_MODEL_NAME))
  })

  it('reports not downloaded when nothing is present', async () => {
    const status = await getVadModelStatus(baseDir)
    expect(status).toEqual({
      file: VAD_MODEL_NAME,
      bytes: VAD_MODEL_BYTES,
      downloaded: false,
    })
  })

  it('downloads the model on demand', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('vad-onnx-data', { status: 200 }))
    const path = await ensureVadModel(baseDir)
    expect(path).toBe(getVadModelPath(baseDir))
    expect(await readFile(path, 'utf8')).toBe('vad-onnx-data')
  })

  it('reports downloaded once the file is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('vad-onnx-data', { status: 200 }))
    await ensureVadModel(baseDir)
    const status = await getVadModelStatus(baseDir)
    expect(status.downloaded).toBe(true)
  })

  it('reuses existing files without fetching', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('vad-onnx-data', { status: 200 }))
    await ensureVadModel(baseDir)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }))
    fetchSpy.mockClear()
    await ensureVadModel(baseDir)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('propagates download failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 404, statusText: 'Not Found' }))
    await expect(ensureVadModel(baseDir)).rejects.toThrow(/404/)
  })
})
