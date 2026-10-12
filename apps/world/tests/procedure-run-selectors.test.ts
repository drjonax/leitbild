import { describe, expect, test } from 'bun:test'
import type { ActorId, IsoTimestamp, ProcedureDocument, ProcedureRunState } from '../src/core/model/index.ts'
import {
  furthestTouchedStep,
  procedureCurrentStep,
  procedureBranchActionText,
  procedureActorIsAi,
  procedureActorLabel,
  procedureCompletionWarning,
  procedureDecisionTargetText,
  procedureDecisionTone,
  procedureDriverView,
  procedureHumanisedId,
  procedureRunSummaryTitle,
  procedureOffPathConfirmation,
  procedurePlantTime,
  procedureStepRangeText,
  procedureStepRows,
  procedureRunDocumentKey,
  procedureRunSummariesForScope,
  procedureRunSummaryText,
  procedureStepDisplayName,
} from '../src/ui/procedures/procedure-run-selectors.ts'

const at = '2026-01-01T00:00:00.000Z' as IsoTimestamp
const actor = 'actor:test' as ActorId
const source = {
  sourceId: 'pwr-ops',
  label: 'PWR operations procedures',
  repository: 'leitbild-wikis/pwr-ops',
  ref: 'main',
  path: 'wiki/procedures',
  revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  fetchedAt: at,
  sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/tree/main/wiki/procedures',
}
const unitScope = {
  plantId: 'halden-unit-a',
  label: 'Halden Unit A',
} as const

const procedure = {
  source,
  procedureId: 'E-0',
  title: 'Reactor Trip or Safety Injection',
  csfsMonitored: [],
  entryTriggers: [],
  description: '',
  sourcePath: 'wiki/procedures/E-0.md',
  sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/blob/main/wiki/procedures/E-0.md',
  rawMarkdown: '',
  tags: [],
  steps: [
    {
      id: 'verify-reactor-trip',
      label: '1',
      title: 'Step 1',
      level: 2,
      blocks: [],
      branches: [],
      tagIds: [],
      sourceLine: 10,
      sourceEndLine: 59,
    },
    {
      id: 'verify-phase-a-isolation',
      label: '6',
      title: 'Step 6',
      level: 2,
      blocks: [],
      branches: [],
      tagIds: [],
      sourceLine: 60,
      sourceEndLine: 70,
    },
  ],
} satisfies ProcedureDocument

const activeRun = {
  runId: 'procedure-run:test-a',
  sourceId: 'pwr-ops',
  sourceRevision: source.revision,
  sourcePath: 'wiki/procedures/E-0.md',
  procedureId: 'E-0',
  scope: unitScope,
  title: 'Reactor Trip or Safety Injection',
  status: 'active',
  startedAt: at,
  startedBy: actor,
  stepStates: [{
    stepId: 'verify-phase-a-isolation',
    assessment: 'unknown',
    favorite: false,
    updatedAt: at,
    updatedBy: actor,
  }],
} satisfies ProcedureRunState

