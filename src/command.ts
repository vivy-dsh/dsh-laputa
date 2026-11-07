/**
 * `/laputa status|validate|reload|init` adapter. The command is registered
 * only when the host provides a `commands` capability. It reports the
 * initialized state and can start the guided setup. Writes come from the
 * model-facing `laputa_init` tool or the same-level web panel.
 * @module dsh-laputa
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PersonaCache, PersonaReadOutcome, PersonaStatus } from './cache.ts'
import { describeError } from './domain.ts'

/** One command invocation from the host. */
export interface CommandInvocation {
  readonly rawInput: string
  readonly agent?: Agent
  readonly signal?: AbortSignal
  readonly commandId?: string
}

/** A command handler result in the host's discriminated shape. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }

/** A command definition accepted by the host `commands.register()`. */
export interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** Optional host capability that registers slash commands. */
export interface CommandsCapability {
  register(definition: CommandDefinition): () => void
}

const USAGE = '用法：/laputa status | validate | reload | init | publish | revisions | rollback <n>'

const DISABLED = 'laputa: 当前已停用；在 profile 中设置 enabled: true 并重启后再试'
const UNAVAILABLE = 'laputa: 当前没有 revision 状态；请确认插件已启用并配置了可写的 stateDir'

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(1)} KiB`
}

function pendingLabel(pending: readonly string[]): string {
  return pending.length === 0 ? '无' : pending.join('，')
}

function hasStore(status: PersonaStatus): boolean {
  return status.stateDirectory != null
}

function formatLedger(outcome: PersonaReadOutcome): string {
  return Object.entries(
    outcome.status === 'initialized' ? outcome.assembled.files : outcome.files,
  ).map(([name, size]) => `${name} ${bytes(size)}`).join('，')
}

/** Render the current cache state as plain text. */
export function formatStatus(status: PersonaStatus): string {
  const lines = [
    `laputa: ${status.enabled ? '已启用' : '已停用'}`,
    `人格: ${status.personaId}`,
    `目录: ${status.directory}${status.customSource ? '（sourceDir）' : ''}`,
    `初始化: ${!status.enabled ? '已停用' : status.loaded ? (status.initialized ? '已完成' : '未完成') : '未加载'}`,
  ]
  if (status.enabled && status.loaded && !status.initialized) {
    lines.push(`待填写: ${pendingLabel(status.pendingFiles)}`)
  }
  if (hasStore(status)) {
    const live = status.revision == null ? '未发布' : `r${status.revision}`
    lines.push(`版本: ${live} / 共 ${status.revisionCount ?? 0} 个`)
    lines.push(`草稿: ${status.revisionPending === true ? '有未发布修改' : '已同步'}`)
  }
  lines.push(`文件: ${Object.entries(status.files).map(([name, size]) => `${name} ${bytes(size)}`).join('，')}`)
  lines.push(`组装: ${status.chars} 字符`)
  lines.push(`指纹: ${status.fingerprint === '' ? '未加载' : status.fingerprint.slice(0, 12)}`)
  if (status.lastLoadedAt !== undefined) lines.push(`加载: ${status.lastLoadedAt}`)
  if (status.lastError !== undefined) lines.push(`错误: ${status.lastError}`)
  else if (status.pendingChanges) {
    lines.push(hasStore(status)
      ? '状态: 草稿有未发布修改；执行 /laputa publish 发布后对新会话生效'
      : '状态: 文件已变化；下一轮自动生效，或执行 /laputa reload')
  } else lines.push('状态: 正常')
  lines.push('面板: 侧边栏「人格」')
  return lines.join('\n')
}

function formatInit(status: PersonaStatus): CommandResult {
  if (!status.enabled) {
    return { kind: 'error', text: 'laputa: 当前已停用；在 profile 中设置 enabled: true 并重启后再试' }
  }
  if (status.initialized) {
    const hint = hasStore(status)
      ? '保存的是草稿；执行 /laputa publish 发布后对新会话生效'
      : '保存后下一轮自动生效，也可执行 /laputa reload'
    return {
      kind: 'success',
      text: `laputa: 人格已初始化。如需补充仍为空的文件，可以让模型使用 laputa_init，或直接手动编辑；${hint}。`,
    }
  }
  return {
    kind: 'success',
    text: [
      'laputa: 人格尚未初始化。请在对话里回答下面两个问题：',
      '1. 我是谁？（IDENTITY：可以是名字，也可以是名字之外的身份、语气、价值观）',
      '2. 我的使命是什么？（MISSION）',
      `待填写: ${pendingLabel(status.pendingFiles)}`,
      '也可以选择高级初始化：再补充 RELATIONSHIP（如何相处）与 REDLINE（硬边界），DREAM / DARK 会由 agent 根据对话生成。',
    ].join('\n'),
  }
}

function parseInput(rawInput: string): { verb: string; args: string[] } {
  const input = rawInput.trim().replace(/^\/?laputa(?=\s|$)/, '').trim()
  if (input === '') return { verb: 'status', args: [] }
  const [verb = 'status', ...args] = input.split(/\s+/)
  return { verb, args }
}

/**
 * Register the `/laputa` command.
 * @param commands - host command registry.
 * @param cache - persona cache to inspect or refresh.
 * @returns the host's unregister disposer.
 */
export function registerLaputaCommand(
  commands: CommandsCapability,
  cache: PersonaCache,
): () => void {
  return commands.register({
    name: 'laputa',
    description: '查看、校验、发布或回滚当前人格；未初始化时给出填写引导',
    input: { hint: 'status | validate | reload | init | publish | revisions | rollback <n>' },
    handler(invocation) {
      const { verb, args } = parseInput(invocation.rawInput)
      if (verb === 'status') {
        return { kind: 'success', text: formatStatus(cache.status()) }
      }
      if (verb === 'validate') {
        try {
          const outcome = cache.validate()
          if (outcome.status === 'uninitialized') {
            return {
              kind: 'success',
              text: `laputa: 未初始化，待填写 — ${pendingLabel(outcome.pending)}`,
            }
          }
          return {
            kind: 'success',
            text: `laputa: 校验通过，${outcome.assembled.chars} 字符，${formatLedger(outcome)}`,
          }
        } catch (error) {
          return { kind: 'error', text: `laputa: 校验失败 — ${describeError(error)}` }
        }
      }
      if (verb === 'reload') {
        if (!cache.status().enabled) {
          return { kind: 'error', text: DISABLED }
        }
        try {
          const outcome = cache.reload()
          if (invocation.agent !== undefined) cache.refreshSessions(invocation.agent)
          if (outcome.status === 'uninitialized') {
            return {
              kind: 'success',
              text: `laputa: 已重新加载，仍未初始化；待填写 — ${pendingLabel(outcome.pending)}`,
            }
          }
          const revision = cache.status().revision
          const live = revision == null ? '' : `，r${revision}`
          return { kind: 'success', text: `laputa: 已重新加载${live}，${outcome.assembled.chars} 字符` }
        } catch (error) {
          return { kind: 'error', text: `laputa: 重新加载失败 — ${describeError(error)}` }
        }
      }
      if (verb === 'init') {
        return formatInit(cache.status())
      }
      if (verb === 'publish') {
        const status = cache.status()
        if (!status.enabled) return { kind: 'error', text: DISABLED }
        if (!hasStore(status)) return { kind: 'error', text: UNAVAILABLE }
        try {
          const result = cache.publishDraft({
            expectedBaseRevision: status.revision ?? null,
            expectedDraftDigest: status.draftDigest,
            source: { actor: 'command', note: 'laputa publish' },
          })
          return {
            kind: 'success',
            text: result.created
              ? `laputa: 已发布 r${result.current.revision}；新会话生效`
              : `laputa: 内容未变化，当前版本仍为 r${result.current.revision}`,
          }
        } catch (error) {
          return { kind: 'error', text: `laputa: 发布失败 — ${describeError(error)}` }
        }
      }
      if (verb === 'revisions') {
        const status = cache.status()
        if (!status.enabled) return { kind: 'error', text: DISABLED }
        if (!hasStore(status)) return { kind: 'error', text: UNAVAILABLE }
        try {
          const rows = cache.listRevisions()
          if (rows.length === 0) return { kind: 'success', text: 'laputa: 尚无已发布版本' }
          return {
            kind: 'success',
            text: [
              'laputa: 版本历史（* 为当前）',
              ...rows.map((row) => {
                const details = [
                  `${row.current ? '*' : ' '} r${row.revision}`,
                  row.createdAt,
                  ...(row.parent === null ? [] : [`parent r${row.parent}`]),
                  ...(row.restoredFrom === null ? [] : [`restored from r${row.restoredFrom}`]),
                ]
                return details.join('  ')
              }),
            ].join('\n'),
          }
        } catch (error) {
          return { kind: 'error', text: `laputa: 读取版本历史失败 — ${describeError(error)}` }
        }
      }
      if (verb === 'rollback') {
        const status = cache.status()
        if (!status.enabled) return { kind: 'error', text: DISABLED }
        if (!hasStore(status)) return { kind: 'error', text: UNAVAILABLE }
        const target = args[0] === undefined ? Number.NaN : Number(args[0])
        if (!Number.isSafeInteger(target) || target <= 0) {
          return { kind: 'error', text: `${USAGE}\n回滚需要一个正整数版本号` }
        }
        try {
          const result = cache.rollbackTo({
            targetRevision: target,
            expectedBaseRevision: status.revision ?? 0,
            expectedDraftDigest: status.draftDigest,
            source: { actor: 'command', note: 'laputa rollback' },
          })
          return {
            kind: 'success',
            text: result.created
              ? `laputa: 已回滚到 r${target}，生成新版本 r${result.current.revision}；新会话生效`
              : `laputa: 目标内容与当前版本一致，仍为 r${result.current.revision}`,
          }
        } catch (error) {
          return { kind: 'error', text: `laputa: 回滚失败 — ${describeError(error)}` }
        }
      }
      return { kind: 'error', text: `${USAGE}\n未知子命令：${verb}` }
    },
  })
}
