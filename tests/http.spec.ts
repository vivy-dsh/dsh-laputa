import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePersonaBinding, type PersonaBinding } from '../src/binding.ts'
import { PersonaCache, type PersonaLimits } from '../src/cache.ts'
import { PANEL_PREFIX, registerLaputaPanel } from '../src/http.ts'
import { readPersonaDraft, RevisionStore } from '../src/revision.ts'
import { removeDir, tempDir, writePersona } from './helpers.ts'

const LIMITS = { maxSourceBytes: 1024, maxPersonaChars: 4096 }
const dirs: string[] = []

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function fixture(overrides: Parameters<typeof writePersona>[1] = {}) {
  const root = tempDir()
  dirs.push(root)
  const directory = join(root, 'persona')
  writePersona(directory, overrides)
  const binding = resolvePersonaBinding({ personaId: 'vivy', sourceDir: directory })
  const cache = new PersonaCache(binding, LIMITS)
  cache.load()
  return { root, directory, binding, cache }
}

function storeFixture(
  overrides: Parameters<typeof writePersona>[1] = {},
  limits: PersonaLimits = LIMITS,
) {
  const root = tempDir()
  dirs.push(root)
  const directory = join(root, 'persona')
  writePersona(directory, overrides)
  const stateDirectory = join(root, 'state')
  const binding = resolvePersonaBinding({
    personaId: 'vivy',
    sourceDir: directory,
    stateDir: stateDirectory,
  })
  const store = new RevisionStore(binding, stateDirectory, limits)
  const cache = new PersonaCache(binding, limits, () => {}, store)
  cache.load()
  return { root, directory, stateDirectory, binding, store, cache }
}

function draftDigest(binding: PersonaBinding): string {
  return readPersonaDraft(binding, LIMITS).digest
}

interface Reply {
  readonly status: number | undefined
  readonly body: Record<string, any>
}

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

