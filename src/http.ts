/**
 * Loopback HTTP API for the persona management panel.
 *
 * The panel can inspect status, read one of the six documents, replace one
 * document after a concurrent-change check, and force a cache reload. Every
 * request is same-origin, loopback-only, and must pass the host session
 * rejection hook. Paths come from the resolved binding; request bodies only
 * carry a file name and content.
 * @module dsh-laputa
 */

import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { inspectPersonaDirectory } from './binding.ts'
import type { PersonaCache, PersonaStatus } from './cache.ts'
import { diffPersonaFiles } from './diff.ts'
import { ASSEMBLY_FILES, PersonaError, describeError, type PersonaFile } from './domain.ts'
import { safeRead } from './safe-read.ts'
import { isPersonaFile, replacePersonaFile } from './write.ts'

/** Route prefix served by the DSH web server. */
export const PANEL_PREFIX = '/dsh-laputa/api'

const DEFAULT_BODY_LIMIT = 256 * 1024
const EMPTY_DIGEST = createHash('sha256').update(Buffer.alloc(0)).digest('hex')

/** Minimal shape of the host web server capability. */
export interface PanelWebServer {
  register(route: {
    readonly kind: 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => unknown
  }): () => void
}

/** Minimal shape of the host connection capability. */
export interface PanelConnection {
  requestRejection(req: IncomingMessage): unknown
}

/** One file row returned to the panel. */
export interface PersonaFileDetail {
  readonly bytes: number
  readonly digest: string
  readonly blank: boolean
  readonly exists: boolean
}

type FileDetails = Record<PersonaFile, PersonaFileDetail>

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function allowedHost(host: string | undefined): boolean {
  const value = String(host ?? '').toLowerCase()
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(value)
}

function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers.origin === undefined) return true
  try {
    return new URL(req.headers.origin).host.toLowerCase() === String(req.headers.host).toLowerCase()
  } catch {
    return false
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > limit) {
      throw Object.assign(new Error('request body is too large'), { code: 'BODY_TOO_LARGE' })
    }
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { code: 'INVALID_JSON' })
  }
}

function requireJson(req: IncomingMessage): boolean {
  return String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')
}

function readFileDetails(cache: PersonaCache): FileDetails {
  const directory = inspectPersonaDirectory(cache.binding)
  const details = {} as FileDetails
  for (const name of ASSEMBLY_FILES) {
    if (directory === undefined) {
      details[name] = { bytes: 0, digest: EMPTY_DIGEST, blank: true, exists: false }
      continue
    }
    const file = join(directory, name)
    let exists = true
    try {
      lstatSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      exists = false
    }
    const { bytes, digest } = safeRead(file, cache.limits.maxSourceBytes, true)
    details[name] = {
      bytes: bytes.length,
      digest,
      blank: bytes.toString('utf8').trim() === '',
      exists,
    }
  }
  return details
}

function payload(cache: PersonaCache): { status: PersonaStatus; fileDetails: FileDetails } {
  return { status: cache.status(), fileDetails: readFileDetails(cache) }
}

function wireCode(error: PersonaError): string {
  switch (error.code) {
    case 'persona_file_changed': return 'FILE_CHANGED'
    case 'unknown_persona_file': return 'INVALID_NAME'
    case 'invalid_utf8': return 'INVALID_UTF8'
    case 'source_byte_budget_exceeded':
    case 'persona_character_budget_exceeded': return 'BUDGET_EXCEEDED'
    case 'revision_conflict': return 'REVISION_CONFLICT'
    case 'revision_not_found': return 'REVISION_NOT_FOUND'
    case 'revision_not_initialized': return 'REVISION_NOT_INITIALIZED'
    case 'revision_state_corrupt': return 'REVISION_STATE_CORRUPT'
    case 'revision_lock_timeout': return 'REVISION_LOCK_TIMEOUT'
    case 'revision_unavailable': return 'REVISION_UNAVAILABLE'
    default: return error.code.toUpperCase()
  }
}

function errorStatus(error: PersonaError): number {
  switch (error.code) {
    case 'unknown_persona_file': return 400
    case 'persona_file_changed':
    case 'revision_conflict': return 409
    case 'revision_not_found': return 404
    case 'revision_state_corrupt': return 500
    case 'revision_lock_timeout':
    case 'revision_unavailable': return 503
    default: return 422
  }
}

