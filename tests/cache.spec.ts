import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePersonaBinding } from '../src/binding.ts'
import { PersonaCache, type PersonaReadOutcome } from '../src/cache.ts'
import { ASSEMBLY_FILES, PersonaError } from '../src/domain.ts'
import { RevisionStore } from '../src/revision.ts'
import { removeDir, tempDir, writePersona } from './helpers.ts'

const dirs: string[] = []

function fixture() {
  const root = tempDir()
  dirs.push(root)
  const directory = join(root, 'persona')
  writePersona(directory)
  const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: directory })
  return { root, directory, binding }
}

function missingFixture() {
  const root = tempDir()
  dirs.push(root)
  const directory = join(root, 'not-created')
  const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: directory })
  return { root, directory, binding }
}

function storeFixture() {
  const root = tempDir()
  dirs.push(root)
  const directory = join(root, 'persona')
  writePersona(directory)
  const binding = resolvePersonaBinding({
    personaId: 'vivy',
    sourceDir: directory,
    stateDir: join(root, 'state'),
  })
  const store = new RevisionStore(binding, binding.stateDirectory, {
    maxSourceBytes: 1024,
    maxPersonaChars: 4096,
  })
  return { root, directory, binding, store }
}

function warnCollector() {
  const warnings: string[] = []
  return { warnings, warn: (message: string) => { warnings.push(message) } }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaError)
    return (error as PersonaError).code
  }
  throw new Error('expected a PersonaError')
}

function assembled(outcome: PersonaReadOutcome) {
  if (outcome.status !== 'initialized') throw new Error('expected an initialized persona')
  return outcome.assembled
}

afterEach(() => {
  while (dirs.length > 0) removeDir(dirs.pop() as string)
})

