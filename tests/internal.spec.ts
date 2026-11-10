import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ call: vi.fn(), register: vi.fn() }))
vi.mock('../../_shared/ipc.mjs', () => ({ callComponent: transport.call, registerComponentInternal: transport.register }))
const moduleName = '../internal.mjs'
const { registerLaputaInternal } = await import(moduleName)
const home = process.env.DSH_HOME
beforeEach(() => { vi.clearAllMocks(); process.env.DSH_HOME = 'C:\\dream-test' })
afterEach(() => { if (home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = home })

function fixture() {
  const candidates = { stage: vi.fn(() => ({ candidateId: 'candidate-1' })), baseline: vi.fn(), status: vi.fn() }
  registerLaputaInternal({ webServer: {} }, candidates)
  const registration = transport.register.mock.calls[0]![1]
  const body = { ticketId: 'ticket-1', subjectId: 'subject-1', files: { 'MISSION.MD': 'mission', 'IDENTITY.MD': 'reviewed' },
    expectedBaseRevision: 3, expectedDraftDigest: 'draft-digest', evidenceIds: ['event-1'], summary: 'Refine persona' }
  return { candidates, body, handle: registration.handle as (request: unknown) => Promise<unknown> }
}

describe('production persona owner IPC authorization', () => {
  it('authorizes the exact bytes, baseline, evidence and summary before owner mutation', async () => {
    const { candidates, body, handle } = fixture()
    transport.call.mockResolvedValue({ authorized: true, subjectId: body.subjectId, runId: 'run-1', requestId: 'request-1' })
    await expect(handle({ method: 'POST', path: '/candidates/stage', body: { ...body, filesDigest: 'caller-forgery' } })).resolves.toEqual({ candidateId: 'candidate-1' })
    const filesDigest = createHash('sha256').update(JSON.stringify({ 'IDENTITY.MD': 'reviewed', 'MISSION.MD': 'mission' })).digest('hex')
    expect(transport.call).toHaveBeenCalledExactlyOnceWith({ home: 'C:\\dream-test', name: 'evolution', path: '/dream/authorize', body: {
      ticketId: 'ticket-1', subjectId: 'subject-1', scope: 'persona:stage', filesDigest,
      expectedBaseRevision: 3, expectedDraftDigest: 'draft-digest', evidenceIds: ['event-1'], summary: 'Refine persona',
    } })
    expect(candidates.stage).toHaveBeenCalledOnce()
    expect(transport.call.mock.invocationCallOrder[0]).toBeLessThan(candidates.stage.mock.invocationCallOrder[0]!)
  })
  it.each([
    undefined,
    { authorized: false, subjectId: 'subject-1', requestId: 'request-1', runId: 'run-1' },
    { authorized: true, subjectId: 'different-subject', requestId: 'request-1', runId: 'run-1' },
    { authorized: true, subjectId: 'subject-1', requestId: 'request-1' },
    { authorized: true, subjectId: 'subject-1', runId: 'run-1' },
  ])('fails closed for missing or mismatched trusted authorization: %j', async authorization => {
    const { candidates, body, handle } = fixture()
    transport.call.mockResolvedValue(authorization)
    await expect(handle({ method: 'POST', path: '/candidates/stage', body })).rejects.toMatchObject({ code: 'LAPUTA_STAGE_UNAUTHORIZED' })
    expect(candidates.stage).not.toHaveBeenCalled()
  })
  it('fails closed if Evolution denies an unbound Ticket or altered frozen plan', async () => {
    const { candidates, body, handle } = fixture()
    transport.call.mockRejectedValue(Object.assign(new Error('Exact persona files absent from frozen Dream plan'), { code: 'EVOLUTION_REFUSED' }))
    await expect(handle({ method: 'POST', path: '/candidates/stage', body: { ...body, files: { 'IDENTITY.MD': 'altered' } } })).rejects.toThrow('frozen Dream plan')
    expect(candidates.stage).not.toHaveBeenCalled()
  })
  it('does not expose approve or reject through component IPC', async () => {
    const { candidates, body, handle } = fixture()
    await expect(handle({ method: 'POST', path: '/candidate/decide', body })).rejects.toMatchObject({ code: 'LAPUTA_OPERATION_UNKNOWN' })
    expect(candidates.stage).not.toHaveBeenCalled()
    expect(transport.call).not.toHaveBeenCalled()
  })
})
