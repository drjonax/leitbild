import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, EventId, IsoTimestamp, ProcedureDocument, SimulationRunEvent, SimulationRunId } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import { createSimulationRunStateStore } from '../src/core/simulation-runs/state-store.ts'
import { procedureBranchVerdict, type ProcedureActorKind } from '../src/features/procedures/driver-rules.ts'
import type { ProcedureObservationPort, ProcedureTagValue } from '../src/features/procedures/pack-observations.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { prepareProcedureCommand } from '../src/features/procedures/run-state.ts'

const source = {
  sourceId: 'pwr-ops', label: 'PWR operations procedures', repository: 'leitbild-wikis/pwr-ops', ref: 'main',
  path: 'wiki/procedures', revision: 'b'.repeat(40), fetchedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/tree/main/wiki/procedures',
}

const e0 = `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Reactor Trip or Safety Injection
csfs-monitored: [subcriticality]
---
# E-0 — Reactor Trip or Safety Injection
## Step 1 [id: verify-reactor-trip]
Check: reactor trip breakers «TRIP-BKR-A» AND «TRIP-BKR-B» OPEN AND neutron flux «NIS-PR-AVG» decreasing
- Verified [outcome: normal] → #verify-turbine-trip
- Not verified [outcome: rno] → [[FR-S.1]]
## Step 2 [id: verify-turbine-trip]
Check: all turbine stop valves CLOSED
- Verified [outcome: normal] → #check-power
## Step 3 [id: check-power]
Check: neutron flux «NIS-PR-AVG» below 5 percent
- Below [outcome: normal] → END
- Indication unreliable [outcome: unknown] → #verify-reactor-trip
- Rising [outcome: rno] → #verify-reactor-trip

## Tags

- id: TRIP-BKR-A
  description: reactor trip breaker A position
- id: TRIP-BKR-B
  description: reactor trip breaker B position
- id: NIS-PR-AVG
  description: power range neutron flux average
  units: percent
`

const frs1 = `---
type: procedure
procedure-md: 0.7
procedure-id: FR-S.1
title: Response to Nuclear Power Generation
---
# FR-S.1 — Response to Nuclear Power Generation
## Step 1 [id: insert-rods]
Action: insert control rods
- Done [outcome: normal] → END
`

const documents: Readonly<Record<string, ProcedureDocument>> = Object.fromEntries([['E-0', e0], ['FR-S.1', frs1]].map(([id, markdown]) =>
  [id, parseProcedureMarkdown({ source, sourcePath: `wiki/procedures/${id}.md`, sourceUrl: `https://example.test/${id}.md`, rawMarkdown: markdown! })]))

const plantId = 'plant:unit-2'
const scope = { plantId, label: 'Unit 2' }
const assistant = { id: 'actor:ai:assistant' as ActorId, kind: 'ai' as const, label: 'Assistant' }
const otherAgent = { id: 'actor:ai:other' as ActorId, kind: 'ai' as const, label: 'Shift advisor' }
const operator = { id: 'actor:operator' as ActorId, kind: 'person' as const }

type Reading = ProcedureTagValue | Error | 'missing'
const reading = (tagId: string, formatted: string, value: unknown, quality = 'good'): ProcedureTagValue => ({ tagId, label: tagId, value, formatted, quality })

// Test-only Pack port: the plant's current answers per tag.
const fakePort = (values: Readonly<Record<string, Reading>>, reads: string[]): ProcedureObservationPort => ({
  validateTags: async tags => new Map(tags.map(tag => [tag.id, { id: tag.id, status: values[tag.id] === 'missing' || values[tag.id] === undefined ? 'missing' as const : 'resolved' as const, warnings: [] }])),
  readTag: async tag => {
    reads.push(tag.id)
    const value = values[tag.id]
    if (value instanceof Error) throw value
    if (value === undefined || value === 'missing') throw new Error(`test plant has no ${tag.id}`)
    return value
  },
  evaluateCsfs: async () => new Map(),
})

