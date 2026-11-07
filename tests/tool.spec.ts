import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolvePersonaBinding } from '../src/binding.ts'
import { PersonaCache } from '../src/cache.ts'
import { PersonaError } from '../src/domain.ts'
import { RevisionStore } from '../src/revision.ts'
import { INIT_TOOL_NAME, registerPersonaTool } from '../src/tool.ts'
import { removeDir, tempDir, writePersona } from './helpers.ts'

const LIMITS = { maxSourceBytes: 1024, maxPersonaChars: 4096 }
const dirs: string[] = []

interface CapturedTool {
  name: string
  description: string
  parameters: { type: string; properties: Record<string, { type: string; description?: string }>; required?: string[] }
  output: {
    schema: { type: string; properties: Record<string, unknown> }
    render(args: unknown, value: unknown): Array<{ type: string; text: string }>
  }
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>
  presentCall(args: unknown): unknown
}

function capture(options: { prepared?: boolean; store?: boolean } = {}) {
  const root = tempDir()
  dirs.push(root)
  const directory = join(root, 'persona')
  if (options.prepared === true) writePersona(directory)
  const binding = resolvePersonaBinding({
    personaId: 'vivy',
    sourceDir: directory,
    stateDir: join(root, 'state'),
  })
  const store = options.store === true
    ? new RevisionStore(binding, binding.stateDirectory, LIMITS)
    : undefined
  const cache = new PersonaCache(binding, LIMITS, undefined, store)
  cache.load()

  let definition: CapturedTool | undefined
  const ctx = {
    tools: {
      register(value: CapturedTool) {
        definition = value
        return () => {}
      },
    },
  } as unknown as Context
  const dispose = registerPersonaTool(ctx, cache)
  if (definition === undefined) throw new Error('tool was not registered')
  return { root, directory, cache, store, tool: definition, dispose }
}

function topLevel(): Agent {
  return { session: { id: 'root', header: {} } } as unknown as Agent
}

function subagent(): Agent {
  return { session: { id: 'child', header: { origin: 'subagent' } } } as unknown as Agent
}

afterEach(() => {
  while (dirs.length > 0) removeDir(dirs.pop() as string)
})

