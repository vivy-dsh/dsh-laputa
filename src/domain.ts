/**
 * Persona file contract and error vocabulary shared by the reader, assembler,
 * cache, command, and plugin entry. The names mirror laputa's boundary errors
 * so a validation failure is recognizable across the two implementations.
 * @module dsh-laputa
 */

/** Persona documents in their fixed assembly order. */
export const ASSEMBLY_FILES = [
  'MISSION.MD',
  'IDENTITY.MD',
  'RELATIONSHIP.MD',
  'REDLINE.MD',
  'DREAM.MD',
  'DARK.MD',
] as const

/** One persona document name. */
export type PersonaFile = (typeof ASSEMBLY_FILES)[number]

/**
 * Files that must exist once a persona is initialized. Initialization itself is
 * gated by MISSION and IDENTITY being non-blank; the other two may exist empty.
 */
export const REQUIRED_FILES: ReadonlySet<PersonaFile> = new Set([
  'MISSION.MD',
  'IDENTITY.MD',
  'RELATIONSHIP.MD',
  'REDLINE.MD',
])

/** Files whose content decides whether the persona is initialized. */
export const CORE_FILES: readonly PersonaFile[] = ['MISSION.MD', 'IDENTITY.MD']

/** Files that may be absent entirely. */
export const OPTIONAL_FILES: ReadonlySet<PersonaFile> = new Set([
  'DREAM.MD',
  'DARK.MD',
])

/** Default per-file byte cap (64 KiB). */
export const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024

/** Default total assembled character cap (24k characters, about 6k tokens). */
export const DEFAULT_MAX_PERSONA_CHARS = 24_000

/** Stable failure codes, aligned with laputa's boundary vocabulary. */
export type PersonaErrorCode =
  | 'invalid_persona_id'
  | 'invalid_source_dir'
  | 'persona_directory_missing'
  | 'symlink_not_supported'
  | 'role_directory_mismatch'
  | 'required_file_missing'
  | 'file_open_refused'
  | 'world_writable_file_refused'
  | 'not_an_unaliased_regular_file'
  | 'source_byte_budget_exceeded'
  | 'invalid_utf8'
  | 'mission_assignment_required'
  | 'identity_assignment_required'
  | 'persona_character_budget_exceeded'
  | 'unknown_persona_file'
  | 'persona_file_changed'
  | 'revision_conflict'
  | 'revision_not_found'
  | 'revision_not_initialized'
  | 'revision_state_corrupt'
  | 'revision_lock_timeout'
  | 'revision_unavailable'

/** A persona boundary failure carrying a stable code. */
export class PersonaError extends Error {
  readonly code: PersonaErrorCode

  constructor(code: PersonaErrorCode, message: string) {
    super(message)
    this.name = 'PersonaError'
    this.code = code
  }
}

/** Render an unknown failure for logs and command output. */
export function describeError(error: unknown): string {
  if (error instanceof PersonaError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
