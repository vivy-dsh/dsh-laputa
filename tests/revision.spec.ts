import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePersonaBinding } from '../src/binding.ts'
import { PersonaError } from '../src/domain.ts'
import {
  CURRENT_FILE, MANIFEST_FILE, REVISIONS_DIR, RevisionStore, readPersonaDraft,
} from '../src/revision.ts'
import { removeDir, tempDir, writePersona } from './helpers.ts'

const POSIX = process.platform !== 'win32'
const LIMITS = { maxSourceBytes: 4096, maxPersonaChars: 16_000 }
const dirs: string[] = []

function dir(): string {
  const value = tempDir()
  dirs.push(value)
  return value
}

afterEach(() => {
  while (dirs.length > 0) removeDir(dirs.pop() as string)
})

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaError)
    return (error as PersonaError).code
  }
  throw new Error('expected a PersonaError')
}

function fixture(options: { initialized?: boolean, retainRevisions?: number } = {}) {
  const root = dir()
  const directory = join(root, 'persona')
  if (options.initialized !== false) writePersona(directory)
  const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: directory })
  const stateDirectory = join(root, 'state')
  const limits = options.retainRevisions === undefined
    ? LIMITS
    : { ...LIMITS, retainRevisions: options.retainRevisions }
  const store = new RevisionStore(binding, stateDirectory, limits)
  return { root, directory, binding, stateDirectory, store }
}

function draftDigest(binding: ReturnType<typeof resolvePersonaBinding>): string {
  return readPersonaDraft(binding, LIMITS).digest
}

function publishIdentity(
  store: RevisionStore,
  directory: string,
  binding: ReturnType<typeof resolvePersonaBinding>,
  identity: string,
  base: number,
) {
  writePersona(directory, { 'IDENTITY.MD': identity })
  return store.publish({
    expectedBaseRevision: base,
    expectedDraftDigest: draftDigest(binding),
    source: { actor: 'tool', note: 'test' },
  })
}

function revisionPath(stateDirectory: string, revision: number): string {
  return join(stateDirectory, REVISIONS_DIR, `r${String(revision).padStart(6, '0')}`)
}

function tempLeftovers(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => name.startsWith('.') && name.endsWith('.tmp'))
}

describe('bootstrap', () => {
  it('creates r000001 and the current pointer from an initialized draft', () => {
    const { stateDirectory, binding, store } = fixture()
    const loaded = store.bootstrapFromDraft()
    expect(loaded?.revision).toBe(1)
    expect(loaded?.manifest.parent).toBeNull()
    expect(loaded?.manifest.restoredFrom).toBeNull()
    expect(loaded?.manifest.contentDigest).toBe(draftDigest(binding))

    const pointer = JSON.parse(readFileSync(join(stateDirectory, CURRENT_FILE), 'utf8'))
    expect(pointer).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      directory: 'r000001',
    })
    expect(readFileSync(join(revisionPath(stateDirectory, 1), MANIFEST_FILE), 'utf8'))
      .toContain('"personaId": "vivy"')

    expect(store.bootstrapFromDraft()?.revision).toBe(1)
    expect(store.list()).toHaveLength(1)
    expect(tempLeftovers(join(stateDirectory, REVISIONS_DIR))).toEqual([])
    if (POSIX) {
      expect(statSync(stateDirectory).mode & 0o777).toBe(0o700)
      expect(statSync(revisionPath(stateDirectory, 1)).mode & 0o777).toBe(0o700)
      expect(statSync(join(revisionPath(stateDirectory, 1), MANIFEST_FILE)).mode & 0o777).toBe(0o600)
    }
  })

  it('does not create state while the draft is uninitialized', () => {
    const { stateDirectory, store } = fixture({ initialized: false })
    expect(store.bootstrapFromDraft()).toBeNull()
    expect(existsSync(stateDirectory)).toBe(false)
  })

  it('adopts the highest complete revision when the pointer is missing', () => {
    const { stateDirectory, directory, binding, store } = fixture()
    store.bootstrapFromDraft()
    writePersona(directory, { 'IDENTITY.MD': 'second identity' })
    store.publish({ expectedBaseRevision: 1, expectedDraftDigest: draftDigest(binding) })
    rmSync(join(stateDirectory, CURRENT_FILE))

    const recovered = store.bootstrapFromDraft()
    expect(recovered?.revision).toBe(2)
    expect(JSON.parse(readFileSync(join(stateDirectory, CURRENT_FILE), 'utf8')).revision).toBe(2)
  })

  it('reports corruption instead of falling back past a broken highest revision', () => {
    const { stateDirectory, directory, binding, store } = fixture()
    store.bootstrapFromDraft()
    writePersona(directory, { 'IDENTITY.MD': 'second identity' })
    store.publish({ expectedBaseRevision: 1, expectedDraftDigest: draftDigest(binding) })
    rmSync(join(stateDirectory, CURRENT_FILE))
    writeFileSync(join(revisionPath(stateDirectory, 2), MANIFEST_FILE), '{not json\n', { mode: 0o600 })

    expect(codeOf(() => store.bootstrapFromDraft())).toBe('revision_state_corrupt')
    expect(existsSync(join(stateDirectory, CURRENT_FILE))).toBe(false)
  })

  it('detects a garbled pointer', () => {
    const { stateDirectory, store } = fixture()
    store.bootstrapFromDraft()
    writeFileSync(join(stateDirectory, CURRENT_FILE), '{"schemaVersion":1}\n', { mode: 0o600 })
    expect(codeOf(() => store.loadCurrent())).toBe('revision_state_corrupt')
    expect(codeOf(() => store.bootstrapFromDraft())).toBe('revision_state_corrupt')
  })
})

