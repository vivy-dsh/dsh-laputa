import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import {
  PERSONA_SECTION_NAME, createOnboardingSection, createPersonaSection, isTopLevelAgent,
  registerPersonaInjection,
} from '../src/adapter.ts'
import { ONBOARDING_SECTION_NAME } from '../src/onboarding.ts'
import { INIT_TOOL_NAME } from '../src/tool.ts'

interface FakeAgent {
  readonly agent: Agent
  readonly sections: PromptSection[]
  readonly tools: Array<{ name: string }>
  readonly injectedWith: string[][]
  disposed: number
  failInstall: boolean
}

function fakeAgent(options: {
  id?: string
  origin?: 'subagent'
  depth?: number
  failInstall?: boolean
  noTools?: boolean
} = {}): FakeAgent {
  const sections: PromptSection[] = []
  const tools: Array<{ name: string }> = []
  const injectedWith: string[][] = []
  const entry = {
    sections,
    tools,
    injectedWith,
    disposed: 0,
    failInstall: options.failInstall === true,
  } as FakeAgent
  const agent = {
    id: options.id ?? 'session-1',
    session: {
      id: options.id ?? 'session-1',
      header: {
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.depth === undefined ? {} : { delegationDepth: options.depth }),
      },
    },
    ctx: {
      inject(dependencies: string[], install: (scope: unknown) => void) {
        injectedWith.push(dependencies)
        if (entry.failInstall) throw new Error('inject failed')
        const scope: Record<string, unknown> = {
          systemPrompt: {
            getSectionOrder: () => 0,
            section: (section: PromptSection) => { sections.push(section) },
          },
        }
        if (options.noTools !== true) {
          scope.tools = {
            register(definition: { name: string }) {
              tools.push(definition)
              return () => {}
            },
          }
        }
        install(scope)
        return {
          dispose: async () => { entry.disposed += 1 },
        }
      },
    },
  } as unknown as Agent
  Object.defineProperty(entry, 'agent', { value: agent, enumerable: true })
  return entry
}

interface FakeContext {
  readonly ctx: Context
  emit(event: string, payload: unknown): void
  cleanup(): Promise<void>
}

function fakeContext(initial: FakeAgent[] = []): FakeContext {
  const listeners = new Map<string, (payload: unknown) => void>()
  let cleanupFn: (() => Promise<void>) | undefined
  const ctx = {
    agents: { list: () => initial.map(entry => entry.agent) },
    on(event: string, listener: (payload: unknown) => void) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(factory: () => () => Promise<void>) {
      cleanupFn = factory()
      return () => {}
    },
  } as unknown as Context
  return {
    ctx,
    emit(event, payload) { listeners.get(event)?.(payload) },
    async cleanup() { await cleanupFn?.() },
  }
}

interface FakeCache {
  promptText(): string
  onboardingText(): string
  session(key: unknown): {
    readonly revision: number | null
    promptText(): string
    onboardingText(): string
    refresh(): void
  }
  releaseSession(key: unknown): void
  hasSession(key: unknown): boolean
}

function fakeCache(persona: string, onboarding = ''): FakeCache {
  const sessions = new Map<unknown, { persona: string; onboarding: string }>()
  return {
    promptText: () => persona,
    onboardingText: () => onboarding,
    session(key: unknown) {
      let state = sessions.get(key)
      if (state === undefined) {
        state = { persona, onboarding }
        sessions.set(key, state)
      }
      const pinned = state
      return {
        revision: null,
        promptText: () => pinned.persona,
        onboardingText: () => pinned.onboarding,
        refresh: () => {
          pinned.persona = persona
          pinned.onboarding = onboarding
        },
      }
    },
    releaseSession(key: unknown) { sessions.delete(key) },
    hasSession: (key: unknown) => sessions.has(key),
  }
}

