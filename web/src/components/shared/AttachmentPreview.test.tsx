// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@shared/types.js'

vi.mock('./ImageModal', () => ({
  ImageModal: ({ src, isOpen }: { src: string; isOpen: boolean }) =>
    isOpen ? <div data-testid="image-modal">{src}</div> : null,
}))

import { AttachmentPreview } from './AttachmentPreview'

const imageAttachment: Attachment = {
  id: 'a1',
  filename: 'shot.png',
  mimeType: 'image/png',
  size: 10,
  data: 'data:image/png;base64,x',
}

describe('AttachmentPreview', () => {
  it('opens the image modal when the image thumbnail is clicked', () => {
    render(<AttachmentPreview attachment={imageAttachment} onRemove={() => {}} />)
    expect(screen.queryByTestId('image-modal')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /view image/i }))
    expect(screen.getByTestId('image-modal').textContent).toBe('data:image/png;base64,x')
  })

  it('does not remove the attachment when the image is clicked', () => {
    const onRemove = vi.fn()
    render(<AttachmentPreview attachment={imageAttachment} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: /view image/i }))
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('removes via the close button without opening the modal', () => {
    const onRemove = vi.fn()
    render(<AttachmentPreview attachment={imageAttachment} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: /remove shot\.png/i }))
    expect(onRemove).toHaveBeenCalledWith('a1')
    expect(screen.queryByTestId('image-modal')).toBeNull()
  })

  it('shows no zoom control for non-image attachments', () => {
    render(
      <AttachmentPreview
        attachment={{ ...imageAttachment, filename: 'notes.txt', mimeType: 'text/plain', data: 'hello' }}
        onRemove={() => {}}
      />,
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('button', { name: /view image/i })).toBeNull()
  })
})