describe('persona cache', () => {
  it('loads and reports the assembled persona', () => {
    const { directory, binding } = fixture()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    const outcome = cache.load()
    expect(outcome.status).toBe('initialized')
    expect(assembled(outcome).body).toBe('mission\n\nidentity\n\nrelationship\n\nredline')
    const status = cache.status()
    expect(status.enabled).toBe(true)
    expect(status.loaded).toBe(true)
    expect(status.initialized).toBe(true)
    expect(status.chars).toBe(assembled(outcome).chars)
    expect(status.files['MISSION.MD']).toBe(7)
    expect(status.pendingFiles).toEqual([])
    expect(status.directory).toBe(realpathSync(directory))
    expect(status.pendingChanges).toBe(false)
    expect(status.lastError).toBeUndefined()
    expect(status.revision).toBeNull()
    expect(status.liveDigest).toBeNull()
    expect(status.draftDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(status.draftInitialized).toBe(true)
    expect(status.draftPendingFiles).toEqual([])
    expect(status.draftChars).toBe(assembled(outcome).chars)
    expect(status.revisionPending).toBe(false)
    expect(status.revisionCount).toBe(0)
    expect(status.stateDirectory).toBeNull()
    expect(cache.onboardingText()).toBe('')
  })

  it('re-reads after a manual edit and reports pending changes', () => {
    const { directory, binding } = fixture()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    cache.load()
    writeFileSync(join(directory, 'IDENTITY.MD'), 'a much longer identity', { mode: 0o600 })
    chmodSync(join(directory, 'IDENTITY.MD'), 0o600)
    expect(cache.status().pendingChanges).toBe(true)
    const text = cache.promptText()
    expect(text).toContain('a much longer identity')
    expect(cache.status().pendingChanges).toBe(false)
  })

  it('keeps the last good text when a live edit is invalid', () => {
    const { directory, binding } = fixture()
    const { warnings, warn } = warnCollector()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 }, warn)
    const good = assembled(cache.load())
    chmodSync(join(directory, 'MISSION.MD'), 0o666)
    expect(cache.promptText()).toBe(good.text)
    expect(cache.promptText()).toBe(good.text)
    expect(warnings).toHaveLength(1)
    const status = cache.status()
    expect(status.lastError).toContain('world_writable_file_refused')
    expect(status.stale).toBe(true)

    chmodSync(join(directory, 'MISSION.MD'), 0o600)
    expect(cache.promptText()).toContain('mission')
    expect(cache.status().lastError).toBeUndefined()
  })

  it('validate does not mutate the cache', () => {
    const { directory, binding } = fixture()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    const good = assembled(cache.load())
    writeFileSync(join(directory, 'MISSION.MD'), '', { mode: 0o600 })
    const outcome = cache.validate()
    expect(outcome.status).toBe('uninitialized')
    expect(cache.status().initialized).toBe(true)
    expect(cache.status().lastError).toBeUndefined()
    expect(cache.promptText()).not.toBe(good.text)
    expect(cache.promptText()).toBe('')
    expect(cache.status().initialized).toBe(false)
    expect(cache.status().pendingFiles).toContain('MISSION.MD')
  })

  it('reload replaces the last good text after the source is fixed', () => {
    const { directory, binding } = fixture()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    cache.load()
    writeFileSync(join(directory, 'IDENTITY.MD'), 'replacement', { mode: 0o600 })
    chmodSync(join(directory, 'IDENTITY.MD'), 0o600)
    const outcome = cache.reload()
    expect(assembled(outcome).body).toContain('replacement')
    expect(cache.promptText()).toContain('replacement')
  })

  it('keeps the last good text when reload fails', () => {
    const { directory, binding } = fixture()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    const good = assembled(cache.load())
    chmodSync(join(directory, 'MISSION.MD'), 0o666)
    expect(() => cache.reload()).toThrowError(PersonaError)
    expect(cache.promptText()).toBe(good.text)
  })

  it('treats a missing directory as uninitialized and guides setup', () => {
    const { directory, binding } = missingFixture()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    const outcome = cache.load()
    expect(outcome.status).toBe('uninitialized')
    if (outcome.status !== 'uninitialized') throw new Error('expected uninitialized')
    expect(outcome.pending).toEqual([...ASSEMBLY_FILES])
    expect(cache.promptText()).toBe('')
    expect(cache.onboardingText()).toContain('Who am I?')
    expect(cache.onboardingText()).toContain('laputa_init')
    const status = cache.status()
    expect(status.initialized).toBe(false)
    expect(status.pendingFiles).toEqual([...ASSEMBLY_FILES])
    expect(status.files['MISSION.MD']).toBe(0)
    expect(status.directory).toBe(directory)
    expect(status.lastError).toBeUndefined()
  })

  it.each([
    ['MISSION.MD', '   \n\t'],
    ['IDENTITY.MD', '   '],
  ] as const)('treats a blank %s as uninitialized', (name, value) => {
    const { directory, binding } = fixture()
    writeFileSync(join(directory, name), value, { mode: 0o600 })
    chmodSync(join(directory, name), 0o600)
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    const outcome = cache.load()
    expect(outcome.status).toBe('uninitialized')
    if (outcome.status !== 'uninitialized') throw new Error('expected uninitialized')
    expect(outcome.pending).toContain(name)
    expect(outcome.files[name]).toBe(Buffer.byteLength(value))
    expect(cache.promptText()).toBe('')
  })

  it('switches from uninitialized to initialized after files are written', () => {
    const { directory, binding } = missingFixture()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    expect(cache.load().status).toBe('uninitialized')
    writePersona(directory)
    expect(cache.promptText()).toContain('mission')
    expect(cache.status().initialized).toBe(true)
    expect(cache.onboardingText()).toBe('')
  })

  it('still fails on invalid UTF-8', () => {
    const { directory, binding } = fixture()
    writeFileSync(join(directory, 'IDENTITY.MD'), Buffer.from([0xff]), { mode: 0o600 })
    chmodSync(join(directory, 'IDENTITY.MD'), 0o600)
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    expect(codeOf(() => cache.load())).toBe('invalid_utf8')
  })

  it('contributes nothing when disabled', () => {
    const { binding } = fixture()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    cache.markDisabled()
    expect(cache.promptText()).toBe('')
    expect(cache.onboardingText()).toBe('')
    expect(cache.status().enabled).toBe(false)
    expect(cache.status().loaded).toBe(false)
  })

  it('enforces the per-file byte cap and character budget', () => {
    const { directory, binding } = fixture()
    writeFileSync(join(directory, 'IDENTITY.MD'), 'x'.repeat(20), { mode: 0o600 })
    chmodSync(join(directory, 'IDENTITY.MD'), 0o600)
    const smallBytes = new PersonaCache(binding, { maxSourceBytes: 10, maxPersonaChars: 4096 })
    expect(codeOf(() => smallBytes.load())).toBe('source_byte_budget_exceeded')
    const smallChars = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 10 })
    expect(codeOf(() => smallChars.load())).toBe('persona_character_budget_exceeded')
  })
})

