import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, access, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import AdmZip from 'adm-zip'

export const STT_MODEL_NAME = 'vosk-model-small-fr-0.22'
export const STT_MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip'
const STT_MODEL_MARKER = 'am/final.mdl'

export function getSttModelDir(dataDir: string): string {
  return join(dataDir, 'stt', STT_MODEL_NAME)
}

export function getSttModelMarkerPath(modelDir: string): string {
  return join(modelDir, STT_MODEL_MARKER)
}

export async function ensureSttModel(dataDir: string, url: string = STT_MODEL_URL): Promise<string> {
  const modelDir = getSttModelDir(dataDir)
  try {
    await access(getSttModelMarkerPath(modelDir))
    return modelDir
  } catch {
    // not downloaded yet
  }

  const sttDir = join(dataDir, 'stt')
  await mkdir(sttDir, { recursive: true })
  const workDir = join(sttDir, `${STT_MODEL_NAME}.work`)
  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })

  const zipPath = join(workDir, `${STT_MODEL_NAME}.zip`)
  try {
    await downloadFile(url, zipPath)
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

export async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  const writer = createWriteStream(dest)
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value) {
        writer.write(Buffer.from(value))
      }
    }
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve())
      writer.on('error', (error) => reject(error))
      writer.end()
    })
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

export async function downloadIfMissing(url: string, dest: string): Promise<void> {
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
