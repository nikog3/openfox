// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useDisplaySettings } from './useDisplaySettings'
import { SETTINGS_KEYS, settingResource } from '../lib/resources'
import { clearCache } from '../lib/resourceCache'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
  clearCache()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function makeProbe(select: (s: { showThinking: boolean }) => { showThinking: boolean }) {
  let renders = 0
  let lastRef: unknown = null
  function Probe() {
    const value = useDisplaySettings(select)
    renders++
    lastRef = value
    return <div data-testid="probe">{String(value.showThinking)}</div>
  }
  return { Probe, count: () => renders, last: () => lastRef }
}

describe('useDisplaySettings', () => {
  it('does not re-render a consumer when an unused setting changes', () => {
    const probe = makeProbe((s) => ({ showThinking: s.showThinking }))
    act(() => root.render(<probe.Probe />))
    const initial = probe.count()

    act(() => settingResource.write('false', SETTINGS_KEYS.DISPLAY_SHOW_STATS))
    expect(probe.count()).toBe(initial)

    act(() => settingResource.write('false', SETTINGS_KEYS.DISPLAY_SHOW_THINKING))
    expect(probe.count()).toBe(initial + 1)
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('false')
  })

  it('returns a stable reference when the selected fields are unchanged', () => {
    const probe = makeProbe((s) => ({ showThinking: s.showThinking }))
    act(() => root.render(<probe.Probe />))
    const first = probe.last()

    act(() => settingResource.write('true', SETTINGS_KEYS.DISPLAY_SHOW_STATS))
    expect(probe.last()).toBe(first)

    act(() => settingResource.write('false', SETTINGS_KEYS.DISPLAY_SHOW_THINKING))
    expect(probe.last()).not.toBe(first)
  })

  it('returns the full object with a stable reference by default', () => {
    let renders = 0
    let last: unknown = null
    function Full() {
      const value = useDisplaySettings()
      renders++
      last = value
      return <div>{String(value.showThinking)}</div>
    }
    act(() => root.render(<Full />))
    const first = last

    act(() => settingResource.write('false', SETTINGS_KEYS.DISPLAY_SHOW_STATS))
    expect(last).not.toBe(first)
    expect(renders).toBeGreaterThan(1)
  })
})
