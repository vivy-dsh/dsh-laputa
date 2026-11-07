/**
 * dsh-laputa Phase 1 — user-authored persona injection plus guided setup.
 *
 * The plugin reads six opaque Markdown documents from
 * `$DSH_HOME/laputa/<personaId>/` (or an absolute `sourceDir`), assembles them
 * in a fixed order, and contributes the result as an agent-scoped system
 * prompt section. While IDENTITY and MISSION are blank, it injects onboarding
 * instructions instead and exposes `laputa_init`, a create-only tool that
 * fills missing files and never overwrites user content. It also serves the
 * loopback API used by the same-level web panel. It does not change tool
 * permissions. Automatic proposals, rewrites, and rollback belong to a later
 * phase.
 * @module dsh-laputa
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerPersonaInjection } from './adapter.ts'
import { resolvePersonaBinding } from './binding.ts'
import { PersonaCache } from './cache.ts'
import { registerLaputaCommand, type CommandsCapability } from './command.ts'
import { DEFAULT_MAX_PERSONA_CHARS, DEFAULT_MAX_SOURCE_BYTES } from './domain.ts'
import { registerLaputaPanel } from './http.ts'
import { revisionName, RevisionStore } from './revision.ts'

export const name = 'laputa'
export const inject = ['agents']

/** Plugin configuration. */
export interface Config {
  /**
   * Whether the persona is injected. Defaults to false; the setup script
   * writes a profile override that enables it for a selected persona.
   */
  enabled?: boolean
  /** Persona directory name under `$DSH_HOME/laputa/`. */
  personaId?: string
  /** Absolute persona directory; overrides the default `$DSH_HOME/laputa/<personaId>`. */
  sourceDir?: string
  /** Absolute revision state directory; defaults to `$DSH_HOME/laputa/.state/<personaId>`. */
  stateDir?: string
  /** Per-file byte cap. */
  maxSourceBytes?: number
  /** Total assembled character cap. */
  maxPersonaChars?: number
  /** Revision retention window; 0 or absent keeps every revision. */
  retainRevisions?: number
}

/** Schemastery configuration for the persona plugin. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  personaId: z.string().default('default'),
  sourceDir: z.string(),
  stateDir: z.string(),
  maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
  maxPersonaChars: z.number().step(1).min(1).default(DEFAULT_MAX_PERSONA_CHARS),
  retainRevisions: z.number().step(1).min(0).default(0),
})

/**
 * Mount the persona reader, command, and prompt injection.
 * @param ctx - Cordis context with the agent registry available.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('laputa')
  const info = (message: string): void => { logger.info(message) }
  const warn = (message: string): void => { logger.warn(message) }
  const enabled = config.enabled === true

  // An enabled plugin tolerates a missing persona directory (first-run setup
  // creates it), but still rejects an existing directory that fails the
  // symlink, permission, or containment checks.
  const binding = resolvePersonaBinding({
    personaId: config.personaId ?? 'default',
    ...(config.sourceDir === undefined ? {} : { sourceDir: config.sourceDir }),
    ...(config.stateDir === undefined ? {} : { stateDir: config.stateDir }),
  }, { inspect: enabled })

  const limits = {
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    maxPersonaChars: config.maxPersonaChars ?? DEFAULT_MAX_PERSONA_CHARS,
    retainRevisions: config.retainRevisions ?? 0,
  }
  const revisions = enabled ? new RevisionStore(binding, binding.stateDirectory, limits) : undefined
  const cache = new PersonaCache(binding, limits, warn, revisions)

  if (enabled) {
    const outcome = cache.load()
    const revision = cache.status().revision
    if (outcome.status === 'initialized') {
      info(`persona "${binding.personaId}" loaded from ${binding.directory} (${outcome.assembled.chars} chars, revision ${revision === null ? 'none' : revisionName(revision)})`)
    } else {
      info(`persona "${binding.personaId}" is not initialized; guided setup is enabled (${outcome.pending.join(', ')})`)
    }
    if (revision !== null) info(`revision state: ${binding.stateDirectory} (live ${revisionName(revision)})`)
  } else {
    cache.markDisabled()
    info('disabled; set enabled: true and a personaId in the profile patch to inject a persona')
  }

  const commands = ctx.get('commands') as CommandsCapability | undefined
  if (commands) {
    ctx.effect(() => registerLaputaCommand(commands, cache))
  } else {
    warn('commands capability not available; /laputa is not registered')
  }

  if (enabled) registerPersonaInjection(ctx, cache, warn)

  // The panel API activates only when the host provides both services. Its
  // absence never blocks the persona reader, so headless startup still works.
  ctx.inject(['webServer', 'connection'], (scope) => {
    scope.effect(() => registerLaputaPanel(scope, cache), 'laputa: panel api')
  })
}
