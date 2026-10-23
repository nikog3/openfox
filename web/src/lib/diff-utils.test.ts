import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff, pairSplitRows, getSplitChangeGroups, inlineDiff } from './diff-utils'

describe('parseUnifiedDiff', () => {
  it('parses hunk headers into old/new line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1234..5678 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,3 +10,4 @@',
      ' line1',
      '-old line',
      '+new line',
      '+extra line',
      ' line2',
      '',
    ].join('\n')

    const rows = parseUnifiedDiff(diff)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toEqual({ type: 'context', oldLine: 10, newLine: 10, content: 'line1' })
    expect(rows[1]).toEqual({ type: 'removed', oldLine: 11, newLine: null, content: 'old line' })
    expect(rows[2]).toEqual({ type: 'added', oldLine: null, newLine: 11, content: 'new line' })
    expect(rows[3]).toEqual({ type: 'added', oldLine: null, newLine: 12, content: 'extra line' })
    expect(rows[4]).toEqual({ type: 'context', oldLine: 12, newLine: 13, content: 'line2' })
  })

  it('tracks line numbers across multiple hunks', () => {
    const diff = ['@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -20,2 +20,2 @@', ' x', '-y', '+Y'].join('\n')
    const rows = parseUnifiedDiff(diff)
    expect(rows[3]).toEqual({ type: 'context', oldLine: 20, newLine: 20, content: 'x' })
    expect(rows[4]).toEqual({ type: 'removed', oldLine: 21, newLine: null, content: 'y' })
    expect(rows[5]).toEqual({ type: 'added', oldLine: null, newLine: 21, content: 'Y' })
  })

  it('handles hunks without counts', () => {
    const diff = ['@@ -5 +5 @@', '-a', '+b'].join('\n')
    const rows = parseUnifiedDiff(diff)
    expect(rows[0]).toEqual({ type: 'removed', oldLine: 5, newLine: null, content: 'a' })
    expect(rows[1]).toEqual({ type: 'added', oldLine: null, newLine: 5, content: 'b' })
  })

  it('skips no-newline markers and returns empty for empty input', () => {
    const rows = parseUnifiedDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n')
    expect(rows).toHaveLength(2)
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('pairSplitRows', () => {
  it('pairs context rows to both sides', () => {
    const rows = parseUnifiedDiff('@@ -1,2 +1,2 @@\n a\n b')
    const paired = pairSplitRows(rows)
    expect(paired).toEqual([
      { old: expect.objectContaining({ content: 'a' }), new: expect.objectContaining({ content: 'a' }) },
      { old: expect.objectContaining({ content: 'b' }), new: expect.objectContaining({ content: 'b' }) },
    ])
  })

  it('pairs a removed line with an added line', () => {
    const rows = parseUnifiedDiff('@@ -1 +1 @@\n-old\n+new')
    const paired = pairSplitRows(rows)
    expect(paired).toHaveLength(1)
    expect(paired[0]?.old?.content).toBe('old')
    expect(paired[0]?.new?.content).toBe('new')
  })

  it('fills empty cells when one side has more lines', () => {
    const rows = parseUnifiedDiff('@@ -1,3 +1,1 @@\n-a\n-b\n-c\n+d')
    const paired = pairSplitRows(rows)
    expect(paired).toHaveLength(3)
    expect(paired[0]?.old?.content).toBe('a')
    expect(paired[0]?.new?.content).toBe('d')
    expect(paired[1]?.old?.content).toBe('b')
    expect(paired[1]?.new).toBeNull()
    expect(paired[2]?.old?.content).toBe('c')
    expect(paired[2]?.new).toBeNull()
  })
})

describe('getSplitChangeGroups', () => {
  it('groups consecutive non-context split rows', () => {
    const split = pairSplitRows(parseUnifiedDiff(['@@ -1,5 +1,5 @@', ' a', '-b1', '+c1', ' d', '-e', ' f'].join('\n')))
    expect(getSplitChangeGroups(split)).toEqual([
      { startRow: 1, endRow: 2 },
      { startRow: 3, endRow: 4 },
    ])
  })

  it('returns an empty list when nothing changed', () => {
    const split = pairSplitRows(parseUnifiedDiff('@@ -1 +1 @@\n a'))
    expect(getSplitChangeGroups(split)).toEqual([])
  })
})

describe('inlineDiff', () => {
  it('returns no ranges for identical strings', () => {
    expect(inlineDiff('abc', 'abc')).toEqual({ oldRanges: [], newRanges: [] })
  })

  it('finds the changed character ranges', () => {
    const result = inlineDiff('foo bar', 'foo baz')
    expect(result.oldRanges).toEqual([{ start: 6, end: 7 }])
    expect(result.newRanges).toEqual([{ start: 6, end: 7 }])
  })

  it('handles insertions and deletions', () => {
    const inserted = inlineDiff('abc', 'abXc')
    expect(inserted.oldRanges).toEqual([])
    expect(inserted.newRanges).toEqual([{ start: 2, end: 3 }])

    const deleted = inlineDiff('abXc', 'abc')
    expect(deleted.oldRanges).toEqual([{ start: 2, end: 3 }])
    expect(deleted.newRanges).toEqual([])
  })

  it('falls back to full-line ranges for very long lines', () => {
    const long = 'x'.repeat(500)
    const result = inlineDiff(long, long + 'y')
    expect(result.oldRanges).toEqual([{ start: 0, end: 500 }])
    expect(result.newRanges).toEqual([{ start: 0, end: 501 }])
  })
})
