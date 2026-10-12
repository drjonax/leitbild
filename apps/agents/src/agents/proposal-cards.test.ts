import { describe, expect, test } from 'bun:test'
import { workspaceResourceReferenceSchema, type WorkspaceId } from '@leitbild/contracts'
import type { ExecutionCall } from '../core/executions/store.ts'
import { PROPOSE_OPERATION_ID } from './operation-claims.ts'
import { createProposalCardReader, PROPOSALS_OPERATION_ID, proposedOperationsOf } from './proposal-cards.ts'

// Demo beat 4: the agent proposes shutting MOV-8000A; a person approves it
// in the display window. The answer's card reads World's status.

const workspaceId = '6f1c4b8e-3a2d-4c1b-9f0e-1a2b3c4d5e6f' as WorkspaceId
const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
const proposeInput = { plantId: 'plant:halden-1', tagId: 'MOV-8000A', value: 0, reason: 'PORV-456A does not follow its SHUT demand', procedureStep: 'Isolate a leaking PORV', evidence: ['PT-455'] }

const call = (id: string, calls: ReadonlyArray<unknown>, results: ReadonlyArray<unknown>): ExecutionCall => ({
  id, tool: 'workspace_call', startedAt: 1, completedAt: 2, argumentBytes: 1, resultBytes: 1,
  arguments: { calls }, result: { success: true, data: { results } },
})
const proposed = call('call_1_0', [{ key: 'propose', operationId: PROPOSE_OPERATION_ID, input: proposeInput }], [
  { key: 'propose', operationId: PROPOSE_OPERATION_ID, target: { kind: 'resource', ref: run }, success: true, data: { ok: true, commandId: 'command:p1', acceptedAt: '2026-10-12T10:02:40.000Z' } },
])
const refused = call('call_2_0', [{ key: 'start', operationId: PROPOSE_OPERATION_ID, input: { ...proposeInput, tagId: 'RCP-A-RUN', value: true } }], [
  { key: 'start', operationId: PROPOSE_OPERATION_ID, success: false, error: 'simulation_command_rejected: Not offered to operators: An RCP start needs seal injection and oil lift' },
])
const read = call('call_0_0', [{ key: 'pressure', operationId: 'world.process-plant.signals.read', input: {} }], [
  { key: 'pressure', operationId: 'world.process-plant.signals.read', success: true, data: { values: [] } },
])

const worldProposal = (status: string, closed?: Record<string, unknown>) => ({
  id: 'command:p1', plantId: 'plant:halden-1', write: { path: 'pressurizer.blockValvePositionFraction', value: 0 }, item: 'pressurizer.blockValve', word: 'SHUT',
  reason: proposeInput.reason, evidence: [{ tagId: 'PT-455', path: 'pressurizer.pressureMPa', value: 15.26 }], proposer: { actorId: 'actor:ai:advisor', origin: 'ai' },
  proposedAtElapsedMs: 45_000, proposedAtWallMs: 1, expiresAtElapsedMs: 165_000, extended: false, status, ...(closed === undefined ? {} : { closed }),
})

describe('what a turn proposed', () => {
  test('reads each propose call\'s input, its proposal id and the Resource it went to, or World\'s refusal', () => {
    expect(proposedOperationsOf([read, proposed, refused])).toEqual([
      { callId: 'call_1_0', key: 'propose', plantId: 'plant:halden-1', target: 'MOV-8000A', value: 0, reason: proposeInput.reason, procedureStep: proposeInput.procedureStep, evidence: ['PT-455'],
        outcome: { kind: 'recorded', proposalId: 'command:p1', resource: run } },
      { callId: 'call_2_0', key: 'start', plantId: 'plant:halden-1', target: 'RCP-A-RUN', value: true, reason: proposeInput.reason, procedureStep: proposeInput.procedureStep, evidence: ['PT-455'],
        outcome: { kind: 'refused', reason: 'Not offered to operators: An RCP start needs seal injection and oil lift' } },
    ])
  })

  test('an actuation\'s reset is proposed by its rule id alone, and is a card too', () => {
    const resetInput = { plantId: 'plant:halden-1', reset: 'safety-injection-manual', reason: 'ES-1.1: SI termination criteria met', procedureStep: 'ES-1.1 Step 1', evidence: ['PT-455'] }
    const reset = call('call_4_0', [{ key: 'reset', operationId: PROPOSE_OPERATION_ID, input: resetInput }], [
      { key: 'reset', operationId: PROPOSE_OPERATION_ID, target: { kind: 'resource', ref: run }, success: true, data: { ok: true, commandId: 'command:r1', acceptedAt: 'x', word: 'RESET Manual safety injection' } },
    ])
    expect(proposedOperationsOf([reset])).toEqual([
      { callId: 'call_4_0', key: 'reset', plantId: 'plant:halden-1', target: 'safety-injection-manual', reset: true, value: undefined, reason: resetInput.reason, procedureStep: resetInput.procedureStep, evidence: ['PT-455'],
        outcome: { kind: 'recorded', proposalId: 'command:r1', resource: run } },
    ])
  })

  test('a recorded proposal whose evidence lost its target is an error, not a card without status', () => {
    const untargeted = call('call_3_0', [{ key: 'propose', operationId: PROPOSE_OPERATION_ID, input: proposeInput }], [
      { key: 'propose', operationId: PROPOSE_OPERATION_ID, success: true, data: { ok: true, commandId: 'command:p1', acceptedAt: 'x' } },
    ])
    expect(() => proposedOperationsOf([untargeted])).toThrow('lacks its command id or the Resource it went to')
  })
})

