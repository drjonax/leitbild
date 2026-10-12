import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, SimulationRunEvent, SimulationRunId, EventId, IsoTimestamp, ObjectId, ProcedureDocument, OperationalObject } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import { createSimulationRunStateStore } from '../src/core/simulation-runs/state-store.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { prepareProcedureCommand, type ProcedureCommitContext } from '../src/features/procedures/run-state.ts'

// Commands come from a person unless a test names another actor kind.
const procedureCommandEvents = async (config: Parameters<typeof prepareProcedureCommand>[0] & Omit<ProcedureCommitContext, 'objectIds' | 'actorKind'> & { readonly actorKind?: ProcedureCommitContext['actorKind'] }) => {
  const commit = await prepareProcedureCommand(config)
  return commit?.({ ...config, actorKind: config.actorKind ?? 'person', objectIds: new Set(['halden-unit-a', 'halden-unit-b']) }) ?? null
}

const source = {
  sourceId: 'pwr-ops',
  label: 'PWR operations procedures',
  repository: 'leitbild-wikis/pwr-ops',
  ref: 'main',
  path: 'wiki/procedures',
  revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  fetchedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/tree/main/wiki/procedures',
}

const e0Fixture = `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Reactor Trip or Safety Injection
profile: nuclear-erg
category: diagnostic-eop
csfs-monitored: [subcriticality, core-cooling]
entry-triggers: [reactor-trip-signal]
---

# E-0 — Reactor Trip or Safety Injection

Entry procedure.

## Step 1 [id: verify-reactor-trip]
Check: reactor trip breakers «TRIP-BKR-A» OPEN
Caution: confirm subcriticality before any other action
- Verified → #verify-turbine-trip
  Because: rapid neutron flux decrease confirms core shutdown
- Not verified → [[FR-S.1]]
  Because: ATWS response required

## Step 2 [id: verify-turbine-trip]
Action: manually trip turbine if required
- Verified → END

## Tags

- id: TRIP-BKR-A
  description: reactor trip breaker A position
  sim-path: rps.trip_breaker.a.position
  units: enum[OPEN,CLOSED]
  equipment: reactor-protection-system
`

const parseFixture = (): ProcedureDocument =>
  parseProcedureMarkdown({
    source,
    sourcePath: 'wiki/procedures/E-0.md',
    sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/blob/main/wiki/procedures/E-0.md',
    rawMarkdown: e0Fixture,
  })

const unitAScope = {
  plantId: 'halden-unit-a',
  label: 'Halden Unit A',
} as const

const unitBScope = {
  plantId: 'halden-unit-b',
  label: 'Halden Unit B',
} as const

