import { describe, expect, test } from 'bun:test'
import type { ActorId, IsoTimestamp, ProcedureDocument, ProcedureRunState } from '../src/core/model/index.ts'
import type { ProcedureCsfEvaluation, ProcedureObservationPort, ProcedureTagValue } from '../src/features/procedures/pack-observations.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { composeProcedureRunView, composeProcedureStepView, procedureStepNotFoundCode, type ProcedureStepViewPorts } from '../src/features/procedures/step-view.ts'

const source = {
  sourceId: 'pwr-ops', label: 'PWR operations procedures', repository: 'leitbild-wikis/pwr-ops', ref: 'main',
  path: 'wiki/procedures', revision: 'c'.repeat(40), fetchedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/tree/main/wiki/procedures',
}

const plantTime = '2026-10-13T08:01:00.000Z' as IsoTimestamp

const markdown = (csfs: string) => `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Reactor Trip or Safety Injection
${csfs}
---
# E-0 — Reactor Trip or Safety Injection

A preamble the step view leaves out.

## Step 1 [id: verify-reactor-trip]
Note: Simulator applicability, see [model scope](../model-and-scope.md).
Check: reactor trip breakers «TRIP-BKR-A» AND «TRIP-BKR-B» OPEN AND neutron flux «NIS-PR-AVG» decreasing
Basis: Technical basis text with [a link](../basis.md#trip) the AI does not decide by.
- Verified [outcome: normal] → #verify-turbine-trip
  Because: rapid neutron flux decrease confirms [core shutdown](../basis.md)
- Not verified [outcome: rno] → [[FR-S.1]]
## Step 2 [id: verify-turbine-trip]
Check: all turbine stop valves CLOSED
- Verified [outcome: normal] → END

## Tags

- id: TRIP-BKR-A
  description: reactor trip breaker A position
  model-note: the model reports closed as a boolean
- id: TRIP-BKR-B
  description: reactor trip breaker B position
- id: NIS-PR-AVG
  description: power range neutron flux average
  units: percent
`

const document = (csfs = 'csfs-monitored: [subcriticality, core-cooling]'): ProcedureDocument =>
  parseProcedureMarkdown({ source, sourcePath: 'wiki/procedures/E-0.md', sourceUrl: 'https://example.test/E-0.md', rawMarkdown: markdown(csfs) })

const run = (overrides: Partial<ProcedureRunState> = {}): ProcedureRunState => ({
  runId: 'procedure-run:view', sourceId: source.sourceId, sourceRevision: source.revision, sourcePath: 'wiki/procedures/E-0.md',
  procedureId: 'E-0', scope: { plantId: 'plant:unit-2', label: 'Unit 2' }, title: 'Reactor Trip or Safety Injection', status: 'active',
  startedAt: '2026-10-13T08:00:00.000Z' as IsoTimestamp, startedBy: 'actor:ai:assistant' as ActorId, currentStepId: 'verify-reactor-trip',
  driver: { kind: 'ai', actorId: 'actor:ai:assistant' as ActorId, label: 'Assistant', since: '2026-10-13T08:00:00.000Z' as IsoTimestamp },
  stepStates: [], ...overrides,
})

const value = (tagId: string, formatted: string, extra: Partial<ProcedureTagValue> = {}): ProcedureTagValue =>
  ({ tagId, label: tagId, value: 0, formatted, quality: 'good', ...extra })

const csf = (id: string, status: ProcedureCsfEvaluation['status'], extra: Partial<ProcedureCsfEvaluation> = {}): ProcedureCsfEvaluation =>
  ({ id, label: id, status, signalCount: 0, signals: [], qualification: 'reference-model-criteria', ...extra })

