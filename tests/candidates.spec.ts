import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePersonaBinding } from '../src/binding.ts'
import { PersonaCache } from '../src/cache.ts'
import { PersonaCandidates, type CandidateInput } from '../src/candidates.ts'
import { RevisionStore } from '../src/revision.ts'
import { removeDir, tempDir, writePersona } from './helpers.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) removeDir(dirs.pop()!) })
function fixture(initialized = true, retainRevisions = 0) {
  const root = tempDir(); dirs.push(root)
  const directory = join(root, 'persona')
  writePersona(directory, initialized ? {} : { 'IDENTITY.MD': '' })
  const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: directory, stateDir: join(root, 'state') })
  const limits = { maxSourceBytes: 4096, maxPersonaChars: 16000, retainRevisions }
  const revisions = new RevisionStore(binding, binding.stateDirectory, limits)
  const cache = new PersonaCache(binding, limits, () => {}, revisions)
  cache.load()
  const owner = new PersonaCandidates(cache)
  const baseline = owner.baseline()
  const input: CandidateInput = { ticketId: 'ticket-1', subjectId: 'subject-1', evidenceIds: ['event-2', 'event-1'],
    summary: 'Use clearer boundaries', files: { 'IDENTITY.MD': 'reviewed identity' },
    expectedBaseRevision: baseline.revision!, expectedDraftDigest: baseline.draftDigest }
  return { directory, revisions, cache, owner, input }
}