describe('procedure run selectors', () => {
  test('reads a procmd step id as words when a heading only has a fallback step title', () => {
    expect(procedureStepDisplayName(procedure.steps[1]!)).toBe('Verify phase a isolation')
    expect(procedureHumanisedId('check_rcp-status')).toBe('Check rcp status')
    expect(procedureStepDisplayName({ ...procedure.steps[0]!, title: 'Verify reactor trip' })).toBe('Verify reactor trip')
  })

  test('a branch on another step than the current one names where the Run stands and where it goes', () => {
    const [first, sixth] = procedure.steps
    const branch = (targetKind: 'step' | 'retry' | 'end', target: string) => ({ label: 'Verified', target, targetKind, tagIds: [], sourceLine: 11 })
    expect(procedureOffPathConfirmation({ document: procedure, current: sixth!, from: first!, branch: branch('step', 'verify-phase-a-isolation') })).toEqual({
      title: 'Move E-0 from step 6 to step 6?',
      body: 'Selecting “Verified” on step 1 records that decision and makes step 6 (Verify phase a isolation) the current step.',
      action: 'Move E-0 to step 6',
    })
    expect(procedureOffPathConfirmation({ document: procedure, current: sixth!, from: first!, branch: branch('retry', 'RETRY') }).title)
      .toBe('Move E-0 from step 6 back to step 1?')
    expect(procedureOffPathConfirmation({ document: procedure, current: sixth!, from: first!, branch: branch('end', 'END') }))
      .toMatchObject({ title: 'End E-0 from step 1? It is at step 6.', action: 'End E-0' })
  })

  test('labels internal branch actions with procedure, step number, and step name', () => {
    expect(procedureBranchActionText({
      currentDocument: procedure,
      branch: {
        label: 'Phase A isolated',
        target: 'verify-phase-a-isolation',
        targetKind: 'step',
        tagIds: [],
        sourceLine: 11,
      },
    })).toBe('Go to E-0, step 6: Verify phase a isolation')
  })

  test('labels external branch actions with target procedure first step when loaded', () => {
    const targetProcedure = {
      ...procedure,
      procedureId: 'FR-C.1',
      title: 'Response to Inadequate Core Cooling',
      steps: [{
        id: 'verify-icc',
        label: '1',
        title: 'Step 1',
        level: 2,
        blocks: [],
        branches: [],
        tagIds: [],
        sourceLine: 12,
        sourceEndLine: 15,
      }],
    } satisfies ProcedureDocument

    expect(procedureBranchActionText({
      currentDocument: procedure,
      targetDocument: targetProcedure,
      branch: {
        label: 'Cooling inadequate',
        target: 'FR-C.1',
        targetKind: 'procedure',
        tagIds: [],
        sourceLine: 13,
      },
    })).toBe('Go to FR-C.1, step 1: Verify icc')
  })

  test('summarizes the furthest touched step by document order', () => {
    expect(furthestTouchedStep(activeRun, procedure)).toEqual({
      stepId: 'verify-phase-a-isolation',
      label: '6',
      name: 'Verify phase a isolation',
    })
  })

  test('uses canonical current step before furthest touched step', () => {
    const run = {
      ...activeRun,
      currentStepId: 'verify-reactor-trip',
    } satisfies ProcedureRunState
    expect(procedureCurrentStep(run, procedure)?.progress).toEqual({
      stepId: 'verify-reactor-trip',
      label: '1',
      name: 'Verify reactor trip',
    })
  })

  test('keeps the shared current step when a transitioned procedure is no longer active', () => {
    const transitionedRun = {
      ...activeRun,
      status: 'completed',
      currentStepId: 'verify-phase-a-isolation',
    } satisfies ProcedureRunState
    expect(procedureCurrentStep(transitionedRun, procedure)?.progress).toEqual({
      stepId: 'verify-phase-a-isolation',
      label: '6',
      name: 'Verify phase a isolation',
    })
  })

  test('separates active and completed runs by unit scope', () => {
    const otherUnitRun = {
      ...activeRun,
      runId: 'procedure-run:test-b',
      scope: {
        plantId: 'halden-unit-b',
        label: 'Halden Unit B',
      },
    } satisfies ProcedureRunState
    const summaries = procedureRunSummariesForScope(
      [activeRun, otherUnitRun],
      unitScope,
      new Map([[procedureRunDocumentKey(activeRun), procedure]]),
    )
    expect(summaries.active.map(procedureRunSummaryText)).toEqual(['E-0:6'])
    expect(summaries.inactive).toEqual([])
  })

  test('folds decided steps, groups the untouched steps a branch jumped over, and marks the current step', () => {
    const steps = Array.from({ length: 8 }, (_, index) => ({
      id: `s${index + 1}`, label: String(index + 1), title: `Step ${index + 1}`, level: 2,
      blocks: [], branches: [], tagIds: [], sourceLine: index * 10 + 1, sourceEndLine: index * 10 + 9,
    }))
    const document = { ...procedure, steps } satisfies ProcedureDocument
    const decision = (target: string) => ({ branchIndex: 0, label: 'Go on', targetKind: 'step' as const, target, selectedBy: actor, simulationTime: '2026-01-01T10:14:45.000Z' as IsoTimestamp })
    const state = (stepId: string, extra: Record<string, unknown>) => ({ stepId, assessment: 'blank' as const, favorite: false, updatedAt: at, updatedBy: actor, ...extra })
    const run = {
      ...activeRun,
      currentStepId: 's7',
      stepStates: [state('s1', { decision: decision('s2') }), state('s2', { decision: decision('s7') }), state('s4', { assessment: 'complete' })],
    } satisfies ProcedureRunState
    const rows = procedureStepRows(document, run)
    expect(rows.map(row => row.kind === 'step' ? `${row.step.label}:${row.role}` : `bypassed ${row.steps.map(step => step.label).join(',')} (${row.from.label}→${row.to.label})`)).toEqual([
      '1:decided', '2:decided', 'bypassed 3 (2→7)', '4:open', 'bypassed 5,6 (2→7)', '7:current', '8:open',
    ])
    expect(procedureStepRows(document, { ...run, status: 'completed' }).find(row => row.kind === 'step' && row.step.id === 's7')).toMatchObject({ role: 'open' })
    expect(procedureStepRows(document, null).every(row => row.kind === 'step' && row.role === 'open')).toBe(true)
    expect(procedureStepRangeText([steps[4]!, steps[5]!, steps[6]!, steps[0]!], document)).toBe('1, 5–7')
    expect(procedureDecisionTargetText(document, decision('s7'))).toBe('7')
    expect(procedureDecisionTargetText(document, { ...decision('FR-S.1'), targetKind: 'procedure' })).toBe('FR-S.1')
    expect(procedureDecisionTone(decision('s2'))).toBe('taken')
    expect(procedureDecisionTone({ ...decision('s2'), outcome: 'rno' })).toBe('rno')
  })

  test('names who decided and when by the plant clock', () => {
    expect(procedurePlantTime('2026-01-01T10:14:45.120Z')).toBe('10:14:45')
    expect(procedurePlantTime('2026-01-01T10:14:45.120Z', 'minutes')).toBe('10:14')
    expect(() => procedurePlantTime('yesterday')).toThrow()
    expect(procedureActorIsAi('actor:ai:assistant')).toBe(true)
    expect(procedureActorIsAi('actor:operator')).toBe(false)
    expect(procedureActorLabel('actor:operator')).toBe('Operator')
    expect(procedureActorLabel('actor:ai:assistant')).toBe('AI')
    expect(procedureActorLabel('actor:ai:assistant', 'Assistant')).toBe('Assistant')
  })

  test('says who drives an active Run, how many steps the driving AI decided, and whom a person can hand it back to', () => {
    const ai = 'actor:ai:assistant' as ActorId
    const decided = (stepId: string, selectedBy: ActorId, time: string, selectedByLabel?: string) => ({
      stepId, assessment: 'blank' as const, favorite: false, updatedAt: at, updatedBy: selectedBy,
      decision: { branchIndex: 0, targetKind: 'step' as const, target: 'verify-phase-a-isolation', selectedBy, simulationTime: time as IsoTimestamp, ...(selectedByLabel ? { selectedByLabel } : {}) },
    })
    const stepStates = [decided('a', actor, '2026-01-01T10:10:00.000Z'), decided('b', ai, '2026-01-01T10:12:00.000Z', 'Assistant'), decided('c', ai, '2026-01-01T10:14:00.000Z', 'Assistant')]
    const aiRun = { ...activeRun, stepStates, driver: { kind: 'ai' as const, actorId: ai, label: 'Assistant', since: '2026-01-01T10:11:30.000Z' as IsoTimestamp } } satisfies ProcedureRunState
    expect(procedureDriverView(aiRun)).toEqual({ kind: 'ai', label: 'Assistant', since: '10:11', aiSteps: 2, handBackTo: 'Assistant' })
    expect(procedureRunSummaryTitle({ run: aiRun, procedureId: 'E-0', title: 'Reactor Trip', status: 'active', step: null })).toContain('Driven by AI: Assistant')
    const personRun = { ...aiRun, driver: { kind: 'person' as const, actorId: 'actor:operator' as ActorId, since: '2026-01-01T10:15:00.000Z' as IsoTimestamp } } satisfies ProcedureRunState
    expect(procedureDriverView(personRun)).toEqual({ kind: 'person', label: 'Operator', since: '10:15', aiSteps: 0, handBackTo: 'Assistant' })
    expect(procedureDriverView({ ...personRun, stepStates: [] })?.handBackTo).toBeNull()
    expect(procedureDriverView({ ...aiRun, status: 'completed' })).toBeNull()
    expect(procedureDriverView(activeRun)).toBeNull()
  })

  test('completing away from an END step names the steps still open; at an END step it says nothing', () => {
    const steps = Array.from({ length: 6 }, (_, index) => ({
      id: `s${index + 1}`, label: String(index + 1), title: `Step ${index + 1}`, level: 2, blocks: [], tagIds: [],
      branches: index === 3 ? [{ label: 'Done', target: 'END', targetKind: 'end' as const, tagIds: [], sourceLine: index * 10 + 5 }] : [],
      sourceLine: index * 10 + 1, sourceEndLine: index * 10 + 9,
    }))
    const document = { ...procedure, steps } satisfies ProcedureDocument
    const state = (stepId: string, extra: Record<string, unknown>) => ({ stepId, assessment: 'blank' as const, favorite: false, updatedAt: at, updatedBy: actor, ...extra })
    const run = { ...activeRun, currentStepId: 's2', stepStates: [state('s1', { decision: { branchIndex: 0, targetKind: 'step' as const, target: 's2', selectedBy: actor, simulationTime: at } }), state('s5', { assessment: 'complete' })] } satisfies ProcedureRunState
    expect(procedureCompletionWarning(document, run)).toBe('E-0 is at step 2, not at an END step. Steps 2–4, 6 are still open.')
    expect(procedureCompletionWarning(document, { ...run, currentStepId: 's4' })).toBeNull()
    expect(procedureCompletionWarning(document, { ...run, currentStepId: 's6' })).toBeNull()
  })
})
