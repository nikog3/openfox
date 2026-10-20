import { getGlobalDataDir } from '../../cli/paths.js'
import { getRuntimeConfig } from '../runtime-config.js'
import { serverT } from '../i18n.js'
import { getSetting, SETTINGS_KEYS } from '../db/settings.js'
import { ensureSttModel } from './model.js'
import { createVoskProvider } from './vosk-provider.js'
import { ensureWhisperModel, resolveWhisperModelSize } from './whisper-model.js'
import { ensureVadModel } from './vad-model.js'
import { createWhisperProvider } from './whisper-provider.js'
import { SttService } from './service.js'
import type { SttProviderFactory } from './types.js'

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

function createFactory(): SttProviderFactory {
  return async (onPartial) => {
    const mode = getRuntimeConfig().mode ?? 'production'
    const dataDir = getGlobalDataDir(mode)
    const engine = (getSetting(SETTINGS_KEYS.STT_ENGINE) ?? 'off').trim()

    if (engine === '' || engine === 'off') {
      throw new Error(serverT({ en: 'Speech-to-text is disabled', fr: 'La dictée est désactivée' }))
    }

    if (engine === 'whisper') {
      const size = resolveWhisperModelSize(getSetting(SETTINGS_KEYS.STT_WHISPER_MODEL))
      const language = (getSetting(SETTINGS_KEYS.STT_LANGUAGE) ?? 'fr').trim() || 'fr'
      let model: Awaited<ReturnType<typeof ensureWhisperModel>>
      let vadModel: string
      try {
        model = await ensureWhisperModel(dataDir, size)
        vadModel = await ensureVadModel(dataDir)
      } catch (error) {
        throw modelPrepError(error)
      }
      return createWhisperProvider(model.encoder, model.decoder, model.tokens, language, vadModel, onPartial)
    }

    let modelPath: string
    try {
      modelPath = await ensureSttModel(dataDir)
    } catch (error) {
      throw modelPrepError(error)
    }
    return createVoskProvider(modelPath, onPartial)
  }
}

export function getSttService(): SttService {
  if (!service) {
    service = new SttService(createFactory())
  }
  return service
}
