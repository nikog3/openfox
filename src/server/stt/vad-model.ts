import { join } from 'node:path'
import { filePresent, downloadIfMissing } from './model.js'

export const VAD_MODEL_NAME = 'silero_vad.onnx'
export const VAD_MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
export const VAD_MODEL_BYTES = 643_854

export function getVadModelDir(dataDir: string): string {
  return join(dataDir, 'stt', 'vad')
}

export function getVadModelPath(dataDir: string): string {
  return join(getVadModelDir(dataDir), VAD_MODEL_NAME)
}

export interface VadModelStatus {
  file: string
  bytes: number
  downloaded: boolean
}

export async function getVadModelStatus(dataDir: string): Promise<VadModelStatus> {
  return {
    file: VAD_MODEL_NAME,
    bytes: VAD_MODEL_BYTES,
    downloaded: await filePresent(getVadModelPath(dataDir)),
  }
}

export async function ensureVadModel(dataDir: string): Promise<string> {
  const dest = getVadModelPath(dataDir)
  await downloadIfMissing(VAD_MODEL_URL, dest)
  if (!(await filePresent(dest))) {
    throw new Error(`VAD model ${VAD_MODEL_NAME} is not available after download`)
  }
  return dest
}
