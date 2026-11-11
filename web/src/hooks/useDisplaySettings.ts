import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { deriveDisplaySettings, displaySettingsResource, type DisplaySettings } from '../lib/resources'
import { load, release, retain, subscribe } from '../lib/resourceCache'

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const key of ka) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    ) {
      return false
    }
  }
  return true
}

/** Wrap a selector so its result keeps a stable reference while the selected
 * fields are shallow-equal — the primitive that stops consumers re-rendering
 * when an unused setting changes. */
function useStableSelector<T, R>(selector: (t: T) => R) {
  const lastRef = useRef<R | undefined>(undefined)
  const hasRef = useRef(false)
  return useCallback(
    (input: T): R => {
      const result = selector(input)
      if (hasRef.current && shallowEqual(lastRef.current, result)) return lastRef.current as R
      lastRef.current = result
      hasRef.current = true
      return result
    },
    [selector],
  )
}

/**
 * Single subscription over all display settings. One batched fetch warms the
 * per-key entries; the snapshot derives from the per-key cache so any per-key
 * write converges without a refetch. Pass a selector to subscribe to only the
 * fields you read — the returned reference stays stable, so a consumer never
 * re-renders when an unused setting changes.
 */
export function useDisplaySettings<T = DisplaySettings>(selector: (s: DisplaySettings) => T = (s) => s as T) {
  const select = useStableSelector(selector)
  const getSnapshot = useCallback(() => select(deriveDisplaySettings()), [select])
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useLayoutEffect(() => {
    const key = displaySettingsResource.keyOf()
    load(key, () => displaySettingsResource.fetch(), displaySettingsResource.maxAgeMs)
    retain(key)
    return () => release(key)
  }, [])

  return value
}