function errorHint(error: PersonaError): string {
  switch (error.code) {
    case 'persona_file_changed': return '重新加载文件后再保存'
    case 'revision_conflict': return '刷新版本状态后重试'
    case 'revision_not_initialized': return '补全 IDENTITY 与 MISSION 后重试'
    case 'revision_not_found': return '刷新历史后选择已存在的版本'
    case 'revision_state_corrupt': return '检查 revision 状态目录后重试'
    case 'revision_lock_timeout': return '稍后重试'
    case 'revision_unavailable': return '在配置中启用 revision 状态目录'
    default: return '检查人格文件后重试'
  }
}

function failure(res: ServerResponse, status: number, code: string, error: string, hint: string): void {
  send(res, status, { ok: false, code, error, hint })
}

function failFrom(res: ServerResponse, error: unknown): void {
  if (error instanceof PersonaError) {
    failure(res, errorStatus(error), wireCode(error), error.message, errorHint(error))
    return
  }
  failure(res, 422, 'PANEL_ERROR', describeError(error), '检查人格目录权限与内容后重试')
}

function isRevisionNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parseRevisionQuery(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null
  const revision = Number(value)
  return Number.isSafeInteger(revision) ? revision : null
}

/**
 * Register the panel API. Returns the host's route disposer.
 * @param ctx - child context providing `webServer` and `connection`.
 * @param cache - persona cache backing the panel.
 */