function harness(cache: PersonaCache, options: {
  connection?: boolean
  reject?: unknown
} = {}) {
  let handler: Handler | undefined
  const ctx = {
    get: (key: string) => {
      if (key === 'webServer') {
        return {
          register(route: { handler: Handler }) {
            handler = route.handler
            return () => {}
          },
        }
      }
      if (key === 'connection') {
        return options.connection === false
          ? undefined
          : { requestRejection: () => options.reject }
      }
      return undefined
    },
  } as unknown as Context
  registerLaputaPanel(ctx, cache)

  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    if (handler === undefined) throw new Error('panel handler was not registered')
    const chunks = body === undefined
      ? []
      : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const req = Readable.from(chunks) as unknown as IncomingMessage
    Object.assign(req, {
      url: `${PANEL_PREFIX}${path}`,
      method,
      headers: {
        host: '127.0.0.1:3082',
        ...(method === 'POST' && body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
    })
    let status: number | undefined
    let value = ''
    const res = {
      writeHead(code: number) { status = code },
      end(text: string) { value = text },
    } as unknown as ServerResponse
    await handler(req, res)
    return { status, body: JSON.parse(value) as Record<string, any> }
  }

  return { call }
}

afterEach(() => {
  while (dirs.length > 0) removeDir(dirs.pop() as string)
})

describe('panel HTTP API', () => {
  it('returns status and file details', async () => {
    const { cache } = fixture()
    const { call } = harness(cache)
    const reply = await call('GET', '/status')
    expect(reply.status).toBe(200)
    expect(reply.body.ok).toBe(true)
    expect(reply.body.status.personaId).toBe('vivy')
    expect(reply.body.status.initialized).toBe(true)
    expect(reply.body.fileDetails['IDENTITY.MD'].digest).toBe(digest('identity'))
    expect(reply.body.fileDetails['DREAM.MD'].blank).toBe(true)
    expect(reply.body.fileDetails['DREAM.MD'].exists).toBe(true)
  })

  it('reads one document by exact name', async () => {
    const { cache } = fixture()
    const { call } = harness(cache)
    const reply = await call('GET', '/file?name=IDENTITY.MD')
    expect(reply.status).toBe(200)
    expect(reply.body.content).toBe('identity')
    expect(reply.body.digest).toBe(digest('identity'))
    expect(reply.body.exists).toBe(true)
    expect((await call('GET', '/file?name=../escape')).status).toBe(400)
    expect((await call('GET', '/file?name=NOPE.MD')).body.code).toBe('INVALID_NAME')
  })

  it('replaces one file and reloads the cache', async () => {
    const { directory, cache } = fixture()
    const { call } = harness(cache)
    const reply = await call('POST', '/file', {
      name: 'RELATIONSHIP.MD',
      content: 'peer\n',
      expectedDigest: digest('relationship'),
    })
    expect(reply.status).toBe(200)
    expect(reply.body.ok).toBe(true)
    expect(reply.body.name).toBe('RELATIONSHIP.MD')
    expect(reply.body.reloaded).toBe(true)
    expect(reply.body.status.initialized).toBe(true)
    expect(readFileSync(join(directory, 'RELATIONSHIP.MD'), 'utf8')).toBe('peer\n')
  })

  it('rejects a stale digest with 409', async () => {
    const { cache } = fixture()
    const { call } = harness(cache)
    const reply = await call('POST', '/file', {
      name: 'IDENTITY.MD',
      content: 'new\n',
      expectedDigest: digest('stale'),
    })
    expect(reply.status).toBe(409)
    expect(reply.body.code).toBe('FILE_CHANGED')
  })

  it('maps budget failures to 422', async () => {
    const { cache } = fixture()
    const { call } = harness(cache)
    const reply = await call('POST', '/file', {
      name: 'IDENTITY.MD',
      content: 'x'.repeat(2000),
      expectedDigest: digest('identity'),
    })
    expect(reply.status).toBe(422)
    expect(reply.body.code).toBe('BUDGET_EXCEEDED')
  })

  it('reloads on request', async () => {
    const { directory, cache } = fixture()
    const { call } = harness(cache)
    const before = await call('GET', '/status')
    expect(before.body.status.pendingChanges).toBe(false)
    writePersona(directory, { 'MISSION.MD': 'changed' })
    const reply = await call('POST', '/reload')
    expect(reply.status).toBe(200)
    expect(reply.body.status.chars).toBeGreaterThan(0)
    expect(reply.body.status.pendingChanges).toBe(false)
  })

  it('rejects non-loopback hosts and cross-site origins', async () => {
    const { cache } = fixture()
    const { call } = harness(cache)
    expect((await call('GET', '/status', undefined, { host: 'example.com' })).status).toBe(403)
    expect((await call('POST', '/reload', {}, { origin: 'https://example.com' })).status).toBe(403)
    expect((await call('POST', '/reload', {}, { origin: 'http://127.0.0.1:3082' })).status).toBe(200)
  })

  it('requires the host session check', async () => {
    const { cache } = fixture()
    expect((await harness(cache, { reject: 401 }).call('GET', '/status')).status).toBe(401)
    expect((await harness(cache, { connection: false }).call('GET', '/status')).status).toBe(503)
  })

  it('requires JSON and caps the request body', async () => {
    const { cache } = fixture()
    const { call } = harness(cache)
    expect((await call('POST', '/file', { name: 'IDENTITY.MD' }, { 'content-type': 'text/plain' })).status).toBe(415)
    const oversized = await call('POST', '/file', {
      name: 'IDENTITY.MD',
      content: 'x'.repeat(300 * 1024),
      expectedDigest: digest('identity'),
    })
    expect(oversized.status).toBe(413)
    expect(oversized.body.code).toBe('BODY_TOO_LARGE')
  })

  it('rejects malformed JSON and incomplete payloads', async () => {
    const { cache } = fixture()
    const { call } = harness(cache)
    const malformed = await call('POST', '/file', '{not json')
    expect(malformed.status).toBe(400)
    expect(malformed.body.code).toBe('INVALID_JSON')
    const incomplete = await call('POST', '/file', { name: 'IDENTITY.MD' })
    expect(incomplete.status).toBe(400)
    expect(incomplete.body.code).toBe('INVALID_REQUEST')
  })
})

describe('panel revision API', () => {
  async function editDraft(call: ReturnType<typeof harness>['call']): Promise<void> {
    const reply = await call('POST', '/file', {
      name: 'RELATIONSHIP.MD',
      content: 'peer\n',
      expectedDigest: digest('relationship'),
    })
    expect(reply.status).toBe(200)
    expect(reply.body.reloaded).toBe(false)
  }

  it('reports revision state in the status payload', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    const reply = await call('GET', '/status')
    expect(reply.status).toBe(200)
    expect(reply.body.status.revision).toBe(1)
    expect(reply.body.status.liveDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(reply.body.status.draftDigest).toBe(reply.body.status.liveDigest)
    expect(reply.body.status.draftInitialized).toBe(true)
    expect(reply.body.status.revisionPending).toBe(false)
    expect(reply.body.status.revisionRetention).toBe(0)
  })

  it('reports the configured retention in status', async () => {
    const { cache } = storeFixture({}, { ...LIMITS, retainRevisions: 3 })
    const { call } = harness(cache)
    const reply = await call('GET', '/status')
    expect(reply.status).toBe(200)
    expect(reply.body.status.revisionRetention).toBe(3)
  })

  it('saves a file to the draft without changing the live revision', async () => {
    const { directory, cache } = storeFixture()
    const { call } = harness(cache)
    await editDraft(call)
    const status = (await call('GET', '/status')).body.status
    expect(status.revision).toBe(1)
    expect(status.revisionPending).toBe(true)
    expect(status.draftDigest).not.toBe(status.liveDigest)
    expect(cache.promptText()).not.toContain('peer')
    expect(readFileSync(join(directory, 'RELATIONSHIP.MD'), 'utf8')).toBe('peer\n')
  })

  it('publishes the draft with compare-and-swap', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    await editDraft(call)
    const status = (await call('GET', '/status')).body.status

    const reply = await call('POST', '/publish', {
      expectedBaseRevision: 1,
      expectedDraftDigest: status.draftDigest,
    })
    expect(reply.status).toBe(200)
    expect(reply.body.published).toBe(true)
    expect(reply.body.revision).toBe(2)
    expect(reply.body.status.revision).toBe(2)
    expect(reply.body.status.revisionPending).toBe(false)
    expect(cache.promptText()).toContain('peer')

    const again = await call('POST', '/publish', {
      expectedBaseRevision: 2,
      expectedDraftDigest: reply.body.status.draftDigest,
    })
    expect(again.status).toBe(200)
    expect(again.body.published).toBe(false)
    expect(again.body.revision).toBe(2)
  })

  it('rejects a stale base revision with 409', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    await editDraft(call)
    const status = (await call('GET', '/status')).body.status
    const reply = await call('POST', '/publish', {
      expectedBaseRevision: 7,
      expectedDraftDigest: status.draftDigest,
    })
    expect(reply.status).toBe(409)
    expect(reply.body.code).toBe('REVISION_CONFLICT')
  })

  it('rejects a stale draft digest with 409', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    await editDraft(call)
    const reply = await call('POST', '/publish', {
      expectedBaseRevision: 1,
      expectedDraftDigest: digest('stale'),
    })
    expect(reply.status).toBe(409)
    expect(reply.body.code).toBe('FILE_CHANGED')
  })

  it('rejects publishing an uninitialized draft with 422', async () => {
    const fixture = storeFixture({ 'MISSION.MD': '', 'IDENTITY.MD': '' })
    const { call } = harness(fixture.cache)
    const reply = await call('POST', '/publish', {
      expectedBaseRevision: null,
      expectedDraftDigest: draftDigest(fixture.binding),
    })
    expect(reply.status).toBe(422)
    expect(reply.body.code).toBe('REVISION_NOT_INITIALIZED')
  })

  it('rolls back by creating a new revision and restoring the draft', async () => {
    const { directory, cache } = storeFixture()
    const { call } = harness(cache)
    await editDraft(call)
    const first = (await call('GET', '/status')).body.status
    await call('POST', '/publish', {
      expectedBaseRevision: 1,
      expectedDraftDigest: first.draftDigest,
    })
    const live = (await call('GET', '/status')).body.status

    const reply = await call('POST', '/rollback', {
      targetRevision: 1,
      expectedBaseRevision: live.revision,
      expectedDraftDigest: live.draftDigest,
    })
    expect(reply.status).toBe(200)
    expect(reply.body.published).toBe(true)
    expect(reply.body.revision).toBe(3)
    expect(reply.body.status.revision).toBe(3)
    expect(readFileSync(join(directory, 'RELATIONSHIP.MD'), 'utf8')).toBe('relationship')

    const history = await call('GET', '/revisions')
    expect(history.status).toBe(200)
    expect(history.body.current).toBe(3)
    expect(history.body.revisions.map((row: { revision: number }) => row.revision)).toEqual([1, 2, 3])
    expect(history.body.revisions[2].restoredFrom).toBe(1)
    expect(history.body.revisions[2].current).toBe(true)
  })

  it('rejects unknown rollback targets and stale bases', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    const status = (await call('GET', '/status')).body.status
    const unknown = await call('POST', '/rollback', {
      targetRevision: 99,
      expectedBaseRevision: status.revision,
      expectedDraftDigest: status.draftDigest,
    })
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('REVISION_NOT_FOUND')
  })

  it('rejects rollback with a stale base revision', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    await editDraft(call)
    const first = (await call('GET', '/status')).body.status
    await call('POST', '/publish', {
      expectedBaseRevision: 1,
      expectedDraftDigest: first.draftDigest,
    })
    const live = (await call('GET', '/status')).body.status
    const reply = await call('POST', '/rollback', {
      targetRevision: 1,
      expectedBaseRevision: 1,
      expectedDraftDigest: live.draftDigest,
    })
    expect(reply.status).toBe(409)
    expect(reply.body.code).toBe('REVISION_CONFLICT')
  })

  it('reports revision_unavailable without a store', async () => {
    const { cache } = fixture()
    const { call } = harness(cache)
    const reply = await call('POST', '/rollback', {
      targetRevision: 1,
      expectedBaseRevision: null,
      expectedDraftDigest: digest('x'),
    })
    expect(reply.status).toBe(503)
    expect(reply.body.code).toBe('REVISION_UNAVAILABLE')
  })

  it('lists history in ascending order with the current revision', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    const history = await call('GET', '/revisions')
    expect(history.status).toBe(200)
    expect(history.body.current).toBe(1)
    expect(history.body.revisions).toEqual([{
      revision: 1,
      createdAt: expect.any(String),
      parent: null,
      restoredFrom: null,
      contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      current: true,
      source: { actor: 'bootstrap' },
    }])
  })

  it('returns a historical revision with a diff against the live revision', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    await editDraft(call)
    const draft = (await call('GET', '/status')).body.status
    await call('POST', '/publish', {
      expectedBaseRevision: 1,
      expectedDraftDigest: draft.draftDigest,
    })

    const reply = await call('GET', '/revision?revision=1')
    expect(reply.status).toBe(200)
    expect(reply.body.revision).toBe(1)
    expect(reply.body.liveRevision).toBe(2)
    expect(reply.body.sameAsLive).toBe(false)
    expect(reply.body.manifest.revision).toBe(1)
    expect(reply.body.manifest.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(reply.body.manifest.files['RELATIONSHIP.MD']).toMatchObject({
      bytes: expect.any(Number),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(reply.body.diff.from).toBe(2)
    expect(reply.body.diff.to).toBe(1)

    const relationship = reply.body.diff.files
      .find((file: { name: string }) => file.name === 'RELATIONSHIP.MD')
    expect(relationship).toMatchObject({
      changed: true,
      added: 1,
      removed: 1,
      truncated: false,
    })
    expect(relationship.hunks).toHaveLength(1)
    expect(relationship.hunks[0].lines.map((line: { kind: string }) => line.kind))
      .toEqual(['remove', 'add'])
    expect(relationship.content).toBeUndefined()

    const mission = reply.body.diff.files
      .find((file: { name: string }) => file.name === 'MISSION.MD')
    expect(mission).toMatchObject({ changed: false, added: 0, removed: 0, hunks: [] })
    expect(reply.body.files).toBeUndefined()
  })

  it('returns the live revision without a diff', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    const reply = await call('GET', '/revision?revision=1')
    expect(reply.status).toBe(200)
    expect(reply.body.sameAsLive).toBe(true)
    expect(reply.body.liveRevision).toBe(1)
    expect(reply.body.diff).toBeNull()
  })

  it('validates revision queries', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    for (const query of ['?revision=0', '?revision=1.5', '?revision=abc', '']) {
      const reply = await call('GET', `/revision${query}`)
      expect(reply.status).toBe(400)
      expect(reply.body.code).toBe('INVALID_REQUEST')
    }
    const missing = await call('GET', '/revision?revision=99')
    expect(missing.status).toBe(404)
    expect(missing.body.code).toBe('REVISION_NOT_FOUND')
  })

  it('reports revision_unavailable for a revision query without a store', async () => {
    const { cache } = fixture()
    const { call } = harness(cache)
    const reply = await call('GET', '/revision?revision=1')
    expect(reply.status).toBe(503)
    expect(reply.body.code).toBe('REVISION_UNAVAILABLE')
  })

  it('maps a held lock to 503 REVISION_LOCK_TIMEOUT', async () => {
    const { stateDirectory, cache } = storeFixture()
    const { call } = harness(cache)
    writeFileSync(join(stateDirectory, '.revision.lock'), `${JSON.stringify({
      pid: process.pid,
      token: 'held',
      createdAt: new Date().toISOString(),
    })}\n`)
    const status = (await call('GET', '/status')).body.status
    const reply = await call('POST', '/publish', {
      expectedBaseRevision: status.revision,
      expectedDraftDigest: status.draftDigest,
    })
    expect(reply.status).toBe(503)
    expect(reply.body.code).toBe('REVISION_LOCK_TIMEOUT')
  })

  it('maps corrupt revision state to 500 REVISION_STATE_CORRUPT', async () => {
    const { stateDirectory, cache } = storeFixture()
    const { call } = harness(cache)
    writeFileSync(join(stateDirectory, 'current.json'), '{broken\n')
    const reply = await call('GET', '/revisions')
    expect(reply.status).toBe(500)
    expect(reply.body.code).toBe('REVISION_STATE_CORRUPT')
    const detail = await call('GET', '/revision?revision=1')
    expect(detail.status).toBe(500)
    expect(detail.body.code).toBe('REVISION_STATE_CORRUPT')
  })

  it('validates publish and rollback bodies', async () => {
    const { cache } = storeFixture()
    const { call } = harness(cache)
    const badBase = await call('POST', '/publish', {
      expectedBaseRevision: 'one',
      expectedDraftDigest: digest('x'),
    })
    expect(badBase.status).toBe(400)
    expect(badBase.body.code).toBe('INVALID_REQUEST')
    const missing = await call('POST', '/publish', {})
    expect(missing.status).toBe(400)
    expect(missing.body.code).toBe('INVALID_REQUEST')
    const badTarget = await call('POST', '/rollback', {
      targetRevision: 0,
      expectedBaseRevision: null,
      expectedDraftDigest: digest('x'),
    })
    expect(badTarget.status).toBe(400)
    expect(badTarget.body.code).toBe('INVALID_REQUEST')
  })

  it('records the panel as the actor of a publish and a rollback', async () => {
    const { store, cache } = storeFixture()
    const { call } = harness(cache)
    await editDraft(call)
    const draft = (await call('GET', '/status')).body.status
    await call('POST', '/publish', { expectedBaseRevision: 1, expectedDraftDigest: draft.draftDigest })
    expect(store.readRevision(2).manifest.source).toEqual({ actor: 'panel' })
    const live = (await call('GET', '/status')).body.status
    await call('POST', '/rollback', { targetRevision: 1, expectedBaseRevision: 2, expectedDraftDigest: live.draftDigest })
    expect(store.readRevision(3).manifest.source).toEqual({ actor: 'panel' })
  })
})