describe('where World says a proposal stands', () => {
  const reader = (respond: (body: Record<string, unknown>) => Response, requests: Array<{ url: string; body: Record<string, unknown> }> = []) =>
    createProposalCardReader({
      workspaceId,
      hostBaseUrl: 'http://127.0.0.1:4000',
      fetchImpl: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        requests.push({ url, body })
        return respond(body)
      }) as unknown as typeof fetch,
    })
  const agent = { id: 'agent-7', name: 'Shift advisor' }

  test('reads the Plant\'s proposals through the Host as the proposing agent, and gives each card World\'s record', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const cards = await reader(() => Response.json({ result: { plantId: 'plant:halden-1', plantElapsedMs: 70_000, proposals: [
      { proposal: worldProposal('approved', { atElapsedMs: 65_000, actorId: 'actor:human:hilde', commandId: 'command:d1' }) },
    ] } }), requests).read(proposedOperationsOf([proposed, refused]), agent)
    expect(requests).toEqual([{
      url: `http://127.0.0.1:4000/api/workspaces/${workspaceId}/capabilities/${PROPOSALS_OPERATION_ID}/invoke`,
      body: { resource: run, input: { plantId: 'plant:halden-1' }, actor: { kind: 'ai', id: 'agent-7', displayName: 'Shift advisor' } },
    }])
    expect(cards.map(card => card.outcome)).toEqual([
      { kind: 'recorded', proposalId: 'command:p1', plantElapsedMs: 70_000, proposal: expect.objectContaining({ status: 'approved', word: 'SHUT', closed: { atElapsedMs: 65_000, actorId: 'actor:human:hilde', commandId: 'command:d1' } }) },
      { kind: 'refused', reason: 'Not offered to operators: An RCP start needs seal injection and oil lift' },
    ])
  })

  test('a pending proposal carries World\'s review; one the Plant no longer keeps, or a refused read, is unreadable with why', async () => {
    const review = { permitted: true, evidence: [{ tagId: 'PT-455', then: 15.26, now: 15.17 }], changed: true }
    const pending = await reader(() => Response.json({ result: { plantId: 'plant:halden-1', plantElapsedMs: 50_000, proposals: [{ proposal: worldProposal('pending'), review }] } }))
      .read(proposedOperationsOf([proposed]), agent)
    expect(pending[0]!.outcome).toMatchObject({ kind: 'recorded', proposal: { status: 'pending' }, review })
    const gone = await reader(() => Response.json({ result: { plantId: 'plant:halden-1', plantElapsedMs: 50_000, proposals: [] } })).read(proposedOperationsOf([proposed]), agent)
    expect(gone[0]!.outcome).toEqual({ kind: 'unreadable', proposalId: 'command:p1', reason: 'the Plant no longer keeps this proposal' })
    const restricted = await reader(() => Response.json({ error: { code: 'agent_access_restricted', message: 'AI inspect access is restricted for: plant:halden-1' } }, { status: 403 }))
      .read(proposedOperationsOf([proposed]), agent)
    expect(restricted[0]!.outcome).toEqual({ kind: 'unreadable', proposalId: 'command:p1', reason: 'AI inspect access is restricted for: plant:halden-1' })
  })
})
