/**
 * Immutable persona revisions.
 *
 * The persona directory remains the editable draft. Published revisions live
 * outside it, under the DSH state directory, as numbered directories that are
 * written once and never modified. `current.json` is the live pointer; a
 * publish is a compare-and-swap on its revision number, and a rollback copies
 * an older revision into a new one instead of overwriting history. An optional
 * retention window prunes old revisions after the new pointer is committed.
 * @module dsh-laputa
 */

import {
  chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  ASSEMBLY_FILES, PersonaError, type PersonaFile,
} from './domain.ts'
import {
  assemblePersona, assessPersona, digestPersonaFiles, personaCharacterCount,
  type AssembledPersona, type PersonaFileBytes,
} from './assemble.ts'
import {
  ensurePersonaDirectory, assertPersonaContainment, type PersonaBinding,
} from './binding.ts'
import {
  atomicWriteFile, digestOf, fsyncDirectory, LockBusyError, withFileLock, writeJsonAtomic,
} from './atomic.ts'
import { readPersonaDirectory, safeRead } from './safe-read.ts'
import type { PersonaLimits } from './cache.ts'

/** Revision schema version. */
export const REVISION_SCHEMA_VERSION = 1
/** Live pointer file name. */
export const CURRENT_FILE = 'current.json'
/** Directory holding immutable revisions. */
export const REVISIONS_DIR = 'revisions'
/** Per-revision manifest file name. */
export const MANIFEST_FILE = 'manifest.json'
/** Advisory lock file name. */
export const LOCK_FILE = '.revision.lock'

const HEX_DIGEST = /^[0-9a-f]{64}$/

/** Who asked for a revision; the note says what the request was. */
export const REVISION_ACTORS = ['panel', 'tool', 'command', 'bootstrap'] as const
export type RevisionActor = typeof REVISION_ACTORS[number]
export interface RevisionSource {
  readonly actor: RevisionActor
  readonly note?: string
}

/** One file entry in a revision manifest. */
export interface RevisionFileEntry {
  readonly bytes: number
  readonly digest: string
}

/** Immutable description of one published revision. */
export interface RevisionManifest {
  readonly schemaVersion: number
  readonly personaId: string
  readonly revision: number
  readonly parent: number | null
  readonly restoredFrom: number | null
  readonly createdAt: string
  readonly contentDigest: string
  readonly files: Readonly<Record<PersonaFile, RevisionFileEntry>>
  readonly source?: RevisionSource
}

/** The live revision pointer. */
export interface CurrentPointer {
  readonly schemaVersion: number
  readonly revision: number
  readonly directory: string
  readonly manifestDigest: string
  readonly updatedAt: string
}

/** One fully loaded and verified revision. */
export interface LoadedRevision {
  readonly revision: number
  readonly directory: string
  readonly manifest: RevisionManifest
  readonly manifestDigest: string
  readonly files: Readonly<Record<PersonaFile, Buffer>>
  readonly assembled: AssembledPersona
}

/** One row of revision history. */
export interface RevisionSummary {
  readonly revision: number
  readonly createdAt: string
  readonly parent: number | null
  readonly restoredFrom: number | null
  readonly contentDigest: string
  readonly current: boolean
  readonly source?: RevisionSource
}

/** Draft state used for publishing. */
export interface DraftState {
  readonly files: Readonly<Record<PersonaFile, Buffer>>
  readonly digest: string
  readonly initialized: boolean
  readonly pending: readonly PersonaFile[]
  readonly assembled: AssembledPersona | null
  readonly chars: number
}

/** Compare-and-swap publish input. */
export interface PublishInput {
  readonly expectedBaseRevision: number | null
  readonly expectedDraftDigest: string
  readonly source?: RevisionSource
}

/** Publish or rollback result. */
export interface PublishResult {
  readonly current: LoadedRevision
  readonly created: boolean
}

/** Rollback input. */
export interface RollbackInput extends PublishInput {
  readonly targetRevision: number
  readonly source?: RevisionSource
}

function corrupt(message: string): PersonaError {
  return new PersonaError('revision_state_corrupt', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HEX_DIGEST.test(value)) {
    throw corrupt(`${label} is not a sha256 digest`)
  }
  return value
}

