import { describe, it, expect } from 'vitest'
import { resolveSafePath } from './safe-path.js'

describe('resolveSafePath', () => {
  const cwd = process.platform === 'win32' ? 'C:\\proj' : '/home/user/proj'

  it('resolves a simple relative path inside the workdir', () => {
    expect(resolveSafePath(cwd, 'src/a.ts')).not.toBeNull()
  })

  it('resolves a nested relative path', () => {
    const resolved = resolveSafePath(cwd, 'src/nested/b.ts')
    expect(resolved).not.toBeNull()
    expect(resolved!.startsWith(cwd)).toBe(true)
  })

  it('rejects parent-directory traversal', () => {
    expect(resolveSafePath(cwd, '../outside.txt')).toBeNull()
  })

  it('rejects traversal hidden in a nested path', () => {
    expect(resolveSafePath(cwd, 'a/../../outside.txt')).toBeNull()
  })

  it('rejects absolute POSIX paths on posix', () => {
    if (process.platform === 'win32') return
    expect(resolveSafePath(cwd, '/etc/passwd')).toBeNull()
  })

  it('rejects absolute Windows paths on win32', () => {
    if (process.platform !== 'win32') return
    expect(resolveSafePath(cwd, 'C:\\evil\\file.txt')).toBeNull()
  })

  it('rejects empty and NUL-containing paths', () => {
    expect(resolveSafePath(cwd, '')).toBeNull()
    expect(resolveSafePath(cwd, 'a\0b.txt')).toBeNull()
  })
})
