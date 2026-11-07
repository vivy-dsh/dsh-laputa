import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import type { Config as ConfigShape } from '../src/index.ts'
import { DEFAULT_MAX_PERSONA_CHARS, DEFAULT_MAX_SOURCE_BYTES } from '../src/domain.ts'

const base = {} as Partial<ConfigShape>

describe('config defaults', () => {
  it('is disabled by default', () => {
    expect(Config(base as never).enabled).toBe(false)
  })

  it('defaults the persona id', () => {
    expect(Config(base as never).personaId).toBe('default')
  })

  it('leaves sourceDir unset so the plugin uses DSH_HOME', () => {
    expect(Config(base as never).sourceDir).toBeUndefined()
  })

  it('defaults the per-file byte cap', () => {
    expect(Config(base as never).maxSourceBytes).toBe(65536)
    expect(Config(base as never).maxSourceBytes).toBe(DEFAULT_MAX_SOURCE_BYTES)
  })

  it('defaults the assembled character cap', () => {
    expect(Config(base as never).maxPersonaChars).toBe(24000)
    expect(Config(base as never).maxPersonaChars).toBe(DEFAULT_MAX_PERSONA_CHARS)
  })

  it('accepts a partial override for the profile patch', () => {
    const config = Config({ enabled: true, personaId: 'vivy' } as never)
    expect(config.enabled).toBe(true)
    expect(config.personaId).toBe('vivy')
    expect(config.maxPersonaChars).toBe(DEFAULT_MAX_PERSONA_CHARS)
  })

  it('accepts an absolute sourceDir and explicit limits', () => {
    const config = Config({
      sourceDir: '/srv/personas/vivy',
      maxSourceBytes: 1024,
      maxPersonaChars: 4096,
    } as never)
    expect(config.sourceDir).toBe('/srv/personas/vivy')
    expect(config.maxSourceBytes).toBe(1024)
    expect(config.maxPersonaChars).toBe(4096)
  })

  it('rejects non-positive limits', () => {
    expect(() => Config({ maxSourceBytes: 0 } as never)).toThrow()
    expect(() => Config({ maxPersonaChars: 0 } as never)).toThrow()
  })

  it('rejects fractional limits', () => {
    expect(() => Config({ maxSourceBytes: 1.5 } as never)).toThrow()
    expect(() => Config({ maxPersonaChars: 1.5 } as never)).toThrow()
  })

  it('rejects a non-boolean enabled flag', () => {
    expect(() => Config({ enabled: 'yes' } as never)).toThrow()
  })

  it('defaults retainRevisions to 0 and accepts non-negative integers', () => {
    expect(Config(base as never)).toMatchObject({ retainRevisions: 0 })
    expect(Config({ retainRevisions: 5 } as never)).toMatchObject({ retainRevisions: 5 })
    expect(() => Config({ retainRevisions: -1 } as never)).toThrow()
    expect(() => Config({ retainRevisions: 1.5 } as never)).toThrow()
  })
})
