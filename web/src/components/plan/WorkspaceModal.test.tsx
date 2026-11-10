// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { authFetch } from '../../lib/api'
import type { Mock } from 'vitest'
import { WorkspaceModal } from './WorkspaceModal'
import type { WorkspaceInfo } from '../../lib/resources'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const mockRefresh = vi.fn() as Mock

vi.mock('../../lib/resources', () => ({
  workspacesResource: {
    refresh: () => mockRefresh(),
  },
}))

vi.mock('../../hooks/useSessionModalState', () => ({
  useSessionModalState: () => ({
    t: (arg: { en: string; fr: string }, params?: Record<string, string>) =>
      arg.en.replace(/{{(\w+)}}/g, (_, k: string) => params?.[k] ?? ''),
    refreshSession: vi.fn(),
    busy: false,
    setBusy: vi.fn(),
    error: null,
    setError: vi.fn(),
    loading: false,
    setLoading: vi.fn(),
    newName: '',
    setNewName: vi.fn(),
    handleClose: vi.fn(),
    canCreate: true,
    resetState: vi.fn(),
  }),
}))

vi.mock('../../hooks/useUpstreamSync', () => ({
  toSync: () => null,
}))

vi.mock('../../lib/api', () => ({
  authFetch: vi.fn(),
}))

vi.mock('../shared/ModalShell', () => ({
  ModalShell: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}))

vi.mock('../shared/ScrollArea', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../shared/CreateInputSection', () => ({
  CreateInputSection: () => null,
}))

vi.mock('../shared/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />,
}))

vi.mock('../shared/icons', () => ({
  FolderIcon: () => '[folder]',
}))

vi.mock('./SyncBadge', () => ({
  SyncBadge: () => null,
}))

vi.mock('wouter', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function renderModal(workspaces: WorkspaceInfo[]) {
  mockRefresh.mockResolvedValue({ workspaces, main: null })
  render(
    <WorkspaceModal
      isOpen
      onClose={() => {}}
      projectId="p1"
      sessionId="s1"
      currentWorkspace={null}
      currentBranch="main"
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(cleanup)

/* ------------------------------------------------------------------ */
/*  Setup status indicators                                           */
/* ------------------------------------------------------------------ */

describe('WorkspaceModal — setup status', () => {
  const base: WorkspaceInfo = {
    name: 'ws',
    path: '/tmp/ws',
    branch: null,
    ahead: null,
    behind: null,
    setupStatus: null,
    setupError: null,
  }

  it('shows a spinner and "installing…" for a workspace with a running setup', async () => {
    renderModal([{ ...base, name: 'ws-a', path: '/tmp/ws-a', setupStatus: 'running' }])
    expect(await screen.findByText('installing…')).toBeInTheDocument()
    expect(screen.getByTestId('spinner')).toBeInTheDocument()
  })

  it('shows "setup failed" for a workspace with a failed setup', async () => {
    renderModal([{ ...base, name: 'ws-b', path: '/tmp/ws-b', setupStatus: 'error' }])
    expect(await screen.findByText('setup failed')).toBeInTheDocument()
  })

  it('shows no setup indicator when all setups are done', async () => {
    renderModal([{ ...base, name: 'ws-c', path: '/tmp/ws-c', setupStatus: 'done' }])
    expect(await screen.findByText('ws-c')).toBeInTheDocument()
    expect(screen.queryByText('installing…')).not.toBeInTheDocument()
    expect(screen.queryByText('setup failed')).not.toBeInTheDocument()
  })

  it('shows the setup error as a tooltip on the failed badge', async () => {
    renderModal([{ ...base, name: 'ws-e', path: '/tmp/ws-e', setupStatus: 'error', setupError: 'npm ERR! boom' }])
    const badge = await screen.findByText('setup failed')
    expect(badge).toHaveAttribute('title', 'npm ERR! boom')
  })

  it('shows a retry button for a failed setup and calls the retry endpoint on click', async () => {
    vi.mocked(authFetch).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as any)
    renderModal([{ ...base, name: 'ws-d', path: '/tmp/ws-d', setupStatus: 'error', setupError: 'npm ERR! boom' }])
    const retry = await screen.findByTitle('Retry setup')
    fireEvent.click(retry)
    expect(authFetch).toHaveBeenCalledWith('/api/projects/p1/workspaces/ws-d/retry-setup', {
      method: 'POST',
    })
  })
})