function pinningCache(initial = 'r1'): FakeCache & {
  setPersona(value: string): void
  setOnboarding(value: string): void
} {
  let persona = initial
  let onboarding = ''
  const sessions = new Map<unknown, { persona: string; onboarding: string }>()
  return {
    setPersona(value: string) { persona = value },
    setOnboarding(value: string) { onboarding = value },
    promptText: () => persona,
    onboardingText: () => onboarding,
    session(key: unknown) {
      let state = sessions.get(key)
      if (state === undefined) {
        state = { persona, onboarding }
        sessions.set(key, state)
      }
      const pinned = state
      return {
        revision: null,
        promptText: () => pinned.persona,
        onboardingText: () => pinned.onboarding,
        refresh: () => {
          pinned.persona = persona
          pinned.onboarding = onboarding
        },
      }
    },
    releaseSession(key: unknown) { sessions.delete(key) },
    hasSession: (key: unknown) => sessions.has(key),
  }
}

function install(context: FakeContext, cache: FakeCache, warn = () => {}) {
  registerPersonaInjection(context.ctx, cache as never, warn)
}

function sectionText(section: PromptSection | undefined): string {
  if (section === undefined) throw new Error('expected a prompt section')
  return (section.text as () => string)()
}

describe('top-level agent detection', () => {
  it('accepts a root session', () => {
    expect(isTopLevelAgent(fakeAgent().agent)).toBe(true)
  })

  it('accepts an explicit zero delegation depth', () => {
    expect(isTopLevelAgent(fakeAgent({ depth: 0 }).agent)).toBe(true)
  })

  it('rejects subagent origin', () => {
    expect(isTopLevelAgent(fakeAgent({ origin: 'subagent' }).agent)).toBe(false)
  })

  it('rejects delegated sessions', () => {
    expect(isTopLevelAgent(fakeAgent({ depth: 1 }).agent)).toBe(false)
  })
})

describe('persona section', () => {
  it('uses the stable name, requested order, and disables interpolation', () => {
    const section = createPersonaSection(fakeCache('persona text'), 1)
    expect(section.name).toBe(PERSONA_SECTION_NAME)
    expect(section.name).toBe('laputa:persona')
    expect(section.order).toBe(1)
    expect(section.interpolate).toBe(false)
    expect((section.text as () => string)()).toBe('persona text')
  })

  it('reads the cache on every assembly', () => {
    let current = 'first'
    const section = createPersonaSection({ promptText: () => current }, 1)
    expect((section.text as () => string)()).toBe('first')
    current = 'second'
    expect((section.text as () => string)()).toBe('second')
  })
})

describe('onboarding section', () => {
  it('uses a separate stable name and disables interpolation', () => {
    const section = createOnboardingSection(fakeCache('', 'ask the user'), 2)
    expect(section.name).toBe(ONBOARDING_SECTION_NAME)
    expect(section.name).toBe('laputa:onboarding')
    expect(section.order).toBe(2)
    expect(section.interpolate).toBe(false)
    expect((section.text as () => string)()).toBe('ask the user')
  })

  it('reads the cache on every assembly', () => {
    let current = ''
    const section = createOnboardingSection({ onboardingText: () => current }, 2)
    expect((section.text as () => string)()).toBe('')
    current = 'guided setup'
    expect((section.text as () => string)()).toBe('guided setup')
  })
})

