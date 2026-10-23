// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import type { Mock } from 'vitest'
import { GitStatusPanel } from './GitStatusPanel'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const mockUseGitStatus = vi.fn() as Mock
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

vi.mock('../shared/ScrollArea', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../shared/icons', () => ({
  ArrowUpIcon: () => '[up]',
  ArrowDownIcon: () => '[down]',
  PencilIcon: () => '[pencil]',
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
  diffModalProps.path = undefined
  diffModalProps.staged = undefined
  mockGitStatus()
})

afterEach(cleanup)

/* ------------------------------------------------------------------ */
/*  Rendering                                                         */
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

  it('shows additions in green and deletions in red', () => {
    const { container } = render(<GitStatusPanel />)
    expect(container.querySelector('.text-accent-success')).toHaveTextContent('+10')
    expect(container.querySelector('.text-accent-error')).toHaveTextContent('-2')
  })

  it('is read-only: no commit, stage, discard, push or pull controls', () => {
    const html = renderToStaticMarkup(<GitStatusPanel />)
    expect(html).not.toContain('Commit')
    expect(html).not.toContain('[plus]')
    expect(html).not.toContain('[trash]')
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
    expect(screen.getByTestId('diff-modal')).toBeInTheDocument()
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
