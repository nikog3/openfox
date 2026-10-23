// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import type { Mock } from 'vitest'
import { GitStatusPanel } from './GitStatusPanel'
import type { ReactNode } from 'react'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const mockUseGitStatus = vi.fn() as Mock
const mockAuthFetch = vi.fn() as Mock
const diffModalProps: { path?: string; staged?: boolean } = {}

vi.mock('../../hooks/useGitStatus', () => ({
  useGitStatus: () => mockUseGitStatus(),
}))

vi.mock('../../stores/session/session-scope', () => ({
  useScopedContext: () => ({
    sessionId: 's1',
    currentSession: { id: 's1', projectId: 'p1', workspace: '/tmp/proj', workdir: '/tmp/proj' },
  }),
}))

vi.mock('../../lib/api', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}))

vi.mock('../../hooks/useSetting', () => ({
  useSetting: () => ({ value: '', loading: false }),
}))

vi.mock('../../lib/resources', () => ({
  SETTINGS_KEYS: {
    DISPLAY_SHOW_OPEN_IN_EDITOR: 'display.showOpenInEditorLinks',
    VSCODE_REMOTE_PREFIX: 'editor.vscodeRemotePrefix',
  },
}))

vi.mock('./DiffModal', () => ({
  DiffModal: (props: { path: string; staged: boolean; isOpen: boolean }) => {
    diffModalProps.path = props.path
    diffModalProps.staged = props.staged
    return <div data-testid="diff-modal" />
  },
}))

vi.mock('../shared/ConfirmModal', () => ({
  ConfirmModal: ({
    isOpen,
    onClose,
    onConfirm,
    message,
  }: {
    isOpen: boolean
    onClose: () => void
    onConfirm: () => void
    message: ReactNode
  }) =>
    isOpen ? (
      <div data-testid="confirm-modal">
        {message}
        <button onClick={onClose} aria-label="cancel-discard">
          cancel
        </button>
        <button onClick={onConfirm} aria-label="confirm-discard">
          confirm
        </button>
      </div>
    ) : null,
}))

vi.mock('../shared/ScrollArea', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../shared/icons', () => ({
  ArrowUpIcon: () => '[up]',
  ArrowDownIcon: () => '[down]',
  CheckIcon: () => '[check]',
  GitCommitIcon: () => '[commit]',
  GitPullIcon: () => '[pull]',
  GitPushIcon: () => '[push]',
  MinusIcon: () => '[minus]',
  PlusIcon: () => '[plus]',
  ThinkingIcon: () => '[think]',
  TrashIcon: () => '[trash]',
}))

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const files = [
  {
    path: 'src/a.ts',
    status: 'modified',
    staged: true,
    unstaged: false,
    untracked: false,
    additions: 10,
    deletions: 2,
  },
  { path: 'src/b.ts', status: 'modified', staged: false, unstaged: true, untracked: false, additions: 3, deletions: 1 },
  { path: 'src/c.ts', status: 'added', staged: false, unstaged: false, untracked: true, additions: 5, deletions: 0 },
]

function mockGitStatus(overrides?: {
  files?: typeof files
  sync?: { ahead: number; behind: number } | null
  loading?: boolean
}) {
  mockUseGitStatus.mockReturnValue({
    branch: 'main',
    sync: { ahead: 1, behind: 2 },
    diff: { files, loading: false, error: null },
    ...(overrides?.sync !== undefined ? { sync: overrides.sync } : {}),
    ...(overrides?.files !== undefined ? { diff: { files: overrides.files, loading: false, error: null } } : {}),
    ...(overrides?.loading !== undefined ? { diff: { files: [], loading: overrides.loading, error: null } } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGitStatus()
  mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, output: '' }) })
})

afterEach(cleanup)

/* ------------------------------------------------------------------ */
/*  Static rendering                                                  */
/* ------------------------------------------------------------------ */