describe('injection registration', () => {
  it('installs both sections and the setup tool for an existing top-level agent', () => {
    const entry = fakeAgent()
    const context = fakeContext([entry])
    install(context, fakeCache('persona', 'onboarding'))
    expect(entry.injectedWith).toEqual([['systemPrompt'], ['tools']])
    expect(entry.sections).toHaveLength(2)
    expect(entry.sections.map(section => section.name)).toEqual(['laputa:persona', 'laputa:onboarding'])
    expect(entry.sections.map(section => section.order)).toEqual([1, 2])
    expect(entry.tools.map(tool => tool.name)).toEqual([INIT_TOOL_NAME])
  })

  it('skips subagents and delegated sessions', () => {
    const subagent = fakeAgent({ id: 'sub', origin: 'subagent' })
    const delegated = fakeAgent({ id: 'child', depth: 1 })
    const context = fakeContext([subagent, delegated])
    install(context, fakeCache('persona'))
    expect(subagent.injectedWith).toHaveLength(0)
    expect(delegated.injectedWith).toHaveLength(0)
  })

  it('installs when a top-level agent is created later', () => {
    const context = fakeContext()
    install(context, fakeCache('persona'))
    const late = fakeAgent({ id: 'late' })
    context.emit('agent/created', { agent: late.agent })
    expect(late.sections).toHaveLength(2)
    expect(late.tools).toHaveLength(1)
  })

  it('ignores a late subagent creation', () => {
    const context = fakeContext()
    install(context, fakeCache('persona'))
    const late = fakeAgent({ id: 'late', origin: 'subagent' })
    context.emit('agent/created', { agent: late.agent })
    expect(late.injectedWith).toHaveLength(0)
  })

  it('disposes every surface when the agent is disposed', () => {
    const entry = fakeAgent()
    const context = fakeContext([entry])
    install(context, fakeCache('persona'))
    context.emit('agent/disposed', { agent: entry.agent })
    expect(entry.disposed).toBe(2)
  })

  it('reports installation failures without throwing', () => {
    const entry = fakeAgent({ failInstall: true })
    const context = fakeContext([entry])
    const warnings: string[] = []
    expect(() => install(context, fakeCache('persona'), message => { warnings.push(message) })).not.toThrow()
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('inject failed')
  })

  it('keeps the prompt sections when the tools service is missing', () => {
    const entry = fakeAgent({ noTools: true })
    const context = fakeContext([entry])
    const warnings: string[] = []
    install(context, fakeCache('persona', 'onboarding'), message => { warnings.push(message) })
    expect(entry.sections).toHaveLength(2)
    expect(entry.tools).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(INIT_TOOL_NAME)
  })

  it('disposes every installed surface on plugin unload', async () => {
    const first = fakeAgent({ id: 'a' })
    const second = fakeAgent({ id: 'b' })
    const context = fakeContext([first, second])
    install(context, fakeCache('persona'))
    await context.cleanup()
    expect(first.disposed).toBe(2)
    expect(second.disposed).toBe(2)
  })

  it('pins each agent to the persona at install time', () => {
    const cache = pinningCache()
    cache.setOnboarding('setup r1')
    const first = fakeAgent({ id: 'a' })
    const context = fakeContext([first])
    install(context, cache)
    expect(sectionText(first.sections[0])).toBe('r1')
    expect(sectionText(first.sections[1])).toBe('setup r1')

    cache.setPersona('r2')
    cache.setOnboarding('')
    expect(sectionText(first.sections[0])).toBe('r1')
    expect(sectionText(first.sections[1])).toBe('setup r1')

    const late = fakeAgent({ id: 'b' })
    context.emit('agent/created', { agent: late.agent })
    expect(sectionText(late.sections[0])).toBe('r2')
    expect(sectionText(late.sections[1])).toBe('')
  })

  it('releases the pin when the agent is disposed', () => {
    const cache = pinningCache()
    const entry = fakeAgent()
    const context = fakeContext([entry])
    install(context, cache)
    expect(cache.hasSession(entry.agent)).toBe(true)
    context.emit('agent/disposed', { agent: entry.agent })
    expect(cache.hasSession(entry.agent)).toBe(false)
  })

  it('releases every pin on plugin unload', async () => {
    const cache = pinningCache()
    const first = fakeAgent({ id: 'a' })
    const second = fakeAgent({ id: 'b' })
    const context = fakeContext([first, second])
    install(context, cache)
    await context.cleanup()
    expect(cache.hasSession(first.agent)).toBe(false)
    expect(cache.hasSession(second.agent)).toBe(false)
  })

  it('releases the pin when no surface could be installed', () => {
    const cache = pinningCache()
    const entry = fakeAgent({ failInstall: true })
    const context = fakeContext([entry])
    install(context, cache, () => {})
    expect(cache.hasSession(entry.agent)).toBe(false)
  })
})