function requireCounter(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw corrupt(`${label} is not a positive integer`)
  }
  return value
}

function requireParent(value: unknown, label: string): number | null {
  if (value === null) return null
  return requireCounter(value, label)
}

function requireFileEntry(value: unknown, label: string): RevisionFileEntry {
  if (!isRecord(value)) throw corrupt(`${label} is not a file entry`)
  return {
    bytes: value.bytes === 0 ? 0 : requireCounter(value.bytes, `${label}.bytes`),
    digest: requireDigest(value.digest, `${label}.digest`),
  }
}

function parseSource(value: unknown, label: string): RevisionSource | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw corrupt(`${label} source is not an object`)
  if (typeof value.actor !== 'string' || !(REVISION_ACTORS as readonly string[]).includes(value.actor)) {
    throw corrupt(`${label} source names an unknown actor`)
  }
  let note: string | undefined
  if (value.note !== undefined) {
    if (typeof value.note !== 'string' || value.note.trim() === '') throw corrupt(`${label} source note is empty`)
    note = value.note
  }
  return note === undefined ? { actor: value.actor as RevisionActor } : { actor: value.actor as RevisionActor, note }
}

function parseManifest(raw: string, expectedRevision: number, personaId: string): RevisionManifest {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw corrupt(`revision r${expectedRevision} manifest is not valid JSON`)
  }
  if (!isRecord(value)) throw corrupt(`revision r${expectedRevision} manifest is not an object`)
  if (value.schemaVersion !== REVISION_SCHEMA_VERSION) {
    throw corrupt(`revision r${expectedRevision} has an unsupported schema version`)
  }
  if (value.personaId !== personaId) {
    throw corrupt(`revision r${expectedRevision} belongs to another persona`)
  }
  if (value.revision !== expectedRevision) {
    throw corrupt(`revision r${expectedRevision} manifest names another revision`)
  }
  if (value.createdAt === undefined || typeof value.createdAt !== 'string') {
    throw corrupt(`revision r${expectedRevision} has no createdAt`)
  }
  const parent = requireParent(value.parent, `revision r${expectedRevision} parent`)
  const restoredFrom = requireParent(value.restoredFrom, `revision r${expectedRevision} restoredFrom`)
  const contentDigest = requireDigest(value.contentDigest, `revision r${expectedRevision} contentDigest`)
  if (!isRecord(value.files)) throw corrupt(`revision r${expectedRevision} has no files`)

  const files = {} as Record<PersonaFile, RevisionFileEntry>
  for (const name of ASSEMBLY_FILES) {
    files[name] = requireFileEntry(value.files[name], `revision r${expectedRevision} ${name}`)
  }
  if (Object.keys(value.files).length !== ASSEMBLY_FILES.length) {
    throw corrupt(`revision r${expectedRevision} manifest has unexpected files`)
  }
  const source = parseSource(value.source, `revision r${expectedRevision}`)

  return {
    schemaVersion: REVISION_SCHEMA_VERSION,
    personaId,
    revision: expectedRevision,
    parent,
    restoredFrom,
    createdAt: value.createdAt,
    contentDigest,
    files,
    ...(source === undefined ? {} : { source }),
  }
}

function parsePointer(raw: string): CurrentPointer {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw corrupt(`${CURRENT_FILE} is not valid JSON`)
  }
  if (!isRecord(value)) throw corrupt(`${CURRENT_FILE} is not an object`)
  if (value.schemaVersion !== REVISION_SCHEMA_VERSION) {
    throw corrupt(`${CURRENT_FILE} has an unsupported schema version`)
  }
  const revision = requireCounter(value.revision, `${CURRENT_FILE} revision`)
  if (value.directory !== revisionName(revision)) {
    throw corrupt(`${CURRENT_FILE} names an unexpected directory`)
  }
  if (value.updatedAt === undefined || typeof value.updatedAt !== 'string') {
    throw corrupt(`${CURRENT_FILE} has no updatedAt`)
  }
  return {
    schemaVersion: REVISION_SCHEMA_VERSION,
    revision,
    directory: revisionName(revision),
    manifestDigest: requireDigest(value.manifestDigest, `${CURRENT_FILE} manifestDigest`),
    updatedAt: value.updatedAt,
  }
}

