/** Owner-controlled immutable proposals. Internal callers may stage, humans alone may decide. */
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { assemblePersona, digestPersonaFiles } from './assemble.ts'
import { atomicWriteFile, digestOf, withFileLock, writeJsonAtomic } from './atomic.ts'
import { ensurePersonaDirectory } from './binding.ts'
import type { PersonaCache } from './cache.ts'
import { ASSEMBLY_FILES, PersonaError, type PersonaFile } from './domain.ts'
import { diffPersonaFiles } from './diff.ts'
import { safeRead } from './safe-read.ts'

type Files = Record<PersonaFile, string>
export interface CandidateInput {
  ticketId: string; subjectId: string; evidenceIds: string[]; summary: string
  files: Partial<Files>; expectedBaseRevision: number; expectedDraftDigest: string
}
interface Candidate {
  candidateId: string; candidateDigest: string; personaId: string; baseRevision: number
  draftDigest: string; ticketId: string; subjectId: string; evidenceIds: string[]; summary: string
  files: Files; baseFiles: Files
}
interface Decision {
  status: 'approved' | 'rejected'; decidedAt: string
  ownerRef?: { personaId: string; revision: number; contentDigest: string }
  /** Whether the approved bytes also replaced the editable draft; false when a human edit was in the way. */
  draftSynced?: boolean
}
const bytes = (files: Files): Record<PersonaFile, Buffer> => Object.fromEntries(
  ASSEMBLY_FILES.map(name => [name, Buffer.from(files[name], 'utf8')]),
) as Record<PersonaFile, Buffer>
const invalid = (message: string): never => { throw new PersonaError('revision_state_corrupt', message) }

export class PersonaCandidates {
  readonly directory: string
  constructor(readonly cache: PersonaCache) { this.directory = join(cache.binding.stateDirectory, 'candidates') }

  baseline() {
    const status = this.cache.status()
    const current = status.enabled && status.initialized ? this.cache.currentRevision() : null
    return { enabled: status.enabled, initialized: status.initialized, personaId: status.personaId,
      revision: current?.revision ?? null, draftDigest: status.draftDigest,
      files: current ? Object.fromEntries(ASSEMBLY_FILES.map(name => [name, current.files[name].toString('utf8')])) : null }
  }