describe('procedure system', () => {
  test('owner applicability is checked against current target at serialized commit, not stale preparation', async () => {
    const command: CommandEnvelope = { id: 'command:applicability' as CommandEnvelope['id'], simulationRunId: 'test' as SimulationRunId,
      actorId: 'operator:test' as ActorId, kind: 'world.procedure.run.start', targetObjectIds: [], issuedAt: nowIso(),
      payload: { sourceId: source.sourceId, sourceRevision: source.revision, procedureId: 'E-0', scope: unitAScope } }
    // Test-only minimal target isolates the owner boundary from physical mechanics.
    const target = { id: 'halden-unit-a', packId: 'process-plant', packData: { model: 'expected' } } as unknown as OperationalObject
    const commit = await prepareProcedureCommand({ command, procedures: undefined, readDocument: async () => parseFixture(),
      assertTargetApplicable: (_document, object) => {
        if ((object.packData as { model: string }).model !== 'expected') throw new Error('owner rejected changed model')
      } })
    let seq = 0
    const context = { simulationRunId: command.simulationRunId, at: command.issuedAt, procedures: undefined, actorKind: 'person' as const,
      objectIds: new Set([target.id]), factory: { eventId: () => `event:${++seq}` as EventId, nextSeq: () => seq } }
    expect(() => commit!({ ...context, objects: new Map([[target.id, { ...target, packData: { model: 'changed' } }]]) })).toThrow('changed model')
    expect(seq).toBe(0)
    expect(() => commit!({ ...context, objects: new Map() })).toThrow('target unavailable')
    expect(commit!({ ...context, objects: new Map([[target.id, target]]) })).toHaveLength(1)
  })
  test('cross-procedure step entry selects exact pinned destination, preserves resumed history, rejects races and missing destinations atomically', async () => {
    let seq = 0
    const simulationRunId = 'step-destination-test' as SimulationRunId
    const at = nowIso()
    const store = createSimulationRunStateStore()
    store.hydrate({ objects: [], seq: 0 })
    const origin = parseProcedureMarkdown({ source, sourcePath: 'P.md', sourceUrl: '/wiki?path=P.md', rawMarkdown:
      e0Fixture.replace('[[FR-S.1]]', '[[N4#abnormal-coast]]') })
    const target = parseProcedureMarkdown({ source, sourcePath: 'N4.md', sourceUrl: '/wiki?path=N4.md', rawMarkdown:
      e0Fixture.replace('procedure-id: E-0', 'procedure-id: N4').replace('[id: verify-turbine-trip]', '[id: abnormal-coast]').replace('- Verified → END', '- Return → [[E-0]]') })
    const readDocument = async (input: { procedureId: string; sourceRevision: string }) => {
      expect(input.sourceRevision).toBe(source.revision)
      return input.procedureId === 'E-0' ? origin : target
    }
    const base = { id: 'command:test' as CommandEnvelope['id'], simulationRunId, actorId: 'actor:test' as ActorId,
      targetObjectIds: [], issuedAt: at }
    const factory = { eventId: () => `event:${++seq}` as EventId, nextSeq: () => seq }
    const run = (id: string) => store.snapshot().procedures!.runs.find(run => run.procedureId === id)!
    const execute = async (command: CommandEnvelope) => {
      const events = await procedureCommandEvents({ simulationRunId, at, command, factory, procedures: store.snapshot().procedures, readDocument })
      for (const event of events!) store.apply(event)
      return events!
    }
    await execute({ ...base, kind: 'world.procedure.run.start', payload: { sourceId: source.sourceId, sourceRevision: source.revision, procedureId: 'E-0', scope: unitAScope } })
    const transition = (): CommandEnvelope => ({ ...base, kind: 'world.procedure.run.transition', payload: { runId: run('E-0').runId, stepId: 'verify-reactor-trip', branchIndex: 1 } })
    const transferred = await execute(transition())
    expect(run('N4').currentStepId).toBe('abnormal-coast')
    expect(transferred.find(event => event.type === 'procedure.branch.selected')).toMatchObject({ target: 'N4', targetStepId: 'abnormal-coast' })
    await execute({ ...base, kind: 'world.procedure.step.update', payload: { runId: run('N4').runId, stepId: 'verify-reactor-trip', assessment: 'complete', currentStepId: 'verify-reactor-trip' } })
    await execute({ ...base, kind: 'world.procedure.run.transition', payload: { runId: run('N4').runId, stepId: 'abnormal-coast', branchIndex: 0 } })
    const prepare = await prepareProcedureCommand({ command: transition(), procedures: store.snapshot().procedures, readDocument })
    const oldHistory = run('N4').stepStates
    await execute(transition())
    expect(run('N4').status).toBe('active')
    expect(run('N4').currentStepId).toBe('abnormal-coast')
    expect(run('N4').stepStates.find(step => step.stepId === 'verify-reactor-trip')?.assessment).toBe('complete')
    expect(oldHistory.find(step => step.stepId === 'verify-reactor-trip')?.assessment).toBe('complete')
    // Independent copy/restore retains the selected branch and destination.
    const copied = createSimulationRunStateStore(); copied.hydrate(store.snapshot())
    expect(copied.snapshot().procedures).toEqual(store.snapshot().procedures)
    const context = { simulationRunId, at, factory, procedures: store.snapshot().procedures, actorKind: 'person' as const, objectIds: new Set(['halden-unit-a']) }
    expect(() => prepare!(context)).toThrow() // Source/destination changed after asynchronous preparation.
    const fresh = { ...store.snapshot().procedures!, runs: store.snapshot().procedures!.runs.map(run => run.procedureId === 'E-0' ? { ...run, status: 'active' as const } : run) }
    const before = store.snapshot().procedures
    await expect(prepareProcedureCommand({ command: transition(), procedures: fresh,
      readDocument: async input => input.procedureId === 'E-0' ? origin : { ...target, steps: target.steps.filter(step => step.id !== 'abnormal-coast') } })).rejects.toThrow('does not contain destination step')
    expect(store.snapshot().procedures).toEqual(before)
  })
  test('uninstalled engineering procedures cannot start, resume, or be entered by a live transition', async () => {
    let seq = 0
    const simulationRunId = 'uninstalled-procedure-test' as SimulationRunId
    const at = nowIso()
    const command: CommandEnvelope = { id: 'command:start' as CommandEnvelope['id'], simulationRunId,
      actorId: 'actor:operator' as ActorId, kind: 'world.procedure.run.start', targetObjectIds: [], issuedAt: at,
      payload: { sourceId: source.sourceId, sourceRevision: source.revision, procedureId: 'E-0', scope: unitAScope } }
    const common = { simulationRunId, at, command, procedures: undefined,
      factory: { eventId: () => `event:${++seq}` as EventId, nextSeq: () => seq } }
    const uninstalled = { ...parseFixture(), annotations: { 'runtime-bindings': 'uninstalled' } }
    await expect(procedureCommandEvents({ ...common, readDocument: async () => uninstalled })).rejects.toThrow('uninstalled runtime bindings')
    const events = await procedureCommandEvents({ ...common, readDocument: async () => parseFixture() })
    const store = createSimulationRunStateStore()
    store.hydrate({ objects: [], seq: 0 })
    for (const event of events!) store.apply(event)
    const run = store.snapshot().procedures!.runs[0]!
    const transition = { ...command, kind: 'world.procedure.run.transition' as const,
      payload: { runId: run.runId, stepId: 'verify-reactor-trip', branchIndex: 1 } }
    const before = store.snapshot().procedures
    await expect(procedureCommandEvents({ ...common, command: transition, procedures: before,
      readDocument: async input => input.procedureId === 'E-0' ? parseFixture() : { ...uninstalled, procedureId: input.procedureId } })).rejects.toThrow('uninstalled runtime bindings')
    expect(store.snapshot().procedures).toEqual(before)
    await expect(procedureCommandEvents({ ...common, command: transition, procedures: before,
      readDocument: async () => uninstalled })).rejects.toThrow('uninstalled runtime bindings')
  })
  test('rejects missing and unsupported procedure formats', () => {
    expect(() => parseProcedureMarkdown({
      source,
      sourcePath: 'wiki/procedures/old.md',
      sourceUrl: 'https://example.test/old.md',
      rawMarkdown: e0Fixture.replace('procedure-md: 0.7', 'procedure-md: 0.6'),
    })).toThrow('procedure-md: 0.7')
    expect(() => parseProcedureMarkdown({
      source,
      sourcePath: 'wiki/procedures/unversioned.md',
      sourceUrl: 'https://example.test/unversioned.md',
      rawMarkdown: e0Fixture.replace('procedure-md: 0.7\n', ''),
    })).toThrow('procedure-md: 0.7')
  })

  test('parses procmd steps, branches, tags, and CSF metadata', () => {
    const procedure = parseFixture()

    expect(procedure.procedureId).toBe('E-0')
    expect(procedure.csfsMonitored).toEqual(['subcriticality', 'core-cooling'])
    expect(procedure.steps).toHaveLength(2)
    expect(procedure.steps[0]?.id).toBe('verify-reactor-trip')
    expect(procedure.steps[0]?.blocks.map(block => block.kind)).toEqual(['check', 'caution'])
    expect(procedure.steps[0]?.branches).toEqual([
      {
        label: 'Verified',
        target: 'verify-turbine-trip',
        targetKind: 'step',
        because: 'rapid neutron flux decrease confirms core shutdown',
        tagIds: [],
        sourceLine: 19,
      },
      {
        label: 'Not verified',
        target: 'FR-S.1',
        targetKind: 'procedure',
        because: 'ATWS response required',
        tagIds: [],
        sourceLine: 21,
      },
    ])
    expect(procedure.tags).toEqual([{
      id: 'TRIP-BKR-A',
      description: 'reactor trip breaker A position',
      simPath: 'rps.trip_breaker.a.position',
      units: 'enum[OPEN,CLOSED]',
      equipment: 'reactor-protection-system',
      annotations: {},
    }])
  })

  test('procedure commands create durable run-state events and restore into snapshots', async () => {
    let seq = 0
    const simulationRunId = 'procedure-test' as SimulationRunId
    const at = nowIso()
    const command: CommandEnvelope = {
      id: 'command:procedure-start' as CommandEnvelope['id'],
      simulationRunId,
      actorId: 'actor:operator' as ActorId,
      kind: 'world.procedure.run.start',
      targetObjectIds: [],
      payload: {
        sourceId: 'pwr-ops',
        sourceRevision: source.revision,
        procedureId: 'E-0',
        scope: unitAScope,
      },
      issuedAt: at,
    }
    const started = await procedureCommandEvents({
      simulationRunId,
      at,
      command,
      procedures: undefined,
      factory: {
        eventId: () => `event:${++seq}` as EventId,
        nextSeq: () => seq,
      },
      readDocument: async () => parseFixture(),
    })
    if (!started) throw new Error('procedure command was not handled')
    const startEvent = started[0] as SimulationRunEvent
    const store = createSimulationRunStateStore()
    store.hydrate({ objects: [], seq: 0 })
    store.apply(startEvent)
    const runId = store.snapshot().procedures?.runs[0]?.runId
    if (!runId) throw new Error('procedure run was not projected')
    expect(store.snapshot().procedures?.runs[0]?.scope).toEqual(unitAScope)
    expect(store.snapshot().procedures?.runs[0]?.currentStepId).toBe('verify-reactor-trip')

    const update = await procedureCommandEvents({
      simulationRunId,
      at,
      command: {
        ...command,
        id: 'command:procedure-step' as CommandEnvelope['id'],
        kind: 'world.procedure.step.update',
        payload: {
          runId,
          stepId: 'verify-reactor-trip',
          assessment: 'complete',
          favorite: true,
          currentStepId: 'verify-turbine-trip',
        },
      },
      procedures: store.snapshot().procedures,
      factory: {
        eventId: () => `event:${++seq}` as EventId,
        nextSeq: () => seq,
      },
      readDocument: async () => parseFixture(),
    })
    if (!update) throw new Error('procedure update command was not handled')
    store.apply(update[0] as SimulationRunEvent)
    expect(store.snapshot().procedures?.runs[0]?.currentStepId).toBe('verify-turbine-trip')

    expect(store.snapshot().procedures?.runs[0]?.stepStates).toEqual([{
      stepId: 'verify-reactor-trip',
      assessment: 'complete',
      favorite: true,
      updatedAt: at,
      updatedBy: 'actor:operator' as ActorId,
    }])
  })

  test('a selected branch is kept on its step with its basis through the step update that follows, and a driver change projects onto the run', async () => {
    let seq = 0
    const simulationRunId = 'procedure-decision-test' as SimulationRunId
    const at = nowIso()
    const factory = { eventId: () => `event:${++seq}` as EventId, nextSeq: () => seq }
    const base: CommandEnvelope = {
      id: 'command:decision-start' as CommandEnvelope['id'], simulationRunId, actorId: 'actor:operator' as ActorId,
      kind: 'world.procedure.run.start', targetObjectIds: [], issuedAt: at,
      payload: { sourceId: 'pwr-ops', sourceRevision: source.revision, procedureId: 'E-0', scope: unitAScope },
    }
    const store = createSimulationRunStateStore()
    store.hydrate({ objects: [], seq: 0 })
    const started = await procedureCommandEvents({ simulationRunId, at, command: base, procedures: undefined, factory, readDocument: async () => parseFixture() })
    for (const event of started ?? []) store.apply(event as SimulationRunEvent)
    const runId = store.snapshot().procedures?.runs[0]?.runId
    if (!runId) throw new Error('procedure run was not projected')
    const transition = await procedureCommandEvents({
      simulationRunId, at, factory, readDocument: async () => parseFixture(), procedures: store.snapshot().procedures,
      command: { ...base, id: 'command:decision-branch' as CommandEnvelope['id'], kind: 'world.procedure.run.transition',
        payload: { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis: 'Both trip breakers read open; power falling.' } },
    })
    for (const event of transition ?? []) store.apply(event as SimulationRunEvent)
    const step = store.snapshot().procedures?.runs[0]?.stepStates.find(state => state.stepId === 'verify-reactor-trip')
    const branch = parseFixture().steps[0]!.branches[0]!
    expect(step?.decision).toMatchObject({ branchIndex: 0, label: branch.label, targetKind: branch.targetKind, target: branch.target, selectedBy: 'actor:operator' })
    expect(store.snapshot().procedures?.runs[0]?.currentStepId).toBe(branch.target)

    const driver = { kind: 'ai' as const, actorId: 'actor:ai:assistant' as ActorId, label: 'Assistant', since: at }
    store.apply({ id: `event:${++seq}` as EventId, simulationRunId, seq, at, provenance: { source: 'ai' },
      type: 'procedure.run.driver.changed', runId, driver, reason: 'claimed', changedAt: at, changedBy: driver.actorId } as SimulationRunEvent)
    expect(store.snapshot().procedures?.runs[0]?.driver).toEqual(driver)
    store.apply({ id: `event:${++seq}` as EventId, simulationRunId, seq, at, provenance: { source: 'operator' },
      type: 'procedure.run.driver.changed', runId, reason: 'person-acted', changedAt: at, changedBy: 'actor:operator' } as SimulationRunEvent)
    expect(store.snapshot().procedures?.runs[0]?.driver).toBeUndefined()
  })

  test('procedure runs are scoped per unit and reset clears only the selected unit procedure', async () => {
    let seq = 0
    const simulationRunId = 'procedure-test' as SimulationRunId
    const at = nowIso()
    const baseCommand = {
      simulationRunId,
      actorId: 'actor:operator' as ActorId,
      kind: 'world.procedure.run.start',
      targetObjectIds: [],
      issuedAt: at,
    } satisfies Omit<CommandEnvelope, 'id' | 'payload'>
    const store = createSimulationRunStateStore()
    store.hydrate({ objects: [], seq: 0 })
    const commandFactory = {
      eventId: () => `event:${++seq}` as EventId,
      nextSeq: () => seq,
    }

    for (const [id, scope] of [['command:start-a', unitAScope], ['command:start-b', unitBScope]] as const) {
      const events = await procedureCommandEvents({
        simulationRunId,
        at,
        command: {
          ...baseCommand,
          id: id as CommandEnvelope['id'],
          payload: {
            sourceId: 'pwr-ops',
            sourceRevision: source.revision,
            procedureId: 'E-0',
            scope,
          },
        },
        procedures: store.snapshot().procedures,
        factory: commandFactory,
        readDocument: async () => parseFixture(),
      })
      if (!events) throw new Error('procedure command was not handled')
      store.apply(events[0] as SimulationRunEvent)
    }

    expect(store.snapshot().procedures?.runs.map(run => run.scope.plantId).sort()).toEqual([
      'halden-unit-a',
      'halden-unit-b',
    ])

    let duplicate = 'accepted'
    try {
      await procedureCommandEvents({
        simulationRunId,
        at,
        command: {
          ...baseCommand,
          id: 'command:duplicate-a' as CommandEnvelope['id'],
          payload: {
            sourceId: 'pwr-ops',
            sourceRevision: source.revision,
            procedureId: 'E-0',
            scope: unitAScope,
          },
        },
        procedures: store.snapshot().procedures,
        factory: commandFactory,
        readDocument: async () => parseFixture(),
      })
    } catch (err) {
      duplicate = err instanceof Error ? err.message : String(err)
    }
    expect(duplicate).toContain('reset it before starting another run')

    const reset = await procedureCommandEvents({
      simulationRunId,
      at,
      command: {
        ...baseCommand,
        id: 'command:reset-a' as CommandEnvelope['id'],
        kind: 'world.procedure.run.reset',
        payload: { sourceId: 'pwr-ops', procedureId: 'E-0', scope: unitAScope },
      },
      procedures: store.snapshot().procedures,
      factory: commandFactory,
      readDocument: async () => parseFixture(),
    })
    if (!reset) throw new Error('procedure reset command was not handled')
    store.apply(reset[0] as SimulationRunEvent)

    expect(store.snapshot().procedures?.runs.map(run => run.scope.plantId)).toEqual(['halden-unit-b'])

    store.apply({
      id: 'event:unit-b-deleted' as EventId,
      simulationRunId,
      seq: ++seq,
      at,
      provenance: { source: 'operator' },
      type: 'object.deleted',
      objectId: unitBScope.plantId as ObjectId,
    })

    expect(store.snapshot().procedures?.runs).toEqual([])
  })
})
