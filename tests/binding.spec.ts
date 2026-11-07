import { existsSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePersonaBinding, validatePersonaId } from '../src/binding.ts'
import { PersonaError } from '../src/domain.ts'
import { removeDir, setDshHome, tempDir, writePersona } from './helpers.ts'

const POSIX = process.platform !== 'win32'
const dirs: string[] = []
const restores: Array<() => void> = []

function dir(): string {
  const value = tempDir()
  dirs.push(value)
  return value
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
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

describe('persona ids', () => {
  it('accepts a plain name', () => {
    expect(validatePersonaId('vivy')).toBe('vivy')
  })

  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\0b'])('rejects %j', value => {
    expect(codeOf(() => validatePersonaId(value))).toBe('invalid_persona_id')
  })
})

describe('persona binding', () => {
  it('defaults to DSH_HOME/laputa/<personaId>', () => {
    const home = dir()
    restores.push(setDshHome(home))
    const target = join(home, 'laputa', 'vivy')
    writePersona(target)
    const binding = resolvePersonaBinding({ personaId: 'vivy' })
    expect(binding.personaId).toBe('vivy')
    expect(binding.directory).toMatch(/laputa[\\/]vivy$/)
    expect(binding.custom).toBe(false)
  })

  it('accepts an absolute sourceDir', () => {
    const target = dir()
    writePersona(target)
    const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: target })
    expect(binding.directory).toBe(realpathSync(target))
    expect(binding.custom).toBe(true)
  })

  it('defaults revision state to DSH_HOME/laputa/.state/<personaId>', () => {
    const home = dir()
    restores.push(setDshHome(home))
    const target = dir()
    writePersona(target)
    const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: target })
    expect(binding.stateDirectory).toBe(join(home, 'laputa', '.state', 'vivy'))
    expect(existsSync(binding.stateDirectory)).toBe(false)
  })

  it('accepts an absolute stateDir', () => {
    const target = dir()
    writePersona(target)
    const state = join(dir(), 'state')
    const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: target, stateDir: state })
    expect(binding.stateDirectory).toBe(state)
  })

  it('rejects a relative stateDir', () => {
    const target = dir()
    writePersona(target)
    expect(codeOf(() => resolvePersonaBinding({
      personaId: 'vivy',
      sourceDir: target,
      stateDir: 'state',
    }))).toBe('invalid_source_dir')
  })

  it('rejects a stateDir inside the persona directory', () => {
    const target = dir()
    writePersona(target)
    expect(codeOf(() => resolvePersonaBinding({
      personaId: 'vivy',
      sourceDir: target,
      stateDir: join(target, '.state'),
    }))).toBe('invalid_source_dir')
  })

  it('rejects a relative sourceDir', () => {
    expect(codeOf(() => resolvePersonaBinding({ personaId: 'vivy', sourceDir: 'persona' })))
      .toBe('invalid_source_dir')
  })

  it('reports a missing directory as not yet created', () => {
    const home = dir()
    restores.push(setDshHome(home))
    const binding = resolvePersonaBinding({ personaId: 'missing' })
    expect(binding.exists).toBe(false)
    expect(binding.directory).toBe(join(home, 'laputa', 'missing'))
  })

  it('skips inspection when the plugin is disabled', () => {
    const home = dir()
    restores.push(setDshHome(home))
    const root = join(home, 'laputa')
    const real = join(root, 'real')
    writePersona(real)
    symlinkSync(real, join(root, 'vivy'))
    const binding = resolvePersonaBinding({ personaId: 'vivy' }, { inspect: false })
    expect(binding.exists).toBe(false)
    expect(binding.directory).toBe(join(root, 'vivy'))
  })

  it('reports an existing directory as inspected', () => {
    const target = dir()
    writePersona(target)
    expect(resolvePersonaBinding({ personaId: 'vivy', sourceDir: target }).exists).toBe(true)
  })

  it('rejects a symlinked persona directory', () => {
    if (!POSIX) return
    const home = dir()
    restores.push(setDshHome(home))
    const root = join(home, 'laputa')
    const real = join(root, 'real')
    writePersona(real)
    symlinkSync(real, join(root, 'vivy'))
    expect(codeOf(() => resolvePersonaBinding({ personaId: 'vivy' }))).toBe('symlink_not_supported')
  })
})
