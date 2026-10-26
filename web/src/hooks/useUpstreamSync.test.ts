// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUpstreamSync, toSync } from './useUpstreamSync'
import { workspacesResource, type WorkspacesData } from '../lib/resources'
import { clearCache } from '../lib/resourceCache'

vi.mock('../lib/api', () => ({
  authFetch: vi.fn(() => Promise.reject(new Error('no network in tests'))),
}))

const data: WorkspacesData = {
  workspaces: [
    { path: '/ws/a', name: 'alpha', branch: 'feat/a', ahead: 2, behind: 1 },
    { path: '/ws/b', name: 'beta', branch: 'main', ahead: null, behind: null },
  ],
  main: { branch: 'main', ahead: 0, behind: 3 },
}

beforeEach(() => {
  clearCache()
})

describe('toSync', () => {
  it('builds a sync object from non-null counts', () => {
    expect(toSync(2, 0)).toEqual({ ahead: 2, behind: 0 })
  })

  it('returns null when either count is missing', () => {
    expect(toSync(null, 0)).toBeNull()
    expect(toSync(0, null)).toBeNull()
  })
})

describe('useUpstreamSync', () => {
  it('returns null before the workspace list is loaded', () => {
    const { result } = renderHook(() => useUpstreamSync('alpha', 'p1'))
    expect(result.current).toBeNull()
  })

  it('uses the main repo sync for the original workspace', () => {
    workspacesResource.write(data, 'p1')
    const { result } = renderHook(() => useUpstreamSync('original', 'p1'))
    expect(result.current).toEqual({ ahead: 0, behind: 3 })
  })

  it('uses the workspace own counts for a linked workspace', () => {
    workspacesResource.write(data, 'p1')
    const { result } = renderHook(() => useUpstreamSync('alpha', 'p1'))
    expect(result.current).toEqual({ ahead: 2, behind: 1 })
  })

  it('returns null for a linked workspace without upstream counts', () => {
    workspacesResource.write(data, 'p1')
    const { result } = renderHook(() => useUpstreamSync('beta', 'p1'))
    expect(result.current).toBeNull()
  })

  it('returns null when the workspace is not in the list', () => {
    workspacesResource.write(data, 'p1')
    const { result } = renderHook(() => useUpstreamSync('gamma', 'p1'))
    expect(result.current).toBeNull()
  })

  it('does not resolve anything for an empty project id', () => {
    const { result } = renderHook(() => useUpstreamSync('alpha', ''))
    expect(result.current).toBeNull()
  })
})
