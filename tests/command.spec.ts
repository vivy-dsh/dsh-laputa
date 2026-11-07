import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PersonaCache, PersonaStatus } from '../src/cache.ts'
import {
  formatStatus, registerLaputaCommand, type CommandDefinition, type CommandInvocation,
} from '../src/command.ts'
import { ASSEMBLY_FILES, PersonaError, type PersonaFile } from '../src/domain.ts'

const FILES = Object.fromEntries(
  ASSEMBLY_FILES.map(name => [name, name === 'MISSION.MD' ? 700 : 0]),
) as Record<PersonaFile, number>

function status(overrides: Partial<PersonaStatus> = {}): PersonaStatus {
  return {
    enabled: true,
    loaded: true,
    initialized: true,
    personaId: 'vivy',
    directory: '/tmp/laputa/vivy',
    customSource: false,
    files: FILES,
    chars: 42,
    fingerprint: 'abcdef0123456789',
    pendingFiles: [],
    lastLoadedAt: '2026-11-02T00:00:00.000Z',
    pendingChanges: false,
    stale: false,
    revision: null,
    liveDigest: null,
    draftDigest: '',
    draftInitialized: true,
    draftChars: 42,
    draftPendingFiles: [],
    revisionPending: false,
    revisionCount: 0,
    revisionRetention: 0,
    stateDirectory: null,
    ...overrides,
  }
}

function harness(cache: Partial<PersonaCache>) {
  let definition: CommandDefinition | undefined
  let disposed = false
  const dispose = registerLaputaCommand({
    register(value) {
      definition = value
      return () => { disposed = true }
    },
  }, cache as PersonaCache)
  if (definition === undefined) throw new Error('command was not registered')
  const run = (rawInput: string, agent?: Agent) => definition?.handler({
    rawInput,
    ...(agent === undefined ? {} : { agent }),
  } as CommandInvocation)
  return { definition, run, dispose, isDisposed: () => disposed }
}

describe('laputa command registration', () => {
  it('registers a single /laputa command with a hint', () => {
    const { definition, dispose } = harness({})
    expect(definition.name).toBe('laputa')
    expect(definition.description).toContain('人格')
    expect(definition.input?.hint).toBe('status | validate | reload | init | publish | revisions | rollback <n>')
    dispose()
  })

  it('returns the host disposer', () => {
    const { dispose, isDisposed } = harness({})
    expect(isDisposed()).toBe(false)
    dispose()
    expect(isDisposed()).toBe(true)
  })
})

describe('/laputa status', () => {
  it('defaults to status for bare input', async () => {
    const { run } = harness({ status: () => status() })
    const result = await run('')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('laputa: 已启用')
    expect(result.text).toContain('人格: vivy')
    expect(result.text).toContain('指纹: abcdef012345')
    expect(result.text).toContain('状态: 正常')
    expect(result.text).toContain('面板: 侧边栏「人格」')
  })

  it('accepts the command name in the raw input', async () => {
    const { run } = harness({ status: () => status() })
    const result = await run('/laputa status')
    expect(result.text).toContain('laputa: 已启用')
  })

  it('reports a disabled plugin', async () => {
    const { run } = harness({ status: () => status({ enabled: false, loaded: false, chars: 0, fingerprint: '' }) })
    const result = await run('status')
    expect(result.text).toContain('laputa: 已停用')
    expect(result.text).toContain('指纹: 未加载')
  })

  it('reports an error and pending changes', async () => {
    const { run } = harness({
      status: () => status({ lastError: 'world_writable_file_refused: nope', stale: true }),
    })
    const result = await run('status')
    expect(result.text).toContain('错误: world_writable_file_refused')

    const pending = harness({ status: () => status({ pendingChanges: true, stale: true }) })
    const pendingResult = await pending.run('status')
    expect(pendingResult.text).toContain('文件已变化')
  })

  it('reports pending files while uninitialized', async () => {
    const { run } = harness({
      status: () => status({
        initialized: false,
        chars: 0,
        pendingFiles: ['IDENTITY.MD', 'RELATIONSHIP.MD'],
      }),
    })
    const result = await run('status')
    expect(result.text).toContain('初始化: 未完成')
    expect(result.text).toContain('待填写: IDENTITY.MD，RELATIONSHIP.MD')
  })

  it('reports an unloaded persona', async () => {
    const { run } = harness({ status: () => status({ loaded: false, initialized: false }) })
    const result = await run('status')
    expect(result.text).toContain('初始化: 未加载')
  })

  it('reports the live revision and an unpublished draft', async () => {
    const { run } = harness({
      status: () => status({
        revision: 2,
        liveDigest: 'a'.repeat(64),
        draftDigest: 'b'.repeat(64),
        revisionPending: true,
        revisionCount: 2,
        stateDirectory: '/tmp/laputa/state/vivy',
        pendingChanges: true,
        stale: true,
      }),
    })
    const result = await run('status')
    expect(result.text).toContain('版本: r2 / 共 2 个')
    expect(result.text).toContain('草稿: 有未发布修改')
    expect(result.text).toContain('/laputa publish')
    expect(result.text).not.toContain('下一轮自动生效')
  })

  it('reports a synced draft', async () => {
    const { run } = harness({
      status: () => status({ revision: 1, revisionCount: 1, stateDirectory: '/tmp/state' }),
    })
    const result = await run('status')
    expect(result.text).toContain('版本: r1 / 共 1 个')
    expect(result.text).toContain('草稿: 已同步')
    expect(result.text).toContain('状态: 正常')
  })
})

