// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react'
import type { Mock } from 'vitest'
import { DiffModal } from './DiffModal'
import type { ReactNode } from 'react'
import type { GitDiffFile } from '../../stores/session/types'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const mockUseResourceWhen = vi.fn() as Mock
const mockWriteText = vi.fn(async () => {})
const mockAuthFetch = vi.fn() as Mock
const mockRefreshDiff = vi.fn(() => Promise.resolve(undefined)) as Mock

const DIFF = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' ctx1',
  '-old line',
  '+new line',
  ' ctx2',
  '-gone',
  ' ctx3',
].join('\n')

vi.mock('../shared/Modal', () => ({
  Modal: ({
    isOpen,
    title,
    headerRight,
    footer,
    children,
  }: {
    isOpen: boolean
    title: ReactNode
    headerRight?: ReactNode
    footer?: ReactNode
    children: ReactNode
  }) =>
    isOpen ? (
      <div role="dialog" data-testid="modal">
        <div data-testid="modal-title">{title}</div>
        {headerRight}
        {children}
        {footer}
      </div>
    ) : null,
}))

vi.mock('../../hooks/useResource', () => ({
  useResourceWhen: (...args: unknown[]) => mockUseResourceWhen(...args),
}))

vi.mock('../../lib/resources', () => ({
  gitFileDiffResource: { keyOf: () => 'git-file-diff', refresh: (...args: unknown[]) => mockRefreshDiff(...args) },
}))

vi.mock('../../lib/api', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}))

vi.mock('../../lib/syntax-highlighter', () => ({
  getLanguageFromPath: () => 'typescript',
  useShikiTheme: () => 'github-dark-default',
  highlightCode: (code: string) =>
    Promise.resolve(
      '<pre class="shiki"><code>' +
        code
          .split('\n')
          .map((line, i) => `<span class="line" data-line="${i}">${line}</span>`)
          .join('\n') +
        '</code></pre>',
    ),
}))

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { clipboard: { writeText: mockWriteText } })
  mockUseResourceWhen.mockReturnValue({ data: { diff: DIFF }, loading: false, error: undefined })
  mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
  mockRefreshDiff.mockResolvedValue({ diff: '' })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderModal() {
  return render(<DiffModal workdir="/tmp/proj" path="src/a.ts" staged={false} isOpen onClose={() => {}} />)
}

/* ------------------------------------------------------------------ */
/*  Views                                                             */
/* ------------------------------------------------------------------ */

describe('DiffModal — views', () => {
  it('renders the split view by default with both sides', () => {
    const { container } = renderModal()
    expect(screen.getByTestId('modal-title')).toHaveTextContent('src/a.ts')
    const changedRow = container.querySelector('[data-split="1"]')!
    const pres = Array.from(changedRow.querySelectorAll('pre'))
    expect(pres[0]?.textContent).toBe('old line')
    expect(pres[1]?.textContent).toBe('new line')
    expect(screen.getAllByText('ctx1')).toHaveLength(2)
    expect(container.querySelectorAll('[data-split="1"] .bg-accent-error\\/10')).toHaveLength(1)
    expect(container.querySelectorAll('[data-split="1"] .bg-accent-success\\/10')).toHaveLength(1)
  })

  it('shows line numbers on both sides of the split view', () => {
    renderModal()
    const firstSplit = screen.getAllByTestId('modal')[0]!.querySelector('[data-split="1"]')!
    const numbers = Array.from(firstSplit.querySelectorAll('span')).map((s) => s.textContent)
    expect(numbers).toContain('2')
  })

  it('applies character-level inline highlighting to changed pairs', () => {
    const { container } = renderModal()
    expect(container.innerHTML).toContain('bg-accent-primary/30')
    expect(container.innerHTML).toContain('>old</span>')
  })

  it('switches to the unified view with add/remove markers', () => {
    renderModal()
    fireEvent.click(screen.getByLabelText('Unified view'))
    expect(screen.getAllByText('+')).toHaveLength(1)
    expect(screen.getAllByText('-')).toHaveLength(2)
    expect(screen.getByText('gone')).toBeInTheDocument()
  })

  it('renders a placeholder when the diff is empty', () => {
    mockUseResourceWhen.mockReturnValue({ data: { diff: '' }, loading: false, error: undefined })
    renderModal()
    expect(screen.getByText('No changes')).toBeInTheDocument()
  })

  it('shows a spinner while loading', () => {
    mockUseResourceWhen.mockReturnValue({ data: undefined, loading: true, error: undefined })
    const { container } = renderModal()
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('shows an error when the diff fails to load', () => {
    mockUseResourceWhen.mockReturnValue({ data: undefined, loading: false, error: 'boom' })
    renderModal()
    expect(screen.getByText('Failed to load diff')).toBeInTheDocument()
  })
})

/* ------------------------------------------------------------------ */
/*  Toolbar                                                           */
/* ------------------------------------------------------------------ */

describe('DiffModal — toolbar', () => {
  it('copies the raw diff to the clipboard', async () => {
    renderModal()
    fireEvent.click(screen.getByLabelText('Copy diff'))
    await vi.waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(DIFF)
    })
    await vi.waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument()
    })
  })

  it('navigates between change groups and wraps around', () => {
    renderModal()
    const counter = () => screen.getByTestId('change-counter')
    expect(counter().textContent).toBe('0/2')
    fireEvent.click(screen.getByLabelText('Next change'))
    expect(counter().textContent).toBe('1/2')
    fireEvent.click(screen.getByLabelText('Next change'))
    expect(counter().textContent).toBe('2/2')
    fireEvent.click(screen.getByLabelText('Next change'))
    expect(counter().textContent).toBe('1/2')
    fireEvent.click(screen.getByLabelText('Previous change'))
    expect(counter().textContent).toBe('2/2')
  })

  it('navigates changes with the keyboard', () => {
    renderModal()
    const body = document.querySelector('[data-split="1"]')!.closest('div[tabindex="0"]') as HTMLElement
    fireEvent.keyDown(body, { key: 'j' })
    expect(screen.getByTestId('change-counter').textContent).toBe('1/2')
    fireEvent.keyDown(body, { key: 'k' })
    expect(screen.getByTestId('change-counter').textContent).toBe('2/2')
  })

  it('requests the staged view through the staged argument', () => {
    render(<DiffModal workdir="/tmp/proj" path="src/a.ts" staged={true} isOpen onClose={() => {}} />)
    expect(mockUseResourceWhen).toHaveBeenCalledWith(true, expect.anything(), '/tmp/proj', 'src/a.ts', true)
  })
})