/** Directory name for a revision number. */
export function revisionName(revision: number): string {
  return `r${String(revision).padStart(6, '0')}`
}

/**
 * Read and assess the draft without touching revision state.
 * @param binding - resolved persona source.
 * @param limits - per-file and total budgets.
 */
export function readPersonaDraft(binding: PersonaBinding, limits: PersonaLimits): DraftState {
  const files = {} as Record<PersonaFile, Buffer>
  let exists = true
  try {
    lstatSync(binding.directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PersonaError('file_open_refused', `cannot inspect persona directory ${binding.directory}: ${String(error)}`)
    }
    exists = false
  }

  if (exists) {
    const canonical = readPersonaDirectory(binding.directory)
    assertPersonaContainment(binding, canonical)
    for (const name of ASSEMBLY_FILES) {
      files[name] = safeRead(join(binding.directory, name), limits.maxSourceBytes, true).bytes
    }
  } else {
    for (const name of ASSEMBLY_FILES) files[name] = Buffer.alloc(0)
  }

  const assessment = assessPersona(files as PersonaFileBytes)
  const digest = digestPersonaFiles(files as PersonaFileBytes)
  const chars = personaCharacterCount(assessment.bodies)
  if (assessment.initialized) {
    const assembled = assemblePersona(files as PersonaFileBytes, limits.maxPersonaChars)
    return {
      files,
      digest,
      initialized: true,
      pending: [],
      assembled,
      chars,
    }
  }
  if (chars > limits.maxPersonaChars) {
    throw new PersonaError(
      'persona_character_budget_exceeded',
      `assembled persona is ${chars} characters; the budget is ${limits.maxPersonaChars}`,
    )
  }
  return {
    files,
    digest,
    initialized: false,
    pending: assessment.pending,
    assembled: null,
    chars,
  }
}

/** Revision store bound to one persona and one state directory. */
export class RevisionStore {
  readonly currentPath: string
  readonly revisionsPath: string
  readonly lockPath: string

  constructor(
    readonly binding: PersonaBinding,
    readonly stateDirectory: string,
    readonly limits: PersonaLimits,
  ) {
    this.currentPath = join(stateDirectory, CURRENT_FILE)
    this.revisionsPath = join(stateDirectory, REVISIONS_DIR)
    this.lockPath = join(stateDirectory, LOCK_FILE)
  }

  /** Absolute directory of one revision. */
  revisionDirectory(revision: number): string {
    return join(this.revisionsPath, revisionName(revision))
  }

