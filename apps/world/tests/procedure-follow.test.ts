import { describe, expect, test } from 'bun:test'
import type { ActorId, IsoTimestamp, ObjectId, ProcedureRunDriver, ProcedureRunState } from '../src/core/model/index.ts'
import type { ProcedureRunLifecycleEvent, SimulationRunEventPayload } from '../src/ui/simulation-run-events.ts'
import {
  procedureAiStartedRunIds,
  procedureAiStartsRead,
  procedureFollowAction,
  procedureFollowIdleMs,
  procedureFollowMark,
  procedureTransferDestination,
  procedureWindowsShowingAiStart,
  type ProcedureSystemWindowEntry,
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

  test('shows a Run an AI agent started on the unit when the route asks, or scrolls to it where the window shows it already', () => {
    const shownE0 = { documentKey: key, run: run('E-0', { currentStepId: 's3' }) }
    expect(procedureFollowAction({ ...idle, runs: [shownE0.run, destination], shown: shownE0, mark: procedureFollowMark(key, shownE0.run), request: destination }))
      .toEqual({ kind: 'show', run: destination })
    expect(procedureFollowAction({ ...idle, runs: [shownE0.run], shown: shownE0, mark: procedureFollowMark(key, shownE0.run), request: shownE0.run }))
      .toEqual({ kind: 'scroll', stepId: 's3' })
    expect(procedureFollowAction({ ...idle, runs: [destination], shown: shownE0, mark: null, request: destination, idleForMs: 0 }))
      .toEqual({ kind: 'wait', delayMs: procedureFollowIdleMs })
    expect(procedureFollowAction({ ...idle, runs: [destination], shown: shownE0, mark: null, request: { ...destination, driver: personDriver } }))
      .toEqual({ kind: 'none' })
  })
})

const lifecycle = (procedureRun: ProcedureRunLifecycleEvent): SimulationRunEventPayload => ({ type: procedureRun.type, procedureRun })
const startedEvent = (started: ProcedureRunState) => lifecycle({ type: 'procedure.run.started', run: started })
const aiStartsDriving = (runId: string) => lifecycle({ type: 'procedure.run.driver.changed', runId, driver: aiDriver, reason: 'started', changedAt: at, changedBy: ai })

describe('procedure window opens on an AI agent\'s start', () => {
  test('counts a Run an AI agent started or resumed, and no Run a person started or an AI agent merely claimed', () => {
    const e0 = run('E-0')
    expect(procedureAiStartedRunIds([startedEvent(e0), aiStartsDriving(e0.runId)])).toEqual([e0.runId])
    expect(procedureAiStartedRunIds([startedEvent({ ...e0, startedBy: operator })])).toEqual([])
    const resumed = lifecycle({ type: 'procedure.run.resumed', runId: e0.runId, resumedAt: at, resumedBy: ai })
    expect(procedureAiStartedRunIds([resumed, aiStartsDriving(e0.runId)])).toEqual([e0.runId])
    // An AI agent resuming a Run it still drives changes no driver.
    expect(procedureAiStartedRunIds([resumed])).toEqual([e0.runId])
    expect(procedureAiStartedRunIds([lifecycle({ type: 'procedure.run.resumed', runId: e0.runId, resumedAt: at, resumedBy: operator })])).toEqual([])
    expect(procedureAiStartedRunIds([lifecycle({ type: 'procedure.run.driver.changed', runId: e0.runId, driver: aiDriver, reason: 'claimed', changedAt: at, changedBy: ai })])).toEqual([])
    expect(procedureAiStartedRunIds([{ type: 'object.upserted' }])).toEqual([])
  })

  test('opens nothing for a transfer, which the window showing the source follows itself', () => {
    expect(procedureAiStartedRunIds([
      startedEvent(destination),
      aiStartsDriving(destination.runId),
      { type: 'procedure.branch.selected' },
      lifecycle({ type: 'procedure.run.closed', runId: transferred.runId, status: 'transferred', closedAt: at, closedBy: ai }),
    ])).toEqual([])
  })

  test('shows an awaited start once its Run is read and an AI agent still drives it; a read without it keeps it awaited', () => {
    const e0 = run('E-0')
    const fr = run('FR-C.1', { driver: personDriver })
    const awaited = new Set([e0.runId, fr.runId, 'procedure-run:not-read-yet'])
    expect(procedureAiStartsRead([e0, fr, destination], awaited)).toEqual({ settled: [e0.runId, fr.runId], show: [e0] })
    expect(procedureAiStartsRead([], awaited)).toEqual({ settled: [], show: [] })
  })

  test('shows the Run in the unit\'s open window in place, else opens a window on it', () => {
    const unitA = 'halden-unit-a' as ObjectId
    const unitB = 'halden-unit-b' as ObjectId
    const windows: ReadonlyArray<ProcedureSystemWindowEntry> = [
      { id: 'procedure-system:a:1', objectId: unitA, initialProcedureId: 'FR-C.1', focusRequest: 2 },
      { id: 'procedure-system:b:2', objectId: unitB },
    ]
    const shown = procedureWindowsShowingAiStart(windows, { objectId: unitA, run: run('E-0'), newWindowId: () => 'unused' })
    expect(shown).toEqual([{ ...windows[0]!, aiStart: { runId: 'procedure-run:e-0' } }, windows[1]!])
    const again = procedureWindowsShowingAiStart(shown, { objectId: unitA, run: run('E-0'), newWindowId: () => 'unused' })
    expect(again[0]?.aiStart).not.toBe(shown[0]?.aiStart)
    expect(procedureWindowsShowingAiStart([windows[1]!], { objectId: unitA, run: run('E-0'), newWindowId: () => 'procedure-system:a:3' }))
      .toEqual([windows[1]!, { id: 'procedure-system:a:3', objectId: unitA, initialProcedureId: 'E-0' }])
  })
})