describe('GitStatusPanel — rendering', () => {
  it('shows a spinner while loading', () => {
    mockGitStatus({ loading: true })
    const html = renderToStaticMarkup(<GitStatusPanel />)
    expect(html).toContain('Checking changes...')
  })

  it('shows a placeholder when there are no changes', () => {
    mockGitStatus({ files: [] })
    const html = renderToStaticMarkup(<GitStatusPanel />)
    expect(html).toContain('No changes')
  })

  it('renders branch, sync arrows and staged/unstaged/untracked counts', () => {
    const html = renderToStaticMarkup(<GitStatusPanel />)
    expect(html).toContain('main')
    expect(html).toContain('[up]')
    expect(html).toContain('[down]')
    expect(html).toContain('1 staged')
    expect(html).toContain('1 unstaged')
    expect(html).toContain('1 untracked')
  })

  it('hides sync arrows when ahead and behind are zero', () => {
    mockGitStatus({ sync: { ahead: 0, behind: 0 } })
    const html = renderToStaticMarkup(<GitStatusPanel />)
    expect(html).not.toContain('[up]')
    expect(html).not.toContain('[down]')
  })

  it('renders Staged, Unstaged and Untracked sections', () => {
    const html = renderToStaticMarkup(<GitStatusPanel />)
    expect(html).toContain('Staged')
    expect(html).toContain('Unstaged')
    expect(html).toContain('Untracked')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('src/b.ts')
    expect(html).toContain('src/c.ts')
  })

  it('hides empty sections', () => {
    mockGitStatus({ files: [files[1]!] })
    const html = renderToStaticMarkup(<GitStatusPanel />)
    expect(html).toContain('Unstaged')
    expect(html).not.toContain('Staged')
    expect(html).not.toContain('Untracked')
  })

  it('lists a file with both staged and unstaged changes in both sections', () => {
    mockGitStatus({
      files: [
        {
          path: 'src/a.ts',
          status: 'modified',
          staged: true,
          unstaged: true,
          untracked: false,
          additions: 1,
          deletions: 1,
        },
      ],
    })
    render(<GitStatusPanel />)
    expect(screen.getAllByText('src/a.ts')).toHaveLength(2)
  })

  it('renders a check for staged-only files and a half marker for mixed files', () => {
    mockGitStatus({
      files: [
        {
          path: 'src/a.ts',
          status: 'modified',
          staged: true,
          unstaged: false,
          untracked: false,
          additions: 1,
          deletions: 1,
        },
        {
          path: 'src/b.ts',
          status: 'modified',
          staged: true,
          unstaged: true,
          untracked: false,
          additions: 1,
          deletions: 1,
        },
      ],
    })
    const html = renderToStaticMarkup(<GitStatusPanel />)
    expect(html).toContain('[check]')
    expect(html).toContain('[minus]')
  })

  it('shows additions in green and deletions in red', () => {
    const { container } = render(<GitStatusPanel />)
    expect(container.querySelector('.text-accent-success')).toHaveTextContent('+10')
    expect(container.querySelector('.text-accent-error')).toHaveTextContent('-2')
  })

  it('renders the commit button with the staged count and a stage-all button', () => {
    const html = renderToStaticMarkup(<GitStatusPanel />)
    expect(html).toContain('Commit')
    expect(html).toContain('[plus]')
  })

  it('hides the stage-all button when every file is already staged', () => {
    mockGitStatus({ files: [files[0]!] })
    const html = renderToStaticMarkup(<GitStatusPanel />)
    expect(html).not.toContain('[plus]')
  })

  it('opens the commit panel showing the message, generate, commit, push and pull', () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(screen.getByTestId('commit-panel')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Commit message…')).toBeInTheDocument()
    expect(screen.getByLabelText('Generate commit message')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '[commit]Commit' })).toBeInTheDocument()
    expect(screen.getByLabelText('Push')).toBeInTheDocument()
    expect(screen.getByLabelText('Pull')).toBeInTheDocument()
  })

  it('closes the commit panel on Escape', () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(screen.getByTestId('commit-panel')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('commit-panel')).not.toBeInTheDocument()
  })

  it('closes the commit panel on an outside click', () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(screen.getByTestId('commit-panel')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('commit-panel')).not.toBeInTheDocument()
  })
})

/* ------------------------------------------------------------------ */
/*  Interactions                                                      */
/* ------------------------------------------------------------------ */

