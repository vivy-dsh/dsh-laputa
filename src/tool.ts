/**
 * `laputa_init` — the only model-facing write surface.
 *
 * The tool is mounted on top-level agents only. It fills missing or empty
 * persona files from explicit user answers and never overwrites content the
 * user already wrote. Paths come from the plugin binding, not from arguments.
 * @module dsh-laputa
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PersonaCache } from './cache.ts'
import { describeError } from './domain.ts'
import { revisionName } from './revision.ts'
import { isTopLevelAgent } from './top-level.ts'
import { initializePersona } from './write.ts'

/** Stable tool name. */
export const INIT_TOOL_NAME = 'laputa_init'

const DESCRIPTION = 'Save the user\'s persona after the guided first-run interview. Use only after the user explicitly answered who they are and what their mission is, or asked to add missing persona files. Creates missing or empty persona files; never overwrites a non-empty file. For advanced setup, include relationship and redline from the user, and draft dream (aspirations and direction) and dark (fears and shadow) yourself from the conversation; never ask the user for dream or dark.'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['initialized', 'uninitialized'] },
    written: { type: 'array', items: { type: 'string' } },
    preserved: { type: 'array', items: { type: 'string' } },
    pending: { type: 'array', items: { type: 'string' } },
    revision: { type: 'integer' },
  },
} as const

const PARAMETERS = {
  identity: {
    type: 'string',
    description: 'The user\'s answer to "Who am I?": a name if they want one, plus identity, tone, and values. Omit if IDENTITY.MD already has content.',
  },
  mission: {
    type: 'string',
    description: 'The user\'s answer to "What is my mission?": what this agent exists to do. Omit if MISSION.MD already has content.',
  },
  relationship: {
    type: 'string',
    description: 'Advanced setup only: how the agent and user should relate, in the user\'s words.',
  },
  redline: {
    type: 'string',
    description: 'Advanced setup only: hard boundaries the user sets. Never invent these.',
  },
  dream: {
    type: 'string',
    description: 'Advanced setup only: aspirations and direction you draft from the conversation. Never ask the user for this.',
  },
  dark: {
    type: 'string',
    description: 'Advanced setup only: fears and shadow you draft from the conversation. Never ask the user for this.',
  },
} as const

/**
 * Register the init tool in one tool-enabled scope.
 * @param ctx - context providing the tool registry.
 * @param cache - persona cache whose binding and limits own the write target.
 * @returns the registry disposer.
 */
export function registerPersonaTool(ctx: Context, cache: PersonaCache): () => void {
  return ctx.tools.register(defineTool({
    name: INIT_TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const written = value.written ?? []
        const preserved = value.preserved ?? []
        const pending = value.pending ?? []
        const lines = [`Persona ${value.status ?? 'uninitialized'}.`]
        if (written.length > 0) lines.push(`Written: ${written.join(', ')}`)
        if (preserved.length > 0) lines.push(`Preserved: ${preserved.join(', ')}`)
        if (pending.length > 0) lines.push(`Still missing or empty: ${pending.join(', ')}`)
        if (typeof value.revision === 'number') lines.push(`Revision: ${revisionName(value.revision)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined || !isTopLevelAgent(agent)) {
        throw new Error('laputa_init is only available to a top-level agent')
      }
      try {
        const base = cache.revisions === undefined
          ? null
          : cache.currentRevision()?.revision ?? null
        const result = initializePersona(cache.binding, args, cache.limits)
        if (cache.revisions !== undefined) {
          cache.publishDraft({
            expectedBaseRevision: base,
            expectedDraftDigest: result.draftDigest,
            source: { actor: 'tool', note: 'laputa_init' },
          })
        }
        const outcome = cache.reload()
        if (cache.revisions !== undefined) cache.refreshSessions(agent)
        const revision = cache.status().revision
        return {
          status: outcome.status,
          written: [...result.written],
          preserved: [...result.preserved],
          pending: [...result.pending],
          ...(revision === null ? {} : { revision }),
        }
      } catch (error) {
        throw new Error(`laputa_init failed: ${describeError(error)}`)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Initialize persona', kind: 'other' }),
  }))
}