export function registerLaputaPanel(ctx: Context, cache: PersonaCache): () => void {
  const webServer = ctx.get('webServer') as PanelWebServer | undefined
  if (webServer === undefined) return () => {}

  return webServer.register({
    kind: 'prefix',
    path: PANEL_PREFIX,
    handler: async (req, res) => {
      if (!allowedHost(req.headers.host)) {
        failure(res, 403, 'HOST_REJECTED', '只接受本机访问', '使用本地 DSH 面板打开人格插件')
        return
      }
      if (req.method !== 'GET' && !sameOrigin(req)) {
        failure(res, 403, 'ORIGIN_REJECTED', '跨站请求被拒绝', '在 DSH 面板内重试')
        return
      }

      const connection = ctx.get('connection') as PanelConnection | undefined
      if (connection === undefined || typeof connection.requestRejection !== 'function') {
        failure(res, 503, 'AUTH_UNAVAILABLE', '会话验证不可用', '检查 DSH 连接服务')
        return
      }
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined && rejection !== null && rejection !== false) {
        failure(
          res,
          typeof rejection === 'number' ? rejection : 403,
          'AUTH_REJECTED',
          '会话未通过验证',
          '重新打开本地面板链接',
        )
        return
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      try {
        if (url.pathname === `${PANEL_PREFIX}/status` && req.method === 'GET') {
          send(res, 200, { ok: true, ...payload(cache) })
          return
        }

        if (url.pathname === `${PANEL_PREFIX}/file` && req.method === 'GET') {
          const name = url.searchParams.get('name') ?? ''
          if (!isPersonaFile(name)) {
            failure(res, 400, 'INVALID_NAME', `未知人格文件：${name}`, '只允许六个固定文件名')
            return
          }
          const directory = inspectPersonaDirectory(cache.binding)
          const file = directory === undefined ? undefined : join(directory, name)
          let bytes: Buffer = Buffer.alloc(0)
          let digest = EMPTY_DIGEST
          let exists = false
          if (file !== undefined) {
            try {
              lstatSync(file)
              exists = true
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            ;({ bytes, digest } = safeRead(file, cache.limits.maxSourceBytes, true))
          }
          send(res, 200, {
            ok: true,
            name,
            content: bytes.toString('utf8'),
            bytes: bytes.length,
            digest,
            exists,
          })
          return
        }

        if (url.pathname === `${PANEL_PREFIX}/file` && req.method === 'POST') {
          if (!requireJson(req)) {
            failure(res, 415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
            return
          }
          const parsed = await readBody(req, DEFAULT_BODY_LIMIT)
          const body = parsed !== null && typeof parsed === 'object'
            ? parsed as Record<string, unknown>
            : {}
          const name = typeof body.name === 'string' ? body.name : ''
          const content = typeof body.content === 'string' ? body.content : undefined
          const expectedDigest = typeof body.expectedDigest === 'string' ? body.expectedDigest : undefined
          if (!isPersonaFile(name) || content === undefined || expectedDigest === undefined) {
            failure(res, 400, 'INVALID_REQUEST', '缺少文件名、内容或版本摘要', '重新加载此文件后再保存')
            return
          }
          const result = replacePersonaFile(
            cache.binding,
            name,
            content,
            expectedDigest,
            cache.limits,
          )
          // With a revision store a save only changes the draft; the live text
          // changes on an explicit publish instead of a reload.
          let reloaded = false
          let reloadError: string | undefined
          if (cache.revisions === undefined) {
            try {
              cache.reload()
              reloaded = true
            } catch (error) {
              reloadError = describeError(error)
            }
          }
          send(res, 200, {
            ok: true,
            ...result,
            reloaded,
            ...(reloadError === undefined ? {} : { reloadError }),
            ...payload(cache),
          })
          return
        }

        if (url.pathname === `${PANEL_PREFIX}/publish` && req.method === 'POST') {
          if (!requireJson(req)) {
            failure(res, 415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
            return
          }
          const parsed = await readBody(req, DEFAULT_BODY_LIMIT)
          const body = parsed !== null && typeof parsed === 'object'
            ? parsed as Record<string, unknown>
            : {}
          const base = body.expectedBaseRevision
          const draftDigest = body.expectedDraftDigest
          if (typeof draftDigest !== 'string' || !(base === null || isRevisionNumber(base))) {
            failure(res, 400, 'INVALID_REQUEST', '缺少期望版本或草稿摘要', '刷新页面后重试')
            return
          }
          const result = cache.publishDraft({
            expectedBaseRevision: base as number | null,
            expectedDraftDigest: draftDigest,
            source: { actor: 'panel' },
          })
          send(res, 200, {
            ok: true,
            published: result.created,
            revision: result.current.revision,
            ...payload(cache),
          })
          return
        }

        if (url.pathname === `${PANEL_PREFIX}/rollback` && req.method === 'POST') {
          if (!requireJson(req)) {
            failure(res, 415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
            return
          }
          const parsed = await readBody(req, DEFAULT_BODY_LIMIT)
          const body = parsed !== null && typeof parsed === 'object'
            ? parsed as Record<string, unknown>
            : {}
          const target = body.targetRevision
          const base = body.expectedBaseRevision
          const draftDigest = body.expectedDraftDigest
          if (!isRevisionNumber(target)
            || typeof draftDigest !== 'string'
            || !(base === null || isRevisionNumber(base))) {
            failure(res, 400, 'INVALID_REQUEST', '缺少目标版本、期望版本或草稿摘要', '刷新页面后重试')
            return
          }
          const result = cache.rollbackTo({
            targetRevision: target,
            expectedBaseRevision: base as number | null,
            expectedDraftDigest: draftDigest,
            source: { actor: 'panel' },
          })
          send(res, 200, {
            ok: true,
            published: result.created,
            revision: result.current.revision,
            ...payload(cache),
          })
          return
        }

        if (url.pathname === `${PANEL_PREFIX}/revisions` && req.method === 'GET') {
          const revisions = cache.listRevisions()
          const current = revisions.find(entry => entry.current)?.revision ?? null
          send(res, 200, { ok: true, current, revisions })
          return
        }

        if (url.pathname === `${PANEL_PREFIX}/revision` && req.method === 'GET') {
          const revision = parseRevisionQuery(url.searchParams.get('revision'))
          if (revision === null) {
            failure(res, 400, 'INVALID_REQUEST', '版本号无效', '选择一个已发布的正整数版本')
            return
          }
          const target = cache.readRevision(revision)
          const live = cache.currentRevision()
          const sameAsLive = live !== null && live.revision === target.revision
          const diff = live === null || sameAsLive
            ? null
            : diffPersonaFiles(live.files, target.files, live.revision, target.revision)
          send(res, 200, {
            ok: true,
            revision: target.revision,
            liveRevision: live?.revision ?? null,
            sameAsLive,
            manifest: target.manifest,
            diff,
          })
          return
        }

        if (url.pathname === `${PANEL_PREFIX}/reload` && req.method === 'POST') {
          cache.reload()
          send(res, 200, { ok: true, ...payload(cache) })
          return
        }

        failure(res, 404, 'NOT_FOUND', '未知接口', '刷新页面后重试')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'BODY_TOO_LARGE') {
          failure(res, 413, 'BODY_TOO_LARGE', '请求体过大', '缩小文件内容后重试')
          return
        }
        if ((error as NodeJS.ErrnoException).code === 'INVALID_JSON') {
          failure(res, 400, 'INVALID_JSON', '请求体不是有效 JSON', '刷新页面后重试')
          return
        }
        failFrom(res, error)
      }
    },
  })
}