/* ------------------------------------------------------------------ */
/*  File list                                                         */
/* ------------------------------------------------------------------ */

const FILES: GitDiffFile[] = [
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

describe('DiffModal — file list', () => {
  it('renders the grouped file list when files are provided', () => {
    render(<DiffModal workdir="/tmp/proj" path="src/a.ts" staged={true} isOpen onClose={() => {}} files={FILES} />)
    expect(screen.getByText('Staged')).toBeInTheDocument()
    expect(screen.getByText('Unstaged')).toBeInTheDocument()
    expect(screen.getByText('Untracked')).toBeInTheDocument()
    expect(screen.getByText('src/b.ts')).toBeInTheDocument()
    expect(screen.getByText('src/c.ts')).toBeInTheDocument()
  })

  it('switches the diff to the clicked file with its staged flag', () => {
    render(<DiffModal workdir="/tmp/proj" path="src/a.ts" staged={true} isOpen onClose={() => {}} files={FILES} />)
    fireEvent.click(screen.getByText('src/b.ts'))
    expect(mockUseResourceWhen).toHaveBeenCalledWith(true, expect.anything(), '/tmp/proj', 'src/b.ts', false)
  })

  it('highlights the active file in the list', () => {
    const { container } = render(
      <DiffModal workdir="/tmp/proj" path="src/a.ts" staged={true} isOpen onClose={() => {}} files={FILES} />,
    )
    expect(container.querySelector('[data-file="src/a.ts"]')?.className).toContain('text-text-primary')
    expect(container.querySelector('[data-file="src/b.ts"]')?.className).not.toContain('text-text-primary')
  })

  it('shows colored addition and deletion counts in the file list', () => {
    const { container } = render(
      <DiffModal workdir="/tmp/proj" path="src/a.ts" staged={true} isOpen onClose={() => {}} files={FILES} />,
    )
    expect(container.querySelector('[data-file="src/a.ts"] .text-accent-success')).toHaveTextContent('+10')
    expect(container.querySelector('[data-file="src/a.ts"] .text-accent-error')).toHaveTextContent('-2')
  })
})

/* ------------------------------------------------------------------ */
/*  Reset                                                             */
/* ------------------------------------------------------------------ */

describe('DiffModal — reset', () => {
  it('renders the reset button in the toolbar', () => {
    renderModal()
    expect(screen.getByLabelText('Reset all changes')).toBeInTheDocument()
  })

  it('opens a confirmation dialog warning that everything is reset', () => {
    renderModal()
    fireEvent.click(screen.getByLabelText('Reset all changes'))
    expect(screen.getAllByTestId('modal')).toHaveLength(2)
    expect(screen.getByText('Reset all changes?')).toBeInTheDocument()
    expect(screen.getByText(/All changes in the repository will be discarded/)).toBeInTheDocument()
    expect(screen.getByText(/untracked files are deleted/)).toBeInTheDocument()
  })

  it('posts to /api/git/restore without a path and closes the modal on confirm', async () => {
    const onClose = vi.fn()
    render(<DiffModal workdir="/tmp/proj" path="src/a.ts" staged={false} isOpen onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Reset all changes'))
    const confirmDialog = screen.getAllByTestId('modal')[1]!
    fireEvent.click(within(confirmDialog).getByText('Reset all'))
    await vi.waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/git/restore',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ workdir: '/tmp/proj' }),
        }),
      )
    })
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('shows the server error message when the restore request fails', async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'git clean failed' }) })
    const onClose = vi.fn()
    render(<DiffModal workdir="/tmp/proj" path="src/a.ts" staged={false} isOpen onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Reset all changes'))
    const confirmDialog = screen.getAllByTestId('modal')[1]!
    fireEvent.click(within(confirmDialog).getByText('Reset all'))
    await vi.waitFor(() => {
      expect(screen.getByText('git clean failed')).toBeInTheDocument()
    })
    expect(onClose).not.toHaveBeenCalled()
  })
})
