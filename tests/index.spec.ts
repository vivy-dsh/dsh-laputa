import { chmodSync, existsSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { apply, inject, name } from '../src/index.ts'
import type { CommandDefinition } from '../src/command.ts'
import { PersonaError } from '../src/domain.ts'
import { removeDir, tempDir, writePersona } from './helpers.ts'

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

interface FakeAgent {
  readonly agent: Agent
  readonly sections: PromptSection[]
  readonly tools: Array<{ name: string }>
}

function fakeAgent(options: { id?: string; origin?: 'subagent'; depth?: number } = {}): FakeAgent {
  const sections: PromptSection[] = []
  const tools: Array<{ name: string }> = []
  const agent = {
    session: {
      id: options.id ?? 'session-1',
      header: {
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.depth === undefined ? {} : { delegationDepth: options.depth }),
      },
    },
    ctx: {
      inject(_dependencies: string[], install: (scope: unknown) => void) {
        install({
          systemPrompt: {
            getSectionOrder: () => 0,
            section: (section: PromptSection) => { sections.push(section) },
          },
          tools: {
            register(definition: { name: string }) {
              tools.push(definition)
              return () => {}
            },
          },
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Agent
  return { agent, sections, tools }
}

function fakeContext(options: {
  commands?: boolean
  agents?: FakeAgent[]
  webServer?: boolean
} = {}) {
  const info: string[] = []
  const warn: string[] = []
  const commands: CommandDefinition[] = []
  const routes: Array<{ path: string }> = []
  const ctx = {
    logger: () => ({
      info: (message: string) => { info.push(message) },
      warn: (message: string) => { warn.push(message) },
    }),
    get: (key: string) => {
      if (key !== 'commands' || options.commands === false) return undefined
      return {
        register(definition: CommandDefinition) {
          commands.push(definition)
          return () => {}
        },
      }
    },
    effect: (factory: () => unknown) => {
      factory()
      return () => {}
    },
    inject: (_dependencies: string[], install: (scope: unknown) => void) => {
      if (options.webServer === false) return { dispose: async () => {} }
      install({
        get: (key: string) => {
          if (key === 'webServer') {
            return {
              register(route: { path: string }) {
                routes.push(route)
                return () => {}
              },
            }
          }
          if (key === 'connection') return { requestRejection: () => undefined }
          return undefined
        },
        effect: (factory: () => unknown) => {
          factory()
          return () => {}
        },
      })
      return { dispose: async () => {} }
    },
    agents: { list: () => (options.agents ?? []).map(entry => entry.agent) },
    on: () => () => {},
  } as unknown as Context
  return { ctx, info, warn, commands, routes }
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

function sectionText(section: PromptSection | undefined): string {
  if (section === undefined) throw new Error('expected a prompt section')
  return (section.text as () => string)()
}

describe('plugin metadata', () => {
  it('injects the agent registry under a stable name', () => {
    expect(name).toBe('laputa')
    expect(inject).toEqual(['agents'])
  })
})

describe('apply when disabled', () => {
  it('registers the command without reading a persona directory', () => {
    const harness = fakeContext()
    apply(harness.ctx, { personaId: 'not-created-yet' })
    expect(harness.commands).toHaveLength(1)
    expect(harness.commands[0]?.name).toBe('laputa')
    expect(harness.info.join('\n')).toContain('disabled')
    expect(harness.routes.map(route => route.path)).toEqual(['/dsh-laputa/api'])
  })

  it('does not inject a prompt section', () => {
    const entry = fakeAgent()
    const harness = fakeContext({ agents: [entry] })
    apply(harness.ctx, {})
    expect(entry.sections).toHaveLength(0)
  })

  it('still rejects an invalid persona id', () => {
    const harness = fakeContext()
    expect(codeOf(() => apply(harness.ctx, { personaId: '..' }))).toBe('invalid_persona_id')
  })

  it('warns when the host has no command capability', () => {
    const harness = fakeContext({ commands: false })
    expect(() => apply(harness.ctx, {})).not.toThrow()
    expect(harness.warn.join('\n')).toContain('commands capability not available')
  })

  it('keeps working when no web services are available', () => {
    const harness = fakeContext({ webServer: false })
    expect(() => apply(harness.ctx, {})).not.toThrow()
    expect(harness.routes).toHaveLength(0)
    expect(harness.commands).toHaveLength(1)
  })
})

describe('apply when enabled', () => {
  it('loads the persona and installs both sections', () => {
    const root = dir()
    const persona = join(root, 'vivy')
    writePersona(persona)
    const entry = fakeAgent()
    const harness = fakeContext({ agents: [entry] })
    apply(harness.ctx, { enabled: true, personaId: 'vivy', sourceDir: persona, stateDir: join(root, 'state') })
    expect(harness.info.join('\n')).toContain('loaded')
    expect(harness.info.join('\n')).toContain('revision r000001')
    expect(existsSync(join(root, 'state', 'current.json'))).toBe(true)
    expect(entry.sections.map(section => section.name)).toEqual(['laputa:persona', 'laputa:onboarding'])
    expect(entry.tools.map(tool => tool.name)).toEqual(['laputa_init'])
  })

  it('skips a subagent that already exists', () => {
    const root = dir()
    const persona = join(root, 'vivy')
    writePersona(persona)
    const child = fakeAgent({ id: 'child', origin: 'subagent' })
    const harness = fakeContext({ agents: [child] })
    apply(harness.ctx, { enabled: true, personaId: 'vivy', sourceDir: persona, stateDir: join(root, 'state') })
    expect(child.sections).toHaveLength(0)
    expect(child.tools).toHaveLength(0)
  })

  it('guides setup instead of failing when the persona directory is missing', () => {
    const root = dir()
    const entry = fakeAgent()
    const harness = fakeContext({ agents: [entry] })
    expect(() => apply(harness.ctx, {
      enabled: true,
      personaId: 'vivy',
      sourceDir: join(root, 'missing'),
      stateDir: join(root, 'state'),
    })).not.toThrow()
    expect(harness.info.join('\n')).toContain('not initialized')
    expect(entry.sections).toHaveLength(2)
    expect(entry.sections[1]?.name).toBe('laputa:onboarding')
    expect(sectionText(entry.sections[0])).toBe('')
    expect(sectionText(entry.sections[1])).toContain('Who am I?')  })

  it('guides setup instead of failing when MISSION.MD is blank', () => {
    const root = dir()
    const persona = join(root, 'vivy')
    writePersona(persona, { 'MISSION.MD': '   ' })
    const entry = fakeAgent()
    const harness = fakeContext({ agents: [entry] })
    expect(() => apply(harness.ctx, {
      enabled: true,
      personaId: 'vivy',
      sourceDir: persona,
      stateDir: join(root, 'state'),
    })).not.toThrow()
    expect(harness.info.join('\n')).toContain('not initialized')
    expect(harness.info.join('\n')).toContain('MISSION.MD')
    expect(sectionText(entry.sections[1])).toContain('MISSION.MD')
  })

  it('still fails activation for a symlinked persona directory', { skip: !POSIX }, () => {
    const root = dir()
    const target = join(root, 'real')
    writePersona(target)
    const persona = join(root, 'vivy')
    symlinkSync(target, persona)
    const harness = fakeContext()
    expect(codeOf(() => apply(harness.ctx, {
      enabled: true,
      personaId: 'vivy',
      sourceDir: persona,
    }))).toBe('symlink_not_supported')
  })

  it('still fails activation for invalid UTF-8', () => {
    const root = dir()
    const persona = join(root, 'vivy')
    writePersona(persona)
    writeFileSync(join(persona, 'IDENTITY.MD'), Buffer.from([0xff]), { mode: 0o600 })
    chmodSync(join(persona, 'IDENTITY.MD'), 0o600)
    const harness = fakeContext()
    expect(codeOf(() => apply(harness.ctx, {
      enabled: true,
      personaId: 'vivy',
      sourceDir: persona,
    }))).toBe('invalid_utf8')
  })
})