const tripped: Readonly<Record<string, Reading>> = {
  'TRIP-BKR-A': reading('TRIP-BKR-A', 'false', false),
  'TRIP-BKR-B': reading('TRIP-BKR-B', 'false', false),
  'NIS-PR-AVG': reading('NIS-PR-AVG', '2.100 percent', 2.1),
}

const harness = () => {
  let seq = 0
  let commandSeq = 0
  const simulationRunId = 'procedure-driver-test' as SimulationRunId
  const store = createSimulationRunStateStore()
  store.hydrate({ objects: [], seq: 0 })
  const factory = { eventId: () => `event:${++seq}` as EventId, nextSeq: () => seq }
  let values = tripped
  const reads: string[] = []
  const execute = async (
    actor: { readonly id: ActorId; readonly kind: ProcedureActorKind; readonly label?: string },
    kind: string,
    payload: unknown,
  ): Promise<ReadonlyArray<SimulationRunEvent>> => {
    const at = nowIso()
    const command: CommandEnvelope = { id: `command:${++commandSeq}` as CommandEnvelope['id'], simulationRunId, actorId: actor.id,
      kind, targetObjectIds: [], issuedAt: at, payload }
    const commit = await prepareProcedureCommand({ command, procedures: store.snapshot().procedures,
      readDocument: async input => documents[input.procedureId]!,
      observations: requested => {
        expect(requested).toBe(plantId)
        return fakePort(values, reads)
      } })
    const events = commit!({ simulationRunId, at, simulationTime: '2026-10-13T08:00:30.000Z' as IsoTimestamp, procedures: store.snapshot().procedures,
      factory, objectIds: new Set([plantId]), actorKind: actor.kind, ...(actor.label === undefined ? {} : { actorLabel: actor.label }) })
    for (const event of events) store.apply(event)
    return events
  }
  const run = (procedureId = 'E-0') => store.snapshot().procedures!.runs.find(candidate => candidate.procedureId === procedureId)!
  const start = async (actor: Parameters<typeof execute>[0] = assistant) => await execute(actor, 'world.procedure.run.start',
    { sourceId: source.sourceId, sourceRevision: source.revision, procedureId: 'E-0', scope })
  const transition = async (actor: Parameters<typeof execute>[0], payload: Record<string, unknown>) =>
    await execute(actor, 'world.procedure.run.transition', { runId: run().runId, stepId: run().currentStepId, ...payload })
  const evidence = { basis: 'Criterion: both trip breakers open, flux falling. Evidence: TRIP-BKR-A false, TRIP-BKR-B false, NIS-PR-AVG 2.1 percent at 08:00:30. Not observable: rod bottom lights.',
    evidenceTagIds: ['TRIP-BKR-A', 'TRIP-BKR-B', 'NIS-PR-AVG'] }
  return { execute, run, start, transition, evidence, reads, setValues: (next: typeof values) => { values = next } }
}

