import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePersonaBinding } from '../src/binding.ts'
import { PersonaError } from '../src/domain.ts'
import { replacePersonaFile } from '../src/write.ts'
import { removeDir, tempDir, writePersona } from './helpers.ts'

const POSIX = process.platform !== 'win32'
const LIMITS = { maxSourceBytes: 1024, maxPersonaChars: 4096 }
const dirs: string[] = []

function newFixture() {
  const root = tempDir()
  dirs.push(root)
  const directory = join(root, 'persona')
  writePersona(directory)
  const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: directory })
  return { root, directory, binding }
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function current(directory: string, name: string): string {
  return readFileSync(join(directory, name), 'utf8')
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaError)
    return (error as PersonaError).code
  }
  throw new Error('expected a PersonaError')
}

function tempLeftovers(directory: string): string[] {
  return readdirSync(directory).filter(name => name.endsWith('.tmp'))
}

afterEach(() => {
  while (dirs.length > 0) removeDir(dirs.pop() as string)
})

describe('panel file replacement', () => {
  it('replaces one file and preserves the others', () => {
    const { directory, binding } = newFixture()
    const previous = current(directory, 'RELATIONSHIP.MD')
    const result = replacePersonaFile(binding, 'RELATIONSHIP.MD', 'peer, not servant\n', digest(previous), LIMITS)
    expect(result.name).toBe('RELATIONSHIP.MD')
    expect(result.initialized).toBe(true)
    expect(result.bytes).toBe(18)
    expect(result.digest).toBe(digest('peer, not servant\n'))
    expect(current(directory, 'RELATIONSHIP.MD')).toBe('peer, not servant\n')
    expect(current(directory, 'MISSION.MD')).toBe('mission')
    expect(current(directory, 'IDENTITY.MD')).toBe('identity')
    expect(tempLeftovers(directory)).toEqual([])
    if (POSIX) {
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(join(directory, 'RELATIONSHIP.MD')).mode & 0o777).toBe(0o600)
    }
  })

  it('creates a missing directory and file', () => {
    const root = tempDir()
    dirs.push(root)
    const directory = join(root, 'persona')
    const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: directory })
    const result = replacePersonaFile(binding, 'IDENTITY.MD', 'a calm guide\n', digest(''), LIMITS)
    expect(result.initialized).toBe(false)
    expect(result.pending).toEqual(['MISSION.MD', 'RELATIONSHIP.MD', 'REDLINE.MD', 'DREAM.MD', 'DARK.MD'])
    expect(current(directory, 'IDENTITY.MD')).toBe('a calm guide\n')
    if (POSIX) {
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(join(directory, 'IDENTITY.MD')).mode & 0o777).toBe(0o600)
    }
  })

  it('allows blanking a core file and reports the uninitialized state', () => {
    const { directory, binding } = newFixture()
    const result = replacePersonaFile(binding, 'IDENTITY.MD', '', digest(current(directory, 'IDENTITY.MD')), LIMITS)
    expect(result.initialized).toBe(false)
    expect(result.pending).toContain('IDENTITY.MD')
    expect(current(directory, 'IDENTITY.MD')).toBe('')
  })

  it('refuses a stale digest without touching the file', () => {
    const { directory, binding } = newFixture()
    const previous = current(directory, 'IDENTITY.MD')
    expect(codeOf(() => replacePersonaFile(binding, 'IDENTITY.MD', 'new\n', digest('stale'), LIMITS)))
      .toBe('persona_file_changed')
    expect(current(directory, 'IDENTITY.MD')).toBe(previous)
    expect(tempLeftovers(directory)).toEqual([])
  })

  it('enforces the per-file byte cap', () => {
    const { directory, binding } = newFixture()
    expect(codeOf(() => replacePersonaFile(
      binding,
      'RELATIONSHIP.MD',
      'x'.repeat(20),
      digest(current(directory, 'RELATIONSHIP.MD')),
      { maxSourceBytes: 10, maxPersonaChars: 4096 },
    ))).toBe('source_byte_budget_exceeded')
    expect(current(directory, 'RELATIONSHIP.MD')).toBe('relationship')
  })

  it('enforces the total character budget even while uninitialized', () => {
    const { directory, binding } = newFixture()
    const accepted = replacePersonaFile(binding, 'IDENTITY.MD', '', digest(current(directory, 'IDENTITY.MD')), LIMITS)
    expect(accepted.initialized).toBe(false)
    expect(codeOf(() => replacePersonaFile(
      binding,
      'MISSION.MD',
      'y'.repeat(30),
      digest(current(directory, 'MISSION.MD')),
      { maxSourceBytes: 1024, maxPersonaChars: 10 },
    ))).toBe('persona_character_budget_exceeded')
  })

  it('refuses unknown file names', () => {
    const { binding } = newFixture()
    expect(codeOf(() => replacePersonaFile(binding, '../escape', 'x', digest(''), LIMITS)))
      .toBe('unknown_persona_file')
  })

  it('refuses a symlinked directory', { skip: !POSIX }, () => {
    const root = tempDir()
    dirs.push(root)
    const real = join(root, 'real')
    writePersona(real)
    const link = join(root, 'link')
    symlinkSync(real, link)
    const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: link }, { inspect: false })
    expect(codeOf(() => replacePersonaFile(binding, 'IDENTITY.MD', 'x', digest('identity'), LIMITS)))
      .toBe('symlink_not_supported')
  })

  it('refuses a symlinked file', { skip: !POSIX }, () => {
    const { directory, binding } = newFixture()
    renameSync(join(directory, 'IDENTITY.MD'), join(directory, 'elsewhere'))
    symlinkSync(join(directory, 'elsewhere'), join(directory, 'IDENTITY.MD'))
    expect(codeOf(() => replacePersonaFile(binding, 'IDENTITY.MD', 'x', digest('identity'), LIMITS)))
      .toBe('symlink_not_supported')
    expect(tempLeftovers(directory)).toEqual([])
  })

  it('refuses a non-regular file', () => {
    const { directory, binding } = newFixture()
    unlinkSync(join(directory, 'IDENTITY.MD'))
    mkdirSync(join(directory, 'IDENTITY.MD'))
    expect(codeOf(() => replacePersonaFile(binding, 'IDENTITY.MD', 'x', digest('identity'), LIMITS)))
      .toBe('not_an_unaliased_regular_file')
  })

  it('refuses a world-writable file', { skip: !POSIX }, () => {
    const { directory, binding } = newFixture()
    chmodSync(join(directory, 'IDENTITY.MD'), 0o666)
    expect(codeOf(() => replacePersonaFile(binding, 'IDENTITY.MD', 'x', digest('identity'), LIMITS)))
      .toBe('world_writable_file_refused')
    expect(lstatSync(join(directory, 'IDENTITY.MD')).isFile()).toBe(true)
  })
})
