import { getGlobalDataDir } from '../../cli/paths.js'
import { getRuntimeConfig } from '../runtime-config.js'
import { serverT } from '../i18n.js'
import { getSetting, SETTINGS_KEYS } from '../db/settings.js'
import { ensureSttModel, resolveVoskModelSize } from './model.js'
import { createVoskProvider } from './vosk-provider.js'
import { ensureWhisperModel, resolveWhisperModelSize } from './whisper-model.js'
import { ensureVadModel } from './vad-model.js'
import { createWhisperProvider } from './whisper-provider.js'
import { SttService } from './service.js'
import type { SttProvider, SttProviderFactory, SttProviderHooks } from './types.js'

let service: SttService | null = null

function modelPrepError(error: unknown): Error {
  return new Error(
    serverT(
      {
        en: 'Failed to prepare the speech model: {{detail}}',
        fr: 'Échec de la préparation du modèle vocal : {{detail}}',
      },
      { detail: error instanceof Error ? error.message : String(error) },
    ),
  )
}

function resolveEngine(): string {
  return (getSetting(SETTINGS_KEYS.STT_ENGINE) ?? 'off').trim()
}

export function createFactory(): SttProviderFactory {
  return {
    configKey(): string {
      const mode = getRuntimeConfig().mode ?? 'production'
      const engine = resolveEngine()
      if (engine === '' || engine === 'off') {
        return `off:${mode}`
      }
      if (engine === 'whisper') {
        const size = resolveWhisperModelSize(getSetting(SETTINGS_KEYS.STT_WHISPER_MODEL))
        const language = (getSetting(SETTINGS_KEYS.STT_LANGUAGE) ?? 'fr').trim() || 'fr'
        return `whisper:${size}:${language}:${mode}`
      }
      const size = resolveVoskModelSize(getSetting(SETTINGS_KEYS.STT_VOSK_MODEL))
      return `vosk:${size}:${mode}`
    },
    async create(hooks: SttProviderHooks): Promise<SttProvider> {
      const mode = getRuntimeConfig().mode ?? 'production'
      const dataDir = getGlobalDataDir(mode)
      const engine = resolveEngine()

      if (engine === '' || engine === 'off') {
        throw new Error(serverT({ en: 'Speech-to-text is disabled', fr: 'La dictée est désactivée' }))
      }

      if (engine === 'whisper') {
        const size = resolveWhisperModelSize(getSetting(SETTINGS_KEYS.STT_WHISPER_MODEL))
        const language = (getSetting(SETTINGS_KEYS.STT_LANGUAGE) ?? 'fr').trim() || 'fr'
        let model: Awaited<ReturnType<typeof ensureWhisperModel>>
        let vadModel: string
        try {
          model = await ensureWhisperModel(dataDir, size, (percent) => hooks.onProgress(percent * 0.95))
          vadModel = await ensureVadModel(dataDir, (percent) => hooks.onProgress(95 + percent * 0.05))
        } catch (error) {
          throw modelPrepError(error)
        }
        return createWhisperProvider(model.encoder, model.decoder, model.tokens, language, vadModel, hooks)
      }

      let modelPath: string
      try {
        const size = resolveVoskModelSize(getSetting(SETTINGS_KEYS.STT_VOSK_MODEL))
        modelPath = await ensureSttModel(dataDir, size, (percent) => hooks.onProgress(percent))
      } catch (error) {
        throw modelPrepError(error)
      }
      return createVoskProvider(modelPath, hooks)
    },
  }
}

const NOOP_HOOKS: SttProviderHooks = {
  onPartial: () => {},
  onActivity: () => {},
  onProgress: () => {},
}

export async function transcribeTestAudio(pcm: Buffer): Promise<string> {
  const factory = createFactory()
  const provider = await factory.create(NOOP_HOOKS)
  try {
    await provider.acceptAudio(pcm)
    return await provider.finalize()
  } finally {
    await provider.dispose()
  }
}

export function getSttService(): SttService {
  if (!service) {
    service = new SttService(createFactory())
  }
  return service
}
