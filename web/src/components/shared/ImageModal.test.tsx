// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ImageModal } from './ImageModal'

const SRC = 'data:image/png;base64,AAAA'
const OTHER_SRC = 'data:image/png;base64,BBBB'

function renderOpen(props: Partial<React.ComponentProps<typeof ImageModal>> = {}) {
  return render(<ImageModal src={SRC} alt="shot" isOpen onClose={() => {}} {...props} />)
}

describe('ImageModal', () => {
  it('renders nothing when closed', () => {
    render(<ImageModal src={SRC} alt="shot" isOpen={false} onClose={() => {}} />)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows the image at 100% with zoom out, zoom in and reset controls', () => {
    renderOpen()
    expect(screen.getByAltText('shot')).toBeTruthy()
    expect(screen.getByText('100%')).toBeTruthy()
    expect(screen.getByLabelText('Zoom out')).toBeTruthy()
    expect(screen.getByLabelText('Zoom in')).toBeTruthy()
    expect(screen.getByLabelText('Reset zoom')).toBeTruthy()
  })

  it('zooms in with the zoom in button', () => {
    renderOpen()
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(screen.getByText('125%')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(screen.getByText('156%')).toBeTruthy()
  })

  it('does not zoom out below 100%', () => {
    renderOpen()
    fireEvent.click(screen.getByLabelText('Zoom out'))
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('resets zoom and panning with the reset button', () => {
    renderOpen()
    fireEvent.click(screen.getByLabelText('Zoom in'))
    fireEvent.click(screen.getByLabelText('Reset zoom'))
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('zooms with the mouse wheel', () => {
    renderOpen()
    const viewport = document.querySelector('[data-testid="image-viewer-viewport"]') as HTMLElement
    fireEvent.wheel(viewport, { deltaY: -100 })
    expect(screen.getByText('115%')).toBeTruthy()
    fireEvent.wheel(viewport, { deltaY: 100 })
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('scales wheel zoom with deltaY magnitude for smooth trackpad zoom', () => {
    renderOpen()
    const viewport = document.querySelector('[data-testid="image-viewer-viewport"]') as HTMLElement
    fireEvent.wheel(viewport, { deltaY: -100 })
    expect(screen.getByText('115%')).toBeTruthy()
    fireEvent.wheel(viewport, { deltaY: -10 })
    expect(screen.getByText('117%')).toBeTruthy()
  })

  it('pans with the arrow keys when zoomed in', () => {
    renderOpen()
    fireEvent.click(screen.getByLabelText('Zoom in'))
    const viewport = document.querySelector('[data-testid="image-viewer-viewport"]') as HTMLElement
    const img = screen.getByAltText('shot')
    Object.defineProperty(viewport, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(viewport, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(img, 'offsetWidth', { value: 1000, configurable: true })
    Object.defineProperty(img, 'offsetHeight', { value: 800, configurable: true })
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(img.style.transform).toContain('translate(48px, 0px)')
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(img.style.transform).toContain('translate(48px, 48px)')
  })

  it('toggles 100% / 200% on double click', () => {
    renderOpen()
    const viewport = document.querySelector('[data-testid="image-viewer-viewport"]') as HTMLElement
    fireEvent.doubleClick(viewport)
    expect(screen.getByText('200%')).toBeTruthy()
    fireEvent.doubleClick(viewport)
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('zooms with keyboard shortcuts', () => {
    renderOpen()
    fireEvent.keyDown(document, { key: '+' })
    expect(screen.getByText('125%')).toBeTruthy()
    fireEvent.keyDown(document, { key: '0' })
    expect(screen.getByText('100%')).toBeTruthy()
    fireEvent.keyDown(document, { key: '-' })
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('resets the zoom when the image source changes', () => {
    const { rerender } = render(<ImageModal src={SRC} alt="shot" isOpen onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(screen.getByText('125%')).toBeTruthy()
    rerender(<ImageModal src={OTHER_SRC} alt="shot" isOpen onClose={() => {}} />)
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('resets the zoom when reopened', () => {
    const { rerender } = render(<ImageModal src={SRC} alt="shot" isOpen onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(screen.getByText('125%')).toBeTruthy()
    rerender(<ImageModal src={SRC} alt="shot" isOpen={false} onClose={() => {}} />)
    rerender(<ImageModal src={SRC} alt="shot" isOpen onClose={() => {}} />)
    expect(screen.getByText('100%')).toBeTruthy()
  })
})
