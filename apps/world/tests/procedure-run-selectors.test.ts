import { describe, expect, test } from 'bun:test'
import type { ActorId, IsoTimestamp, ProcedureDocument, ProcedureRunState } from '../src/core/model/index.ts'
import {
  furthestTouchedStep,
  procedureCurrentStep,
  procedureBranchActionText,
  procedureHumanisedId,
  procedureOffPathConfirmation,
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
})