describe('laputa_init tool', () => {
  it('registers a create-only tool with all six fields', () => {
    const fixture = capture()
    expect(fixture.tool.name).toBe(INIT_TOOL_NAME)
    expect(fixture.tool.description).toContain('never overwrites')
    expect(fixture.tool.parameters.type).toBe('object')
    expect(Object.keys(fixture.tool.parameters.properties).sort())
      .toEqual(['dark', 'dream', 'identity', 'mission', 'redline', 'relationship'])
    expect(fixture.tool.parameters.required).toBeUndefined()
    expect(fixture.tool.output.schema.type).toBe('object')
    expect(Object.keys(fixture.tool.output.schema.properties).sort())
      .toEqual(['pending', 'preserved', 'revision', 'status', 'written'])
  })

  it('writes the persona and reloads the cache', async () => {
    const fixture = capture()
    const result = await fixture.tool.execute({
      identity: 'A calm guide',
      mission: 'Help me think',
      relationship: 'Peer',
      redline: 'Ask first',
      dream: 'Grow steadier',
      dark: 'Fear of being useless',
    }, { agent: topLevel() })
    expect(result.status).toBe('initialized')
    expect(result.written).toHaveLength(6)
    expect(result.preserved).toEqual([])
    expect(fixture.cache.status().initialized).toBe(true)
    expect(fixture.cache.promptText()).toContain('A calm guide')
    expect(readFileSync(join(fixture.directory, 'IDENTITY.MD'), 'utf8')).toBe('A calm guide\n')
  })

  it('publishes the initialized draft and refreshes the calling agent', async () => {
    const fixture = capture({ store: true })
    const agent = topLevel()
    const session = fixture.cache.session(agent)
    expect(session.promptText()).toBe('')
    const result = await fixture.tool.execute({
      identity: 'A calm guide',
      mission: 'Help me think',
    }, { agent })
    expect(result.revision).toBe(1)
    expect(fixture.store!.readRevision(1).manifest.source).toEqual({ actor: 'tool', note: 'laputa_init' })
    expect(fixture.cache.status().revision).toBe(1)
    expect(existsSync(join(fixture.root, 'state', 'current.json'))).toBe(true)
    expect(session.revision).toBe(1)
    expect(session.promptText()).toContain('A calm guide')
  })

  it('keeps the current revision when the content did not change', async () => {
    const fixture = capture({ store: true })
    const agent = topLevel()
    const first = await fixture.tool.execute({ identity: 'id', mission: 'mission' }, { agent })
    expect(first.revision).toBe(1)
    const second = await fixture.tool.execute({ identity: 'id', mission: 'mission' }, { agent })
    expect(second.revision).toBe(1)
    expect(second.preserved).toEqual(['MISSION.MD', 'IDENTITY.MD'])
    expect(fixture.cache.listRevisions()).toHaveLength(1)
  })

  it('surfaces a publish conflict and keeps the draft', async () => {
    const fixture = capture({ store: true })
    fixture.cache.publishDraft = () => {
      throw new PersonaError('revision_conflict', 'current revision moved')
    }
    await expect(fixture.tool.execute({
      identity: 'id',
      mission: 'mission',
    }, { agent: topLevel() })).rejects.toThrow('revision_conflict')
    expect(readFileSync(join(fixture.directory, 'IDENTITY.MD'), 'utf8')).toBe('id\n')
    expect(fixture.cache.status().revision).toBeNull()
  })

  it('preserves existing content and reports what is still pending', async () => {
    const fixture = capture({ prepared: true })
    expect(fixture.cache.status().initialized).toBe(true)
    const result = await fixture.tool.execute({
      identity: 'replacement',
      mission: 'replacement',
      dream: 'draft',
    }, { agent: topLevel() })
    expect(result.preserved).toEqual(['MISSION.MD', 'IDENTITY.MD', 'RELATIONSHIP.MD', 'REDLINE.MD'])
    expect(result.written).toEqual(['DREAM.MD', 'DARK.MD'])
    expect(result.pending).toEqual(['DARK.MD'])
    expect(readFileSync(join(fixture.directory, 'IDENTITY.MD'), 'utf8')).toBe('identity')
  })

  it('rejects a non-top-level agent', async () => {
    const fixture = capture()
    await expect(fixture.tool.execute({ identity: 'id', mission: 'mission' }, { agent: subagent() }))
      .rejects.toThrow('top-level')
  })

  it('rejects a missing execution agent', async () => {
    const fixture = capture()
    await expect(fixture.tool.execute({ identity: 'id', mission: 'mission' }, {}))
      .rejects.toThrow('top-level')
  })

  it('surfaces a write failure as a tool error', async () => {
    const fixture = capture()
    await expect(fixture.tool.execute({ mission: 'mission' }, { agent: topLevel() }))
      .rejects.toThrow('identity_assignment_required')
  })

  it('renders a readable summary', () => {
    const fixture = capture()
    expect(fixture.tool.output.render({}, {
      status: 'initialized',
      written: ['IDENTITY.MD'],
      preserved: ['MISSION.MD'],
      pending: [],
    })).toEqual([{
      type: 'text',
      text: 'Persona initialized.\nWritten: IDENTITY.MD\nPreserved: MISSION.MD',
    }])
  })

  it('renders the published revision', () => {
    const fixture = capture()
    const rendered = fixture.tool.output.render({}, {
      status: 'initialized',
      written: [],
      preserved: [],
      pending: [],
      revision: 3,
    })
    expect(rendered[0]?.text).toContain('Revision: r000003')
  })

  it('presents a generic initialization card', () => {
    const fixture = capture()
    expect(fixture.tool.presentCall({})).toEqual({
      card: 'generic',
      title: 'Initialize persona',
      kind: 'other',
    })
  })

  it('returns the registry disposer', () => {
    const fixture = capture()
    expect(typeof fixture.dispose).toBe('function')
  })
})
