import { describe, expect, test } from 'bun:test'
import type { ProposalCard, WorldProposal } from '../../../agents/proposal-cards.ts'
import { actorName, proposalCardView, proposedInTurn } from './model.ts'

// Demo beat 4 as the answer's card shows it: the agent proposed SHUT
// MOV-8000A; the card follows World's status until a person decides.

const proposed = { callId: 'call_1_0', key: 'propose', plantId: 'plant:halden-1', target: 'MOV-8000A', value: 0, reason: 'isolate', evidence: ['PT-455'] }
const proposal = (status: WorldProposal['status'], closed?: WorldProposal['closed']): WorldProposal => ({
  id: 'command:p1', item: 'pressurizer.blockValve', word: 'SHUT', status, proposer: { actorId: 'actor:ai:agent-7', origin: 'ai' }, expiresAtElapsedMs: 165_000,
  ...(closed === undefined ? {} : { closed }),
})
const recorded = (status: WorldProposal['status'], closed?: WorldProposal['closed'], review?: Extract<ProposalCard['outcome'], { kind: 'recorded' }>['review']): ProposalCard =>
  ({ ...proposed, outcome: { kind: 'recorded', proposalId: 'command:p1', plantElapsedMs: 60_000, proposal: proposal(status, closed), ...(review === undefined ? {} : { review }) } })

describe('an answer\'s proposal card', () => {
  test('a pending proposal awaits a person in the display window, with World\'s check and how the plant moved', () => {
    expect(proposalCardView(recorded('pending', undefined, { permitted: true, evidence: [{ tagId: 'PT-455', then: 15.26, now: 15.17 }], changed: true }), 'Shift advisor')).toEqual({
      action: 'SHUT MOV-8000A',
      item: 'pressurizer.blockValve',
      proposer: 'Shift advisor',
      tone: 'pending',
      status: 'Awaiting a person\'s approval in the display window',
      review: 'I&C allows it now · plant changed since proposed',
      live: true,
    })
    expect(proposalCardView(recorded('pending', undefined, { permitted: false, refusal: 'Interlock: bus A dead', evidence: [], changed: false }), 'Shift advisor').review)
      .toBe('I&C does not allow it now: Interlock: bus A dead')
  })

  test('once decided it names who decided and whether it executed, and stops following', () => {
    expect(proposalCardView(recorded('approved', { atElapsedMs: 65_000, actorId: 'actor:human:hilde', commandId: 'command:d1' }), 'Shift advisor'))
      .toMatchObject({ tone: 'executed', status: 'Approved by hilde · executed', live: false })
    expect(proposalCardView(recorded('rejected', { atElapsedMs: 65_000, actorId: 'actor:human:hilde', reason: 'Block valve stays open per SRO' }), 'Shift advisor'))
      .toMatchObject({ tone: 'closed', status: 'Rejected by hilde: Block valve stays open per SRO', live: false })
    expect(proposalCardView(recorded('expired', { atElapsedMs: 165_000, reason: 'Expired before a person decided' }), 'Shift advisor').status).toBe('Expired before a person decided · not executed')
    expect(proposalCardView(recorded('superseded', { atElapsedMs: 70_000, reason: 'Superseded by a command on the same equipment' }), 'Shift advisor').status)
      .toBe('Superseded: Superseded by a command on the same equipment · not executed')
  })

  test('World\'s refusal, or a status it could not read, is said as such', () => {
    expect(proposalCardView({ ...proposed, target: 'RCP-A-RUN', value: true, outcome: { kind: 'refused', reason: 'Not offered to operators: An RCP start needs seal injection' } }, 'Shift advisor'))
      .toEqual({ action: 'RCP-A-RUN → true', proposer: 'Shift advisor', tone: 'refused', status: 'Refused by World: Not offered to operators: An RCP start needs seal injection', live: false })
    expect(proposalCardView({ ...proposed, outcome: { kind: 'unreadable', proposalId: 'command:p1', reason: 'the Plant no longer keeps this proposal' } }, 'Shift advisor').status)
      .toBe('Status unavailable: the Plant no longer keeps this proposal')
  })

  test('an actuation\'s reset reads as World words it, or by its rule id before World has', () => {
    const reset = { ...proposed, target: 'safety-injection-manual', reset: true as const, value: undefined }
    const word = { ...proposal('pending'), item: 'safetyInjection.trainA', word: 'RESET Manual safety injection' }
    expect(proposalCardView({ ...reset, outcome: { kind: 'recorded', proposalId: 'command:r1', plantElapsedMs: 60_000, proposal: word } }, 'Shift advisor'))
      .toMatchObject({ action: 'RESET Manual safety injection', item: 'safetyInjection.trainA', tone: 'pending' })
    expect(proposalCardView({ ...reset, outcome: { kind: 'refused', reason: 'RESET Manual safety injection is not offered: it may be reset 60 s after it acted: 12 s to go' } }, 'Shift advisor'))
      .toMatchObject({ action: 'RESET safety-injection-manual', tone: 'refused' })
  })

  test('names people and agents by the id their actor carries', () => {
    expect(actorName('actor:human:hilde')).toBe('hilde')
    expect(actorName('operator:evidence')).toBe('operator:evidence')
  })
})

describe('which answers carry a card', () => {
  const answer = { id: 'm1', senderId: 'agent-7', content: 'Proposed.', timestamp: 1, type: 'chat', roomId: 'room-1', generationTraceId: 'turn-1' }
  const trace = (operationIds: ReadonlyArray<string>) => [{ tool: 'workspace_call', argumentKeys: ['calls'], argumentBytes: 1, operationIds, success: true, resultPreview: '' }]

  test('an answer whose turn called the propose operation, and no other', () => {
    expect(proposedInTurn({ ...answer, toolTrace: trace(['world.process-plant.control.propose']) })).toBe(true)
    expect(proposedInTurn({ ...answer, toolTrace: trace(['world.process-plant.display.compose']) })).toBe(false)
    expect(proposedInTurn({ ...answer, type: 'system', toolTrace: trace(['world.process-plant.control.propose']) })).toBe(false)
    expect(proposedInTurn(answer)).toBe(false)
  })
})