describe('persona cache with revisions', () => {
  it('injects the live revision and keeps draft edits unpublished', () => {
    const { directory, binding, store } = storeFixture()
    const cache = new PersonaCache(binding, {
      maxSourceBytes: 1024,
      maxPersonaChars: 4096,
    }, undefined, store)
    const outcome = cache.load()
    expect(outcome.status).toBe('initialized')
    expect(cache.promptText()).toContain('mission')

    const initial = cache.status()
    expect(initial.revision).toBe(1)
    expect(initial.liveDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(initial.revisionCount).toBe(1)
    expect(initial.stateDirectory).toBe(binding.stateDirectory)
    expect(initial.revisionPending).toBe(false)
    expect(initial.pendingChanges).toBe(false)

    writeFileSync(join(directory, 'MISSION.MD'), 'unpublished mission body', { mode: 0o600 })
    chmodSync(join(directory, 'MISSION.MD'), 0o600)
    expect(cache.promptText()).not.toContain('unpublished mission body')

    const draft = cache.status()
    expect(draft.revision).toBe(1)
    expect(draft.draftDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(draft.draftDigest).not.toBe(draft.liveDigest)
    expect(draft.revisionPending).toBe(true)
    expect(draft.pendingChanges).toBe(true)
    expect(cache.validate().status).toBe('initialized')
    expect(cache.status().revision).toBe(1)
  })

  it('publishes the draft and then injects it', () => {
    const { directory, binding, store } = storeFixture()
    const cache = new PersonaCache(binding, {
      maxSourceBytes: 1024,
      maxPersonaChars: 4096,
    }, undefined, store)
    cache.load()
    writeFileSync(join(directory, 'MISSION.MD'), 'published mission body', { mode: 0o600 })
    chmodSync(join(directory, 'MISSION.MD'), 0o600)

    const status = cache.status()
    const result = cache.publishDraft({
      expectedBaseRevision: status.revision,
      expectedDraftDigest: status.draftDigest,
    })
    expect(result.created).toBe(true)
    expect(result.current.revision).toBe(2)
    expect(cache.promptText()).toContain('published mission body')
    expect(cache.status().revision).toBe(2)
    expect(cache.status().revisionPending).toBe(false)
  })

  it('rolls back through a new revision and restores the draft', () => {
    const { directory, binding, store } = storeFixture()
    const cache = new PersonaCache(binding, {
      maxSourceBytes: 1024,
      maxPersonaChars: 4096,
    }, undefined, store)
    cache.load()
    writeFileSync(join(directory, 'MISSION.MD'), 'second version', { mode: 0o600 })
    chmodSync(join(directory, 'MISSION.MD'), 0o600)
    cache.publishDraft({
      expectedBaseRevision: 1,
      expectedDraftDigest: cache.status().draftDigest,
    })
    expect(cache.currentRevision()?.revision).toBe(2)

    const result = cache.rollbackTo({
      targetRevision: 1,
      expectedBaseRevision: 2,
      expectedDraftDigest: cache.status().draftDigest,
    })
    expect(result.created).toBe(true)
    expect(result.current.revision).toBe(3)
    expect(result.current.manifest.restoredFrom).toBe(1)
    expect(cache.promptText()).toContain('mission')
    expect(cache.promptText()).not.toContain('second version')
    expect(readFileSync(join(directory, 'MISSION.MD'), 'utf8')).toBe('mission')
    expect(cache.listRevisions().map(summary => summary.revision)).toEqual([1, 2, 3])
    expect(cache.listRevisions().find(summary => summary.current)?.revision).toBe(3)
  })

  it('reads a historical revision by number', () => {
    const { binding, store } = storeFixture()
    const cache = new PersonaCache(binding, {
      maxSourceBytes: 1024,
      maxPersonaChars: 4096,
    }, undefined, store)
    cache.load()

    const loaded = cache.readRevision(1)
    expect(loaded.revision).toBe(1)
    expect(loaded.manifest.revision).toBe(1)
    expect(loaded.files['MISSION.MD'].toString('utf8')).toBe('mission')
    expect(loaded.assembled.body).toContain('mission')
    expect(codeOf(() => cache.readRevision(99))).toBe('revision_not_found')
  })

  it('records a corrupt pointer on load but keeps the last good text', () => {
    const { binding, store } = storeFixture()
    const cache = new PersonaCache(binding, {
      maxSourceBytes: 1024,
      maxPersonaChars: 4096,
    }, undefined, store)
    cache.load()
    writeFileSync(join(binding.stateDirectory, 'current.json'), '{not json', { mode: 0o600 })

    expect(codeOf(() => cache.reload())).toBe('revision_state_corrupt')
    const outcome = cache.load()
    expect(outcome.status).toBe('initialized')
    expect(cache.promptText()).toContain('mission')
    expect(cache.status().lastError).toContain('revision_state_corrupt')
  })

  it('reports revision_unavailable without a store', () => {
    const { binding } = fixture()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    expect(codeOf(() => cache.publishDraft({ expectedBaseRevision: null, expectedDraftDigest: '' })))
      .toBe('revision_unavailable')
    expect(codeOf(() => cache.rollbackTo({
      targetRevision: 1,
      expectedBaseRevision: null,
      expectedDraftDigest: '',
    }))).toBe('revision_unavailable')
    expect(codeOf(() => cache.currentRevision())).toBe('revision_unavailable')
    expect(codeOf(() => cache.listRevisions())).toBe('revision_unavailable')
    expect(codeOf(() => cache.readRevision(1))).toBe('revision_unavailable')
    const status = cache.status()
    expect(status.revision).toBeNull()
    expect(status.stateDirectory).toBeNull()
    expect(status.revisionCount).toBe(0)
  })
})

describe('session pinning', () => {
  it('pins a session to the live revision until it is refreshed', () => {
    const { directory, binding, store } = storeFixture()
    const cache = new PersonaCache(binding, {
      maxSourceBytes: 1024,
      maxPersonaChars: 4096,
    }, undefined, store)
    cache.load()
    const key = {}
    const session = cache.session(key)
    expect(session.revision).toBe(1)
    expect(session.promptText()).toContain('mission')

    writeFileSync(join(directory, 'MISSION.MD'), 'revised mission body', { mode: 0o600 })
    chmodSync(join(directory, 'MISSION.MD'), 0o600)
    cache.publishDraft({
      expectedBaseRevision: 1,
      expectedDraftDigest: cache.status().draftDigest,
    })

    expect(cache.promptText()).toContain('revised mission body')
    expect(session.promptText()).not.toContain('revised mission body')
    expect(session.revision).toBe(1)

    const fresh = cache.session({})
    expect(fresh.revision).toBe(2)
    expect(fresh.promptText()).toContain('revised mission body')

    session.refresh()
    expect(session.revision).toBe(2)
    expect(session.promptText()).toContain('revised mission body')
    expect(cache.session(key)).toBe(session)
  })

  it('pins draft text without a store', () => {
    const { directory, binding } = fixture()
    const cache = new PersonaCache(binding, { maxSourceBytes: 1024, maxPersonaChars: 4096 })
    cache.load()
    const session = cache.session('agent')
    expect(session.revision).toBeNull()
    expect(session.promptText()).toContain('mission')

    writeFileSync(join(directory, 'IDENTITY.MD'), 'changed identity', { mode: 0o600 })
    chmodSync(join(directory, 'IDENTITY.MD'), 0o600)
    expect(cache.promptText()).toContain('changed identity')
    expect(session.promptText()).not.toContain('changed identity')

    session.refresh()
    expect(session.promptText()).toContain('changed identity')
  })

  it('pins onboarding until the session is refreshed', () => {
    const root = tempDir()
    dirs.push(root)
    const directory = join(root, 'persona')
    const binding = resolvePersonaBinding({
      personaId: 'vivy',
      sourceDir: directory,
      stateDir: join(root, 'state'),
    })
    const store = new RevisionStore(binding, binding.stateDirectory, {
      maxSourceBytes: 1024,
      maxPersonaChars: 4096,
    })
    const cache = new PersonaCache(binding, {
      maxSourceBytes: 1024,
      maxPersonaChars: 4096,
    }, undefined, store)
    cache.load()
    const session = cache.session('agent')
    expect(session.promptText()).toBe('')
    expect(session.onboardingText()).toContain('Who am I?')

    writePersona(directory)
    cache.reload()
    expect(cache.promptText()).toContain('mission')
    expect(session.promptText()).toBe('')
    expect(session.onboardingText()).toContain('Who am I?')

    session.refresh()
    expect(session.revision).toBe(1)
    expect(session.promptText()).toContain('mission')
    expect(session.onboardingText()).toBe('')
  })
})
