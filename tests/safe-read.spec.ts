import { chmodSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PersonaError } from '../src/domain.ts'
import { decodeUtf8, readPersonaDirectory, safeRead } from '../src/safe-read.ts'
import { removeDir, tempDir } from './helpers.ts'

const POSIX = process.platform !== 'win32'
const dirs: string[] = []

function dir(): string {
  const value = tempDir()
  dirs.push(value)
  return value
}

afterEach(() => {
  while (dirs.length > 0) removeDir(dirs.pop() as string)
})

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaError)
    return (error as PersonaError).code
  }
  throw new Error('expected a PersonaError')
}

describe('safe persona reads', () => {
  it('reads a regular file and returns its digest', () => {
    const root = dir()
    const file = join(root, 'MISSION.MD')
    writeFileSync(file, 'hello', { mode: 0o600 })
    chmodSync(file, 0o600)
    const result = safeRead(file, 100, false)
    expect(result.bytes.toString('utf8')).toBe('hello')
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns empty bytes for an absent optional file', () => {
    const root = dir()
    const result = safeRead(join(root, 'DREAM.MD'), 100, true)
    expect(result.bytes.length).toBe(0)
  })

  it('rejects an absent required file', () => {
    const root = dir()
    expect(codeOf(() => safeRead(join(root, 'MISSION.MD'), 100, false))).toBe('required_file_missing')
  })

  it('rejects a symlink', () => {
    if (!POSIX) return
    const root = dir()
    const target = join(root, 'target.MD')
    const link = join(root, 'MISSION.MD')
    writeFileSync(target, 'x', { mode: 0o600 })
    symlinkSync(target, link)
    expect(codeOf(() => safeRead(link, 100, false))).toBe('symlink_not_supported')
  })

  it('rejects a hardlinked file', () => {
    if (!POSIX) return
    const root = dir()
    const first = join(root, 'first.MD')
    const second = join(root, 'second.MD')
    writeFileSync(first, 'x', { mode: 0o600 })
    chmodSync(first, 0o600)
    linkSync(first, second)
    expect(codeOf(() => safeRead(second, 100, false))).toBe('not_an_unaliased_regular_file')
  })

  it('rejects a non-regular file', () => {
    const root = dir()
    mkdirSync(join(root, 'MISSION.MD'))
    expect(codeOf(() => safeRead(join(root, 'MISSION.MD'), 100, false))).toBe('not_an_unaliased_regular_file')
  })

  it('rejects a world-writable file', () => {
    if (!POSIX) return
    const root = dir()
    const file = join(root, 'MISSION.MD')
    writeFileSync(file, 'x', { mode: 0o600 })
    chmodSync(file, 0o666)
    expect(codeOf(() => safeRead(file, 100, false))).toBe('world_writable_file_refused')
  })

  it('rejects a file over the byte cap', () => {
    const root = dir()
    const file = join(root, 'MISSION.MD')
    writeFileSync(file, 'x'.repeat(11), { mode: 0o600 })
    chmodSync(file, 0o600)
    expect(codeOf(() => safeRead(file, 10, false))).toBe('source_byte_budget_exceeded')
  })

  it('rejects invalid UTF-8', () => {
    const root = dir()
    const file = join(root, 'MISSION.MD')
    writeFileSync(file, Buffer.from([0xc3, 0x28]), { mode: 0o600 })
    chmodSync(file, 0o600)
    expect(codeOf(() => safeRead(file, 100, false))).toBe('invalid_utf8')
  })
})

describe('persona directory checks', () => {
  it('resolves a real directory', () => {
    const root = dir()
    expect(readPersonaDirectory(root)).toMatch(/[\\/]/)
  })

  it('rejects a missing directory', () => {
    const root = dir()
    expect(codeOf(() => readPersonaDirectory(join(root, 'missing')))).toBe('persona_directory_missing')
  })

  it('rejects a path that is not a directory', () => {
    const root = dir()
    const file = join(root, 'file')
    writeFileSync(file, 'x', { mode: 0o600 })
    expect(codeOf(() => readPersonaDirectory(file))).toBe('persona_directory_missing')
  })

  it('rejects a symlinked directory', () => {
    if (!POSIX) return
    const root = dir()
    const target = join(root, 'real')
    const link = join(root, 'link')
    mkdirSync(target)
    symlinkSync(target, link)
    expect(codeOf(() => readPersonaDirectory(link))).toBe('symlink_not_supported')
  })

  it('rejects a world-writable directory', () => {
    if (!POSIX) return
    const root = dir()
    chmodSync(root, 0o777)
    expect(codeOf(() => readPersonaDirectory(root))).toBe('world_writable_file_refused')
  })
})

describe('strict UTF-8 decoding', () => {
  it('decodes valid text', () => {
    expect(decodeUtf8(Buffer.from('人格'), 'label')).toBe('人格')
  })

  it('reports invalid bytes', () => {
    expect(codeOf(() => decodeUtf8(Buffer.from([0xff]), 'label'))).toBe('invalid_utf8')
  })
})
