/**
 * Resolve the configured persona directory. The default is
 * `$DSH_HOME/laputa/<personaId>`; an explicit `sourceDir` points at the
 * persona directory itself. An inspected binding is canonicalized and checked
 * for symlinks, permissions, and containment when the directory exists. A
 * missing directory is reported as `exists: false` so first-run onboarding can
 * create it later; a directory that exists but is unsafe still fails.
 * @module dsh-laputa
 */

import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PersonaError } from './domain.ts'
import { readPersonaDirectory } from './safe-read.ts'

/** A resolved persona source. */
export interface PersonaBinding {
  /** Validated persona id. */
  readonly personaId: string
  /** Canonical persona directory when it exists; the intended path otherwise. */
  readonly directory: string
  /** Root the default layout is contained in, or the custom directory's parent. */
  readonly root: string
  /** Whether `sourceDir` was supplied explicitly. */
  readonly custom: boolean
  /** Whether the directory was inspected and exists. */
  readonly exists: boolean
  /** Immutable revision state; never inside the persona directory. */
  readonly stateDirectory: string
}

/** Binding inputs from plugin configuration. */
export interface PersonaBindingInput {
  readonly personaId: string
  readonly sourceDir?: string
  /** Absolute revision state directory; defaults under `$DSH_HOME/laputa/.state`. */
  readonly stateDir?: string
}

/** Binding options. */
export interface PersonaBindingOptions {
  /** Inspect and canonicalize an existing directory. Defaults to true. */
  readonly inspect?: boolean
}

/**
 * Validate a persona id without interpreting it as a path.
 * @param value - configured persona id.
 */
export function validatePersonaId(value: string): string {
  if (value.length === 0 || value === '.' || value === '..'
    || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new PersonaError(
      'invalid_persona_id',
      `personaId must be a non-empty name without path separators: ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * Return the canonical directory, or `undefined` when the path is absent.
 * Anything present but unsafe is rejected by `readPersonaDirectory`.
 * @param directory - candidate persona directory.
 */
function inspectDirectory(directory: string): string | undefined {
  try {
    lstatSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new PersonaError('file_open_refused', `cannot inspect persona directory ${directory}: ${String(error)}`)
  }
  return readPersonaDirectory(directory)
}

/**
 * Verify that a default-layout directory is still inside its canonical root
 * and still named after the persona. Custom sources are exempt because the
 * configured absolute path is authoritative.
 * @param binding - resolved binding.
 * @param canonicalDirectory - canonical directory to check.
 */
export function assertPersonaContainment(binding: PersonaBinding, canonicalDirectory: string): void {
  if (binding.custom) return
  const canonicalRoot = realpathSync(binding.root)
  const expected = join(canonicalRoot, binding.personaId)
  if (canonicalDirectory !== expected) {
    throw new PersonaError(
      'role_directory_mismatch',
      `persona directory is outside ${canonicalRoot}: ${canonicalDirectory}`,
    )
  }
}

/**
 * Inspect an existing persona directory for the panel. A missing directory
 * returns `undefined`; an existing but unsafe directory throws the usual
 * symlink, permission, or containment error.
 * @param binding - resolved binding.
 */
export function inspectPersonaDirectory(binding: PersonaBinding): string | undefined {
  const canonical = inspectDirectory(binding.directory)
  if (canonical === undefined) return undefined
  assertPersonaContainment(binding, canonical)
  return canonical
}

/**
 * Resolve the revision state directory and refuse one that overlaps the
 * editable persona directory.
 * @param value - explicit absolute state directory, if configured.
 * @param personaId - persona id used by the default layout.
 * @param directory - resolved persona directory.
 */
function resolveStateDirectory(
  value: string | undefined,
  personaId: string,
  directory: string,
): string {
  if (value !== undefined && !isAbsolute(value)) {
    throw new PersonaError('invalid_source_dir', `stateDir must be an absolute path: ${value}`)
  }
  const stateDirectory = value === undefined
    ? join(dshHomePath('laputa'), '.state', personaId)
    : resolve(value)
  const persona = resolve(directory)
  const rel = relative(persona, stateDirectory)
  const inside = rel === ''
    || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  if (inside) {
    throw new PersonaError(
      'invalid_source_dir',
      `stateDir must be outside the persona directory: ${stateDirectory}`,
    )
  }
  return stateDirectory
}

/**
 * Create the persona draft directory when absent and return its canonical
 * path with `0700` permissions. Unsafe existing directories still fail.
 * @param binding - resolved binding.
 */
export function ensurePersonaDirectory(binding: PersonaBinding): string {
  let exists = true
  try {
    lstatSync(binding.directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PersonaError('file_open_refused', `cannot inspect persona directory ${binding.directory}: ${String(error)}`)
    }
    exists = false
  }

  if (!exists) {
    mkdirSync(binding.directory, { recursive: true, mode: 0o700 })
  }
  const canonical = inspectPersonaDirectory(binding)
  if (canonical === undefined) {
    throw new PersonaError('persona_directory_missing', `persona directory does not exist: ${binding.directory}`)
  }
  chmodSync(canonical, 0o700)
  return canonical
}

/**
 * Resolve and, when requested, verify a persona directory.
 * @param input - persona id and optional absolute source directory.
 * @param options - whether an existing directory should be inspected.
 */
export function resolvePersonaBinding(
  input: PersonaBindingInput,
  options: PersonaBindingOptions = {},
): PersonaBinding {
  const personaId = validatePersonaId(input.personaId)
  const inspect = options.inspect ?? true

  if (input.sourceDir !== undefined) {
    if (!isAbsolute(input.sourceDir)) {
      throw new PersonaError('invalid_source_dir', `sourceDir must be an absolute path: ${input.sourceDir}`)
    }
    const directory = resolve(input.sourceDir)
    if (!inspect) {
      return {
        personaId,
        directory,
        root: dirname(directory),
        custom: true,
        exists: false,
        stateDirectory: resolveStateDirectory(input.stateDir, personaId, directory),
      }
    }
    const canonical = inspectDirectory(directory)
    return {
      personaId,
      directory: canonical ?? directory,
      root: dirname(directory),
      custom: true,
      exists: canonical !== undefined,
      stateDirectory: resolveStateDirectory(input.stateDir, personaId, directory),
    }
  }

  const root = dshHomePath('laputa')
  const directory = join(root, personaId)
  if (!inspect) {
    return {
      personaId,
      directory,
      root,
      custom: false,
      exists: false,
      stateDirectory: resolveStateDirectory(input.stateDir, personaId, directory),
    }
  }

  const canonical = inspectDirectory(directory)
  if (canonical === undefined) {
    return {
      personaId,
      directory,
      root,
      custom: false,
      exists: false,
      stateDirectory: resolveStateDirectory(input.stateDir, personaId, directory),
    }
  }

  const canonicalRoot = realpathSync(root)
  const rel = relative(canonicalRoot, canonical)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PersonaError('role_directory_mismatch', `persona directory is outside ${root}: ${canonical}`)
  }
  if (basename(canonical) !== personaId) {
    throw new PersonaError('role_directory_mismatch', `persona directory name does not match ${personaId}: ${canonical}`)
  }
  return {
    personaId,
    directory: canonical,
    root: canonicalRoot,
    custom: false,
    exists: true,
    stateDirectory: resolveStateDirectory(input.stateDir, personaId, directory),
  }
}
