/**
 * Bounded line diff between two persona revisions.
 *
 * The panel never receives six full documents for a historical revision. It
 * asks for a manifest plus this diff, which trims unchanged prefix/suffix
 * lines, computes an LCS inside a fixed cell budget, and degrades to line
 * counts when a file or the output exceeds the limits.
 * @module dsh-laputa
 */

import { ASSEMBLY_FILES, type PersonaFile } from './domain.ts'

/** Optional limits for one diff computation. */
export interface DiffLimits {
  readonly maxSideLines?: number
  readonly maxCells?: number
  readonly context?: number
  readonly maxHunks?: number
  readonly maxOutputLines?: number
}

/** Default diff limits. */
export const DEFAULT_DIFF_LIMITS: Readonly<Required<DiffLimits>> = {
  maxSideLines: 2000,
  maxCells: 160000,
  context: 3,
  maxHunks: 50,
  maxOutputLines: 600,
}

type Limits = Required<DiffLimits>

/** One displayed diff line. */
export interface DiffLine {
  readonly kind: 'same' | 'add' | 'remove'
  readonly text: string
  readonly oldLine: number | null
  readonly newLine: number | null
}

/** One contiguous change with context. */
export interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

/** Diff of one text pair. */
export interface TextDiff {
  readonly changed: boolean
  readonly added: number
  readonly removed: number
  readonly truncated: boolean
  readonly hunks: readonly DiffHunk[]
}

/** Diff of one persona file. */
export interface FileDiff extends TextDiff {
  readonly name: PersonaFile
}

/** Diff of a whole persona between two revisions. */
export interface PersonaDiff {
  readonly from: number
  readonly to: number
  readonly files: readonly FileDiff[]
}

interface Op {
  kind: DiffLine['kind']
  text: string
  oldLine: number | null
  newLine: number | null
}

// Callers only pass indexes bounded by the array length; the casts keep the
// hot path free of impossible-branch guards.
function lineAt(lines: readonly string[], index: number): string {
  return lines[index] as string
}

function cell(table: Uint32Array, index: number): number {
  return table[index] as number
}

function resolveLimits(limits: DiffLimits): Limits {
  return { ...DEFAULT_DIFF_LIMITS, ...limits }
}

function normalize(text: string): string {
  const lf = text.replace(/\r\n/g, '\n')
  return lf.endsWith('\n') ? lf.slice(0, -1) : lf
}

function splitLines(text: string): string[] {
  const normalized = normalize(text)
  return normalized === '' ? [] : normalized.split('\n')
}

function countLineDelta(
  oldLines: readonly string[],
  newLines: readonly string[],
): { added: number; removed: number } {
  const counts = new Map<string, number>()
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) - 1)
  for (const line of newLines) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  let removed = 0
  for (const value of counts.values()) {
    if (value > 0) added += value
    else removed -= value
  }
  return { added, removed }
}

/**
 * Diff two texts by line, bounded by the supplied limits.
 * @param oldText - earlier text (the live revision in the panel).
 * @param newText - later text (the selected historical revision).
 * @param limits - optional overrides for the default budgets.
 */
