import { createHash } from 'node:crypto'
import { callComponent, registerComponentInternal } from '../_shared/ipc.mjs'

function refuse(message) { throw Object.assign(new Error(message), { code: 'LAPUTA_STAGE_UNAUTHORIZED' }) }

async function authorizeStage(home, body) {
  if (!body || typeof body !== 'object' || !body.files || typeof body.files !== 'object' || Array.isArray(body.files)
    || typeof body.ticketId !== 'string' || !body.ticketId || typeof body.subjectId !== 'string' || !body.subjectId) {
    refuse('Persona staging requires a live subject-bound Dream Ticket')
  }
  // Hash the actual owner payload, never an authorization digest supplied by the caller.
  const filesDigest = createHash('sha256').update(JSON.stringify(Object.fromEntries(
    Object.keys(body.files).sort().map(name => [name, body.files[name]]),
  ))).digest('hex')
  const authorization = await callComponent({ home, name: 'evolution', path: '/dream/authorize', body: {
    ticketId: body.ticketId, subjectId: body.subjectId, scope: 'persona:stage', filesDigest,
    expectedBaseRevision: body.expectedBaseRevision, expectedDraftDigest: body.expectedDraftDigest,
    evidenceIds: body.evidenceIds, summary: body.summary,
  } })
  if (authorization?.authorized !== true || authorization.subjectId !== body.subjectId
    || typeof authorization.requestId !== 'string' || !authorization.requestId
    || typeof authorization.runId !== 'string' || !authorization.runId) {
    refuse('No matching frozen Dream plan authorizes these exact persona bytes')
  }
}

export function registerLaputaInternal(ctx, candidates) {
  const home = process.env.DSH_HOME
  return registerComponentInternal(ctx, {
    home, name: 'laputa',
    async handle({ method, path, body }) {
      try {
        if (method === 'POST' && path === '/baseline') return candidates.baseline()
        if (method === 'POST' && path === '/candidates/stage') {
          await authorizeStage(home, body)
          return candidates.stage(body)
        }
        if (method === 'POST' && path === '/candidates/status') return candidates.status(body?.candidateId)
        throw Object.assign(new Error('Unknown Laputa owner operation'), { code: 'LAPUTA_OPERATION_UNKNOWN' })
      } catch (error) {
        if (error?.code && !String(error.code).startsWith('LAPUTA_')) error.code = `PERSONA_${String(error.code).toUpperCase()}`
        throw error
      }
    },
  })
}
