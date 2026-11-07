import { describe, expect, it } from 'vitest'
import { ASSEMBLY_FILES, type PersonaFile } from '../src/domain.ts'
import { diffPersonaFiles, diffText } from '../src/diff.ts'

function personaFiles(
  overrides: Partial<Record<PersonaFile, string>> = {},
): Record<PersonaFile, Buffer> {
  const base: Record<PersonaFile, string> = {
    'MISSION.MD': 'mission',
    'IDENTITY.MD': 'identity',
    'RELATIONSHIP.MD': 'relationship',
    'REDLINE.MD': 'redline',
    'DREAM.MD': '',
    'DARK.MD': '',
  }
  const files = {} as Record<PersonaFile, Buffer>
  for (const name of ASSEMBLY_FILES) {
    files[name] = Buffer.from(overrides[name] ?? base[name], 'utf8')
  }
  return files
}

describe('text diff', () => {
  it('reports identical text without hunks', () => {
    expect(diffText('alpha\nbeta', 'alpha\nbeta')).toEqual({
      changed: false,
      added: 0,
      removed: 0,
      truncated: false,
      hunks: [],
    })
  })

  it('reports a single-line replacement with line numbers', () => {
    const result = diffText('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma')
    expect(result).toEqual({
      changed: true,
      added: 1,
      removed: 1,
      truncated: false,
      hunks: [{
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          { kind: 'same', text: 'alpha', oldLine: 1, newLine: 1 },
          { kind: 'remove', text: 'beta', oldLine: 2, newLine: null },
          { kind: 'add', text: 'BETA', oldLine: null, newLine: 2 },
          { kind: 'same', text: 'gamma', oldLine: 3, newLine: 3 },
        ],
      }],
    })
  })

  it('reports a pure insertion and a pure deletion', () => {
    const insertion = diffText('a\nb', 'a\nx\nb', { context: 0 })
    expect(insertion.hunks).toEqual([{
      oldStart: 2,
      oldLines: 0,
      newStart: 2,
      newLines: 1,
      lines: [{ kind: 'add', text: 'x', oldLine: null, newLine: 2 }],
    }])

    const deletion = diffText('a\nx\nb', 'a\nb', { context: 0 })
    expect(deletion.hunks).toEqual([{
      oldStart: 2,
      oldLines: 1,
      newStart: 2,
      newLines: 0,
      lines: [{ kind: 'remove', text: 'x', oldLine: 2, newLine: null }],
    }])
  })

  it('keeps separated changes in separate hunks', () => {
    const result = diffText(
      'a\nb\nc\nd\ne\nf\ng\nh\ni',
      'a\nB\nc\nd\ne\nf\ng\nh\nI',
      { context: 1 },
    )
    expect(result.hunks).toHaveLength(2)
    expect(result.hunks[0].lines.map(line => line.text)).toEqual(['a', 'b', 'B', 'c'])
    expect(result.hunks[1]).toMatchObject({
      oldStart: 8,
      oldLines: 2,
      newStart: 8,
      newLines: 2,
    })
    expect(result.hunks[1].lines.map(line => line.text)).toEqual(['h', 'i', 'I'])
  })

  it('ignores line-ending style and one trailing newline', () => {
    expect(diffText('alpha\r\nbeta\r\n', 'alpha\nbeta').changed).toBe(false)
    expect(diffText('a\n\n', 'a\n')).toMatchObject({
      changed: true,
      added: 0,
      removed: 1,
    })
  })

  it('handles empty text on either side', () => {
    expect(diffText('', 'x')).toMatchObject({
      changed: true,
      added: 1,
      removed: 0,
      truncated: false,
    })
    expect(diffText('x', '')).toMatchObject({
      changed: true,
      added: 0,
      removed: 1,
    })
  })

  it('falls back to counts when a side exceeds the line limit', () => {
    const result = diffText('1\n2\n3\n4\n5', '6\n7\n8\n9\n10', { maxSideLines: 3 })
    expect(result).toEqual({
      changed: true,
      added: 5,
      removed: 5,
      truncated: true,
      hunks: [],
    })
  })

  it('falls back to counts when the LCS table exceeds the cell limit', () => {
    const result = diffText('a\nb', 'c\nd', { maxCells: 4 })
    expect(result).toEqual({
      changed: true,
      added: 2,
      removed: 2,
      truncated: true,
      hunks: [],
    })
  })

  it('trims extra hunks while keeping full counts', () => {
    const result = diffText('a\nb\nc\nd\ne', 'A\nb\nC\nd\nE', {
      context: 0,
      maxHunks: 2,
    })
    expect(result.truncated).toBe(true)
    expect(result.hunks).toHaveLength(2)
    expect(result.added).toBe(3)
    expect(result.removed).toBe(3)
  })

  it('trims hunks that exceed the output line budget', () => {
    const limited = diffText('a\nb\nc\nd\ne', 'A\nb\nC\nd\nE', {
      context: 0,
      maxOutputLines: 3,
    })
    expect(limited.truncated).toBe(true)
    expect(limited.hunks).toHaveLength(1)

    const none = diffText('a\nb\nc\nd\ne', 'A\nb\nC\nd\nE', {
      context: 0,
      maxOutputLines: 1,
    })
    expect(none.truncated).toBe(true)
    expect(none.hunks).toEqual([])
  })
})

describe('persona diff', () => {
  it('covers all six files and keeps unchanged files', () => {
    const from = personaFiles()
    const to = personaFiles({ 'IDENTITY.MD': 'identity changed\n' })
    const result = diffPersonaFiles(from, to, 3, 1)

    expect(result.from).toBe(3)
    expect(result.to).toBe(1)
    expect(result.files.map(file => file.name)).toEqual([...ASSEMBLY_FILES])

    const identity = result.files.find(file => file.name === 'IDENTITY.MD')
    expect(identity).toMatchObject({
      changed: true,
      added: 1,
      removed: 1,
      truncated: false,
    })
    expect(identity?.hunks).toHaveLength(1)

    const mission = result.files.find(file => file.name === 'MISSION.MD')
    expect(mission).toMatchObject({
      changed: false,
      added: 0,
      removed: 0,
      hunks: [],
    })
  })
})
