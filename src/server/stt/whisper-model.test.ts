import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveWhisperModelSize,
  getWhisperModelDir,
  getWhisperEncoderPath,
  getWhisperDecoderPath,
  getWhisperTokensPath,
  getWhisperModelStatus,
  ensureWhisperModel,
  WHISPER_MODELS,
} from './whisper-model.js'

describe('whisper model', () => {
  let baseDir: string

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'openfox-stt-whisper-'))
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await rm(baseDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(join(baseDir, 'stt'), { recursive: true, force: true }).catch(() => {})
  })

  function mockFetchForModels(): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('tokens.txt')) {
        return new Response('<unk>\n', { status: 200 })
      }
      if (url.includes('encoder')) {
        return new Response('encoder-onnx-data', { status: 200 })
      }
      return new Response('decoder-onnx-data', { status: 200 })
    })
  }

  it('resolves known sizes and falls back to small', () => {
    expect(resolveWhisperModelSize('base')).toBe('base')
    expect(resolveWhisperModelSize('medium')).toBe('medium')
    expect(resolveWhisperModelSize('tiny')).toBe('small')
    expect(resolveWhisperModelSize(null)).toBe('small')
    expect(resolveWhisperModelSize(undefined)).toBe('small')
  })

  it('keeps the encoder, decoder and tokens files under the model directory', () => {
    expect(getWhisperEncoderPath(baseDir, 'base')).toBe(join(getWhisperModelDir(baseDir), 'base-encoder.int8.onnx'))
    expect(getWhisperDecoderPath(baseDir, 'base')).toBe(join(getWhisperModelDir(baseDir), 'base-decoder.int8.onnx'))
    expect(getWhisperTokensPath(baseDir, 'base')).toBe(join(getWhisperModelDir(baseDir), 'base-tokens.txt'))
  })

  it('reports not downloaded when nothing is present', async () => {
    const status = await getWhisperModelStatus(baseDir, 'base')
    expect(status).toEqual({
      size: 'base',
      file: `${WHISPER_MODELS.base.encoder} + ${WHISPER_MODELS.base.decoder}`,
      bytes: WHISPER_MODELS.base.bytes,
      downloaded: false,
    })
  })

  it('downloads the encoder, decoder and tokens.txt', async () => {
    mockFetchForModels()
    const model = await ensureWhisperModel(baseDir, 'base')
    expect(model).toEqual({
      encoder: join(getWhisperModelDir(baseDir), WHISPER_MODELS.base.encoder),
      decoder: join(getWhisperModelDir(baseDir), WHISPER_MODELS.base.decoder),
      tokens: join(getWhisperModelDir(baseDir), WHISPER_MODELS.base.tokens),
    })
    expect(await readFile(model.encoder, 'utf8')).toBe('encoder-onnx-data')
    expect(await readFile(model.decoder, 'utf8')).toBe('decoder-onnx-data')
    expect(await readFile(model.tokens, 'utf8')).toBe('<unk>\n')
  })

  it('reports downloaded once all three files are present', async () => {
    mockFetchForModels()
    await ensureWhisperModel(baseDir, 'small')
    const status = await getWhisperModelStatus(baseDir, 'small')
    expect(status.downloaded).toBe(true)
  })

  it('reports not downloaded when only the encoder is present', async () => {
    const dir = getWhisperModelDir(baseDir)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, WHISPER_MODELS.base.encoder), 'encoder-onnx-data')
    const status = await getWhisperModelStatus(baseDir, 'base')
    expect(status.downloaded).toBe(false)
  })

  it('reuses existing files without fetching', async () => {
    mockFetchForModels()
    await ensureWhisperModel(baseDir, 'base')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }))
    fetchSpy.mockClear()
    await ensureWhisperModel(baseDir, 'base')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('propagates download failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 404, statusText: 'Not Found' }))
    await expect(ensureWhisperModel(baseDir, 'base')).rejects.toThrow(/404/)
  })
})