// Test-only ports: a plant clock and Pack answers per tag.
const ports = (config: {
  readonly reads?: Readonly<Record<string, ProcedureTagValue | Error | 'missing'>>
  readonly csfs?: ReadonlyMap<string, ProcedureCsfEvaluation> | Error
  readonly calls?: string[]
} = {}): ProcedureStepViewPorts => ({
  sequence: () => 42,
  clock: () => ({ currentTime: plantTime, paused: false }),
  observations: (): ProcedureObservationPort => ({
    validateTags: async tags => new Map(tags.map(tag => [tag.id, {
      id: tag.id, status: config.reads?.[tag.id] === 'missing' ? 'missing' as const : 'resolved' as const, warnings: tag.id === 'NIS-PR-AVG' ? ['requested percent unavailable'] : [],
    }])),
    readTag: async tag => {
      config.calls?.push(tag.id)
      const read = config.reads?.[tag.id]
      if (read === undefined || read === 'missing') throw new Error(`no ${tag.id}`)
      if (read instanceof Error) throw read
      return read
    },
    evaluateCsfs: async ids => {
      config.calls?.push(`csfs:${ids.join(',')}`)
      if (config.csfs instanceof Error) throw config.csfs
      return config.csfs ?? new Map()
    },
  }),
})

describe('procedure step view', () => {
  test('reads the current step compactly: branches with the AI verdict, step tags with readings and plant time, CSF colours, sequence', async () => {
    const view = await composeProcedureStepView({ run: run(), document: document(), ports: ports({
      reads: {
        'TRIP-BKR-A': value('TRIP-BKR-A', 'false'),
        'TRIP-BKR-B': value('TRIP-BKR-B', 'false', { quality: 'uncertain' }),
        'NIS-PR-AVG': value('NIS-PR-AVG', '3.1 MW', { conversionStatus: 'unavailable', warning: 'requested percent is not available' }),
      },
      csfs: new Map([['subcriticality', csf('subcriticality', 'green', { reason: 'subcritical' })], ['core-cooling', csf('core-cooling', 'orange', { procedure: 'FR-C.2', reason: 'core exit hot' })]]),
    }) })
    expect(view.sequence).toBe(42)
    expect(view.simulationTime).toBe(plantTime)
    expect(view.paused).toBeUndefined()
    expect(view.run).toEqual({ runId: 'procedure-run:view', procedureId: 'E-0', title: 'Reactor Trip or Safety Injection', status: 'active',
      plantId: 'plant:unit-2', unit: 'Unit 2', driver: run().driver, currentStepId: 'verify-reactor-trip', stepNumber: 1, totalSteps: 2 })
    expect(view.step!.blocks.map(block => block.kind)).toEqual(['note', 'check'])
    expect(view.step!.blocks[0]!.text).toBe('Simulator applicability, see model scope.')
    expect(JSON.stringify(view)).not.toContain('preamble')
    expect(JSON.stringify(view)).not.toContain('basis.md')
    expect(view.step!.branches).toEqual([
      { index: 0, label: 'Verified', outcome: 'normal', targetKind: 'step', target: 'verify-turbine-trip', because: 'rapid neutron flux decrease confirms core shutdown', aiMaySelect: true },
      { index: 1, label: 'Not verified', outcome: 'rno', targetKind: 'procedure', target: 'FR-S.1', aiMaySelect: false,
        personOnlyReason: '"Not verified → FR-S.1" is an RNO transfer branch: a person selects it in the procedure window.' },
    ])
    expect(view.tags).toEqual([
      { id: 'TRIP-BKR-A', description: 'reactor trip breaker A position', binding: 'resolved', notes: { 'model-note': 'the model reports closed as a boolean' },
        reading: { formatted: 'false', quality: 'good' } },
      { id: 'TRIP-BKR-B', description: 'reactor trip breaker B position', binding: 'resolved', reading: { formatted: 'false', quality: 'uncertain' } },
      { id: 'NIS-PR-AVG', description: 'power range neutron flux average', binding: 'resolved', warnings: ['requested percent unavailable'],
        reading: { formatted: '3.1 MW', quality: 'good', note: 'requested percent is not available' } },
    ])
    expect(view.csfs).toEqual([{ id: 'subcriticality', status: 'green' }, { id: 'core-cooling', status: 'orange', procedure: 'FR-C.2', reason: 'core exit hot' }])
    expect(view.step!.state).toBeUndefined()
  })

  test('a missing or unreadable tag is reported with its reason, never dropped; a step none of whose tags reads is a person\'s', async () => {
    const calls: string[] = []
    const view = await composeProcedureStepView({ run: run(), document: document('csfs-monitored: []'), ports: ports({ calls,
      reads: { 'TRIP-BKR-A': 'missing', 'TRIP-BKR-B': new Error('runtime unavailable'), 'NIS-PR-AVG': 'missing' } }) })
    expect(view.tags).toEqual([
      { id: 'TRIP-BKR-A', description: 'reactor trip breaker A position', binding: 'missing', notes: { 'model-note': 'the model reports closed as a boolean' }, unavailable: 'not in the plant model' },
      { id: 'TRIP-BKR-B', description: 'reactor trip breaker B position', binding: 'resolved', unavailable: 'runtime unavailable' },
      { id: 'NIS-PR-AVG', description: 'power range neutron flux average', binding: 'missing', warnings: ['requested percent unavailable'], unavailable: 'not in the plant model' },
    ])
    expect(view.step!.branches[0]).toMatchObject({ aiMaySelect: false, personOnlyReason: "None of step 1's tags can be read on this plant now: a person decides this step." })
    // CSFs only when the procedure monitors them.
    expect(view.csfs).toBeUndefined()
    expect(calls.some(call => call.startsWith('csfs:'))).toBe(false)

    const failed = await composeProcedureStepView({ run: run(), document: document(), ports: ports({ csfs: new Error('assessment query refused') }) })
    expect(failed.csfs).toEqual([
      { id: 'subcriticality', status: 'unknown', reason: 'unavailable: assessment query refused' },
      { id: 'core-cooling', status: 'unknown', reason: 'unavailable: assessment query refused' },
    ])
  })

  test('an explicit step, its decision and observation; an unknown step; the run alone after a transfer or END', async () => {
    const decided = run({
      currentStepId: 'verify-turbine-trip',
      observations: [{ stepId: 'verify-turbine-trip', simulationTime: '2026-10-13T08:00:50.000Z' as IsoTimestamp, result: { status: 'unknown', reason: 'no binding' } }],
      stepStates: [{ stepId: 'verify-reactor-trip', assessment: 'complete', favorite: false, comment: 'x'.repeat(600),
        updatedAt: '2026-10-13T08:00:40.000Z' as IsoTimestamp, updatedBy: 'actor:ai:assistant' as ActorId,
        decision: { branchIndex: 0, label: 'Verified', outcome: 'normal', targetKind: 'step', target: 'verify-turbine-trip', basis: 'Breakers open.',
          evidence: [{ tagId: 'TRIP-BKR-A', reading: 'false' }], selectedBy: 'actor:ai:assistant' as ActorId, selectedByLabel: 'Assistant',
          simulationTime: '2026-10-13T08:00:40.000Z' as IsoTimestamp } }],
    })
    const earlier = await composeProcedureStepView({ run: decided, document: document('csfs-monitored: []'), stepId: 'verify-reactor-trip', ports: ports() })
    expect(earlier.run.stepNumber).toBe(1)
    expect(earlier.step!.state!.decision).toMatchObject({ basis: 'Breakers open.', evidence: [{ tagId: 'TRIP-BKR-A', reading: 'false' }], selectedByLabel: 'Assistant' })
    expect(earlier.step!.state!.comment).toHaveLength(500)
    expect(earlier.step!.branches[0]).toMatchObject({ aiMaySelect: false, personOnlyReason: "Step 1 is not the run's current step (verify-turbine-trip): an AI agent works only the current step." })

    const current = await composeProcedureStepView({ run: decided, document: document('csfs-monitored: []'), ports: ports() })
    expect(current.step).toMatchObject({ id: 'verify-turbine-trip', observation: { status: 'unknown', reason: 'no binding', simulationTime: '2026-10-13T08:00:50.000Z' } })
    expect(current.tags).toBeUndefined()
    expect(current.step!.branches[0]).toMatchObject({ aiMaySelect: false, personOnlyReason: '"Verified → END" is an END branch: a person selects it in the procedure window.' })

    await expect(composeProcedureStepView({ run: decided, document: document(), stepId: 'no-such-step', ports: ports() }))
      .rejects.toMatchObject({ code: procedureStepNotFoundCode })

    const closed = composeProcedureRunView({ run: run({ status: 'completed' }), document: document(), ports: ports() })
    expect(closed).toEqual({ sequence: 42, simulationTime: plantTime,
      run: expect.objectContaining({ status: 'completed', totalSteps: 2 }) })
    expect(closed.step).toBeUndefined()
  })
})