describe('/laputa init', () => {
  it('lists the two core questions while uninitialized', async () => {
    const { run } = harness({
      status: () => status({
        initialized: false,
        chars: 0,
        pendingFiles: ['MISSION.MD', 'IDENTITY.MD'],
      }),
    })
    const result = await run('init')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('我是谁')
    expect(result.text).toContain('我的使命')
    expect(result.text).toContain('高级初始化')
    expect(result.text).toContain('DREAM / DARK')
  })

  it('points an initialized persona at the remaining options', async () => {
    const { run } = harness({ status: () => status() })
    const result = await run('init')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已初始化')
    expect(result.text).toContain('laputa_init')
  })

  it('refuses to start setup while disabled', async () => {
    const { run } = harness({ status: () => status({ enabled: false, loaded: false }) })
    const result = await run('init')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('已停用')
  })
})

describe('/laputa validate', () => {
  it('reports a successful validation', async () => {
    const { run } = harness({
      validate: () => ({
        status: 'initialized',
        assembled: { body: 'body', text: 'text', chars: 42, files: FILES },
        fingerprint: 'f',
      }),
    })
    const result = await run('validate')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('校验通过')
    expect(result.text).toContain('42 字符')
    expect(result.text).toContain('MISSION.MD 700 B')
  })

  it('reports an uninitialized persona as pending, not as an error', async () => {
    const { run } = harness({
      validate: () => ({ status: 'uninitialized', pending: ['IDENTITY.MD'], files: FILES, fingerprint: 'f' }),
    })
    const result = await run('validate')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('未初始化')
    expect(result.text).toContain('IDENTITY.MD')
  })

  it('reports the boundary error code', async () => {
    const { run } = harness({
      validate: () => { throw new PersonaError('mission_assignment_required', 'MISSION.MD is empty') },
    })
    const result = await run('validate')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('校验失败')
    expect(result.text).toContain('mission_assignment_required')
  })
})

describe('/laputa reload', () => {
  it('reports the refreshed character count', async () => {
    const { run } = harness({
      status: () => status(),
      reload: () => ({
        status: 'initialized',
        assembled: { body: 'body', text: 'text', chars: 99, files: FILES },
        fingerprint: 'f',
      }),
    })
    const result = await run('reload')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已重新加载')
    expect(result.text).toContain('99 字符')
  })

  it('reports an uninitialized persona after reload', async () => {
    const { run } = harness({
      status: () => status(),
      reload: () => ({ status: 'uninitialized', pending: ['MISSION.MD'], files: FILES, fingerprint: 'f' }),
    })
    const result = await run('reload')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('仍未初始化')
    expect(result.text).toContain('MISSION.MD')
  })

  it('refuses to reload while disabled', async () => {
    const { run } = harness({ status: () => status({ enabled: false }) })
    const result = await run('reload')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('已停用')
  })

  it('reports a reload failure', async () => {
    const { run } = harness({
      status: () => status(),
      reload: () => { throw new PersonaError('invalid_utf8', 'IDENTITY.MD is not UTF-8') },
    })
    const result = await run('reload')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('重新加载失败')
    expect(result.text).toContain('invalid_utf8')
  })

  it('refreshes the calling agent pin and reports the revision', async () => {
    const agent = { session: { id: 'root', header: {} } } as unknown as Agent
    const refreshed: unknown[] = []
    const { run } = harness({
      status: () => status({ revision: 3, revisionCount: 3, stateDirectory: '/tmp/state' }),
      reload: () => ({
        status: 'initialized',
        assembled: { body: 'body', text: 'text', chars: 42, files: FILES },
        fingerprint: 'f',
      }),
      refreshSessions: (key?: unknown) => { refreshed.push(key) },
    })
    const result = await run('reload', agent)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('r3')
    expect(refreshed).toEqual([agent])
  })
})

