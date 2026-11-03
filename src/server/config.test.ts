import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig defaults', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults LLM timeout and idle (TTFT) timeout to 10 minutes', () => {
    const config = loadConfig()
    expect(config.llm.timeout).toBe(600_000)
    expect(config.llm.idleTimeout).toBe(600_000)
  })

  it('defaults agent tool timeout to 10 minutes', () => {
    const config = loadConfig()
    expect(config.agent.toolTimeout).toBe(600_000)
  })

  it('honors explicit OPENFOX_LLM_TIMEOUT and OPENFOX_LLM_IDLE_TIMEOUT overrides', () => {
    vi.stubEnv('OPENFOX_LLM_TIMEOUT', '45000')
    vi.stubEnv('OPENFOX_LLM_IDLE_TIMEOUT', '90000')
    const config = loadConfig()
    expect(config.llm.timeout).toBe(45_000)
    expect(config.llm.idleTimeout).toBe(90_000)
  })
})
