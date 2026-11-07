/**
 * Persona cache with last-known-good behavior.
 *
 * With a revision store the injected text comes from the live revision and a
 * draft edit never changes it until someone publishes. Without a store the
 * legacy behavior applies: the draft directory itself is the source, re-read
 * when its fingerprint changes. A missing directory or blank core files are a
 * normal `uninitialized` state that drives guided setup, not a failure. A
 * failed read (permissions, symlink, invalid UTF-8, budget) keeps the last
 * good text so a manual edit cannot break a live session; the error is
 * recorded for `/laputa status` and `/laputa validate`.
 * @module dsh-laputa
 */

import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSEMBLY_FILES, DEFAULT_MAX_PERSONA_CHARS, DEFAULT_MAX_SOURCE_BYTES,
  describeError, PersonaError, type PersonaFile,
} from './domain.ts'
import type { AssembledPersona } from './assemble.ts'
import type { PersonaBinding } from './binding.ts'
import { renderOnboarding } from './onboarding.ts'
import {
  readPersonaDraft, RevisionStore,
  type DraftState, type LoadedRevision, type PublishInput, type PublishResult,
  type RevisionSummary, type RollbackInput,
} from './revision.ts'

/** Cache limits from plugin configuration. */
export interface PersonaLimits {
  readonly maxSourceBytes: number
  readonly maxPersonaChars: number
  /** Retention window for revisions; 0 or absent keeps every revision. */
  readonly retainRevisions?: number
}

/** One read of the persona source, initialized or not. */
export type PersonaReadOutcome =
  | {
    readonly status: 'initialized'
    readonly assembled: AssembledPersona
    readonly fingerprint: string
  }
  | {
    readonly status: 'uninitialized'
    readonly pending: readonly PersonaFile[]
    readonly files: Readonly<Record<PersonaFile, number>>
    readonly fingerprint: string
  }

/** Observable cache state for `/laputa status`. */
export interface PersonaStatus {
  readonly enabled: boolean
  readonly loaded: boolean
  readonly initialized: boolean
  readonly personaId: string
  readonly directory: string
  readonly customSource: boolean
  readonly files: Readonly<Record<PersonaFile, number>>
  readonly chars: number
  readonly fingerprint: string
  readonly pendingFiles: readonly PersonaFile[]
  readonly lastError?: string
  readonly lastLoadedAt?: string
  readonly pendingChanges: boolean
  readonly stale: boolean
  /** Live revision, or `null` before the first publish. */
  readonly revision: number | null
  /** Live revision content digest. */
  readonly liveDigest: string | null
  /** Draft content digest; empty when the draft cannot be read. */
  readonly draftDigest: string
  /** Whether the draft itself has IDENTITY and MISSION content. */
  readonly draftInitialized: boolean
  /** Draft assembled character count. */
  readonly draftChars: number
  /** Draft files still missing or blank. */
  readonly draftPendingFiles: readonly PersonaFile[]
  /** Whether the draft differs from the live revision. */
  readonly revisionPending: boolean
  /** Number of published revisions. */
  readonly revisionCount: number
  /** Configured retention window for revisions; 0 keeps every revision. */
  readonly revisionRetention: number
  /** Revision state directory, or `null` without a store. */
  readonly stateDirectory: string | null
}

interface StableSnapshot {
  readonly outcome: PersonaReadOutcome
  readonly fingerprint: string
  readonly revision: number | null
  readonly liveDigest: string | null
  readonly draftDigest: string
  readonly draftInitialized: boolean
  readonly draftPendingFiles: readonly PersonaFile[]
  readonly draftChars: number
  readonly revisionPending: boolean
}

/** Persona text pinned at agent install time. */
export interface PersonaSession {
  /** Revision the session was pinned to, or `null` without a store. */
  readonly revision: number | null
  /** Pinned persona prompt text. */
  promptText(): string
  /** Pinned onboarding text. */
  onboardingText(): string
  /** Adopt the current live revision. */
  refresh(): void
}

interface SessionSnapshot {
  readonly text: string
  readonly onboarding: string
  readonly revision: number | null
}

const ZERO_FILES = Object.freeze(
  Object.fromEntries(ASSEMBLY_FILES.map(name => [name, 0])) as Record<PersonaFile, number>,
)

function fileSizes(files: Readonly<Record<PersonaFile, Buffer>>): Record<PersonaFile, number> {
  return Object.fromEntries(
    ASSEMBLY_FILES.map(name => [name, files[name].length]),
  ) as Record<PersonaFile, number>
}

function isRevisionStateError(error: unknown): boolean {
  return error instanceof PersonaError
    && (error.code === 'revision_state_corrupt' || error.code === 'revision_lock_timeout')
}

