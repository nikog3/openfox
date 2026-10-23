export interface DiffRow {
  type: 'added' | 'removed' | 'context'
  oldLine: number | null
  newLine: number | null
  content: string
}

export interface SplitRow {
  old: DiffRow | null
  new: DiffRow | null
}

export interface ChangeGroup {
  startRow: number
  endRow: number
}

export interface InlineRange {
  start: number
  end: number
}

export interface InlineDiff {
  oldRanges: InlineRange[]
  newRanges: InlineRange[]
}

const MAX_INLINE_LEN = 400

export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('@@')) {
      const m = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m && m[1] !== undefined && m[2] !== undefined) {
        oldLine = Number(m[1])
        newLine = Number(m[2])
      }
      continue
    }
    if (
      rawLine.startsWith('diff ') ||
      rawLine.startsWith('index ') ||
      rawLine.startsWith('--- ') ||
      rawLine.startsWith('+++ ') ||
      rawLine.startsWith('\\')
    ) {
      continue
    }
    if (rawLine.startsWith('+')) {
      rows.push({ type: 'added', oldLine: null, newLine, content: rawLine.slice(1) })
      newLine++
    } else if (rawLine.startsWith('-')) {
      rows.push({ type: 'removed', oldLine, newLine: null, content: rawLine.slice(1) })
      oldLine++
    } else if (rawLine.startsWith(' ')) {
      rows.push({ type: 'context', oldLine, newLine, content: rawLine.slice(1) })
      oldLine++
      newLine++
    }
  }
  return rows
}

export function pairSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (!row) break
    if (row.type === 'context') {
      out.push({ old: row, new: row })
      i++
      continue
    }
    const removed: DiffRow[] = []
    const added: DiffRow[] = []
    while (i < rows.length && rows[i]?.type === 'removed') {
      removed.push(rows[i] as DiffRow)
      i++
    }
    while (i < rows.length && rows[i]?.type === 'added') {
      added.push(rows[i] as DiffRow)
      i++
    }
    const pairs = Math.max(removed.length, added.length)
    for (let p = 0; p < pairs; p++) {
      out.push({ old: removed[p] ?? null, new: added[p] ?? null })
    }
  }
  return out
}

export function getSplitChangeGroups(split: SplitRow[]): ChangeGroup[] {
  const groups: ChangeGroup[] = []
  let start = -1
  for (let i = 0; i < split.length; i++) {
    const row = split[i]!
    const isChange = row.old?.type !== 'context' || row.new?.type !== 'context'
    if (isChange && start === -1) start = i
    if (!isChange && start !== -1) {
      groups.push({ startRow: start, endRow: i })
      start = -1
    }
  }
  if (start !== -1) groups.push({ startRow: start, endRow: split.length })
  return groups
}

export function inlineDiff(oldStr: string, newStr: string): InlineDiff {
  if (oldStr === newStr) return { oldRanges: [], newRanges: [] }
  if (oldStr.length > MAX_INLINE_LEN || newStr.length > MAX_INLINE_LEN) {
    return {
      oldRanges: [{ start: 0, end: oldStr.length }],
      newRanges: [{ start: 0, end: newStr.length }],
    }
  }
  const n = oldStr.length
  const m = newStr.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = oldStr[i] === newStr[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const matchOld: boolean[] = new Array<boolean>(n).fill(false)
  const matchNew: boolean[] = new Array<boolean>(m).fill(false)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldStr[i] === newStr[j]) {
      matchOld[i] = true
      matchNew[j] = true
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  const toRanges = (matched: boolean[]): InlineRange[] => {
    const ranges: InlineRange[] = []
    let start = -1
    for (let k = 0; k < matched.length; k++) {
      const isMatch = matched[k] ?? false
      if (!isMatch && start === -1) start = k
      if ((isMatch || k === matched.length - 1) && start !== -1) {
        const end = isMatch ? k : k + 1
        if (end > start) ranges.push({ start, end })
        start = -1
      }
    }
    return ranges
  }
  return { oldRanges: toRanges(matchOld), newRanges: toRanges(matchNew) }
}