describe('immutable persona candidates', () => {
  it('stages idempotently outside draft/live, exposes source/diff, and publishes only on owner decision', () => {
    const { directory, revisions, cache, owner, input } = fixture()
    const session = cache.session({})
    const candidate = owner.stage(input)
    expect(owner.stage(input)).toEqual(candidate)
    expect(revisions.loadCurrent()?.revision).toBe(1)
    expect(readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')).toBe('identity')
    const detail = owner.detail(candidate.candidateId)
    expect(detail.evidenceIds).toEqual(['event-1', 'event-2'])
    expect(detail.diff.files.find(file => file.name === 'IDENTITY.MD')?.changed).toBe(true)
    const result = owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')
    expect(result).toMatchObject({ status: 'approved', ownerRef: { personaId: 'vivy', revision: 2 }, draftSynced: true })
    expect(revisions.loadCurrent()?.files['IDENTITY.MD'].toString()).toBe('reviewed identity')
    // The draft follows the approved content, so the next publish cannot revert the persona.
    expect(readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')).toBe('reviewed identity')
    expect(cache.status().revisionPending).toBe(false)
    expect(session.revision).toBe(1)
    expect(cache.session({}).revision).toBe(2)
    expect(owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')).toEqual(result)
    expect(owner.stage(input)).toEqual(result)
  })
  it('refuses stale draft and stale live revision without changing either', () => {
    const { directory, owner, revisions, input } = fixture()
    const candidate = owner.stage(input)
    writeFileSync(join(directory, 'IDENTITY.MD'), 'human edit')
    expect(() => owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')).toThrow('draft changed')
    expect(revisions.loadCurrent()?.revision).toBe(1)
    expect(owner.status(candidate.candidateId).status).toBe('pending')
    revisions.publish({ expectedBaseRevision: 1, expectedDraftDigest: owner.baseline().draftDigest })
    expect(() => owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')).toThrow('base revision')
    expect(readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')).toBe('human edit')
  })
  it('rejects once, retains its audit record and never changes live content', () => {
    const { owner, revisions, input } = fixture()
    const candidate = owner.stage(input)
    expect(owner.decide(candidate.candidateId, candidate.candidateDigest, 'reject').status).toBe('rejected')
    expect(owner.list()).toHaveLength(1)
    expect(() => owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')).toThrow('already decided')
    expect(revisions.loadCurrent()?.revision).toBe(1)
  })
  it('recovers an owner commit without its receipt and cannot subsequently reject it', () => {
    const { owner, revisions, input } = fixture()
    const candidate = owner.stage(input)
    owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')
    rmSync(join(owner.directory, `${candidate.candidateId}.decision.json`))
    expect(owner.status(candidate.candidateId)).toMatchObject({ status: 'approved', ownerRef: { revision: 2 } })
    expect(() => owner.decide(candidate.candidateId, candidate.candidateDigest, 'reject')).toThrow('already decided')
    expect(owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve').status).toBe('approved')
    expect(revisions.count()).toBe(2)
  })
  it('fails closed for disabled/uninitialized personas, invalid files and tampered content', () => {
    const { owner, cache, input } = fixture()
    expect(() => owner.stage({ ...input, files: { '../../x': 'bad' } } as CandidateInput)).toThrow()
    const candidate = owner.stage(input)
    writeFileSync(join(owner.directory, `${candidate.candidateId}.json`), '{}')
    expect(() => owner.detail(candidate.candidateId)).toThrow('integrity')
    cache.markDisabled()
    expect(() => owner.stage(input)).toThrow('disabled or uninitialized')
    const uninitialized = fixture(false)
    expect(() => uninitialized.owner.stage(uninitialized.input)).toThrow('disabled or uninitialized')
    expect(uninitialized.revisions.count()).toBe(0)
  })
  it('does not mistake an orphan revision before a failed pointer update for a committed approval', () => {
    const { owner, revisions, cache, input } = fixture()
    const pointer = readFileSync(join(revisions.stateDirectory, 'current.json'))
    const candidate = owner.stage(input)
    owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')
    writeFileSync(join(revisions.stateDirectory, 'current.json'), pointer)
    rmSync(join(owner.directory, `${candidate.candidateId}.decision.json`))
    rmSync(join(revisions.stateDirectory, 'candidate-commits', `${candidate.candidateId}.json`))
    cache.reload()
    expect(owner.status(candidate.candidateId).status).toBe('pending')
    expect(owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')).toMatchObject({ ownerRef: { revision: 3 } })
  })
  it('retains owner commit proof across later manual publishes and revision pruning', () => {
    const { owner, revisions, directory, input } = fixture(true, 2)
    const candidate = owner.stage(input)
    owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')
    rmSync(join(owner.directory, `${candidate.candidateId}.decision.json`))
    rmSync(join(revisions.stateDirectory, 'candidate-commits', `${candidate.candidateId}.json`))
    for (const base of [2, 3, 4]) {
      writeFileSync(join(directory, 'IDENTITY.MD'), `manual-${base}`)
      revisions.publish({ expectedBaseRevision: base, expectedDraftDigest: owner.baseline().draftDigest })
    }
    expect(owner.status(candidate.candidateId)).toMatchObject({ status: 'approved', ownerRef: { revision: 2 } })
    expect(revisions.readRevision(2).manifest.source?.note).toBe(`candidate:${candidate.candidateId}`)
  })
  it('does not overwrite a draft edited after a crashed approval', () => {
    const { directory, owner, revisions, input } = fixture()
    const candidate = owner.stage(input)
    owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')
    rmSync(join(owner.directory, `${candidate.candidateId}.decision.json`))
    writeFileSync(join(directory, 'IDENTITY.MD'), 'late human edit')
    const recovered = owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')
    expect(recovered).toMatchObject({ status: 'approved', ownerRef: { revision: 2 } })
    expect(readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')).toBe('late human edit')
    expect(revisions.count()).toBe(2)
  })
  it('refuses to publish a draft copied from an older revision', () => {
    const { directory, owner, revisions, input } = fixture()
    const candidate = owner.stage(input)
    owner.decide(candidate.candidateId, candidate.candidateDigest, 'approve')
    const previous = readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')
    writeFileSync(join(directory, 'IDENTITY.MD'), 'newer identity')
    revisions.publish({ expectedBaseRevision: 2, expectedDraftDigest: owner.baseline().draftDigest })
    writeFileSync(join(directory, 'IDENTITY.MD'), previous)
    try {
      revisions.publish({ expectedBaseRevision: 3, expectedDraftDigest: owner.baseline().draftDigest })
      throw new Error('expected the stale draft to be refused')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('persona_draft_stale')
    }
  })
})
