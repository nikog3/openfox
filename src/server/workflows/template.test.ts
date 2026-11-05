/**
 * Workflow Template Variables – Tests
 */

import { describe, it, expect } from 'vitest'
import { TEMPLATE_VARIABLES, resolveTemplate, type TemplateContext } from './template.js'

function makeCtx(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    workdir: '/tmp/project',
    reason: '2 criteria remaining',
    verifierFindings: '',
    previousStepOutput: '',
    criteriaCount: 3,
    pendingCount: 2,
    criteriaList: '- c1 [PENDING]',
    modifiedFiles: '- src/index.ts',
    stepOutput: {},
    params: {},
    language: 'English',
    ...overrides,
  }
}

describe('TEMPLATE_VARIABLES', () => {
  it('includes the language variable', () => {
    const entry = TEMPLATE_VARIABLES.find((v) => v.name === 'language')
    expect(entry).toBeDefined()
    expect(entry?.description).toBeTruthy()
  })
})

describe('resolveTemplate', () => {
  it('resolves {{language}} from the context', () => {
    expect(resolveTemplate('Write the summary in {{language}}.', makeCtx())).toBe('Write the summary in English.')
    expect(resolveTemplate('{{language}}', makeCtx({ language: 'French' }))).toBe('French')
  })

  it('keeps {{language}} as a built-in (params cannot override it)', () => {
    const ctx = makeCtx({ params: { language: 'German' } })
    expect(resolveTemplate('{{language}}', ctx)).toBe('English')
  })
})
