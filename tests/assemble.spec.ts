import { describe, expect, it } from 'vitest'
import { assemblePersona, PERSONA_PROMPT_PREFIX } from '../src/assemble.ts'
import { ASSEMBLY_FILES, PersonaError } from '../src/domain.ts'

function buffers(overrides: Partial<Record<(typeof ASSEMBLY_FILES)[number], string>> = {}) {
  const values: Record<string, string> = {
    'MISSION.MD': 'mission',
    'IDENTITY.MD': 'identity',
    'RELATIONSHIP.MD': 'relationship',
    'REDLINE.MD': 'redline',
    'DREAM.MD': 'dream',
    'DARK.MD': 'dark',
    ...overrides,
  }
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, Buffer.from(value)]))
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

describe('persona assembly', () => {
  it('joins files in the fixed order with blank lines', () => {
    const result = assemblePersona(buffers())
    expect(result.body).toBe('mission\n\nidentity\n\nrelationship\n\nredline\n\ndream\n\ndark')
    expect(result.chars).toBe(result.body.length)
    expect(result.text).toBe(`${PERSONA_PROMPT_PREFIX}\n\n${result.body}`)
    expect(result.files['MISSION.MD']).toBe(7)
  })

  it('skips empty optional files', () => {
    const result = assemblePersona(buffers({ 'DREAM.MD': '', 'DARK.MD': '' }))
    expect(result.body).toBe('mission\n\nidentity\n\nrelationship\n\nredline')
  })

  it('skips an absent optional file', () => {
    const files = buffers()
    delete files['DARK.MD']
    const result = assemblePersona(files)
    expect(result.body.endsWith('dream')).toBe(true)
    expect(result.files['DARK.MD']).toBe(0)
  })

  it('requires a non-empty mission', () => {
    expect(codeOf(() => assemblePersona(buffers({ 'MISSION.MD': '' })))).toBe('mission_assignment_required')
    expect(codeOf(() => assemblePersona(buffers({ 'MISSION.MD': '   \n\t' })))).toBe('mission_assignment_required')
  })

  it('rejects a missing mission buffer', () => {
    const files = buffers()
    delete files['MISSION.MD']
    expect(codeOf(() => assemblePersona(files))).toBe('mission_assignment_required')
  })

  it('enforces the total character budget', () => {
    const result = assemblePersona(buffers({ 'IDENTITY.MD': 'x'.repeat(20) }))
    expect(() => assemblePersona(buffers({ 'IDENTITY.MD': 'x'.repeat(20) }), result.body.length - 1))
      .toThrowError(PersonaError)
  })

  it('preserves literal braces and source text verbatim', () => {
    const result = assemblePersona(buffers({ 'IDENTITY.MD': 'hello {{ name }}' }))
    expect(result.body).toContain('hello {{ name }}')
    expect(result.text).toContain('hello {{ name }}')
  })

  it('rejects invalid UTF-8 in an included file', () => {
    const files = buffers()
    files['IDENTITY.MD'] = Buffer.from([0xff])
    expect(codeOf(() => assemblePersona(files))).toBe('invalid_utf8')
  })
})
