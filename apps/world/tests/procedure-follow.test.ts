import { describe, expect, test } from 'bun:test'
import type { ActorId, IsoTimestamp, ProcedureRunDriver, ProcedureRunState } from '../src/core/model/index.ts'
import {
  procedureFollowAction,
  procedureFollowIdleMs,
  procedureFollowMark,
  procedureTransferDestination,
} from '../src/ui/procedures/procedure-follow.ts'

const at = '2026-01-01T10:14:45.000Z' as IsoTimestamp
const ai = 'actor:ai:assistant' as ActorId
const operator = 'actor:operator' as ActorId
const aiDriver: ProcedureRunDriver = { kind: 'ai', actorId: ai, label: 'Assistant', since: at }
const personDriver: ProcedureRunDriver = { kind: 'person', actorId: operator, since: at }
const unit = { plantId: 'halden-unit-a', label: 'Halden Unit A' }

const run = (procedureId: string, extra: Partial<ProcedureRunState> = {}): ProcedureRunState => ({
  runId: `procedure-run:${procedureId.toLowerCase()}`,
  sourceId: 'pwr-ops',
  sourceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourcePath: `wiki/procedures/${procedureId}.md`,
  procedureId,
  scope: unit,
  title: procedureId,
  status: 'active',
  startedAt: at,
  startedBy: ai,
  currentStepId: 's1',
  driver: aiDriver,
  stepStates: [],
  ...extra,
})

// E-0 closed at step 4 by its transfer to ES-0.1, and the destination it handed on to.
const transferred = run('E-0', {
  status: 'transferred',
  currentStepId: 's4',
  stepStates: [{
    stepId: 's4', assessment: 'complete', favorite: false, updatedAt: at, updatedBy: ai,
    decision: { branchIndex: 0, targetKind: 'procedure', target: 'ES-0.1', selectedBy: ai, simulationTime: at },
  }],
})
const destination = run('ES-0.1', { currentStepId: 'e1' })

const key = 'E-0 on unit A'
const idle = { ownWrite: false, request: null, idleForMs: Number.POSITIVE_INFINITY } as const

describe('procedure window follows an AI agent', () => {
  test('scrolls to the new current step of a Run an AI agent drives, once the person has left the window alone', () => {
    const before = run('E-0', { currentStepId: 's2' })
    const after = { ...before, currentStepId: 's3' }
    const mark = procedureFollowMark(key, before)
    expect(procedureFollowAction({ ...idle, runs: [after], shown: { documentKey: key, run: after }, mark })).toEqual({ kind: 'scroll', stepId: 's3' })
    expect(procedureFollowAction({ ...idle, runs: [after], shown: { documentKey: key, run: after }, mark, idleForMs: 1_000 }))
      .toEqual({ kind: 'wait', delayMs: procedureFollowIdleMs - 1_000 })
    expect(procedureFollowAction({ ...idle, runs: [after], shown: { documentKey: key, run: after }, mark, idleForMs: procedureFollowIdleMs }))
      .toEqual({ kind: 'scroll', stepId: 's3' })
    expect(procedureFollowAction({ ...idle, runs: [before], shown: { documentKey: key, run: before }, mark })).toEqual({ kind: 'none' })
  })

  test('scrolls to where an AI agent started the procedure the window shows', () => {
    const started = run('E-0')
    expect(procedureFollowAction({ ...idle, runs: [started], shown: { documentKey: key, run: started }, mark: procedureFollowMark(key, null) }))
      .toEqual({ kind: 'scroll', stepId: 's1' })
  })

  test('leaves alone a change of its own, a document it just loaded, and a Run a person drives or shares', () => {
    const before = run('E-0', { currentStepId: 's2' })
    const after = { ...before, currentStepId: 's3' }
    const mark = procedureFollowMark(key, before)
    const shown = { documentKey: key, run: after }
    expect(procedureFollowAction({ ...idle, runs: [after], shown, mark, ownWrite: true })).toEqual({ kind: 'none' })
    expect(procedureFollowAction({ ...idle, runs: [after], shown, mark: null })).toEqual({ kind: 'none' })
    expect(procedureFollowAction({ ...idle, runs: [after], shown, mark: procedureFollowMark('E-0 on unit B', before) })).toEqual({ kind: 'none' })
    const personRun = { ...after, driver: personDriver }
    expect(procedureFollowAction({ ...idle, runs: [personRun], shown: { documentKey: key, run: personRun }, mark })).toEqual({ kind: 'none' })
    const { driver: _shared, ...sharedRun } = after
    expect(procedureFollowAction({ ...idle, runs: [sharedRun], shown: { documentKey: key, run: sharedRun }, mark })).toEqual({ kind: 'none' })
  })

  test('goes on to the destination of a transfer an AI agent made while the window showed the Run', () => {
    const before = { ...transferred, status: 'active' as const }
    const runs = [transferred, destination]
    const shown = { documentKey: key, run: transferred }
    expect(procedureTransferDestination(runs, transferred)).toBe(destination)
    expect(procedureFollowAction({ ...idle, runs, shown, mark: procedureFollowMark(key, before) })).toEqual({ kind: 'show', run: destination })
    expect(procedureFollowAction({ ...idle, runs, shown, mark: procedureFollowMark(key, before), idleForMs: 500 }))
      .toEqual({ kind: 'wait', delayMs: procedureFollowIdleMs - 500 })
    // A Run opened already held stays where the person opened it.
    expect(procedureFollowAction({ ...idle, runs, shown, mark: procedureFollowMark(key, transferred) })).toEqual({ kind: 'none' })
  })

  test('follows a transfer only from an AI-driven Run to an active Run an AI agent drives', () => {
    expect(procedureTransferDestination([transferred, { ...destination, driver: personDriver }], transferred)).toBeNull()
    expect(procedureTransferDestination([transferred, { ...destination, status: 'completed' }], transferred)).toBeNull()
    expect(procedureTransferDestination([transferred], transferred)).toBeNull()
    expect(procedureTransferDestination([destination], { ...transferred, driver: personDriver })).toBeNull()
    expect(procedureTransferDestination([destination], { ...transferred, status: 'active' })).toBeNull()
    expect(procedureTransferDestination([destination, { ...destination, runId: 'procedure-run:es-0.1-b', scope: { plantId: 'halden-unit-b' } }],
      { ...transferred, scope: { plantId: 'halden-unit-b' } })?.runId).toBe('procedure-run:es-0.1-b')
    const stepDecision = { ...transferred.stepStates[0]!, decision: { ...transferred.stepStates[0]!.decision!, targetKind: 'step' as const, target: 's5' } }
    expect(procedureTransferDestination([destination], { ...transferred, stepStates: [stepDecision] })).toBeNull()
  })
})