  /**
   * Read the live pointer, or `null` when no state exists. A pointer that
   * exists but is malformed fails as corruption; it is never ignored.
   */
  readCurrent(): CurrentPointer | null {
    if (!this.stateDirectoryExists()) return null
    let raw: string
    try {
      raw = readFileSync(this.currentPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw corrupt(`cannot read ${CURRENT_FILE}: ${String(error)}`)
    }
    return parsePointer(raw)
  }

  /** Load and verify the live revision, or `null` before the first publish. */
  loadCurrent(): LoadedRevision | null {
    const pointer = this.readCurrent()
    if (pointer === null) return null
    return this.readRevisionAt(pointer.revision, 'revision_state_corrupt', pointer)
  }

  /** Load and verify one revision. */
  readRevision(revision: number): LoadedRevision {
    return this.readRevisionAt(revision, 'revision_not_found')
  }

  /** Count revision directories without loading their contents. */
  count(): number {
    return this.revisionNumbers().length
  }

  /** List every verified revision in ascending order. */
  list(): RevisionSummary[] {
    const current = this.readCurrent()
    const revisions = this.revisionNumbers()
      .sort((left, right) => left - right)
      .map((revision) => {
        const loaded = this.readRevisionAt(revision, 'revision_state_corrupt')
        return {
          revision,
          createdAt: loaded.manifest.createdAt,
          parent: loaded.manifest.parent,
          restoredFrom: loaded.manifest.restoredFrom,
          contentDigest: loaded.manifest.contentDigest,
          current: current?.revision === revision,
          ...(loaded.manifest.source === undefined ? {} : { source: loaded.manifest.source }),
        }
      })
    return revisions
  }

  /**
   * Adopt existing state, publish the initialized draft as r1, or return
   * `null` while the draft is uninitialized. State is only created once the
   * draft has content.
   */
  bootstrapFromDraft(): LoadedRevision | null {
    const pointer = this.readCurrent()
    if (pointer !== null) return this.loadCurrent()

    const highest = this.highestRevisionNumber()
    if (highest !== null) {
      return this.withStateLock(() => {
        const again = this.readCurrent()
        if (again !== null) return this.loadCurrent()
        this.cleanupTempsUnlocked()
        const recoveredHighest = this.highestRevisionNumber() ?? highest
        const loaded = this.readRevisionAt(recoveredHighest, 'revision_state_corrupt')
        this.writePointer(loaded)
        return loaded
      })
    }

    const draft = readPersonaDraft(this.binding, this.limits)
    if (!draft.initialized || draft.assembled === null) return null
    const assembled = draft.assembled

    return this.withStateLock(() => {
      const again = this.readCurrent()
      if (again !== null) return this.loadCurrent()
      this.cleanupTempsUnlocked()
      const race = this.highestRevisionNumber()
      if (race !== null) {
        const loaded = this.readRevisionAt(race, 'revision_state_corrupt')
        this.writePointer(loaded)
        return loaded
      }
      const created = this.createRevisionUnlocked({
        files: draft.files,
        digest: draft.digest,
        assembled,
      }, null, null, { actor: 'bootstrap' })
      this.writePointer(created)
      return created
    })
  }

  /**
   * Publish the draft as a new revision. The caller's expected base and draft
   * digest are both checked under the state lock; identical content is a
   * no-op instead of a new revision.
   */
  publish(input: PublishInput): PublishResult {
    return this.withStateLock(() => {
      this.cleanupTempsUnlocked()
      const current = this.loadCurrent()
      const base = current?.revision ?? null
      if (input.expectedBaseRevision !== base) {
        throw new PersonaError(
          'revision_conflict',
          `current revision is ${base ?? 'none'}, not ${input.expectedBaseRevision ?? 'none'}`,
        )
      }

      const draft = readPersonaDraft(this.binding, this.limits)
      if (!draft.initialized || draft.assembled === null) {
        throw new PersonaError('revision_not_initialized', 'draft must be initialized before publishing')
      }
      if (draft.digest !== input.expectedDraftDigest) {
        throw new PersonaError('persona_file_changed', 'draft changed before publishing')
      }
      if (current !== null && current.manifest.contentDigest === draft.digest) {
        return { current, created: false }
      }

      const prune = this.retentionCandidates()
      this.verifyRetentionCandidates(prune)

      const created = this.createRevisionUnlocked({
        files: draft.files,
        digest: draft.digest,
        assembled: draft.assembled,
      }, base, null, input.source)
      this.writePointer(created)
      this.deleteRetainedOut(prune)
      return { current: created, created: true }
    })
  }

  /**
   * Restore an older revision as a new revision, then restore the draft to the
   * same content so the next publish cannot silently reintroduce the draft.
   */
  rollback(input: RollbackInput): PublishResult {
    return this.withStateLock(() => {
      this.cleanupTempsUnlocked()
      const pointer = this.readCurrent()
      if (pointer === null) {
        throw new PersonaError('revision_not_found', 'there is no current revision to roll back from')
      }
      const current = this.loadCurrent()
      if (current === null) {
        throw new PersonaError('revision_not_found', 'there is no current revision to roll back from')
      }
      if (input.expectedBaseRevision !== current.revision) {
        throw new PersonaError(
          'revision_conflict',
          `current revision is ${current.revision}, not ${input.expectedBaseRevision}`,
        )
      }

      const target = this.readRevisionAt(input.targetRevision, 'revision_not_found')
      const draft = readPersonaDraft(this.binding, this.limits)
      if (draft.digest !== input.expectedDraftDigest) {
        throw new PersonaError('persona_file_changed', 'draft changed before rolling back')
      }
      if (target.manifest.contentDigest === current.manifest.contentDigest) {
        return { current, created: false }
      }

      const prune = this.retentionCandidates()
      this.verifyRetentionCandidates(prune)

      const created = this.createRevisionUnlocked({
        files: target.files,
        digest: target.manifest.contentDigest,
        assembled: target.assembled,
      }, current.revision, input.targetRevision, input.source)
      this.writePointer(created)

      const directory = ensurePersonaDirectory(this.binding)
      for (const name of ASSEMBLY_FILES) {
        atomicWriteFile(join(directory, name), target.files[name], { mode: 0o600 })
      }
      this.deleteRetainedOut(prune)
      return { current: created, created: true }
    })
  }

  private stateDirectoryExists(): boolean {
    let info
    try {
      info = lstatSync(this.stateDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw corrupt(`cannot inspect revision state directory: ${String(error)}`)
    }
    if (info.isSymbolicLink()) throw corrupt('revision state directory is a symlink')
    if (!info.isDirectory()) throw corrupt('revision state directory is not a directory')
    if ((info.mode & 0o002) !== 0) throw corrupt('revision state directory is world-writable')
    return true
  }

  private ensureStateDirectory(): void {
    if (this.stateDirectoryExists()) {
      chmodSync(this.stateDirectory, 0o700)
      return
    }
    mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 })
    chmodSync(this.stateDirectory, 0o700)
    fsyncDirectory(dirname(this.stateDirectory))
  }