  private ready() {
    const status = this.cache.status()
    if (!status.enabled || !status.initialized || !this.cache.revisions) {
      throw new PersonaError('revision_unavailable', 'persona is disabled or uninitialized')
    }
    return this.cache.revisions
  }
  private ensure() {
    this.ready()
    if (existsSync(this.directory) && (lstatSync(this.directory).isSymbolicLink() || !lstatSync(this.directory).isDirectory())) invalid('invalid candidate directory')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }
  private path(id: string, suffix = '.json') {
    if (!/^[a-f0-9]{64}$/.test(id)) invalid('invalid candidate id')
    return join(this.directory, id + suffix)
  }
  private read(id: string): Candidate {
    const candidate = JSON.parse(safeRead(this.path(id), 2 * 1024 * 1024, false).bytes.toString('utf8')) as Candidate
    const { candidateId, candidateDigest, ...payload } = candidate
    if (candidateId !== id || candidateDigest !== id || digestOf(JSON.stringify(payload)) !== id) invalid('candidate integrity check failed')
    return candidate
  }
  private decision(id: string): Decision | null {
    const path = this.path(id, '.decision.json')
    if (existsSync(path)) return JSON.parse(safeRead(path, 4096, false).bytes.toString('utf8')) as Decision
    // Owner publication is authoritative even if the process died before writing its receipt.
    const committed = this.cache.revisions?.candidateCommit(id)
    return committed ? { status: 'approved', decidedAt: committed.manifest.createdAt,
      ownerRef: { personaId: this.cache.binding.personaId, revision: committed.revision, contentDigest: committed.manifest.contentDigest } } : null
  }
  stage(input: CandidateInput) {
    this.ensure()
    if (!input || typeof input !== 'object' || !input.files || typeof input.files !== 'object'
      || Object.keys(input.files).some(name => !(ASSEMBLY_FILES as readonly string[]).includes(name))
      || ![input.ticketId, input.subjectId, input.summary].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8000)
      || !Array.isArray(input.evidenceIds) || !input.evidenceIds.length || input.evidenceIds.length > 1000
      || !input.evidenceIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512)) invalid('invalid proposal provenance')
    // A lost staging response must be recoverable after the human has published
    // or edited the draft. Match the complete original request, never just a ticket.
    for (const name of readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const prior = this.read(name.slice(0, -5))
      if (prior.ticketId !== input.ticketId || prior.subjectId !== input.subjectId
        || prior.baseRevision !== input.expectedBaseRevision || prior.draftDigest !== input.expectedDraftDigest
        || prior.summary !== input.summary
        || JSON.stringify(prior.evidenceIds) !== JSON.stringify([...new Set(input.evidenceIds)].sort())) continue
      const merged = { ...prior.baseFiles, ...input.files }
      if (ASSEMBLY_FILES.every(file => merged[file] === prior.files[file])) return this.status(prior.candidateId)
    }
    const baseline = this.baseline()
    if (baseline.revision !== input.expectedBaseRevision || baseline.draftDigest !== input.expectedDraftDigest) {
      throw new PersonaError('revision_conflict', 'proposal baseline changed')
    }
    const baseFiles = baseline.files as Files
    const files = { ...baseFiles }
    for (const name of ASSEMBLY_FILES) {
      const value = input.files[name]
      if (value !== undefined) {
        if (typeof value !== 'string' || Buffer.byteLength(value) > this.cache.limits.maxSourceBytes) invalid('invalid proposal file')
        files[name] = value
      }
    }
    assemblePersona(bytes(files), this.cache.limits.maxPersonaChars)
    if (digestPersonaFiles(bytes(files)) === digestPersonaFiles(bytes(baseFiles))) invalid('proposal contains no change')
    const payload = { personaId: baseline.personaId, baseRevision: input.expectedBaseRevision,
      draftDigest: input.expectedDraftDigest, ticketId: input.ticketId, subjectId: input.subjectId,
      evidenceIds: [...new Set(input.evidenceIds)].sort(), summary: input.summary, files, baseFiles }
    const id = digestOf(JSON.stringify(payload))
    withFileLock(join(this.directory, '.candidate.lock'), () => {
      if (!existsSync(this.path(id))) writeJsonAtomic(this.path(id), { candidateId: id, candidateDigest: id, ...payload })
      else this.read(id)
    })
    return this.status(id)
  }
  status(id: string) {
    const candidate = this.read(id)
    const decision = this.decision(id)
    return { candidateId: id, candidateDigest: id, personaId: candidate.personaId, baseRevision: candidate.baseRevision,
      ticketId: candidate.ticketId, subjectId: candidate.subjectId, evidenceIds: candidate.evidenceIds,
      summary: candidate.summary, status: decision?.status ?? 'pending', ...decision }
  }
  list() {
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => this.status(name.slice(0, -5)))
  }
  detail(id: string) {
    const candidate = this.read(id)
    return { ...this.status(id), draftDigest: candidate.draftDigest, files: candidate.files, baseFiles: candidate.baseFiles,
      diff: diffPersonaFiles(bytes(candidate.baseFiles), bytes(candidate.files), candidate.baseRevision, candidate.baseRevision + 1) }
  }
  decide(id: string, digest: string, action: 'approve' | 'reject') {
    const revisions = this.ready()
    this.ensure()
    return withFileLock(join(this.directory, '.candidate.lock'), () => {
      const candidate = this.read(id)
      if (digest !== candidate.candidateDigest) invalid('review digest mismatch')
      const previous = this.decision(id)
      if (previous) {
        if ((previous.status === 'approved') !== (action === 'approve')) throw new PersonaError('revision_conflict', 'candidate already decided')
        return this.status(id)
      }
      const decision: Decision = { status: action === 'approve' ? 'approved' : 'rejected', decidedAt: new Date().toISOString() }
      if (action === 'approve') {
        const result = revisions.publishCandidate({ candidateId: id, files: bytes(candidate.files),
          expectedBaseRevision: candidate.baseRevision, expectedDraftDigest: candidate.draftDigest })
        decision.ownerRef = { personaId: candidate.personaId, revision: result.current.revision, contentDigest: result.current.manifest.contentDigest }
        // Keep the draft on the approved content when nobody edited it concurrently.
        try { decision.draftSynced = this.syncDraft(candidate) } catch { decision.draftSynced = false }
        this.cache.reload()
      }
      writeJsonAtomic(this.path(id, '.decision.json'), decision)
      return this.status(id)
    })
  }
  /**
   * Replace the editable draft with the approved bytes only when the draft still
   * holds exactly what the proposal was based on (or already holds the proposal).
   * A concurrent human edit wins; the reviewer is told the draft stayed stale.
   */
  private syncDraft(candidate: Candidate): boolean {
    const draftDigest = this.cache.status().draftDigest
    const approved = digestPersonaFiles(bytes(candidate.files))
    if (draftDigest === approved) return true
    if (draftDigest !== digestPersonaFiles(bytes(candidate.baseFiles))) return false
    const directory = ensurePersonaDirectory(this.cache.binding)
    try {
      for (const name of ASSEMBLY_FILES) atomicWriteFile(join(directory, name), Buffer.from(candidate.files[name], 'utf8'), { mode: 0o600 })
    } catch (error) {
      // Each file write is atomic, the six together are not: put the base back before failing.
      for (const name of ASSEMBLY_FILES) {
        try { atomicWriteFile(join(directory, name), Buffer.from(candidate.baseFiles[name], 'utf8'), { mode: 0o600 }) } catch {}
      }
      throw error
    }
    return this.cache.status().draftDigest === approved
  }
}