describe('publish', () => {
  it('creates monotonically increasing revisions and leaves history immutable', () => {
    const { directory, binding, store } = fixture()
    store.bootstrapFromDraft()
    writePersona(directory, { 'IDENTITY.MD': 'second identity' })
    const second = store.publish({ expectedBaseRevision: 1, expectedDraftDigest: draftDigest(binding) })
    expect(second.created).toBe(true)
    expect(second.current.revision).toBe(2)
    expect(second.current.manifest.parent).toBe(1)

    writePersona(directory, { 'IDENTITY.MD': 'third identity' })
    const third = store.publish({ expectedBaseRevision: 2, expectedDraftDigest: draftDigest(binding) })
    expect(third.current.revision).toBe(3)
    expect(third.current.manifest.parent).toBe(2)

    expect(store.readRevision(1).files['IDENTITY.MD'].toString('utf8')).toBe('identity')
    expect(store.readRevision(2).files['IDENTITY.MD'].toString('utf8')).toBe('second identity')
    expect(store.list().map(entry => entry.revision)).toEqual([1, 2, 3])
    expect(store.loadCurrent()?.revision).toBe(3)
  })

  it('rejects a stale expected base without creating a revision', () => {
    const { directory, binding, store } = fixture()
    store.bootstrapFromDraft()
    writePersona(directory, { 'IDENTITY.MD': 'second identity' })
    store.publish({ expectedBaseRevision: 1, expectedDraftDigest: draftDigest(binding) })

    writePersona(directory, { 'IDENTITY.MD': 'third identity' })
    expect(codeOf(() => store.publish({
      expectedBaseRevision: 1,
      expectedDraftDigest: draftDigest(binding),
    }))).toBe('revision_conflict')
    expect(store.list()).toHaveLength(2)
    expect(store.loadCurrent()?.revision).toBe(2)
  })

  it('rejects a changed draft digest', () => {
    const { directory, binding, store } = fixture()
    store.bootstrapFromDraft()
    writePersona(directory, { 'IDENTITY.MD': 'changed' })
    const stale = draftDigest(binding)
    writePersona(directory, { 'IDENTITY.MD': 'changed again' })
    expect(codeOf(() => store.publish({
      expectedBaseRevision: 1,
      expectedDraftDigest: stale,
    }))).toBe('persona_file_changed')
    expect(store.list()).toHaveLength(1)
  })

  it('rejects publishing an uninitialized draft', () => {
    const { binding, store } = fixture({ initialized: false })
    expect(codeOf(() => store.publish({
      expectedBaseRevision: null,
      expectedDraftDigest: readPersonaDraft(binding, LIMITS).digest,
    }))).toBe('revision_not_initialized')
  })

  it('treats an identical publish as a no-op', () => {
    const { binding, store } = fixture()
    store.bootstrapFromDraft()
    const result = store.publish({
      expectedBaseRevision: 1,
      expectedDraftDigest: draftDigest(binding),
    })
    expect(result.created).toBe(false)
    expect(result.current.revision).toBe(1)
    expect(store.list()).toHaveLength(1)
  })

  it('creates r000001 directly when the first publish has a null base', () => {
    const { binding, store } = fixture()
    const result = store.publish({
      expectedBaseRevision: null,
      expectedDraftDigest: draftDigest(binding),
    })
    expect(result.created).toBe(true)
    expect(result.current.revision).toBe(1)
    expect(result.current.manifest.parent).toBeNull()
  })
})

