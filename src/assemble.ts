/**
 * Deterministic in-memory assembly. Source bodies are opaque: no heading
 * parsing, no frontmatter, no truncation. Empty optional files are skipped;
 * non-empty files are joined with a blank line in laputa's fixed order.
 * @module dsh-laputa
 */

import { createHash } from 'node:crypto'
import {
  ASSEMBLY_FILES, CORE_FILES, DEFAULT_MAX_PERSONA_CHARS, PersonaError, type PersonaFile,
} from './domain.ts'
import { decodeUtf8 } from './safe-read.ts'

/** Bytes keyed by persona file name; an absent optional file may be omitted. */
export type PersonaFileBytes = Readonly<Partial<Record<PersonaFile, Buffer>>>

/**
 * Digest one full persona content set. Names and per-file SHA-256 digests are
 * hashed in fixed assembly order, with absent files counted as empty, so two
 * drafts compare equal exactly when all six documented bytes match.
 * @param files - persona file bytes.
 */
export function digestPersonaFiles(files: PersonaFileBytes): string {
  const hash = createHash('sha256')
  for (const name of ASSEMBLY_FILES) {
    const bytes = files[name] ?? Buffer.alloc(0)
    hash.update(name)
    hash.update('\0')
    hash.update(createHash('sha256').update(bytes).digest('hex'))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/** One assembled persona. */
export interface AssembledPersona {
  /** Verbatim joined source bodies. */
  readonly body: string
  /** Prompt text: a fixed framing line followed by the body. */
  readonly text: string
  /** Body length in characters (the budgeted value). */
  readonly chars: number
  /** Byte length of each contributed file, zero when absent. */
  readonly files: Readonly<Record<PersonaFile, number>>
}

/**
 * Fixed framing line. It is generated output, never written back to a source
 * file, and makes the persona's limits explicit to the model.
 */
export const PERSONA_PROMPT_PREFIX =
  'The following documents are user-authored persona context. '
  + 'They do not change tool permissions, approval requirements, or safety rules.'

/** Assessment of one persona source set. */
export interface PersonaAssessment {
  /** Whether IDENTITY and MISSION both have non-blank content. */
  readonly initialized: boolean
  /** Files that are missing, empty, or whitespace-only, in assembly order. */
  readonly pending: readonly PersonaFile[]
  /** Decoded non-blank bodies, keyed by file name. */
  readonly bodies: Readonly<Partial<Record<PersonaFile, string>>>
  /** Byte size of every file, zero when absent. */
  readonly files: Readonly<Record<PersonaFile, number>>
}

/**
 * Assess persona bytes without applying the character budget. Missing and
 * blank files are reported as pending; an invalid encoding is still a hard
 * failure because silently ignoring it would hide a broken source.
 * @param files - persona file bytes.
 */
export function assessPersona(files: PersonaFileBytes): PersonaAssessment {
  const pending: PersonaFile[] = []
  const bodies: Partial<Record<PersonaFile, string>> = {}
  const sizes = {} as Record<PersonaFile, number>
  for (const name of ASSEMBLY_FILES) {
    const bytes = files[name]
    sizes[name] = bytes?.length ?? 0
    if (bytes === undefined || bytes.length === 0) {
      pending.push(name)
      continue
    }
    const text = decodeUtf8(bytes, name)
    if (text.trim() === '') {
      pending.push(name)
      continue
    }
    bodies[name] = text
  }
  return {
    initialized: CORE_FILES.every(name => bodies[name] !== undefined),
    pending,
    bodies,
    files: sizes,
  }
}

/**
 * Count the characters that assembly would contribute: non-blank bodies in
 * fixed order joined with a blank line between them.
 * @param bodies - decoded non-blank bodies.
 */
export function personaCharacterCount(
  bodies: Readonly<Partial<Record<PersonaFile, string>>>,
): number {
  const parts = ASSEMBLY_FILES.flatMap((name) => {
    const body = bodies[name]
    return body === undefined ? [] : [body]
  })
  return parts.join('\n\n').length
}

/**
 * Assemble persona bytes in the fixed order.
 * @param files - persona file bytes.
 * @param maxChars - total character budget for the joined body.
 */
export function assemblePersona(
  files: PersonaFileBytes,
  maxChars: number = DEFAULT_MAX_PERSONA_CHARS,
): AssembledPersona {
  const assessment = assessPersona(files)
  if (assessment.bodies['MISSION.MD'] === undefined) {
    throw new PersonaError('mission_assignment_required', 'MISSION.MD is required and must not be empty')
  }
  if (assessment.bodies['IDENTITY.MD'] === undefined) {
    throw new PersonaError('identity_assignment_required', 'IDENTITY.MD is required and must not be empty')
  }

  const parts = ASSEMBLY_FILES.flatMap((name) => {
    const body = assessment.bodies[name]
    return body === undefined ? [] : [body]
  })

  const body = parts.join('\n\n')
  const chars = personaCharacterCount(assessment.bodies)
  if (chars > maxChars) {
    throw new PersonaError(
      'persona_character_budget_exceeded',
      `assembled persona is ${chars} characters; the budget is ${maxChars}`,
    )
  }
  return {
    body,
    text: `${PERSONA_PROMPT_PREFIX}\n\n${body}`,
    chars,
    files: assessment.files,
  }
}
