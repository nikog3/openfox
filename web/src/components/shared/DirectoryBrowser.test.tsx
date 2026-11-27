// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryBrowser } from './DirectoryBrowser'

const authFetch = vi.fn()

vi.mock('../../lib/api', () => ({ authFetch: (url: string) => authFetch(url) }))

function mockListing(url: string) {
  if (url === '/api/directories?path=drives%3A') {
    return {
      current: 'drives:',
      parent: null,
      directories: [
        { name: 'C:', path: 'C:\\' },
        { name: 'D:', path: 'D:\\' },
      ],
    }
  }
  if (url === '/api/directories?path=C%3A%5C') {
    return {
      current: 'C:\\',
      parent: 'drives:',
      directories: [{ name: 'Users', path: 'C:\\Users' }],
    }
  }
  if (url === '/api/directories?path=D%3A%5C') {
    return {
      current: 'D:\\',
      parent: 'drives:',
      directories: [{ name: 'games', path: 'D:\\games' }],
    }
  }
  if (url === '/api/directories?path=C%3A%5CUsers') {
    return {
      current: 'C:\\Users',
      parent: 'C:\\',
      directories: [{ name: 'geoffrey', path: 'C:\\Users\\geoffrey' }],
    }
  }
  const current = url.includes('%2Froot%2Fchild') ? '/root/child' : '/root'
  return {
    current,
    parent: current === '/root/child' ? '/root' : '/',
    directories: current === '/root' ? [{ name: 'child', path: '/root/child' }] : [],
  }
}

describe('DirectoryBrowser', () => {
  afterEach(cleanup)

  beforeEach(() => {
    authFetch.mockReset()
    authFetch.mockImplementation(async (url: string) => ({
      json: async () => mockListing(url),
    }))
  })

  it('navigates into a folder on row click', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="/root" onSelect={onSelect} onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'child' }))

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/directories?path=%2Froot%2Fchild'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('selects a folder via the per-row Select button', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="/root" onSelect={onSelect} onClose={vi.fn()} />)

    await screen.findByText('child')

    fireEvent.click(screen.getByRole('button', { name: 'Select child' }))

    expect(onSelect).toHaveBeenCalledWith('/root/child')
  })

  it('selects the current folder via the top breadcrumb button', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="/root" onSelect={onSelect} onClose={vi.fn()} />)

    const button = await screen.findByRole('button', { name: 'Select' })
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledWith('/root')
  })

  it('navigates up to the drives level from a drive root', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="C:\" onSelect={onSelect} onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '..' }))

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/directories?path=drives%3A'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows the drives level with a This PC label and no header Select', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="drives:" onSelect={onSelect} onClose={vi.fn()} />)

    await screen.findByText('This PC')
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()
    expect(await screen.findByRole('button', { name: 'C:' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'D:' })).toBeDefined()
  })

  it('navigates into a drive from the drives level', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="drives:" onSelect={onSelect} onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'D:' }))

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/directories?path=D%3A%5C'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('selects a drive root from the drives level', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="drives:" onSelect={onSelect} onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Select D:' }))

    expect(onSelect).toHaveBeenCalledWith('D:\\')
  })

  it('navigates to the drives level via the This PC crumb at a drive root', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="C:\" onSelect={onSelect} onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'This PC' }))

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/directories?path=drives%3A'))
  })

  it('shows This PC as the first crumb below a drive root', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="C:\Users" onSelect={onSelect} onClose={vi.fn()} />)

    const thisPc = await screen.findByRole('button', { name: 'This PC' })
    const driveCrumb = screen.getByRole('button', { name: 'C:' })
    const crumbSpans = Array.from(thisPc.parentElement!.parentElement!.children)
    expect(crumbSpans[0]).toBe(thisPc.parentElement)
    expect(crumbSpans[1]).toBe(driveCrumb.parentElement)
  })

  it('navigates instead of selecting on Enter over the .. row at a drive root', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="C:\" onSelect={onSelect} onClose={vi.fn()} />)

    const parentRow = await screen.findByRole('button', { name: '..' })
    fireEvent.keyDown(parentRow, { key: 'ArrowDown' })
    fireEvent.keyDown(parentRow, { key: 'Enter' })

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/directories?path=drives%3A'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('has no This PC crumb on a unix path', async () => {
    const onSelect = vi.fn()
    render(<DirectoryBrowser initialPath="/root" onSelect={onSelect} onClose={vi.fn()} />)

    await screen.findByText('child')
    expect(screen.queryByRole('button', { name: 'This PC' })).toBeNull()
  })
})
