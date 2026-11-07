import {
  chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePersonaBinding } from '../src/binding.ts'
import { digestPersonaFiles } from '../src/assemble.ts'
import { ASSEMBLY_FILES, PersonaError } from '../src/domain.ts'
import { initializePersona } from '../src/write.ts'
import { removeDir, setDshHome, tempDir, writePersona } from './helpers.ts'

const POSIX = process.platform !== 'win32'
const LIMITS = { maxSourceBytes: 1024, maxPersonaChars: 4096 }
const dirs: string[] = []
const restores: Array<() => void> = []

function newFixture() {
  const root = tempDir()
  dirs.push(root)
  const directory = join(root, 'persona')
  const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: directory })
  return { root, directory, binding }
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
  while (restores.length > 0) restores.pop()?.()
  while (dirs.length > 0) removeDir(dirs.pop() as string)
})

describe('create-only persona initialization', () => {
  it('creates a restricted directory and all six files', () => {
    const { directory, binding } = newFixture()
    const result = initializePersona(binding, {
      identity: 'A calm guide',
      mission: 'Help me think',
      relationship: 'Peer, not servant',
      redline: 'Never spend money',
      dream: 'Grow steadier',
      dark: 'Fear of being useless',
    }, LIMITS)
    expect(result.written).toEqual([...ASSEMBLY_FILES])
    expect(result.preserved).toEqual([])
    expect(result.pending).toEqual([])
    expect(readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')).toBe('A calm guide\n')
    expect(readFileSync(join(directory, 'MISSION.MD'), 'utf8')).toBe('Help me think\n')
    expect(readFileSync(join(directory, 'DARK.MD'), 'utf8')).toBe('Fear of being useless\n')
    expect(tempLeftovers(directory)).toEqual([])
    if (POSIX) {
      expect(statSync(realpathSync(directory)).mode & 0o777).toBe(0o700)
      for (const name of ASSEMBLY_FILES) {
        expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600)
      }
    }
  })

  it('preserves every non-empty file', () => {
    const { directory, binding } = newFixture()
    writePersona(directory)
    const result = initializePersona(binding, {
      identity: 'replacement identity',
      mission: 'replacement mission',
      relationship: 'replacement relationship',
      redline: 'replacement redline',
      dream: 'dream draft',
      dark: 'dark draft',
    }, LIMITS)
    expect(result.preserved).toEqual(['MISSION.MD', 'IDENTITY.MD', 'RELATIONSHIP.MD', 'REDLINE.MD'])
    expect(result.written).toEqual(['DREAM.MD', 'DARK.MD'])
    expect(readFileSync(join(directory, 'MISSION.MD'), 'utf8')).toBe('mission')
    expect(readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')).toBe('identity')
    expect(readFileSync(join(directory, 'DREAM.MD'), 'utf8')).toBe('dream draft\n')
  })

  it('fills blank files and leaves non-empty ones alone', () => {
    const { directory, binding } = newFixture()
    writePersona(directory, { 'IDENTITY.MD': '   \n', 'RELATIONSHIP.MD': 'mine\n' })
    const result = initializePersona(binding, {
      identity: 'new identity',
      mission: 'new mission',
    }, LIMITS)
    expect(result.written).toEqual(['IDENTITY.MD', 'DREAM.MD', 'DARK.MD'])
    expect(result.preserved).toEqual(['MISSION.MD', 'RELATIONSHIP.MD', 'REDLINE.MD'])
    expect(readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')).toBe('new identity\n')
    expect(readFileSync(join(directory, 'RELATIONSHIP.MD'), 'utf8')).toBe('mine\n')
  })

  it('writes empty files for unanswered advanced fields', () => {
    const { directory, binding } = newFixture()
    const result = initializePersona(binding, { identity: 'id', mission: 'mission' }, LIMITS)
    expect(result.written).toEqual([...ASSEMBLY_FILES])
    expect(readFileSync(join(directory, 'DREAM.MD'), 'utf8')).toBe('')
    expect(readFileSync(join(directory, 'RELATIONSHIP.MD'), 'utf8')).toBe('')
    expect(result.pending).toEqual(['RELATIONSHIP.MD', 'REDLINE.MD', 'DREAM.MD', 'DARK.MD'])
  })

  it('rejects a missing mission or identity before writing anything', () => {
    const { directory, binding } = newFixture()
    expect(codeOf(() => initializePersona(binding, {}, LIMITS))).toBe('mission_assignment_required')
    expect(readdirSync(directory)).toEqual([])
    expect(codeOf(() => initializePersona(binding, { mission: 'mission' }, LIMITS)))
      .toBe('identity_assignment_required')
    expect(readdirSync(directory)).toEqual([])
  })

  it('enforces the per-file byte cap', () => {
    const { directory, binding } = newFixture()
    expect(codeOf(() => initializePersona(binding, {
      identity: 'x'.repeat(20),
      mission: 'mission',
    }, { maxSourceBytes: 10, maxPersonaChars: 4096 }))).toBe('source_byte_budget_exceeded')
    expect(readdirSync(directory)).toEqual([])
  })

  it('enforces the total character budget', () => {
    const { directory, binding } = newFixture()
    expect(codeOf(() => initializePersona(binding, {
      identity: 'x'.repeat(20),
      mission: 'y'.repeat(20),
    }, { maxSourceBytes: 1024, maxPersonaChars: 10 }))).toBe('persona_character_budget_exceeded')
    expect(readdirSync(directory)).toEqual([])
  })

  it('creates the default layout under DSH_HOME', () => {
    const home = tempDir()
    dirs.push(home)
    restores.push(setDshHome(home))
    const binding = resolvePersonaBinding({ personaId: 'vivy' })
    expect(binding.exists).toBe(false)
    const result = initializePersona(binding, { identity: 'id', mission: 'mission' }, LIMITS)
    const directory = join(home, 'laputa', 'vivy')
    expect(result.written).toEqual([...ASSEMBLY_FILES])
    expect(readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')).toBe('id\n')
    if (POSIX) expect(statSync(directory).mode & 0o777).toBe(0o700)
  })

  it('refuses a symlinked persona directory', { skip: !POSIX }, () => {
    const root = tempDir()
    dirs.push(root)
    const real = join(root, 'real')
    writePersona(real)
    const link = join(root, 'link')
    symlinkSync(real, link)
    const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: link }, { inspect: false })
    expect(codeOf(() => initializePersona(binding, { identity: 'id', mission: 'mission' }, LIMITS)))
      .toBe('symlink_not_supported')
  })

  it('refuses a symlinked persona file', { skip: !POSIX }, () => {
    const { directory, binding } = newFixture()
    writePersona(directory)
    renameSync(join(directory, 'DREAM.MD'), join(directory, 'elsewhere'))
    symlinkSync(join(directory, 'elsewhere'), join(directory, 'DREAM.MD'))
    expect(codeOf(() => initializePersona(binding, { identity: 'id', mission: 'mission' }, LIMITS)))
      .toBe('symlink_not_supported')
    expect(tempLeftovers(directory)).toEqual([])
  })

  it('refuses a world-writable empty file', { skip: !POSIX }, () => {
    const { directory, binding } = newFixture()
    writePersona(directory)
    chmodSync(join(directory, 'IDENTITY.MD'), 0o666)
    expect(codeOf(() => initializePersona(binding, { identity: 'id', mission: 'mission' }, LIMITS)))
      .toBe('world_writable_file_refused')
  })

  it('refuses a non-regular persona file', () => {
    const { directory, binding } = newFixture()
    writePersona(directory)
    const name = 'DARK.MD'
    unlinkSync(join(directory, name))
    mkdirSync(join(directory, name))
    expect(codeOf(() => initializePersona(binding, { identity: 'id', mission: 'mission' }, LIMITS)))
      .toBe('not_an_unaliased_regular_file')
  })

  it('returns a draft digest over the final six files', () => {
    const { directory, binding } = newFixture()
    const result = initializePersona(binding, {
      identity: 'id',
      mission: 'mission',
    }, LIMITS)
    const files = Object.fromEntries(
      ASSEMBLY_FILES.map(name => [name, readFileSync(join(directory, name))]),
    )
    expect(result.draftDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.draftDigest).toBe(digestPersonaFiles(files))
    expect(tempLeftovers(directory)).toEqual([])
  })

  it('does not leave temporary files behind on success', () => {
    const { directory, binding } = newFixture()
    initializePersona(binding, { identity: 'id', mission: 'mission' }, LIMITS)
    expect(tempLeftovers(directory)).toEqual([])
    expect(lstatSync(join(directory, 'MISSION.MD')).isFile()).toBe(true)
  })
})
