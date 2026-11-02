import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
}))

vi.mock('../db/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/settings.js')>()
  return {
    ...actual,
    getSetting: vi.fn((key: string) => state.settings[key] ?? null),
  }
})

vi.mock('../runtime-config.js', () => ({
  getRuntimeConfig: () => ({ mode: 'production' }),
}))

vi.mock('voskify', () => ({
  VoskModel: vi.fn(),
}))

import { SETTINGS_KEYS } from '../db/settings.js'
import { createFactory } from './index.js'

describe('stt factory configKey', () => {
  beforeEach(() => {
    state.settings = {}
  })

  it('uses off:production when the engine is off', () => {
    expect(createFactory().configKey()).toBe('off:production')
  })

  it('uses vosk:small:production by default', () => {
    state.settings[SETTINGS_KEYS.STT_ENGINE] = 'vosk'
    expect(createFactory().configKey()).toBe('vosk:small:production')
  })

  it('uses vosk:large:production when the vosk model is large', () => {
    state.settings[SETTINGS_KEYS.STT_ENGINE] = 'vosk'
    state.settings[SETTINGS_KEYS.STT_VOSK_MODEL] = 'large'
    expect(createFactory().configKey()).toBe('vosk:large:production')
  })

  it('falls back to vosk:small:production for an invalid vosk model size', () => {
    state.settings[SETTINGS_KEYS.STT_ENGINE] = 'vosk'
    state.settings[SETTINGS_KEYS.STT_VOSK_MODEL] = 'huge'
    expect(createFactory().configKey()).toBe('vosk:small:production')
  })

  it('uses whisper:<size>:<language>:production for the whisper engine', () => {
    state.settings[SETTINGS_KEYS.STT_ENGINE] = 'whisper'
    state.settings[SETTINGS_KEYS.STT_WHISPER_MODEL] = 'medium'
    state.settings[SETTINGS_KEYS.STT_LANGUAGE] = 'en'
    expect(createFactory().configKey()).toBe('whisper:medium:en:production')
  })
})
