import { mkdir, rm, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { downloadFile } from './model.js'

export type WhisperModelSize = 'base' | 'small' | 'medium'

interface WhisperModelInfo {
  encoder: string
  decoder: string
  tokens: string
  bytes: number
}

function hfUrl(size: WhisperModelSize, file: string): string {
  return `https://huggingface.co/csukuangfj/sherpa-onnx-whisper-${size}/resolve/main/${file}`
}

export const WHISPER_MODELS: Record<WhisperModelSize, WhisperModelInfo> = {
  base: {
    encoder: 'base-encoder.int8.onnx',
    decoder: 'base-decoder.int8.onnx',
    tokens: 'base-tokens.txt',
    bytes: 160_609_290,
  },
  small: {
    encoder: 'small-encoder.int8.onnx',
    decoder: 'small-decoder.int8.onnx',
    tokens: 'small-tokens.txt',
    bytes: 375_485_327,
  },
  medium: {
    encoder: 'medium-encoder.int8.onnx',
    decoder: 'medium-decoder.int8.onnx',
    tokens: 'medium-tokens.txt',
    bytes: 946_072_270,
  },
}

export const WHISPER_MODEL_SIZES: WhisperModelSize[] = ['base', 'small', 'medium']

export function getWhisperModelDir(dataDir: string): string {
  return join(dataDir, 'stt', 'whisper')
}

export function getWhisperEncoderPath(dataDir: string, size: WhisperModelSize): string {
  return join(getWhisperModelDir(dataDir), WHISPER_MODELS[size].encoder)
}

export function getWhisperDecoderPath(dataDir: string, size: WhisperModelSize): string {
  return join(getWhisperModelDir(dataDir), WHISPER_MODELS[size].decoder)
}

export function getWhisperTokensPath(dataDir: string, size: WhisperModelSize): string {
  return join(getWhisperModelDir(dataDir), WHISPER_MODELS[size].tokens)
}

export function resolveWhisperModelSize(size: string | null | undefined): WhisperModelSize {
  if (size === 'base' || size === 'small' || size === 'medium') {
    return size
  }
  return 'small'
}

async function filePresent(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isFile() && s.size > 0
  } catch {
    return false
  }
}

function isWhisperModelPresent(dataDir: string, size: WhisperModelSize): Promise<boolean> {
  return Promise.all([
    filePresent(getWhisperEncoderPath(dataDir, size)),
    filePresent(getWhisperDecoderPath(dataDir, size)),
    filePresent(getWhisperTokensPath(dataDir, size)),
  ]).then(([encoder, decoder, tokens]) => encoder && decoder && tokens)
}

export interface WhisperModelStatus {
  size: WhisperModelSize
  file: string
  bytes: number
  downloaded: boolean
}

export async function getWhisperModelStatus(dataDir: string, size: WhisperModelSize): Promise<WhisperModelStatus> {
  const info = WHISPER_MODELS[size]
  return {
    size,
    file: `${info.encoder} + ${info.decoder}`,
    bytes: info.bytes,
    downloaded: await isWhisperModelPresent(dataDir, size),
  }
}

async function downloadIfMissing(url: string, dest: string): Promise<void> {
  if (await filePresent(dest)) {
    return
  }
  await mkdir(dirname(dest), { recursive: true })
  const work = `${dest}.part`
  try {
    await downloadFile(url, work)
    await rename(work, dest)
  } finally {
    await rm(work, { force: true }).catch(() => {})
  }
}

export interface WhisperModelPaths {
  encoder: string
  decoder: string
  tokens: string
}

export async function ensureWhisperModel(dataDir: string, size: WhisperModelSize): Promise<WhisperModelPaths> {
  const info = WHISPER_MODELS[size]
  const encoder = getWhisperEncoderPath(dataDir, size)
  const decoder = getWhisperDecoderPath(dataDir, size)
  const tokens = getWhisperTokensPath(dataDir, size)
  await Promise.all([
    downloadIfMissing(hfUrl(size, info.encoder), encoder),
    downloadIfMissing(hfUrl(size, info.decoder), decoder),
    downloadIfMissing(hfUrl(size, info.tokens), tokens),
  ])
  if (!(await isWhisperModelPresent(dataDir, size))) {
    throw new Error(`Whisper model ${info.encoder} + ${info.decoder} is not available after download`)
  }
  return { encoder, decoder, tokens }
}