describe('GitStatusPanel — git operations', () => {
  it('stages an unstaged file when its checkbox is clicked', async () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByLabelText('Stage src/b.ts'))
    await vi.waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/git/stage',
        expect.objectContaining({
          body: JSON.stringify({ workdir: '/tmp/proj', paths: ['src/b.ts'] }),
        }),
      )
    })
  })

  it('unstages a staged file when its checkbox is clicked', async () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByLabelText('Unstage src/a.ts'))
    await vi.waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/git/unstage',
        expect.objectContaining({
          body: JSON.stringify({ workdir: '/tmp/proj', paths: ['src/a.ts'] }),
        }),
      )
    })
  })

  it('stages every unstaged and untracked file in one call', async () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByLabelText('Stage all changes'))
    await vi.waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/git/stage',
        expect.objectContaining({
          body: JSON.stringify({ workdir: '/tmp/proj', paths: ['src/b.ts', 'src/c.ts'] }),
        }),
      )
    })
  })

  it('resizes the file list within its bounds when the handle is dragged', () => {
    render(<GitStatusPanel />)
    const list = screen.getByTestId('git-list')
    expect(list).toHaveStyle({ height: '150px' })

    const handle = screen.getByTestId('git-list-resize')
    fireEvent.pointerDown(handle, { clientY: 200 })
    // Drag down shrinks the list; clamped at the 100px minimum.
    fireEvent.pointerMove(window, { clientY: 250 })
    expect(list).toHaveStyle({ height: '100px' })

    // Drag far up grows the list; clamped at 60% of the viewport.
    fireEvent.pointerMove(window, { clientY: -500 })
    expect(list).toHaveStyle({ height: `${Math.round(window.innerHeight * 0.6)}px` })

    fireEvent.pointerUp(window)
  })

  it('discards a file after confirming the dialog', async () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByLabelText('Discard changes in src/c.ts'))
    expect(screen.getByTestId('confirm-modal')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('confirm-discard'))
    await vi.waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/git/discard',
        expect.objectContaining({
          body: JSON.stringify({ workdir: '/tmp/proj', paths: ['src/c.ts'] }),
        }),
      )
    })
  })

  it('does not discard when the dialog is closed', async () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByLabelText('Discard changes in src/c.ts'))
    fireEvent.click(screen.getByLabelText('cancel-discard'))
    expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument()
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it('commits with the entered message', async () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    fireEvent.change(screen.getByPlaceholderText('Commit message…'), { target: { value: 'my commit' } })
    fireEvent.click(screen.getByRole('button', { name: '[commit]Commit' }))
    await vi.waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/git/commit',
        expect.objectContaining({
          body: JSON.stringify({ workdir: '/tmp/proj', message: 'my commit' }),
        }),
      )
    })
  })

  it('closes the commit panel and clears the message after a successful commit', async () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    fireEvent.change(screen.getByPlaceholderText('Commit message…'), { target: { value: 'my commit' } })
    fireEvent.click(screen.getByRole('button', { name: '[commit]Commit' }))
    await vi.waitFor(() => {
      expect(screen.queryByTestId('commit-panel')).not.toBeInTheDocument()
    })
  })

  it('disables the commit button with an empty message', () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(screen.getByRole('button', { name: '[commit]Commit' })).toBeDisabled()
  })

  it('disables the commit trigger when nothing is staged', () => {
    mockGitStatus({ files: files.filter((f) => !f.staged) })
    render(<GitStatusPanel />)
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
  })

  it('disables commit and generate when nothing is staged', () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(screen.getByRole('button', { name: '[commit]Commit' })).toBeDisabled()
  })

  it('generates a commit message and fills the textarea', async () => {
    mockAuthFetch.mockImplementation(async (url: string) => {
      if (url === '/api/git/commit-message') {
        return { ok: true, json: async () => ({ success: true, message: 'feat: auto' }) }
      }
      return { ok: true, json: async () => ({ success: true, output: '' }) }
    })
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    fireEvent.click(screen.getByLabelText('Generate commit message'))
    await vi.waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/git/commit-message',
        expect.objectContaining({
          body: JSON.stringify({ workdir: '/tmp/proj' }),
        }),
      )
    })
    await vi.waitFor(() => {
      expect(screen.getByPlaceholderText('Commit message…')).toHaveValue('feat: auto')
    })
  })

  it('pushes and pulls on demand', async () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    fireEvent.click(screen.getByLabelText('Push'))
    await vi.waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/git/push', expect.objectContaining({ method: 'POST' }))
    })
    await act(async () => {})
    fireEvent.click(screen.getByLabelText('Pull'))
    await vi.waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/git/pull', expect.objectContaining({ method: 'POST' }))
    })
  })

  it('disables pull when the branch has no upstream but keeps push enabled', () => {
    mockGitStatus({ sync: null })
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(screen.getByLabelText('Push')).not.toBeDisabled()
    expect(screen.getByLabelText('Pull')).toBeDisabled()
  })

  it('shows the server error message on failure', async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ success: false, error: 'boom' }) })
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    fireEvent.click(screen.getByLabelText('Push'))
    await vi.waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument()
    })
  })

  it('shows a success message after a successful commit', async () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    fireEvent.change(screen.getByPlaceholderText('Commit message…'), { target: { value: 'msg' } })
    fireEvent.click(screen.getByRole('button', { name: '[commit]Commit' }))
    await vi.waitFor(() => {
      expect(screen.queryByText('Committed')).not.toBeInTheDocument()
    })
  })
})

/* ------------------------------------------------------------------ */
/*  Diff modal                                                        */
/* ------------------------------------------------------------------ */

describe('GitStatusPanel — diff modal', () => {
  it('opens the diff modal in the staged view for a staged file', () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByText('src/a.ts'))
    expect(screen.getByTestId('diff-modal')).toBeInTheDocument()
    expect(diffModalProps.path).toBe('src/a.ts')
    expect(diffModalProps.staged).toBe(true)
  })

  it('opens the diff modal in the unstaged view for an unstaged file', () => {
    render(<GitStatusPanel />)
    fireEvent.click(screen.getByText('src/b.ts'))
    expect(diffModalProps.path).toBe('src/b.ts')
    expect(diffModalProps.staged).toBe(false)
  })

  it('opens the staged view for the staged copy of a mixed file', () => {
    mockGitStatus({
      files: [
        {
          path: 'src/a.ts',
          status: 'modified',
          staged: true,
          unstaged: true,
          untracked: false,
          additions: 1,
          deletions: 1,
        },
      ],
    })
    render(<GitStatusPanel />)
    const entries = screen.getAllByText('src/a.ts')
    fireEvent.click(entries[0]!)
    expect(diffModalProps.staged).toBe(true)
    fireEvent.click(entries[1]!)
    expect(diffModalProps.staged).toBe(false)
  })
})