describe('procedure run driver and AI decision rules', () => {
  test('an AI agent that starts a procedure drives it, and its normal branch on readable evidence records the readings on the step decision', async () => {
    const h = harness()
    const started = await h.start()
    expect(started.map(event => event.type)).toEqual(['procedure.run.started', 'procedure.run.driver.changed'])
    expect(h.run().driver).toMatchObject({ kind: 'ai', actorId: assistant.id, label: 'Assistant' })
    expect(started[1]).toMatchObject({ reason: 'started', changedBy: assistant.id })

    const events = await h.transition(assistant, { branchIndex: 0, ...h.evidence })
    expect(h.reads.sort()).toEqual(['NIS-PR-AVG', 'TRIP-BKR-A', 'TRIP-BKR-B'])
    expect(events.find(event => event.type === 'procedure.branch.selected')).toMatchObject({
      selectedBy: assistant.id, selectedByLabel: 'Assistant', basis: h.evidence.basis, label: 'Verified', outcome: 'normal',
    })
    const decision = h.run().stepStates.find(step => step.stepId === 'verify-reactor-trip')!.decision!
    expect(decision).toMatchObject({ branchIndex: 0, target: 'verify-turbine-trip', selectedBy: assistant.id, selectedByLabel: 'Assistant',
      basis: h.evidence.basis, simulationTime: '2026-10-13T08:00:30.000Z' })
    expect(decision.evidence).toEqual([
      { tagId: 'TRIP-BKR-A', reading: 'false' },
      { tagId: 'TRIP-BKR-B', reading: 'false' },
      { tagId: 'NIS-PR-AVG', reading: '2.100 percent' },
    ])
    expect(h.run().currentStepId).toBe('verify-turbine-trip')
    expect(h.run().stepStates.find(step => step.stepId === 'verify-reactor-trip')!.assessment).toBe('complete')
    expect(h.run().driver?.kind).toBe('ai')
  })

  test('an AI agent cannot reset, and cannot select an RNO, unknown, transfer or END branch', async () => {
    const h = harness()
    await h.start()
    await expect(h.execute(assistant, 'world.procedure.run.reset', { sourceId: source.sourceId, procedureId: 'E-0', scope }))
      .rejects.toThrow('A person resets procedure runs')
    await expect(h.transition(assistant, { branchIndex: 1, ...h.evidence })).rejects.toThrow('"Not verified → FR-S.1" is an RNO transfer branch: a person selects it in the procedure window.')
    expect(h.run().status).toBe('active')
    expect(h.run().stepStates).toEqual([])

    // Walk to step 3 as the AI (step 2 cites no tag, so a person answers it).
    await h.transition(assistant, { branchIndex: 0, ...h.evidence })
    for (const cited of [{ evidenceTagIds: ['NIS-PR-AVG'] }, {}]) {
      await expect(h.transition(assistant, { branchIndex: 0, basis: 'Stop valves closed.', ...cited }))
        .rejects.toThrow('Step 2 cites no plant tag World can read: a person decides this step.')
    }
    await expect(h.transition(operator, { branchIndex: 0, evidenceTagIds: ['NIS-PR-AVG'] })).rejects.toThrow('«NIS-PR-AVG» is not cited in step 2')
    await h.transition(operator, { branchIndex: 0 })
    expect(h.run().driver?.kind).toBe('ai')
    const powerEvidence = { basis: 'Flux 2.1 percent at 08:00:30.', evidenceTagIds: ['NIS-PR-AVG'] }
    await expect(h.transition(assistant, { branchIndex: 0, ...powerEvidence })).rejects.toThrow('is an END branch')
    await expect(h.transition(assistant, { branchIndex: 1, ...powerEvidence })).rejects.toThrow('is an unknown-outcome branch')
    await expect(h.transition(assistant, { branchIndex: 2, ...powerEvidence })).rejects.toThrow('is an RNO branch')
    expect(h.run().currentStepId).toBe('check-power')
  })

  test('an AI transition off the current step, without a basis or evidence, or on a tag it cannot read is refused', async () => {
    const h = harness()
    await h.start()
    await expect(h.execute(assistant, 'world.procedure.run.transition', { runId: h.run().runId, stepId: 'check-power', branchIndex: 0, ...h.evidence }))
      .rejects.toThrow()
    await expect(h.execute(assistant, 'world.procedure.run.transition', { runId: h.run().runId, stepId: 'check-power', branchIndex: 1, basis: 'Flux low.', evidenceTagIds: ['NIS-PR-AVG'] }))
      .rejects.toThrow('is an unknown-outcome branch')
    // A normal step branch off the current step.
    await h.transition(assistant, { branchIndex: 0, ...h.evidence })
    await expect(h.execute(assistant, 'world.procedure.run.transition', { runId: h.run().runId, stepId: 'verify-reactor-trip', branchIndex: 0, ...h.evidence }))
      .rejects.toThrow("Step 1 is not the run's current step (verify-turbine-trip): an AI agent works only the current step.")

    const fresh = harness()
    await fresh.start()
    await expect(fresh.transition(assistant, { branchIndex: 0, evidenceTagIds: ['TRIP-BKR-A'] })).rejects.toThrow('only with a basis')
    await expect(fresh.transition(assistant, { branchIndex: 0, basis: 'Breakers open.' })).rejects.toThrow('cites 1 to 6 of step 1\'s tags as evidenceTagIds')
    await expect(fresh.transition(assistant, { branchIndex: 0, basis: 'Breakers open.', evidenceTagIds: ['PT-455'] })).rejects.toThrow('«PT-455» is not cited in step 1')
    fresh.setValues({ ...tripped, 'TRIP-BKR-B': 'missing' })
    await expect(fresh.transition(assistant, { branchIndex: 0, ...fresh.evidence })).rejects.toThrow('«TRIP-BKR-B» is not in the plant model: a person decides step 1')
    fresh.setValues({ ...tripped, 'NIS-PR-AVG': new Error('runtime unavailable') })
    await expect(fresh.transition(assistant, { branchIndex: 0, ...fresh.evidence })).rejects.toThrow('«NIS-PR-AVG» could not be read (runtime unavailable): a person decides step 1')
    expect(fresh.run().currentStepId).toBe('verify-reactor-trip')
    expect(fresh.run().stepStates).toEqual([])

    // A person may select with an unreadable tag; World records why it had no value.
    await fresh.transition(operator, { branchIndex: 0, basis: 'Breakers open on the board.', evidenceTagIds: ['NIS-PR-AVG'] })
    expect(fresh.run().stepStates.find(step => step.stepId === 'verify-reactor-trip')!.decision!.evidence)
      .toEqual([{ tagId: 'NIS-PR-AVG', reading: 'unavailable: runtime unavailable' }])
  })

  test('a person answering the current step keeps the AI driving; a tick, jump, off-path branch or close takes over; comments and favorites never do', async () => {
    const h = harness()
    await h.start()
    await h.transition(operator, { branchIndex: 0 })
    expect(h.run().driver).toMatchObject({ kind: 'ai', actorId: assistant.id })

    await h.execute(operator, 'world.procedure.step.update', { runId: h.run().runId, stepId: 'verify-turbine-trip', comment: 'Stop valves look closed.', favorite: true })
    expect(h.run().driver?.kind).toBe('ai')

    const tick = await h.execute(operator, 'world.procedure.step.update', { runId: h.run().runId, stepId: 'verify-turbine-trip', assessment: 'complete' })
    expect(tick.map(event => event.type)).toEqual(['procedure.run.driver.changed', 'procedure.step.updated'])
    expect(tick[0]).toMatchObject({ reason: 'person-acted', driver: { kind: 'person', actorId: operator.id }, changedBy: operator.id })
    expect(h.run().driver).toMatchObject({ kind: 'person', actorId: operator.id })

    // While a person drives, an AI agent only reads.
    await expect(h.transition(assistant, { branchIndex: 0, ...h.evidence })).rejects.toThrow('A person drives E-0 on Unit 2')
    await expect(h.execute(assistant, 'world.procedure.step.update', { runId: h.run().runId, stepId: 'verify-turbine-trip', comment: 'note' }))
      .rejects.toThrow('an AI agent only reads it until a person hands it back')
    await expect(h.execute(assistant, 'world.procedure.run.close', { runId: h.run().runId, status: 'abandoned' })).rejects.toThrow('A person drives')
    await expect(h.execute(assistant, 'world.procedure.run.drive', { runId: h.run().runId, action: 'claim' })).rejects.toThrow('A person drives')
    await expect(h.execute(assistant, 'world.procedure.run.drive', { runId: h.run().runId, action: 'release' })).rejects.toThrow('A person drives')

    // Hand back: released, then the AI claims it again.
    expect((await h.execute(operator, 'world.procedure.run.drive', { runId: h.run().runId, action: 'release' }))[0]).toMatchObject({ reason: 'released' })
    expect(h.run().driver).toBeUndefined()
    await expect(h.execute(assistant, 'world.procedure.step.update', { runId: h.run().runId, stepId: 'verify-turbine-trip', comment: 'note' }))
      .rejects.toThrow('Nobody drives E-0 on Unit 2: claim it with world.procedure.run.drive')
    await h.execute(assistant, 'world.procedure.run.drive', { runId: h.run().runId, action: 'claim' })
    expect(h.run().driver).toMatchObject({ kind: 'ai', actorId: assistant.id })
    expect(await h.execute(assistant, 'world.procedure.run.drive', { runId: h.run().runId, action: 'claim' })).toEqual([])
    await expect(h.execute(otherAgent, 'world.procedure.run.drive', { runId: h.run().runId, action: 'claim' })).rejects.toThrow('Assistant, another AI agent, drives')

    // A jump of the current step takes over; so does a branch off the current step, and a close.
    const jump = await h.execute(operator, 'world.procedure.step.update', { runId: h.run().runId, stepId: 'check-power', currentStepId: 'check-power' })
    expect(jump[0]).toMatchObject({ type: 'procedure.run.driver.changed', reason: 'person-acted' })
    await h.execute(operator, 'world.procedure.run.drive', { runId: h.run().runId, action: 'release' })
    await h.execute(assistant, 'world.procedure.run.drive', { runId: h.run().runId, action: 'claim' })
    const offPath = await h.execute(operator, 'world.procedure.run.transition', { runId: h.run().runId, stepId: 'verify-reactor-trip', branchIndex: 0 })
    expect(offPath[0]).toMatchObject({ type: 'procedure.run.driver.changed', reason: 'person-acted' })
    await h.execute(operator, 'world.procedure.run.drive', { runId: h.run().runId, action: 'claim' })
    await h.execute(operator, 'world.procedure.run.drive', { runId: h.run().runId, action: 'release' })
    await h.execute(assistant, 'world.procedure.run.drive', { runId: h.run().runId, action: 'claim' })
    const closed = await h.execute(operator, 'world.procedure.run.close', { runId: h.run().runId, status: 'abandoned' })
    expect(closed.map(event => event.type)).toEqual(['procedure.run.driver.changed', 'procedure.run.closed'])
  })

  test('an AI agent records only a short comment on a run it drives', async () => {
    const h = harness()
    await h.start()
    for (const update of [{ assessment: 'complete' }, { favorite: true }, { currentStepId: 'check-power' }]) {
      await expect(h.execute(assistant, 'world.procedure.step.update', { runId: h.run().runId, stepId: 'verify-reactor-trip', ...update }))
        .rejects.toThrow('An AI agent records only a comment on a step')
    }
    await expect(h.execute(assistant, 'world.procedure.step.update', { runId: h.run().runId, stepId: 'verify-reactor-trip', comment: 'x'.repeat(501) }))
      .rejects.toThrow('at most 500 characters')
    await h.execute(assistant, 'world.procedure.step.update', { runId: h.run().runId, stepId: 'verify-reactor-trip', comment: 'Waiting for flux to fall.' })
    expect(h.run().stepStates[0]).toMatchObject({ comment: 'Waiting for flux to fall.', assessment: 'blank' })
  })

  test('a transfer a person selects hands the run\'s driver on to the destination', async () => {
    const h = harness()
    await h.start()
    const events = await h.transition(operator, { branchIndex: 1 })
    expect(events.map(event => event.type)).toEqual(['procedure.run.started', 'procedure.run.driver.changed', 'procedure.branch.selected', 'procedure.step.updated', 'procedure.run.closed'])
    expect(h.run('FR-S.1').driver).toMatchObject({ kind: 'ai', actorId: assistant.id })
    expect(h.run('E-0')).toMatchObject({ status: 'transferred', driver: { kind: 'ai' } })
    // Resuming the transferred procedure: an AI agent may resume what it drives.
    await h.execute(operator, 'world.procedure.run.drive', { runId: h.run('FR-S.1').runId, action: 'claim' })
    expect(h.run('FR-S.1').driver?.kind).toBe('person')
  })

  test('a person resuming a transferred run an AI agent drives takes it over; an AI agent cannot resume one a person drives', async () => {
    const h = harness()
    await h.start()
    await h.transition(operator, { branchIndex: 1 })
    const resumed = await h.start(operator)
    expect(resumed.map(event => event.type)).toEqual(['procedure.run.driver.changed', 'procedure.run.resumed'])
    expect(h.run('E-0').driver?.kind).toBe('person')

    const other = harness()
    await other.start(operator)
    expect(other.run().driver).toBeUndefined()
    await other.execute(operator, 'world.procedure.run.drive', { runId: other.run().runId, action: 'claim' })
    await other.transition(operator, { branchIndex: 1 })
    expect(other.run('FR-S.1').driver?.kind).toBe('person')
    await expect(other.start(assistant)).rejects.toThrow('A person drives E-0 on Unit 2')
  })

  test('a person taking over while an AI transition is being prepared wins: the prepared AI commit is refused', async () => {
    const h = harness()
    await h.start()
    const run = h.run()
    const at = nowIso()
    let seq = 100
    const factory = { eventId: () => `event:race-${++seq}` as EventId, nextSeq: () => seq }
    const prepared = await prepareProcedureCommand({
      command: { id: 'command:ai-race' as CommandEnvelope['id'], simulationRunId: 'procedure-driver-test' as SimulationRunId, actorId: assistant.id,
        kind: 'world.procedure.run.transition', targetObjectIds: [], issuedAt: at, payload: { runId: run.runId, stepId: 'verify-reactor-trip', branchIndex: 0, ...h.evidence } },
      procedures: { runs: [run] }, readDocument: async input => documents[input.procedureId]!, observations: () => fakePort(tripped, []),
    })
    // The person ticks the step after the AI's reads, before its commit.
    await h.execute(operator, 'world.procedure.step.update', { runId: run.runId, stepId: 'verify-reactor-trip', assessment: 'unknown' })
    expect(h.run().driver?.kind).toBe('person')
    const store = { runs: [h.run()] }
    expect(() => prepared!({ simulationRunId: 'procedure-driver-test' as SimulationRunId, at, procedures: store, factory,
      objectIds: new Set([plantId]), actorKind: 'ai', actorLabel: 'Assistant' })).toThrow('A person drives E-0 on Unit 2')
    expect(h.run().stepStates.find(step => step.stepId === 'verify-reactor-trip')).toMatchObject({ assessment: 'unknown' })
    expect(h.run().stepStates.find(step => step.stepId === 'verify-reactor-trip')?.decision).toBeUndefined()
  })

  test('the branch verdict step.read reports is the one the commit rules apply', () => {
    const document = documents['E-0']!
    const [first, second, third] = document.steps
    const active = { status: 'active' as const, currentStepId: first!.id }
    expect(procedureBranchVerdict({ run: active, step: first!, branch: first!.branches[0]! })).toEqual({ aiMaySelect: true })
    expect(procedureBranchVerdict({ run: active, step: first!, branch: first!.branches[0]!, readableTagIds: new Set() }))
      .toEqual({ aiMaySelect: false, personOnlyReason: "None of step 1's tags can be read on this plant now: a person decides this step." })
    expect(procedureBranchVerdict({ run: active, step: first!, branch: first!.branches[1]! }).aiMaySelect).toBe(false)
    expect(procedureBranchVerdict({ run: { ...active, currentStepId: second!.id }, step: second!, branch: second!.branches[0]! }))
      .toEqual({ aiMaySelect: false, personOnlyReason: 'Step 2 cites no plant tag World can read: a person decides this step.' })
    expect(procedureBranchVerdict({ run: { status: 'transferred', currentStepId: third!.id }, step: third!, branch: second!.branches[0]! }))
      .toEqual({ aiMaySelect: false, personOnlyReason: 'The procedure run is transferred; no branch of it can be selected.' })
  })
})