describe('rollback', () => {
  it('creates a new revision from history, preserves old revisions, and restores the draft', () => {
    const { directory, binding, stateDirectory, store } = fixture()
    store.bootstrapFromDraft()
    writePersona(directory, { 'IDENTITY.MD': 'second identity' })
    store.publish({ expectedBaseRevision: 1, expectedDraftDigest: draftDigest(binding) })
    writePersona(directory, { 'IDENTITY.MD': 'third identity' })
    store.publish({ expectedBaseRevision: 2, expectedDraftDigest: draftDigest(binding) })

    const result = store.rollback({
      targetRevision: 1,
      expectedBaseRevision: 3,
      expectedDraftDigest: draftDigest(binding),
    })
    expect(result.created).toBe(true)
    expect(result.current.revision).toBe(4)
    expect(result.current.manifest.parent).toBe(3)
    expect(result.current.manifest.restoredFrom).toBe(1)
    expect(result.current.manifest.contentDigest).toBe(store.readRevision(1).manifest.contentDigest)
    expect(result.current.files['IDENTITY.MD'].toString('utf8')).toBe('identity')

    expect(store.readRevision(1).files['IDENTITY.MD'].toString('utf8')).toBe('identity')
    expect(store.readRevision(2).files['IDENTITY.MD'].toString('utf8')).toBe('second identity')
    expect(store.readRevision(3).files['IDENTITY.MD'].toString('utf8')).toBe('third identity')
    expect(readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')).toBe('identity')
    expect(JSON.parse(readFileSync(join(stateDirectory, CURRENT_FILE), 'utf8')).revision).toBe(4)

    const history = store.list()
    expect(history.map(entry => entry.revision)).toEqual([1, 2, 3, 4])
    expect(history.filter(entry => entry.current).map(entry => entry.revision)).toEqual([4])
  })

  it('rejects an unknown target revision', () => {
    const { binding, store } = fixture()
    store.bootstrapFromDraft()
    expect(codeOf(() => store.rollback({
      targetRevision: 9,
      expectedBaseRevision: 1,
      expectedDraftDigest: draftDigest(binding),
    }))).toBe('revision_not_found')
  })

  it('rejects a corrupt target revision', () => {
    const { directory, stateDirectory, binding, store } = fixture()
    store.bootstrapFromDraft()
    writePersona(directory, { 'IDENTITY.MD': 'second identity' })
    store.publish({ expectedBaseRevision: 1, expectedDraftDigest: draftDigest(binding) })
    rmSync(join(revisionPath(stateDirectory, 1), 'DARK.MD'))
    expect(codeOf(() => store.rollback({
      targetRevision: 1,
      expectedBaseRevision: 2,
      expectedDraftDigest: draftDigest(binding),
    }))).toBe('revision_state_corrupt')
  })

  it('rejects a stale base and a changed draft digest before creating anything', () => {
    const { directory, binding, store } = fixture()
    store.bootstrapFromDraft()
    writePersona(directory, { 'IDENTITY.MD': 'second identity' })
    store.publish({ expectedBaseRevision: 1, expectedDraftDigest: draftDigest(binding) })

    expect(codeOf(() => store.rollback({
      targetRevision: 1,
      expectedBaseRevision: 1,
      expectedDraftDigest: draftDigest(binding),
    }))).toBe('revision_conflict')
    expect(codeOf(() => store.rollback({
      targetRevision: 1,
      expectedBaseRevision: 2,
      expectedDraftDigest: 'a'.repeat(64),
    }))).toBe('persona_file_changed')
    expect(store.list()).toHaveLength(2)
  })

  it('treats a rollback to the live content as a no-op', () => {
    const { binding, store } = fixture()
    store.bootstrapFromDraft()
    const result = store.rollback({
      targetRevision: 1,
      expectedBaseRevision: 1,
      expectedDraftDigest: draftDigest(binding),
    })
    expect(result.created).toBe(false)
    expect(result.current.revision).toBe(1)
    expect(store.list()).toHaveLength(1)
  })
})

describe('recovery cleanup', () => {
  it('removes stale temporary revision directories during publish', () => {
    const { directory, binding, stateDirectory, store } = fixture()
    store.bootstrapFromDraft()
    const stale = join(stateDirectory, REVISIONS_DIR, '.r000009.bad.tmp')
    mkdirSync(stale, { recursive: true, mode: 0o700 })
    writePersona(directory, { 'IDENTITY.MD': 'second identity' })
    store.publish({ expectedBaseRevision: 1, expectedDraftDigest: draftDigest(binding) })
    expect(existsSync(stale)).toBe(false)
  })

  it('rejects a pointer whose manifest digest does not match', () => {
    const { stateDirectory, store } = fixture()
    store.bootstrapFromDraft()
    const pointer = JSON.parse(readFileSync(join(stateDirectory, CURRENT_FILE), 'utf8'))
    pointer.manifestDigest = '0'.repeat(64)
    writeFileSync(join(stateDirectory, CURRENT_FILE), `${JSON.stringify(pointer, null, 2)}\n`, { mode: 0o600 })
    expect(codeOf(() => store.loadCurrent())).toBe('revision_state_corrupt')
  })
})

describe('locks', () => {
  it('fails fast while a live lock is held', () => {
    const { stateDirectory, binding, store } = fixture()
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDirectory, '.revision.lock'), `${JSON.stringify({
      pid: process.pid,
      token: 'live',
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 })
    expect(codeOf(() => store.publish({
      expectedBaseRevision: null,
      expectedDraftDigest: draftDigest(binding),
    }))).toBe('revision_lock_timeout')
  })

  it('takes over a lock left by a dead process', () => {
    const { stateDirectory, binding, store } = fixture()
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDirectory, '.revision.lock'), `${JSON.stringify({
      pid: 2 ** 30,
      token: 'dead',
      createdAt: '2000-01-01T00:00:00.000Z',
    })}\n`, { mode: 0o600 })
    const result = store.publish({
      expectedBaseRevision: null,
      expectedDraftDigest: draftDigest(binding),
    })
    expect(result.current.revision).toBe(1)
    expect(existsSync(join(stateDirectory, '.revision.lock'))).toBe(false)
  })
})

describe('integrity', () => {
  it('rejects a revision whose file was removed', () => {
    const { stateDirectory, store } = fixture()
    store.bootstrapFromDraft()
    rmSync(join(revisionPath(stateDirectory, 1), 'DARK.MD'))
    expect(codeOf(() => store.readRevision(1))).toBe('revision_state_corrupt')
    expect(codeOf(() => store.loadCurrent())).toBe('revision_state_corrupt')
  })

  it('reports an unknown revision as not found', () => {
    const { store } = fixture()
    store.bootstrapFromDraft()
    expect(codeOf(() => store.readRevision(9))).toBe('revision_not_found')
  })

  it('leaves no temporary directories after publishing', () => {
    const { directory, binding, store } = fixture()
    store.bootstrapFromDraft()
    writePersona(directory, { 'IDENTITY.MD': 'second identity' })
    store.publish({ expectedBaseRevision: 1, expectedDraftDigest: draftDigest(binding) })
    expect(tempLeftovers(join(store.stateDirectory, REVISIONS_DIR))).toEqual([])
  })
})

describe('source provenance', () => {
  it('records the actor on bootstrap, publish and rollback, and lists it', () => {
    const { directory, binding, store } = fixture()
    const boot = store.bootstrapFromDraft()!
    expect(boot.manifest.source).toEqual({ actor: 'bootstrap' })
    writePersona(directory, { 'IDENTITY.MD': 'second identity' })
    const published = store.publish({ expectedBaseRevision: 1, expectedDraftDigest: draftDigest(binding),
      source: { actor: 'tool', note: 'laputa_init' } })
    expect(published.current.manifest.source).toEqual({ actor: 'tool', note: 'laputa_init' })
    const rolled = store.rollback({ targetRevision: 1, expectedBaseRevision: 2, expectedDraftDigest: draftDigest(binding),
      source: { actor: 'command', note: 'laputa rollback' } })
    expect(rolled.current.manifest.source).toEqual({ actor: 'command', note: 'laputa rollback' })
    expect(store.list().map(entry => entry.source)).toEqual([{ actor: 'bootstrap' },
      { actor: 'tool', note: 'laputa_init' }, { actor: 'command', note: 'laputa rollback' }])
    expect(store.readRevision(1).manifest.source).toEqual({ actor: 'bootstrap' })
  })

  it('refuses a manifest whose source is malformed', () => {
    const { stateDirectory, store } = fixture()
    store.bootstrapFromDraft()
    const path = join(revisionPath(stateDirectory, 1), MANIFEST_FILE)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...manifest, source: { actor: 'intruder' } }), { mode: 0o600 })
    expect(codeOf(() => store.list())).toBe('revision_state_corrupt')
  })

  it('reads a manifest without a source as having none', () => {
    const { stateDirectory, store } = fixture()
    store.bootstrapFromDraft()
    const path = join(revisionPath(stateDirectory, 1), MANIFEST_FILE)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    delete manifest.source
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 })
    expect(store.readRevision(1).manifest.source).toBeUndefined()
  })
})

describe('revision retention', () => {
  it('keeps the newest N revisions including the new one', () => {
    const { directory, binding, store } = fixture({ retainRevisions: 3 })
    store.bootstrapFromDraft()
    let base = 1
    for (const identity of ['a', 'b', 'c', 'd']) {
      base = publishIdentity(store, directory, binding, identity, base).current.revision
    }
    expect(base).toBe(5)
    expect(store.list().map(entry => entry.revision)).toEqual([3, 4, 5])
    expect(codeOf(() => store.readRevision(1))).toBe('revision_not_found')
    expect(codeOf(() => store.readRevision(2))).toBe('revision_not_found')
  })

  it('keeps only the live revision when retainRevisions is 1', () => {
    const { directory, binding, store } = fixture({ retainRevisions: 1 })
    store.bootstrapFromDraft()
    publishIdentity(store, directory, binding, 'only', 1)
    expect(store.list().map(entry => entry.revision)).toEqual([2])
    expect(store.loadCurrent()!.revision).toBe(2)
  })

  it('retains everything when retainRevisions is 0', () => {
    const { directory, binding, store } = fixture({ retainRevisions: 0 })
    store.bootstrapFromDraft()
    let base = 1
    for (const identity of ['a', 'b', 'c']) {
      base = publishIdentity(store, directory, binding, identity, base).current.revision
    }
    expect(base).toBe(4)
    expect(store.list()).toHaveLength(4)
  })

  it('prunes after a rollback restores the draft', () => {
    const { directory, binding, store } = fixture({ retainRevisions: 2 })
    store.bootstrapFromDraft()
    publishIdentity(store, directory, binding, 'first', 1)
    const rolled = store.rollback({
      targetRevision: 1,
      expectedBaseRevision: 2,
      expectedDraftDigest: draftDigest(binding),
      source: { actor: 'tool', note: 'test' },
    })
    expect(rolled.current.revision).toBe(3)
    expect(store.list().map(entry => entry.revision)).toEqual([2, 3])
    expect(readFileSync(join(directory, 'IDENTITY.MD'), 'utf8')).toBe('identity')
  })

  it('aborts a publish when a prune candidate is corrupt, creating nothing', () => {
    const { directory, binding, stateDirectory, store } = fixture({ retainRevisions: 1 })
    store.bootstrapFromDraft()
    renameSync(join(revisionPath(stateDirectory, 1), MANIFEST_FILE), join(revisionPath(stateDirectory, 1), 'moved.json'))
    const before = readFileSync(join(stateDirectory, CURRENT_FILE), 'utf8')
    expect(codeOf(() => publishIdentity(store, directory, binding, 'next', 1))).toBe('revision_state_corrupt')
    expect(readFileSync(join(stateDirectory, CURRENT_FILE), 'utf8')).toBe(before)
    expect(readdirSync(join(stateDirectory, REVISIONS_DIR)).sort()).toEqual(['r000001'])
  })

  it('aborts before creating anything when only the oldest revision is corrupt', () => {
    const { directory, binding, stateDirectory, store } = fixture({ retainRevisions: 2 })
    store.bootstrapFromDraft()
    publishIdentity(store, directory, binding, 'a', 1)
    publishIdentity(store, directory, binding, 'b', 2)
    renameSync(join(revisionPath(stateDirectory, 2), MANIFEST_FILE), join(revisionPath(stateDirectory, 2), 'moved.json'))
    const before = readFileSync(join(stateDirectory, CURRENT_FILE), 'utf8')
    expect(codeOf(() => publishIdentity(store, directory, binding, 'c', 3))).toBe('revision_state_corrupt')
    expect(readFileSync(join(stateDirectory, CURRENT_FILE), 'utf8')).toBe(before)
    expect(readdirSync(join(stateDirectory, REVISIONS_DIR)).sort())
      .toEqual(['r000002', 'r000003'])
  })

  it('does not prune on a no-op publish', () => {
    const { binding, stateDirectory, store } = fixture({ retainRevisions: 1 })
    store.bootstrapFromDraft()
    const before = readFileSync(join(stateDirectory, CURRENT_FILE), 'utf8')
    const noop = store.publish({
      expectedBaseRevision: 1,
      expectedDraftDigest: draftDigest(binding),
      source: { actor: 'tool', note: 'same' },
    })
    expect(noop.created).toBe(false)
    expect(noop.current.revision).toBe(1)
    expect(store.list()).toHaveLength(1)
    expect(store.readRevision(1).manifest.revision).toBe(1)
    expect(readFileSync(join(stateDirectory, CURRENT_FILE), 'utf8')).toBe(before)
  })
})