export function diffText(oldText: string, newText: string, limits: DiffLimits = {}): TextDiff {
  const resolved = resolveLimits(limits)
  const oldNormalized = normalize(oldText)
  const newNormalized = normalize(newText)
  if (oldNormalized === newNormalized) {
    return { changed: false, added: 0, removed: 0, truncated: false, hunks: [] }
  }

  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  let prefix = 0
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix)
  const newMiddle = newLines.slice(prefix, newLines.length - suffix)
  if (
    oldMiddle.length > resolved.maxSideLines
    || newMiddle.length > resolved.maxSideLines
    || (oldMiddle.length + 1) * (newMiddle.length + 1) > resolved.maxCells
  ) {
    const delta = countLineDelta(oldLines, newLines)
    return {
      changed: true,
      added: delta.added,
      removed: delta.removed,
      truncated: true,
      hunks: [],
    }
  }

  const ops: Op[] = []
  for (const [index, text] of oldLines.slice(0, prefix).entries()) {
    ops.push({
      kind: 'same',
      text,
      oldLine: index + 1,
      newLine: index + 1,
    })
  }

  const width = newMiddle.length + 1
  const table = new Uint32Array((oldMiddle.length + 1) * width)
  for (let row = oldMiddle.length - 1; row >= 0; row--) {
    const oldLine = lineAt(oldMiddle, row)
    for (let column = newMiddle.length - 1; column >= 0; column--) {
      table[row * width + column] = oldLine === lineAt(newMiddle, column)
        ? cell(table, (row + 1) * width + column + 1) + 1
        : Math.max(
          cell(table, (row + 1) * width + column),
          cell(table, row * width + column + 1),
        )
    }
  }

  let added = 0
  let removed = 0
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldMiddle.length && newIndex < newMiddle.length) {
    const oldLine = lineAt(oldMiddle, oldIndex)
    const newLine = lineAt(newMiddle, newIndex)
    if (oldLine === newLine) {
      ops.push({
        kind: 'same',
        text: oldLine,
        oldLine: prefix + oldIndex + 1,
        newLine: prefix + newIndex + 1,
      })
      oldIndex++
      newIndex++
    } else if (
      cell(table, (oldIndex + 1) * width + newIndex)
      >= cell(table, oldIndex * width + newIndex + 1)
    ) {
      ops.push({
        kind: 'remove',
        text: oldLine,
        oldLine: prefix + oldIndex + 1,
        newLine: null,
      })
      removed++
      oldIndex++
    } else {
      ops.push({
        kind: 'add',
        text: newLine,
        oldLine: null,
        newLine: prefix + newIndex + 1,
      })
      added++
      newIndex++
    }
  }
  while (oldIndex < oldMiddle.length) {
    ops.push({
      kind: 'remove',
      text: lineAt(oldMiddle, oldIndex),
      oldLine: prefix + oldIndex + 1,
      newLine: null,
    })
    removed++
    oldIndex++
  }
  while (newIndex < newMiddle.length) {
    ops.push({
      kind: 'add',
      text: lineAt(newMiddle, newIndex),
      oldLine: null,
      newLine: prefix + newIndex + 1,
    })
    added++
    newIndex++
  }
  for (const [index, text] of oldLines.slice(oldLines.length - suffix).entries()) {
    ops.push({
      kind: 'same',
      text,
      oldLine: oldLines.length - suffix + index + 1,
      newLine: newLines.length - suffix + index + 1,
    })
  }

  const ranges: Array<{ start: number; end: number }> = []
  for (const [index, op] of ops.entries()) {
    if (op.kind === 'same') continue
    const start = Math.max(0, index - resolved.context)
    const end = Math.min(ops.length - 1, index + resolved.context)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
    } else {
      ranges.push({ start, end })
    }
  }

  const oldBefore = new Uint32Array(ops.length + 1)
  const newBefore = new Uint32Array(ops.length + 1)
  for (const [index, op] of ops.entries()) {
    oldBefore[index + 1] = cell(oldBefore, index) + (op.oldLine === null ? 0 : 1)
    newBefore[index + 1] = cell(newBefore, index) + (op.newLine === null ? 0 : 1)
  }

  const hunks: DiffHunk[] = []
  let truncated = false
  let outputLines = 0
  for (const range of ranges) {
    const lines = ops.slice(range.start, range.end + 1)
    if (
      hunks.length >= resolved.maxHunks
      || outputLines + lines.length > resolved.maxOutputLines
    ) {
      truncated = true
      break
    }
    hunks.push({
      oldStart: cell(oldBefore, range.start) + 1,
      oldLines: cell(oldBefore, range.end + 1) - cell(oldBefore, range.start),
      newStart: cell(newBefore, range.start) + 1,
      newLines: cell(newBefore, range.end + 1) - cell(newBefore, range.start),
      lines,
    })
    outputLines += lines.length
  }
  if (hunks.length === 0 && ranges.length > 0) truncated = true

  return { changed: true, added, removed, truncated, hunks }
}

/**
 * Diff every persona file between two revisions.
 * @param fromFiles - files of the earlier (live) revision.
 * @param toFiles - files of the later (selected) revision.
 * @param fromRevision - earlier revision number.
 * @param toRevision - later revision number.
 * @param limits - optional diff limits.
 */
export function diffPersonaFiles(
  fromFiles: Readonly<Record<PersonaFile, Buffer>>,
  toFiles: Readonly<Record<PersonaFile, Buffer>>,
  fromRevision: number,
  toRevision: number,
  limits: DiffLimits = {},
): PersonaDiff {
  const files = ASSEMBLY_FILES.map((name): FileDiff => ({
    name,
    ...diffText(fromFiles[name].toString('utf8'), toFiles[name].toString('utf8'), limits),
  }))
  return { from: fromRevision, to: toRevision, files }
}
