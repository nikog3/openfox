import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, access, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import AdmZip from 'adm-zip'

export type SttVoskModelSize = 'small' | 'large'

interface VoskModelInfo {
  name: string
  url: string
  bytes: number
}

export const STT_VOSK_MODELS: Record<SttVoskModelSize, VoskModelInfo> = {
  small: {
    name: 'vosk-model-small-fr-0.22',
    url: 'https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip',
    bytes: 41_900_000,
  },
  large: {
    name: 'vosk-model-fr-0.22',
    url: 'https://alphacephei.com/vosk/models/vosk-model-fr-0.22.zip',
    bytes: 1_400_000_000,
  },
}

export const STT_VOSK_MODEL_SIZES: SttVoskModelSize[] = ['small', 'large']

const STT_MODEL_MARKER = 'am/final.mdl'

export function resolveVoskModelSize(size: string | null | undefined): SttVoskModelSize {
  if (size === 'small' || size === 'large') {
    return size
  }
  return 'small'
}

export function getSttModelDir(dataDir: string, size: SttVoskModelSize): string {
  return join(dataDir, 'stt', STT_VOSK_MODELS[size].name)
}

export async function deleteVoskModel(dataDir: string, size: SttVoskModelSize): Promise<void> {
  await rm(getSttModelDir(dataDir, size), { recursive: true, force: true })
}

export function downloadPercent(received: number, total: number | null): number | null {
  if (!total || total <= 0) {
    return null
  }
  return Math.min(100, (received / total) * 100)
}

export function getSttModelMarkerPath(modelDir: string): string {
  return join(modelDir, STT_MODEL_MARKER)
}

export interface SttVoskModelStatus {
  size: SttVoskModelSize
  file: string
  bytes: number
  downloaded: boolean
}

export async function getVoskModelStatus(dataDir: string, size: SttVoskModelSize): Promise<SttVoskModelStatus> {
  const info = STT_VOSK_MODELS[size]
  return {
    size,
    file: info.name,
    bytes: info.bytes,
    downloaded: await filePresent(getSttModelMarkerPath(getSttModelDir(dataDir, size))),
  }
}

export async function ensureSttModel(
  dataDir: string,
  size: SttVoskModelSize,
  onProgress?: (percent: number) => void,
): Promise<string> {
  const info = STT_VOSK_MODELS[size]
  const modelDir = getSttModelDir(dataDir, size)
  try {
    await access(getSttModelMarkerPath(modelDir))
    return modelDir
  } catch {
    // not downloaded yet
  }

  const sttDir = join(dataDir, 'stt')
  await mkdir(sttDir, { recursive: true })
  const workDir = join(sttDir, `${info.name}.work`)
  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })

  const zipPath = join(workDir, `${info.name}.zip`)
  try {
    await downloadFile(info.url, zipPath, (received, total) => {
      const percent = downloadPercent(received, total)
      if (percent !== null) {
        onProgress?.(percent)
      }
    })
    await extractZip(zipPath, workDir)
    const extractedRoot = await resolveModelRoot(workDir)
    await rm(modelDir, { recursive: true, force: true })
    await rename(extractedRoot, modelDir)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }

  await access(getSttModelMarkerPath(modelDir))
  return modelDir
}

async function resolveModelRoot(extractDir: string): Promise<string> {
  if (await pathExists(join(extractDir, STT_MODEL_MARKER))) {
    return extractDir
  }
  const entries = await readdir(extractDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const candidate = join(extractDir, entry.name)
    if (await pathExists(join(candidate, STT_MODEL_MARKER))) {
      return candidate
    }
  }
  throw new Error(`Vosk model marker ${STT_MODEL_MARKER} not found after extraction`)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isFile()
  } catch {
    return false
  }
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  const contentLengthHeader = response.headers.get('content-length')
  const total = contentLengthHeader ? Number(contentLengthHeader) : Number.NaN
  const writer = createWriteStream(dest)
  const reader = response.body.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value) {
        received += value.byteLength
        writer.write(Buffer.from(value))
        onProgress?.(received, Number.isFinite(total) ? total : null)
      }
    }
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve())
      writer.on('error', (error) => reject(error))
      writer.end()
    })
    onProgress?.(received, Number.isFinite(total) ? total : null)
  } finally {
    writer.close()
  }
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(destDir, true)
}

export async function filePresent(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isFile() && s.size > 0
  } catch {
    return false
  }
}

export async function downloadIfMissing(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
  if (await filePresent(dest)) {
    return
  }
  await mkdir(dirname(dest), { recursive: true })
  const work = `${dest}.part`
  try {
    await downloadFile(url, work, onProgress)
    await rename(work, dest)
  } finally {
    await rm(work, { force: true }).catch(() => {})
  }
}