describe('/laputa publish', () => {
  function publishCache(overrides: Partial<PersonaCache> = {}, result: unknown = {
    current: { revision: 3 },
    created: true,
  }) {
    const calls: unknown[] = []
    const cache = {
      status: () => status({
        revision: 2,
        draftDigest: 'd'.repeat(64),
        revisionPending: true,
        revisionCount: 2,
        stateDirectory: '/tmp/state',
        ...overrides,
      }),
      publishDraft: (input: unknown) => {
        calls.push(input)
        return result
      },
      ...overrides,
    }
    return { cache: cache as Partial<PersonaCache>, calls }
  }

  it('publishes with the current base and draft digest', async () => {
    const { cache, calls } = publishCache()
    const { run } = harness(cache)
    const result = await run('publish')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已发布 r3')
    expect(calls).toEqual([{ expectedBaseRevision: 2, expectedDraftDigest: 'd'.repeat(64),
      source: { actor: 'command', note: 'laputa publish' } }])
  })

  it('reports an unchanged content result', async () => {
    const { cache } = publishCache({}, { current: { revision: 2 }, created: false })
    const { run } = harness(cache)
    const result = await run('publish')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('内容未变化')
  })

  it('reports a conflict without pretending to publish', async () => {
    const cache = {
      status: () => status({ revision: 2, draftDigest: 'd'.repeat(64), stateDirectory: '/tmp/state' }),
      publishDraft: () => { throw new PersonaError('revision_conflict', 'current revision moved') },
    }
    const { run } = harness(cache as Partial<PersonaCache>)
    const result = await run('publish')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('revision_conflict')
  })

  it('refuses without revision state', async () => {
    const { run } = harness({ status: () => status() })
    const result = await run('publish')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('没有 revision 状态')
  })
})

describe('/laputa revisions', () => {
  it('lists history in order with the current marker', async () => {
    const cache = {
      status: () => status({ revision: 2, revisionCount: 3, stateDirectory: '/tmp/state' }),
      listRevisions: () => [
        { revision: 1, createdAt: 't1', parent: null, restoredFrom: null, contentDigest: 'a', current: false },
        { revision: 2, createdAt: 't2', parent: 1, restoredFrom: null, contentDigest: 'b', current: true },
        { revision: 3, createdAt: 't3', parent: 2, restoredFrom: 1, contentDigest: 'c', current: false },
      ],
    }
    const { run } = harness(cache as Partial<PersonaCache>)
    const result = await run('revisions')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('* r2')
    expect(result.text).toContain('parent r1')
    expect(result.text).toContain('restored from r1')
    expect(result.text.indexOf('r1')).toBeLessThan(result.text.indexOf('r2'))
    expect(result.text.indexOf('r2')).toBeLessThan(result.text.indexOf('r3'))
  })

  it('reports an empty history', async () => {
    const cache = {
      status: () => status({ revisionCount: 0, stateDirectory: '/tmp/state' }),
      listRevisions: () => [],
    }
    const { run } = harness(cache as Partial<PersonaCache>)
    const result = await run('revisions')
    expect(result.text).toContain('尚无已发布版本')
  })
})

describe('/laputa rollback', () => {
  it('rolls back with the current base and draft digest', async () => {
    const calls: unknown[] = []
    const cache = {
      status: () => status({
        revision: 3,
        draftDigest: 'd'.repeat(64),
        revisionCount: 3,
        stateDirectory: '/tmp/state',
      }),
      rollbackTo: (input: unknown) => {
        calls.push(input)
        return { current: { revision: 4 }, created: true }
      },
    }
    const { run } = harness(cache as Partial<PersonaCache>)
    const result = await run('rollback 1')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已回滚到 r1')
    expect(result.text).toContain('新版本 r4')
    expect(calls).toEqual([{
      targetRevision: 1,
      expectedBaseRevision: 3,
      expectedDraftDigest: 'd'.repeat(64),
      source: { actor: 'command', note: 'laputa rollback' },
    }])
  })

  it('requires a positive revision number', async () => {
    const cache = {
      status: () => status({ revision: 2, stateDirectory: '/tmp/state' }),
    }
    const { run } = harness(cache as Partial<PersonaCache>)
    const result = await run('rollback nope')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('正整数版本号')
  })

  it('reports a missing target', async () => {
    const cache = {
      status: () => status({ revision: 2, stateDirectory: '/tmp/state' }),
      rollbackTo: () => { throw new PersonaError('revision_not_found', 'revision 9 does not exist') },
    }
    const { run } = harness(cache as Partial<PersonaCache>)
    const result = await run('rollback 9')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('revision_not_found')
  })

  it('refuses publish and rollback while disabled', async () => {
    const { run } = harness({
      status: () => status({ enabled: false, stateDirectory: '/tmp/state' }),
    })
    expect((await run('publish')).kind).toBe('error')
    expect((await run('publish')).text).toContain('已停用')
    expect((await run('rollback 1')).text).toContain('已停用')
  })
})

describe('error paths', () => {
  it('rejects an unknown verb with usage', async () => {
    const { run } = harness({})
    const result = await run('write')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('/laputa status | validate | reload')
    expect(result.text).toContain('未知子命令：write')
  })

  it('formats a status without a load timestamp', () => {
    const text = formatStatus(status({ lastLoadedAt: undefined, customSource: true }))
    expect(text).not.toContain('加载:')
    expect(text).toContain('目录: /tmp/laputa/vivy（sourceDir）')
  })
})