/**
 * Fingerprint the directory and files without reading contents. Inode, size,
 * mtime, ctime, mode, and link count catch replacements, permission flips, and
 * edits even when a writer preserves the old mtime.
 */
function fingerprintOf(directory: string): string {
  const hash = createHash('sha256')
  try {
    const info = lstatSync(directory)
    hash.update(`dir:${info.ino}:${info.mode}:${info.mtimeMs}:${info.ctimeMs}`)
  } catch (error) {
    hash.update(`dir:error:${(error as NodeJS.ErrnoException).code ?? String(error)}`)
  }
  for (const name of ASSEMBLY_FILES) {
    try {
      const info = lstatSync(join(directory, name))
      hash.update(`\n${name}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}:${info.nlink}`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      hash.update(`\n${name}:${code === 'ENOENT' ? 'missing' : `error:${code ?? String(error)}`}`)
    }
  }
  return hash.digest('hex')
}

/** Persona cache bound to one resolved source. */
export class PersonaCache {
  private current: StableSnapshot | undefined
  private lastError: string | undefined
  private lastLoadedAt: string | undefined
  private warnedFingerprint: string | undefined
  private disabled = false
  private readonly sessions = new Map<unknown, PersonaSession>()

  constructor(
    readonly binding: PersonaBinding,
    readonly limits: PersonaLimits,
    private readonly warn: (message: string) => void = () => {},
    readonly revisions?: RevisionStore,
  ) {}

  /** Mark the plugin disabled; the providers contribute nothing. */
  markDisabled(): void {
    this.disabled = true
  }

  /**
   * Read and assemble now. Uninitialized sources return normally; draft
   * boundary failures throw so activation still reports a broken
   * configuration. Revision-state failures are recorded and fall back to the
   * last good text (or guided setup) instead of blocking activation.
   */
  load(): PersonaReadOutcome {
    this.disabled = false
    if (this.revisions !== undefined) {
      try {
        this.revisions.bootstrapFromDraft()
        const snapshot = this.readStoreSnapshot()
        this.commit(snapshot)
        return snapshot.outcome
      } catch (error) {
        if (!isRevisionStateError(error)) throw error
        this.recordError(error, 'load')
        return this.fallbackAfterRevisionError()
      }
    }

    const snapshot = this.readDraftSnapshot()
    this.commit(snapshot)
    return snapshot.outcome
  }

  /** Force a re-read, replacing the last-known-good value. */
  reload(): PersonaReadOutcome {
    this.disabled = false
    if (this.revisions !== undefined) {
      this.revisions.bootstrapFromDraft()
      const snapshot = this.readStoreSnapshot()
      this.commit(snapshot)
      return snapshot.outcome
    }
    return this.load()
  }

  /** Validate without changing the cache. */
  validate(): PersonaReadOutcome {
    if (this.revisions !== undefined) return this.readStoreSnapshot().outcome
    return this.readDraftSnapshot().outcome
  }

  /**
   * Synchronous persona provider. Never throws: an invalid edit keeps the last
   * good text and is recorded for the commands. Returns an empty string while
   * the persona is uninitialized.
   */
  promptText(): string {
    if (this.disabled) return ''
    this.refreshIfNeeded()
    const current = this.current?.outcome
    return current?.status === 'initialized' ? current.assembled.text : ''
  }

  /**
   * Synchronous onboarding provider. Returns instructions while the persona is
   * uninitialized and an empty string once it is initialized.
   */
  onboardingText(): string {
    if (this.disabled) return ''
    this.refreshIfNeeded()
    const current = this.current?.outcome
    return current?.status === 'uninitialized' ? renderOnboarding(current.pending) : ''
  }

  /** Snapshot the current state for display. */
  status(): PersonaStatus {
    const snapshot = this.current
    const store = this.revisions
    const draft = this.readDraftForStatus()
    const revisionCount = this.countRevisions()

    let revisionPending = false
    if (store !== undefined && draft !== undefined && snapshot !== undefined) {
      revisionPending = snapshot.revision === null
        ? draft.initialized
        : draft.digest !== snapshot.liveDigest
    }

    let pendingChanges = revisionPending
    if (store === undefined && !this.disabled && snapshot !== undefined) {
      try {
        pendingChanges = fingerprintOf(this.binding.directory) !== snapshot.fingerprint
      } catch {
        pendingChanges = true
      }
    }

    const outcome = snapshot?.outcome
    return {
      enabled: !this.disabled,
      loaded: snapshot !== undefined,
      initialized: outcome?.status === 'initialized',
      personaId: this.binding.personaId,
      directory: this.binding.directory,
      customSource: this.binding.custom,
      files: outcome?.status === 'initialized' ? outcome.assembled.files : outcome?.files ?? ZERO_FILES,
      chars: outcome?.status === 'initialized' ? outcome.assembled.chars : 0,
      fingerprint: snapshot?.fingerprint ?? '',
      pendingFiles: outcome?.status === 'uninitialized' ? outcome.pending : [],
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.lastLoadedAt === undefined ? {} : { lastLoadedAt: this.lastLoadedAt }),
      pendingChanges,
      stale: this.lastError !== undefined || pendingChanges,
      revision: snapshot?.revision ?? null,
      liveDigest: snapshot?.liveDigest ?? null,
      draftDigest: draft?.digest ?? '',
      draftInitialized: draft?.initialized ?? false,
      draftChars: draft?.chars ?? 0,
      draftPendingFiles: draft?.pending ?? [],
      revisionPending,
      revisionCount,
      revisionRetention: this.limits.retainRevisions ?? 0,
      stateDirectory: store?.stateDirectory ?? null,
    }
  }

  /**
   * Publish the draft as a new revision and refresh the live view.
   * @param input - expected base revision and draft digest.
   */
  publishDraft(input: PublishInput): PublishResult {
    const result = this.requireStore().publish(input)
    this.reload()
    return result
  }

  /**
   * Restore an older revision as a new revision and refresh the live view.
   * @param input - target, expected base revision, and draft digest.
   */
  rollbackTo(input: RollbackInput): PublishResult {
    const result = this.requireStore().rollback(input)
    this.reload()
    return result
  }

  /** Load the live revision without changing the cache. */
  currentRevision(): LoadedRevision | null {
    return this.requireStore().loadCurrent()
  }

  /** List verified revision history in ascending order. */
  listRevisions(): RevisionSummary[] {
    return this.requireStore().list()
  }

  /** Load one verified revision without changing the cache. */
  readRevision(revision: number): LoadedRevision {
    return this.requireStore().readRevision(revision)
  }

  /**
   * Pin the current text for one agent. The pin never changes on publish or on
   * a draft edit; only `refresh()` adopts the current live revision.
   * @param key - agent identity used for release and targeted refresh.
   */
  session(key: unknown): PersonaSession {
    const existing = this.sessions.get(key)
    if (existing !== undefined) return existing

    let snapshot = this.captureSession()
    const session: PersonaSession = {
      get revision() { return snapshot.revision },
      promptText: () => snapshot.text,
      onboardingText: () => snapshot.onboarding,
      refresh: () => {
        this.refreshIfNeeded()
        snapshot = this.captureSession()
      },
    }
    this.sessions.set(key, session)
    return session
  }

  /**
   * Refresh one pinned session, or every session when no key is given.
   * @param key - agent identity, if only one session should move.
   */
  refreshSessions(key?: unknown): void {
    if (key !== undefined) {
      this.sessions.get(key)?.refresh()
      return
    }
    for (const session of this.sessions.values()) session.refresh()
  }

  /** Drop the pin for a disposed agent. */
  releaseSession(key: unknown): void {
    this.sessions.delete(key)
  }

  private captureSession(): SessionSnapshot {
    this.refreshIfNeeded()
    const outcome = this.current?.outcome
    return {
      text: outcome?.status === 'initialized' ? outcome.assembled.text : '',
      onboarding: outcome?.status === 'uninitialized' ? renderOnboarding(outcome.pending) : '',
      revision: this.current?.revision ?? null,
    }
  }

  private requireStore(): RevisionStore {
    if (this.revisions === undefined) {
      throw new PersonaError('revision_unavailable', 'no revision store is configured')
    }
    return this.revisions
  }

  private readDraftForStatus(): DraftState | undefined {
    try {
      return readPersonaDraft(this.binding, this.limits)
    } catch {
      return undefined
    }
  }

  private countRevisions(): number {
    if (this.revisions === undefined) return 0
    try {
      return this.revisions.count()
    } catch (error) {
      this.lastError = describeError(error)
      return 0
    }
  }

  private refreshIfNeeded(): void {
    if (this.current === undefined) {
      try {
        this.commit(this.readSnapshot())
      } catch (error) {
        this.recordError(error, 'initial')
      }
      return
    }

    let fingerprint: string
    try {
      fingerprint = this.readSnapshotFingerprint()
    } catch (error) {
      this.recordError(error, 'stat')
      return
    }
    if (fingerprint !== this.current.fingerprint) {
      try {
        this.commit(this.readSnapshot())
      } catch (error) {
        this.recordError(error, fingerprint)
      }
    }
  }

  private readSnapshotFingerprint(): string {
    if (this.revisions !== undefined) return this.liveFingerprint()
    return fingerprintOf(this.binding.directory)
  }

  /** Pointer identity: a publish or rollback changes it, a draft edit does not. */
  private liveFingerprint(): string {
    const pointer = this.revisions?.readCurrent()
    return pointer === null || pointer === undefined
      ? 'none'
      : `r${pointer.revision}:${pointer.manifestDigest}`
  }

  private readSnapshot(): StableSnapshot {
    if (this.revisions !== undefined) return this.readStoreSnapshot()
    return this.readDraftSnapshot()
  }

  private fallbackAfterRevisionError(): PersonaReadOutcome {
    if (this.current !== undefined && this.current.revision !== null) {
      return this.current.outcome
    }
    const snapshot = this.readDraftSnapshot()
    this.current = snapshot
    this.lastLoadedAt = new Date().toISOString()
    this.warnedFingerprint = undefined
    return snapshot.outcome
  }

  /**
   * Read the live revision and the draft. Retry when the pointer moves during
   * the read so the snapshot never mixes two revisions.
   */
  private readStoreSnapshot(): StableSnapshot {
    const store = this.revisions as RevisionStore
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.liveFingerprint()
      const live = store.loadCurrent()
      const draft = readPersonaDraft(this.binding, this.limits)
      const after = this.liveFingerprint()
      if (before === after) return this.storeSnapshot(after, live, draft)
    }
    return this.storeSnapshot(
      this.liveFingerprint(),
      store.loadCurrent(),
      readPersonaDraft(this.binding, this.limits),
    )
  }

  private storeSnapshot(
    fingerprint: string,
    live: LoadedRevision | null,
    draft: DraftState,
  ): StableSnapshot {
    const outcome: PersonaReadOutcome = live === null
      ? {
        status: 'uninitialized',
        pending: draft.pending,
        files: fileSizes(draft.files),
        fingerprint,
      }
      : {
        status: 'initialized',
        assembled: live.assembled,
        fingerprint,
      }
    return {
      outcome,
      fingerprint,
      revision: live?.revision ?? null,
      liveDigest: live?.manifest.contentDigest ?? null,
      draftDigest: draft.digest,
      draftInitialized: draft.initialized,
      draftPendingFiles: draft.pending,
      draftChars: draft.chars,
      revisionPending: live === null
        ? draft.initialized
        : draft.digest !== live.manifest.contentDigest,
    }
  }

  /**
   * Read the draft with fingerprint retries. Used when no revision store is
   * configured, where the draft is the injected source.
   */
  private readDraftSnapshot(): StableSnapshot {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = fingerprintOf(this.binding.directory)
      const draft = readPersonaDraft(this.binding, this.limits)
      const after = fingerprintOf(this.binding.directory)
      if (before === after) return this.draftSnapshot(after, draft)
    }
    // Three changes in a row is a writer loop, not a snapshot; read once more
    // and return that value so the session still has the newest valid text.
    const fingerprint = fingerprintOf(this.binding.directory)
    return this.draftSnapshot(fingerprint, readPersonaDraft(this.binding, this.limits))
  }

  private draftSnapshot(fingerprint: string, draft: DraftState): StableSnapshot {
    const outcome: PersonaReadOutcome = draft.initialized && draft.assembled !== null
      ? {
        status: 'initialized',
        assembled: draft.assembled,
        fingerprint,
      }
      : {
        status: 'uninitialized',
        pending: draft.pending,
        files: fileSizes(draft.files),
        fingerprint,
      }
    return {
      outcome,
      fingerprint,
      revision: null,
      liveDigest: null,
      draftDigest: draft.digest,
      draftInitialized: draft.initialized,
      draftPendingFiles: draft.pending,
      draftChars: draft.chars,
      revisionPending: false,
    }
  }

  private commit(snapshot: StableSnapshot): void {
    this.current = snapshot
    this.lastLoadedAt = new Date().toISOString()
    this.lastError = undefined
    this.warnedFingerprint = undefined
  }

  private recordError(error: unknown, fingerprint: string): void {
    this.lastError = describeError(error)
    if (this.warnedFingerprint !== fingerprint) {
      this.warnedFingerprint = fingerprint
      this.warn(`persona refresh failed; keeping the last good text: ${this.lastError}`)
    }
  }
}

/** Default limits, shared by the schema and direct construction. */
export const DEFAULT_PERSONA_LIMITS: PersonaLimits = {
  maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
  maxPersonaChars: DEFAULT_MAX_PERSONA_CHARS,
}
