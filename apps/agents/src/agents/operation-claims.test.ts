import { describe, expect, test } from 'bun:test'
import { collectTurnOperations, operationClaimIssues, PROPOSE_OPERATION_ID, type TurnOperation } from './operation-claims.ts'

// Demo beat 4 (plan C1 §7): the PORV is stuck open, the agent proposes
// shutting its block valve MOV-8000A, and a person approves it in the
// display window. The answer of the proposing turn must say proposed,
// never done.

const proposeInput = { plantId: 'plant:halden-1', tagId: 'MOV-8000A', value: 0, reason: 'PORV-456A does not follow its SHUT demand', evidence: ['PT-455'] }
const proposed: TurnOperation = { operationId: PROPOSE_OPERATION_ID, input: proposeInput, success: true, commandId: 'command:p1' }
const refused: TurnOperation = { operationId: PROPOSE_OPERATION_ID, input: proposeInput, success: false, error: 'simulation_command_rejected: Not offered to operators: An RCP start needs seal injection and oil lift, which the model does not have: not started from the display' }
const written: TurnOperation = { operationId: 'world.process-plant.control.write', input: { plantId: 'plant:halden-1', tagId: 'CHG-PUMP-B', value: true }, success: true, commandId: 'command:w1' }

describe('an answer of a turn that only proposed', () => {
  test('may say it proposed the operation and that it awaits a person\'s approval', () => {
    for (const answer of [
      'I proposed shutting the PORV block valve MOV-8000A; it is awaiting approval in the display window.',
      'Proposed: SHUT MOV-8000A. Once a person approves it, the block valve strokes shut in about 10 s.',
      'MOV-8000A will be shut when you approve the proposal, and pressurizer pressure should then recover.',
      'I have not closed anything: the proposal is pending your decision.',
    ]) expect(operationClaimIssues(answer, [proposed])).toEqual([])
  })

  test('may not say it did it', () => {
    expect(operationClaimIssues('I closed the PORV block valve MOV-8000A, and pressure is recovering.', [proposed])).toEqual([
      'It says "I closed the PORV block valve MOV-8000A, and pressure is recovering.", but this turn only proposed the operation of MOV-8000A: nothing is executed until a person approves it in the display window. Say it is proposed and awaiting a person\'s approval.',
    ])
    expect(operationClaimIssues('Block valve MOV-8000A has been shut.', [proposed])).toHaveLength(1)
    expect(operationClaimIssues('I\'ve now isolated the relief line.', [proposed])).toHaveLength(1)
  })

  test('a passive end state counts only where it names what was proposed', () => {
    // An automatic action the answer reports is not a claim about the proposal.
    expect(operationClaimIssues('The MSIVs have been closed by steam line isolation.', [proposed])).toEqual([])
  })

  test('where the turn also executed a command itself, only claims about the proposed target count', () => {
    expect(operationClaimIssues('I started charging pump B.', [proposed, written])).toEqual([])
    expect(operationClaimIssues('I started charging pump B and I shut MOV-8000A.', [proposed, written])).toHaveLength(1)
  })

  test('an actuation\'s reset, proposed by its rule id, is held to the same', () => {
    const reset: TurnOperation = { operationId: PROPOSE_OPERATION_ID, input: { plantId: 'plant:halden-1', reset: 'safety-injection-manual', reason: 'ES-1.1: SI termination criteria met', evidence: ['PT-455'] }, success: true, commandId: 'command:r1' }
    expect(operationClaimIssues('I proposed resetting safety injection; it awaits your approval in the display window.', [reset])).toEqual([])
    expect(operationClaimIssues('I reset safety injection, so the SI pumps are yours again.', [reset])).toEqual([
      'It says "I reset safety injection", but this turn only proposed the operation of safety-injection-manual: nothing is executed until a person approves it in the display window. Say it is proposed and awaiting a person\'s approval.',
    ])
    expect(operationClaimIssues('Actuation safety-injection-manual has been reset.', [reset])).toHaveLength(1)
  })

  test('may not say it proposed what World refused', () => {
    expect(operationClaimIssues('I proposed starting RCP A for your approval.', [refused])).toEqual([
      'It says "I proposed starting RCP A for your approval.", but World refused the proposal: Not offered to operators: An RCP start needs seal injection and oil lift, which the model does not have: not started from the display. Say it was refused and why.',
    ])
  })

  test('a turn that proposed nothing is not checked', () => {
    expect(operationClaimIssues('I closed MOV-8000A.', [written])).toEqual([])
    expect(operationClaimIssues('I closed MOV-8000A.', [])).toEqual([])
  })
})

describe('what a turn issued', () => {
  test('reads each operation of a workspace_call, its input by batch key and its command id', () => {
    const into: TurnOperation[] = []
    collectTurnOperations(into, 'workspace_call', { calls: [{ key: 'propose', operationId: PROPOSE_OPERATION_ID, input: proposeInput }] }, {
      success: true,
      data: { results: [{ key: 'propose', operationId: PROPOSE_OPERATION_ID, success: true, data: { ok: true, commandId: 'command:p1', acceptedAt: '2026-10-12T10:02:40.000Z' } }] },
    })
    collectTurnOperations(into, 'workspace_call', { calls: [{ key: 'again', operationId: PROPOSE_OPERATION_ID, input: proposeInput }] }, {
      success: true,
      data: { results: [{ key: 'again', operationId: PROPOSE_OPERATION_ID, success: false, error: 'simulation_command_rejected: refused' }] },
    })
    collectTurnOperations(into, 'product_search', { query: 'x' }, { success: true, data: {} })
    expect(into).toEqual([
      { operationId: PROPOSE_OPERATION_ID, input: proposeInput, success: true, commandId: 'command:p1' },
      { operationId: PROPOSE_OPERATION_ID, input: proposeInput, success: false, error: 'simulation_command_rejected: refused' },
    ])
  })
})