  private withStateLock<T>(fn: () => T): T {
    this.ensureStateDirectory()
    try {
      return withFileLock(this.lockPath, fn)
    } catch (error) {
      if (error instanceof LockBusyError) {
        throw new PersonaError('revision_lock_timeout', error.message)
      }
      throw error
    }
  }

  private revisionNumbers(): number[] {
    if (!this.stateDirectoryExists()) return []
    let entries: string[]
    try {
      entries = readdirSync(this.revisionsPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw corrupt(`cannot list revisions: ${String(error)}`)
    }
    const numbers = new Set<number>()
    for (const entry of entries) {
      const match = /^r(\d{6,})$/.exec(entry)
      if (match === null) continue
      const value = Number(match[1])
      if (Number.isSafeInteger(value) && value > 0) numbers.add(value)
    }
    return [...numbers]
  }

  private highestRevisionNumber(): number | null {
    const numbers = this.revisionNumbers()
    return numbers.length === 0 ? null : Math.max(...numbers)
  }

  /**
   * Revisions that fall outside the retention window. `retain` counts the
   * revision about to be created, so only the newest `retain - 1` existing
   * revisions survive.
   */
  private retentionCandidates(): number[] {
    const retain = this.limits.retainRevisions ?? 0
    if (retain <= 0) return []
    return this.revisionNumbers()
      .sort((left, right) => right - left)
      .slice(Math.max(0, retain - 1))
  }

  /**
   * Verify every candidate before anything is created. A corrupt candidate
   * aborts the publish or rollback with `revision_state_corrupt`, so the
   * operation never commits a pointer to state that pruning cannot safely
   * delete.
   */
  private verifyRetentionCandidates(candidates: readonly number[]): void {
    for (const revision of candidates) {
      this.readRevisionAt(revision, 'revision_state_corrupt')
    }
  }

  /** Delete pruned revisions and fsync the revisions directory. */
  private deleteRetainedOut(candidates: readonly number[]): void {
    if (candidates.length === 0) return
    for (const revision of candidates) {
      rmSync(this.revisionDirectory(revision), { recursive: true, force: true })
    }
    fsyncDirectory(this.revisionsPath)
  }

  private cleanupTempsUnlocked(): void {
    let entries: string[]
    try {
      entries = readdirSync(this.revisionsPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw corrupt(`cannot list revisions: ${String(error)}`)
    }
    for (const entry of entries) {
      if (!entry.startsWith('.') || !entry.endsWith('.tmp')) continue
      rmSync(join(this.revisionsPath, entry), { recursive: true, force: true })
    }
  }

  private readRevisionAt(
    revision: number,
    missingCode: 'revision_not_found' | 'revision_state_corrupt',
    pointer?: CurrentPointer,
  ): LoadedRevision {
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new PersonaError(missingCode, `invalid revision number: ${String(revision)}`)
    }
    if (!this.stateDirectoryExists()) {
      throw new PersonaError(missingCode, `revision ${revision} does not exist`)
    }

    const directory = this.revisionDirectory(revision)
    let info
    try {
      info = lstatSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PersonaError(missingCode, `revision ${revision} does not exist`)
      }
      throw corrupt(`cannot inspect revision ${revision}: ${String(error)}`)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw corrupt(`revision ${revision} is not a real directory`)
    }

    let manifestRaw: string
    try {
      manifestRaw = readFileSync(join(directory, MANIFEST_FILE), 'utf8')
    } catch (error) {
      throw corrupt(`cannot read revision ${revision} manifest: ${String(error)}`)
    }
    const manifest = parseManifest(manifestRaw, revision, this.binding.personaId)
    const manifestDigest = digestOf(manifestRaw)
    if (pointer !== undefined) {
      if (pointer.manifestDigest !== manifestDigest) {
        throw corrupt(`revision ${revision} does not match ${CURRENT_FILE}`)
      }
    }

    const files = {} as Record<PersonaFile, Buffer>
    for (const name of ASSEMBLY_FILES) {
      let read
      try {
        read = safeRead(join(directory, name), this.limits.maxSourceBytes, false)
      } catch (error) {
        throw corrupt(`revision ${revision} ${name} is unreadable: ${String(error)}`)
      }
      const entry = manifest.files[name]
      if (read.bytes.length !== entry.bytes || read.digest !== entry.digest) {
        throw corrupt(`revision ${revision} ${name} does not match its manifest`)
      }
      files[name] = read.bytes
    }
    if (digestPersonaFiles(files as PersonaFileBytes) !== manifest.contentDigest) {
      throw corrupt(`revision ${revision} content digest does not match`)
    }

    let assembled
    try {
      assembled = assemblePersona(files as PersonaFileBytes, this.limits.maxPersonaChars)
    } catch (error) {
      throw corrupt(`revision ${revision} cannot be assembled: ${String(error)}`)
    }
    return {
      revision,
      directory,
      manifest,
      manifestDigest,
      files,
      assembled,
    }
  }

