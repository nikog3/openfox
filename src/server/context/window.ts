import { UNKNOWN_CONTEXT_WINDOW } from '../../shared/reasoning-effort.js'

/**
 * Conservative default context window used when no reliable detection is
 * available. Deliberately small: a too-large phantom window makes the token
 * budget blind to the model's real limit and lets prompts overflow it.
 */
export const CONSERVATIVE_CONTEXT_WINDOW = 32_768

export type WindowSource = 'override' | 'backend' | 'default'

export interface WindowResolution {
  window: number
  source: WindowSource
  /** True when a user override was lowered to a smaller detected window. */
  loweredToDetected: boolean
}

function isRealWindow(value: number | undefined): value is number {
  return value !== undefined && value > 0 && value !== UNKNOWN_CONTEXT_WINDOW
}

/**
 * Resolve the effective context window via the priority cascade:
 *   P1 user override (supreme — detection never RAISES it)
 *   P2 backend-detected window (standard /v1/models, Ollama /api/show, llama.cpp /slots)
 *   P4 conservative default (32k)
 *
 * When both an override and a detected window exist, the effective value is
 * min(override, detected): detection can only LOWER the override, and that
 * lowering is flagged so it can be surfaced as a warning.
 */
export function resolveContextWindow(override: number | undefined, detected: number | undefined): WindowResolution {
  const hasOverride = isRealWindow(override)
  const hasDetected = isRealWindow(detected)

  if (hasOverride && hasDetected) {
    if (detected < override) {
      return { window: detected, source: 'backend', loweredToDetected: true }
    }
    return { window: override, source: 'override', loweredToDetected: false }
  }
  if (hasOverride) return { window: override, source: 'override', loweredToDetected: false }
  if (hasDetected) return { window: detected, source: 'backend', loweredToDetected: false }
  return { window: CONSERVATIVE_CONTEXT_WINDOW, source: 'default', loweredToDetected: false }
}
