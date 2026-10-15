// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectTask } from '@shared/types.js'
import { TaskCard } from './TaskCard'

vi.mock('../shared/ImageModal', () => ({
  ImageModal: ({ src, isOpen }: { src: string; isOpen: boolean }) =>
    isOpen ? <div data-testid="image-modal">{src}</div> : null,
}))

const task: ProjectTask = {
  id: 't1',
  projectId: 'p1',
  prompt: 'Do it',
  attachments: [{ id: 'a1', filename: 'pic.png', mimeType: 'image/png', size: 10, data: 'data:image/png;base64,x' }],
  status: 'todo',
  position: 0,
  version: 1,
  sessionIds: [],
  gateValues: [],
  auditTrail: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function renderCard(onEdit: () => void = vi.fn()) {
  render(
    <TaskCard
      task={task}
      projectId="p1"
      agents={[]}
      onEdit={onEdit}
      onMove={() => {}}
      onMoveUp={() => {}}
      onMoveDown={() => {}}
      onDuplicate={() => {}}
      onDelete={() => {}}
      onDragStart={() => {}}
      onDropOnCard={() => {}}
    />,
  )
  return { onEdit }
}

describe('TaskCard image thumbnails', () => {
  it('opens the image modal when a thumbnail is clicked', () => {
    renderCard()
    expect(screen.queryByTestId('image-modal')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /view image/i }))
    expect(screen.getByTestId('image-modal').textContent).toBe('data:image/png;base64,x')
  })

  it('does not open the editor when a thumbnail is clicked', () => {
    const onEdit = vi.fn()
    renderCard(onEdit)
    fireEvent.click(screen.getByRole('button', { name: /view image/i }))
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('still opens the editor when the card body is clicked', () => {
    const onEdit = vi.fn()
    renderCard(onEdit)
    fireEvent.click(screen.getByText('Do it'))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})