  private createRevisionUnlocked(
    content: Pick<DraftState, 'files' | 'digest' | 'assembled'> & { assembled: AssembledPersona },
    parent: number | null,
    restoredFrom: number | null,
    source?: RevisionSource,
  ): LoadedRevision {
    const current = this.readCurrent()
    const next = Math.max(
      current?.revision ?? 0,
      this.highestRevisionNumber() ?? 0,
    ) + 1
    const name = revisionName(next)
    const finalDirectory = join(this.revisionsPath, name)
    const tempDirectory = join(
      this.revisionsPath,
      `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    )

    mkdirSync(tempDirectory, { recursive: true, mode: 0o700 })
    try {
      const files = {} as Record<PersonaFile, RevisionFileEntry>
      for (const file of ASSEMBLY_FILES) {
        const bytes = content.files[file] ?? Buffer.alloc(0)
        atomicWriteFile(join(tempDirectory, file), bytes, { mode: 0o600 })
        files[file] = { bytes: bytes.length, digest: digestOf(bytes) }
      }

      const manifest: RevisionManifest = {
        schemaVersion: REVISION_SCHEMA_VERSION,
        personaId: this.binding.personaId,
        revision: next,
        parent,
        restoredFrom,
        createdAt: new Date().toISOString(),
        contentDigest: content.digest,
        files,
        ...(source === undefined ? {} : { source }),
      }
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
      atomicWriteFile(join(tempDirectory, MANIFEST_FILE), manifestText, { mode: 0o600 })
      fsyncDirectory(tempDirectory)
      renameSync(tempDirectory, finalDirectory)
      fsyncDirectory(this.revisionsPath)

      return {
        revision: next,
        directory: finalDirectory,
        manifest,
        manifestDigest: digestOf(manifestText),
        files: content.files,
        assembled: content.assembled,
      }
    } catch (error) {
      rmSync(tempDirectory, { recursive: true, force: true })
      throw error
    }
  }

  private writePointer(loaded: LoadedRevision): void {
    writeJsonAtomic(this.currentPath, {
      schemaVersion: REVISION_SCHEMA_VERSION,
      revision: loaded.revision,
      directory: revisionName(loaded.revision),
      manifestDigest: loaded.manifestDigest,
      updatedAt: new Date().toISOString(),
    })
  }
}
