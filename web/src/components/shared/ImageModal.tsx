import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../hooks/useT'
import { MinusIcon, PlusIcon, ReloadIcon } from './icons'
import { Modal } from './Modal'

interface ImageModalProps {
  src: string
  alt: string
  isOpen: boolean
  onClose: () => void
}

interface View {
  scale: number
  x: number
  y: number
}

const MIN_SCALE = 1
const MAX_SCALE = 8
const STEP = 1.25
const WHEEL_FACTOR = 1.15
const WHEEL_BASE = 100
const DOUBLE_CLICK_SCALE = 2
const PAN_STEP = 48

const HOME_VIEW: View = { scale: 1, x: 0, y: 0 }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function ImageModal({ src, alt, isOpen, onClose }: ImageModalProps) {
  const t = useT()
  const [view, setView] = useState<View>(HOME_VIEW)
  const [isDragging, setIsDragging] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  const pinch = useRef<{
    dist: number
    scale: number
    midX: number
    midY: number
    baseX: number
    baseY: number
  } | null>(null)

  useEffect(() => {
    if (isOpen) setView(HOME_VIEW)
  }, [isOpen, src])

  const clampOffset = useCallback((x: number, y: number, scale: number) => {
    const el = viewportRef.current
    const img = imgRef.current
    if (!el || !img) return { x, y }
    const maxX = Math.max(0, (img.offsetWidth * scale - el.clientWidth) / 2)
    const maxY = Math.max(0, (img.offsetHeight * scale - el.clientHeight) / 2)
    return {
      x: clamp(x, -maxX, maxX),
      y: clamp(y, -maxY, maxY),
    }
  }, [])

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      setView((v) => {
        const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE)
        if (scale === v.scale) return v
        const el = viewportRef.current
        if (!el) return { ...v, scale }
        const rect = el.getBoundingClientRect()
        const dx = clientX - (rect.left + rect.width / 2)
        const dy = clientY - (rect.top + rect.height / 2)
        const k = scale / v.scale
        const next = { x: dx - (dx - v.x) * k, y: dy - (dy - v.y) * k }
        return { scale, ...clampOffset(next.x, next.y, scale) }
      })
    },
    [clampOffset],
  )

  const zoomByStep = useCallback(
    (dir: 1 | -1) => {
      const el = viewportRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, dir > 0 ? STEP : 1 / STEP)
    },
    [zoomAt],
  )

  const reset = useCallback(() => setView(HOME_VIEW), [])

  const panBy = useCallback(
    (dx: number, dy: number) => {
      setView((v) => ({ ...v, ...clampOffset(v.x + dx, v.y + dy, v.scale) }))
    },
    [clampOffset],
  )

  useEffect(() => {
    if (!isOpen) return
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.deltaY === 0) return
      const exponent = clamp(-e.deltaY / WHEEL_BASE, -3, 3)
      zoomAt(e.clientX, e.clientY, Math.pow(WHEEL_FACTOR, exponent))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [isOpen, zoomAt])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
      if (e.key === '+' || e.key === '=') zoomByStep(1)
      else if (e.key === '-' || e.key === '_') zoomByStep(-1)
      else if (e.key === '0') reset()
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        panBy(
          e.key === 'ArrowLeft' ? -PAN_STEP : e.key === 'ArrowRight' ? PAN_STEP : 0,
          e.key === 'ArrowUp' ? -PAN_STEP : e.key === 'ArrowDown' ? PAN_STEP : 0,
        )
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, zoomByStep, reset, panBy])

  if (!isOpen) return null

  const onPointerDown = (e: React.PointerEvent) => {
    const el = viewportRef.current
    if (!el) return
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // ignore unsupported environments
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) {
      drag.current = { startX: e.clientX, startY: e.clientY, baseX: view.x, baseY: view.y }
      setIsDragging(true)
    } else if (pointers.current.size === 2) {
      drag.current = null
      const [a, b] = [...pointers.current.values()]
      pinch.current = {
        dist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
        scale: view.scale,
        midX: (a!.x + b!.x) / 2,
        midY: (a!.y + b!.y) / 2,
        baseX: view.x,
        baseY: view.y,
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      const p = pinch.current
      const scale = clamp(p.scale * (dist / p.dist), MIN_SCALE, MAX_SCALE)
      const midX = (a!.x + b!.x) / 2
      const midY = (a!.y + b!.y) / 2
      const next = { x: p.baseX + (midX - p.midX), y: p.baseY + (midY - p.midY) }
      setView(() => ({ scale, ...clampOffset(next.x, next.y, scale) }))
    } else if (pointers.current.size === 1 && drag.current) {
      const d = drag.current
      const next = { x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) }
      setView((v) => ({ ...v, ...clampOffset(next.x, next.y, v.scale) }))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) {
      drag.current = null
      setIsDragging(false)
    } else if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()]
      setView((v) => {
        drag.current = { startX: p!.x, startY: p!.y, baseX: v.x, baseY: v.y }
        return v
      })
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (view.scale > 1) reset()
    else zoomAt(e.clientX, e.clientY, DOUBLE_CLICK_SCALE)
  }

  const zoomOutLabel = t({ en: 'Zoom out', fr: 'Dézoomer' })
  const zoomInLabel = t({ en: 'Zoom in', fr: 'Zoomer' })
  const resetLabel = t({ en: 'Reset zoom', fr: 'Réinitialiser le zoom' })

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={''} size="full" scrollable={false}>
      <div
        ref={viewportRef}
        data-testid="image-viewer-viewport"
        className={`relative flex-1 min-h-0 overflow-hidden flex items-center justify-center rounded-lg bg-bg-primary touch-none select-none ${
          isDragging ? 'cursor-grabbing' : view.scale > 1 ? 'cursor-grab' : ''
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          draggable={false}
          className="max-w-full max-h-full object-contain shadow-2xl"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: isDragging ? 'none' : 'transform 80ms ease-out',
          }}
        />
        <div
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-lg border border-border bg-bg-secondary/90 px-2 py-1 backdrop-blur"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label={zoomOutLabel}
            title={zoomOutLabel}
            onClick={() => zoomByStep(-1)}
            className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-primary transition-colors"
          >
            <MinusIcon className="w-4 h-4" />
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-text-secondary">
            {`${Math.round(view.scale * 100)}%`}
          </span>
          <button
            type="button"
            aria-label={zoomInLabel}
            title={zoomInLabel}
            onClick={() => zoomByStep(1)}
            className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-primary transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            aria-label={resetLabel}
            title={resetLabel}
            onClick={reset}
            className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-primary transition-colors"
          >
            <ReloadIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </Modal>
  )
}
