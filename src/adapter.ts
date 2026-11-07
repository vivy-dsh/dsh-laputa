/**
 * Agent-scoped prompt injection and setup tool.
 *
 * The persona section, onboarding section, and `laputa_init` tool are installed
 * only for top-level agents and only through the agent's own Cordis scope, so
 * they dispose with the agent and never leak into subagents. Prompt text
 * providers are synchronous, are evaluated once per assembly, and disable
 * variable interpolation so persona prose containing `{{...}}` stays literal.
 * @module dsh-laputa
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { PersonaCache } from './cache.ts'
import { describeError } from './domain.ts'
import { ONBOARDING_SECTION_NAME } from './onboarding.ts'
import { INIT_TOOL_NAME, registerPersonaTool } from './tool.ts'
import { isTopLevelAgent } from './top-level.ts'

export { isTopLevelAgent } from './top-level.ts'

/** Stable section name; a scoped section shadows the same name elsewhere. */
export const PERSONA_SECTION_NAME = 'laputa:persona'

/** Build the persona prompt section for one agent scope. */
export function createPersonaSection(
  cache: Pick<PersonaCache, 'promptText'>,
  order: number,
): PromptSection {
  return {
    name: PERSONA_SECTION_NAME,
    order,
    text: () => cache.promptText(),
    interpolate: false,
  }
}

/** Build the guided-setup prompt section for one agent scope. */
export function createOnboardingSection(
  cache: Pick<PersonaCache, 'onboardingText'>,
  order: number,
): PromptSection {
  return {
    name: ONBOARDING_SECTION_NAME,
    order,
    text: () => cache.onboardingText(),
    interpolate: false,
  }
}

type Fiber = ReturnType<Context['inject']>

/**
 * Install the prompt sections and setup tool for every current and future
 * top-level agent. A missing `tools` service only loses the tool; a missing
 * `systemPrompt` service only loses the sections. Installation failures never
 * fail agent creation.
 * @param ctx - plugin context providing the agent registry.
 * @param cache - persona cache backing the synchronous providers.
 * @param warn - warning sink.
 */
export function registerPersonaInjection(
  ctx: Context,
  cache: PersonaCache,
  warn: (message: string) => void,
): void {
  const fibers = new Map<Agent, Fiber[]>()

  const install = (agent: Agent): void => {
    if (!isTopLevelAgent(agent) || fibers.has(agent)) return
    const session = cache.session(agent)
    const installed: Fiber[] = []

    try {
      installed.push(agent.ctx.inject(['systemPrompt'], (scope) => {
        const base = scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
        scope.systemPrompt.section(createPersonaSection(session, base + 1))
        scope.systemPrompt.section(createOnboardingSection(session, base + 2))
      }))
    } catch (error) {
      warn(`could not install the persona sections for ${String(agent.session.id)}: ${describeError(error)}`)
    }

    try {
      installed.push(agent.ctx.inject(['tools'], (scope) => {
        registerPersonaTool(scope, cache)
      }))
    } catch (error) {
      warn(`could not install ${INIT_TOOL_NAME} for ${String(agent.session.id)}: ${describeError(error)}`)
    }

    if (installed.length > 0) {
      fibers.set(agent, installed)
    } else {
      cache.releaseSession(agent)
    }
  }

  const dispose = (agent: Agent): void => {
    const pending = fibers.get(agent)
    if (pending === undefined) return
    fibers.delete(agent)
    cache.releaseSession(agent)
    for (const fiber of pending) {
      void fiber.dispose().catch((error: unknown) => {
        warn(`could not dispose persona surfaces for ${String(agent.session.id)}: ${describeError(error)}`)
      })
    }
  }

  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { dispose(agent) })
  ctx.effect(() => async () => {
    const agents = [...fibers.keys()]
    const pending = [...fibers.values()].flat()
    fibers.clear()
    for (const agent of agents) cache.releaseSession(agent)
    await Promise.all(pending.map(fiber => fiber.dispose().catch(() => {})))
  }, 'laputa: persona surfaces')
}
