/**
 * Persona writes.
 *
 * Guided setup is create-only: the model may fill files that are missing or
 * empty, but a file with content is never replaced. The management panel can
 * replace one of the six known files after a concurrent-change check; both
 * paths use a same-directory temporary file, `fsync`, and an atomic rename.
 * New directories are `0700` and new files `0600`.
 * @module dsh-laputa
 */

import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSEMBLY_FILES, PersonaError, type PersonaFile,
} from './domain.ts'
import { atomicWriteFile, digestOf } from './atomic.ts'
import { ensurePersonaDirectory, type PersonaBinding } from './binding.ts'
import {
  assemblePersona, assessPersona, digestPersonaFiles, personaCharacterCount, type PersonaFileBytes,
} from './assemble.ts'
import type { PersonaLimits } from './cache.ts'
import { safeRead } from './safe-read.ts'

/** Fields the model may supply during guided setup. */
export interface PersonaWriteInput {
  readonly identity?: string
  readonly mission?: string
  readonly relationship?: string
  readonly redline?: string
  readonly dream?: string
  readonly dark?: string
}

/** Result of one create-only initialization. */
export interface PersonaWriteResult {
  /** Files created or filled because they were missing or empty. */
  readonly written: readonly PersonaFile[]
  /** Non-empty files left untouched. */
  readonly preserved: readonly PersonaFile[]
  /** Files still missing or blank after the write (normally empty). */
  readonly pending: readonly PersonaFile[]
  /** Digest over the final six files, matching `digestPersonaFiles`. */
  readonly draftDigest: string
}

/** Result of replacing one file from the management panel. */
export interface PersonaFileWriteResult {
  /** File that was replaced. */
  readonly name: PersonaFile
  /** Written byte length. */
  readonly bytes: number
  /** SHA-256 of the written bytes. */
  readonly digest: string
  /** Whether IDENTITY and MISSION are both non-blank after the write. */
  readonly initialized: boolean
  /** Files still missing or blank after the write. */
  readonly pending: readonly PersonaFile[]
}

interface AtomicWriteOptions {
  /** Allow replacing non-blank content. */
  readonly replace?: boolean
  /** Require the target's current digest to match. */
  readonly expectedDigest?: string
}

const EMPTY_DIGEST = digestOf(Buffer.alloc(0))

/** Whether a string names one of the six persona documents. */
export function isPersonaFile(value: string): value is PersonaFile {
  return (ASSEMBLY_FILES as readonly string[]).includes(value)
}

function requirePersonaFile(value: string): PersonaFile {
  if (!isPersonaFile(value)) {
    throw new PersonaError('unknown_persona_file', `unknown persona file: ${value}`)
  }
  return value
}

const FIELD_BY_FILE: Readonly<Record<PersonaFile, keyof PersonaWriteInput>> = {
  'MISSION.MD': 'mission',
  'IDENTITY.MD': 'identity',
  'RELATIONSHIP.MD': 'relationship',
  'REDLINE.MD': 'redline',
  'DREAM.MD': 'dream',
  'DARK.MD': 'dark',
}

function normalize(value: string | undefined): string {
  const text = value?.trim() ?? ''
  return text === '' ? '' : `${text}\n`
}

interface TargetState {
  readonly exists: boolean
  readonly blank: boolean
  readonly bytes: number
  readonly digest: string
}

function targetState(path: string, limit: number): TargetState {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, blank: true, bytes: 0, digest: EMPTY_DIGEST }
    }
    throw new PersonaError('file_open_refused', `cannot inspect persona file ${path}: ${String(error)}`)
  }
  if (info.isSymbolicLink()) {
    throw new PersonaError('symlink_not_supported', `persona file is a symlink: ${path}`)
  }
  if (!info.isFile() || info.nlink !== 1) {
    throw new PersonaError('not_an_unaliased_regular_file', `persona file is not an unaliased regular file: ${path}`)
  }
  if ((info.mode & 0o002) !== 0) {
    throw new PersonaError('world_writable_file_refused', `persona file is world-writable: ${path}`)
  }
  if (info.size === 0) {
    return { exists: true, blank: true, bytes: 0, digest: EMPTY_DIGEST }
  }
  const { bytes, digest } = safeRead(path, limit, true)
  return { exists: true, blank: bytes.toString('utf8').trim() === '', bytes: bytes.length, digest }
}

function writeAtomic(
  directory: string,
  name: PersonaFile,
  content: string,
  limit: number,
  options: AtomicWriteOptions = {},
): void {
  const target = join(directory, name)
  atomicWriteFile(target, content, {
    // A concurrent writer may have changed the target after the caller's
    // read. Check again immediately before the rename.
    beforeRename: () => {
      const state = targetState(target, limit)
      if (options.expectedDigest !== undefined && state.digest !== options.expectedDigest) {
        throw new PersonaError('persona_file_changed', `persona file changed before saving: ${target}`)
      }
      if (options.replace !== true && state.exists && !state.blank) {
        throw new PersonaError('file_open_refused', `persona file changed during initialization: ${target}`)
      }
    },
  })
}

/**
 * Fill missing or empty persona files from guided-setup answers.
 * @param binding - resolved persona source.
 * @param input - answers and optional model drafts.
 * @param limits - per-file and total budgets.
 */
export function initializePersona(
  binding: PersonaBinding,
  input: PersonaWriteInput,
  limits: PersonaLimits,
): PersonaWriteResult {
  const directory = ensurePersonaDirectory(binding)

  const existingBytes: Partial<Record<PersonaFile, Buffer>> = {}
  for (const name of ASSEMBLY_FILES) {
    existingBytes[name] = safeRead(join(directory, name), limits.maxSourceBytes, true).bytes
  }
  const existing = assessPersona(existingBytes as PersonaFileBytes)

  const finalBytes: Partial<Record<PersonaFile, Buffer>> = {}
  const written: PersonaFile[] = []
  const preserved: PersonaFile[] = []
  const pendingWrites: Array<{ name: PersonaFile; content: string }> = []

  for (const name of ASSEMBLY_FILES) {
    const body = existing.bodies[name]
    if (body !== undefined) {
      finalBytes[name] = existingBytes[name] ?? Buffer.from(body, 'utf8')
      preserved.push(name)
      continue
    }
    const content = normalize(input[FIELD_BY_FILE[name]])
    if (Buffer.byteLength(content, 'utf8') > limits.maxSourceBytes) {
      throw new PersonaError(
        'source_byte_budget_exceeded',
        `${name} exceeds ${limits.maxSourceBytes} bytes`,
      )
    }
    finalBytes[name] = Buffer.from(content, 'utf8')
    written.push(name)
    pendingWrites.push({ name, content })
  }

  const final = assessPersona(finalBytes as PersonaFileBytes)
  if (final.bodies['MISSION.MD'] === undefined) {
    throw new PersonaError('mission_assignment_required', 'MISSION.MD must not be empty')
  }
  if (final.bodies['IDENTITY.MD'] === undefined) {
    throw new PersonaError('identity_assignment_required', 'IDENTITY.MD must not be empty')
  }
  assemblePersona(finalBytes as PersonaFileBytes, limits.maxPersonaChars)

  for (const { name, content } of pendingWrites) {
    writeAtomic(directory, name, content, limits.maxSourceBytes)
  }

  return {
    written,
    preserved,
    pending: assessPersona(finalBytes as PersonaFileBytes).pending,
    draftDigest: digestPersonaFiles(finalBytes as PersonaFileBytes),
  }
}

/**
 * Replace one persona document from the management panel.
 *
 * The caller must pass the digest it loaded; a mismatch means another writer
 * changed the file and the save is refused. Blanking IDENTITY or MISSION is
 * allowed and returns `initialized: false`, so the next turn re-enters guided
 * setup instead of failing.
 * @param binding - resolved persona source.
 * @param name - one of the six persona file names.
 * @param content - full replacement content.
 * @param expectedDigest - digest of the content the caller loaded.
 * @param limits - per-file and total budgets.
 */
export function replacePersonaFile(
  binding: PersonaBinding,
  name: string,
  content: string,
  expectedDigest: string,
  limits: PersonaLimits,
): PersonaFileWriteResult {
  const file = requirePersonaFile(name)
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.toString('utf8') !== content) {
    throw new PersonaError('invalid_utf8', `${file} contains an unpaired surrogate`)
  }
  if (bytes.length > limits.maxSourceBytes) {
    throw new PersonaError(
      'source_byte_budget_exceeded',
      `${file} exceeds ${limits.maxSourceBytes} bytes`,
    )
  }

  const directory = ensurePersonaDirectory(binding)
  const current: Partial<Record<PersonaFile, Buffer>> = {}
  for (const candidate of ASSEMBLY_FILES) {
    current[candidate] = safeRead(join(directory, candidate), limits.maxSourceBytes, true).bytes
  }

  const currentBytes = current[file] ?? Buffer.alloc(0)
  if (digestOf(currentBytes) !== expectedDigest) {
    throw new PersonaError('persona_file_changed', `persona file changed before saving: ${join(directory, file)}`)
  }

  const next: PersonaFileBytes = { ...current, [file]: bytes }
  const assessment = assessPersona(next)
  if (assessment.initialized) {
    assemblePersona(next, limits.maxPersonaChars)
  } else {
    const chars = personaCharacterCount(assessment.bodies)
    if (chars > limits.maxPersonaChars) {
      throw new PersonaError(
        'persona_character_budget_exceeded',
        `assembled persona is ${chars} characters; the budget is ${limits.maxPersonaChars}`,
      )
    }
  }

  writeAtomic(directory, file, content, limits.maxSourceBytes, {
    replace: true,
    expectedDigest,
  })

  return {
    name: file,
    bytes: bytes.length,
    digest: digestOf(bytes),
    initialized: assessment.initialized,
    pending: assessment.pending,
  }
}
