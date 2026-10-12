import { describe, expect, test } from 'bun:test'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import type { ActorId, CommandId, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { gridAlarmLifecycleCommandKind } from '../src/packs/electric-grid/commands/alarm.ts'
import { gridDerateBranchCommandKind, gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridShedLoadCommandKind } from '../src/packs/electric-grid/commands/load.ts'
import { gridTripGeneratorCommandKind } from '../src/packs/electric-grid/commands/generator.ts'
import { gridTripHvdcCommandKind } from '../src/packs/electric-grid/commands/hvdc.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { norwayGridModelRef, norwayWinterPeakOperatingPointRef, nordicFrequencyAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { answerElectricGridQuery } from '../src/packs/electric-grid/queries/index.ts'
import { gridAlarmId, noteGridAcSolution, type GridAlarmRecord, type GridAlarmScope } from '../src/packs/electric-grid/runtime/alarms.ts'
import { createGridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { electricGridRuntimeId } from '../src/packs/electric-grid/sim/constants.ts'
import { projectGridObject } from '../src/packs/electric-grid/sim/object-projection.ts'
import { parseElectricGridRuntimeState, restoredGridRuntimeStateFor, runtimeStateForElectricGrids } from '../src/packs/electric-grid/sim/runtime-state.ts'
import type { PackRuntimeEvent } from '../src/simulation/protocol.ts'
import { corridorDefinition, isoAt, steppedGrid, type SteppedGrid } from './fixtures/grid-corridor.ts'
import { scenarios } from './fixtures/scenarios.ts'

const alarmTransitions = (run: SteppedGrid) => run.signals
  .filter(signal => signal.type === 'electric-grid.alarm.raised' || signal.type === 'electric-grid.alarm.cleared')
  .map(signal => ({ alarmId: signal.payload.alarmId as string, type: signal.type, elapsedSeconds: signal.payload.elapsedSeconds as number }))

const lifecycle = (run: SteppedGrid, payload: Readonly<Record<string, unknown>>) => run.command(gridAlarmLifecycleCommandKind, payload)

const norway = compileGridDefinition(gridDefinitionSchema.parse({
  id: 'grid:norway', model: { ref: norwayGridModelRef }, operatingPoint: { ref: norwayRuntimeTestOperatingPointRef }, automation: { ref: nordicFrequencyAutomationRef },
}))

const loadingAlarm = (band: string) => gridAlarmId('branch', 'branch:g-a', `loading-${band}`)

/** The corridor with its direct line open: the A path runs above its emergency rating. */
const overloadedCorridor = (): SteppedGrid => {
  const run = steppedGrid(corridorDefinition())
  run.advanceTo(10_000)
  expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
  run.advanceTo(30_000)
  return run
}

describe('electric grid alarms', () => {
  test('raise with stable ids and priorities; acknowledgement never clears; the condition does', () => {
    const run = overloadedCorridor()
    const emergency = run.grid.alarms.records.get(loadingAlarm('above-emergency'))!
    // Alarms are evaluated at every network solution, so they raise at the switching instant.
    expect(emergency).toMatchObject({ active: true, acknowledged: false, priority: 1, scope: 'branch', assetId: 'branch:g-a', condition: 'loading-above-emergency', raisedAtElapsedMs: 10_000 })
    expect(run.grid.alarms.records.get(loadingAlarm('overload'))).toMatchObject({ active: true, priority: 2 })
    // The 90 % band waits for its 10 s raise delay.
    expect(run.grid.alarms.records.get(loadingAlarm('high'))).toMatchObject({ active: true, priority: 3, raisedAtElapsedMs: 20_000 })

    expect(lifecycle(run, { alarmIds: [emergency.id], action: 'acknowledge' }).ok).toBe(true)
    expect(lifecycle(run, { alarmIds: [emergency.id], action: 'acknowledge' }).reason).toContain('already acknowledged')
    run.advanceTo(60_000)
    expect(run.grid.alarms.records.get(emergency.id)).toMatchObject({ active: true, acknowledged: true })

    // Shedding most of the load relieves the corridor (closing the direct line would fail its synchro-check angle).
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:l', targetDemandMw: 400, emergency: true }).ok).toBe(true)
    run.advanceTo(66_000)
    expect(run.grid.alarms.records.get(emergency.id)!.active).toBe(true)
    run.advanceTo(72_000)
    // Cleared after the 10 s clear delay; cleared and acknowledged, it is forgotten one interval later.
    expect(run.grid.alarms.records.get(emergency.id)).toMatchObject({ active: false, clearedAtElapsedMs: 70_000 })
    run.advanceTo(82_000)
    expect(run.grid.alarms.records.has(emergency.id)).toBe(false)
    // An unacknowledged cleared alarm stays listed until it is acknowledged.
    expect(run.grid.alarms.records.get(loadingAlarm('overload'))).toMatchObject({ active: false, acknowledged: false })
  })

  test('no alarm changes state more than once in 10 s under a chattering condition', () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    for (let cycle = 0; cycle < 40; cycle += 1) {
      // The direct line alternates between 59 % and above its emergency rating every 2 s.
      expect(run.command(gridDerateBranchCommandKind, { assetId: 'branch:g-l', availability: cycle % 2 === 0 ? 0.48 : 1 }).ok).toBe(true)
      run.advanceTo(run.nowMs() + 2_000, [1_000])
    }
    run.advanceTo(run.nowMs() + 60_000)
    const transitions = alarmTransitions(run)
    const byAlarm = new Map<string, typeof transitions>()
    for (const transition of transitions) byAlarm.set(transition.alarmId, [...(byAlarm.get(transition.alarmId) ?? []), transition])
    let multiple = 0
    for (const list of byAlarm.values()) {
      if (list.length > 1) multiple += 1
      for (let index = 1; index < list.length; index += 1) expect(list[index]!.elapsedSeconds - list[index - 1]!.elapsedSeconds).toBeGreaterThanOrEqual(10)
    }
    expect(multiple).toBeGreaterThan(0)
  })

  test('a priority-1 under-frequency alarm of an island persists after acknowledgement and clears back in band', () => {
    const run = steppedGrid(norway)
    run.advanceTo(120_000)
    const islandId = run.grid.busStates.get(norway.model.loads[0]!.busId)!.islandId!
    const units = norway.model.generators
      .filter(generator => run.grid.busStates.get(generator.busId)!.islandId === islandId && run.grid.generators.get(generator.id)!.state === 'online')
      .sort((a, b) => run.grid.generators.get(b.id)!.dispatchMw - run.grid.generators.get(a.id)!.dispatchMw)
    // The largest units of the main island, together at least 3 GW (twice the Nordic reference
    // incident), take its frequency below 49 Hz against the Nordic equivalent's inertia and FCR-D.
    let lostMw = 0
    for (const unit of units) {
      if (lostMw >= 3_000) break
      lostMw += run.grid.generators.get(unit.id)!.dispatchMw
      expect(run.command(gridTripGeneratorCommandKind, { assetId: unit.id }).ok).toBe(true)
    }
    run.advanceTo(124_000)
    const alarmId = gridAlarmId('island', islandId, 'under-frequency-instantaneous-limit')
    expect(run.grid.alarms.records.get(alarmId)).toMatchObject({ active: true, priority: 1, scope: 'island', islandId, unit: 'Hz' })
    expect(lifecycle(run, { alarmIds: [alarmId], action: 'acknowledge' }).ok).toBe(true)
    run.advanceTo(130_000)
    expect(run.grid.alarms.records.get(alarmId)).toMatchObject({ active: true, acknowledged: true })
    // FCR, LFDD, aFRR and mFRR bring the island back; the acknowledged alarm then clears and is forgotten.
    run.advanceTo(1_800_000)
    const frequencyHz = run.grid.islandPlan!.islands.find(island => island.id === islandId)!.frequency!.frequencyHz!
    expect(Math.abs(frequencyHz - 50)).toBeLessThan(0.09)
    for (const band of ['instantaneous-limit', 'steady-state-limit', 'standard-range']) {
      const id = gridAlarmId('island', islandId, `under-frequency-${band}`)
      const types = alarmTransitions(run).filter(transition => transition.alarmId === id).map(transition => transition.type)
      console.info(`under-frequency ${band}: ${types.map(type => type.slice('electric-grid.alarm.'.length)).join(' → ')}`)
      // Raised first, cleared last, alternating: a recovery may dip back once across a band, never chatter within the hysteresis.
      expect(types.length % 2).toBe(0)
      types.forEach((type, index) => expect(type).toBe(index % 2 === 0 ? 'electric-grid.alarm.raised' : 'electric-grid.alarm.cleared'))
      expect(types.length).toBeLessThanOrEqual(4)
    }
    expect(run.grid.alarms.records.has(alarmId)).toBe(false)
    expect(run.grid.alarms.records.get(gridAlarmId('generator', units[0]!.id, 'tripped'))?.active).toBe(true)
  }, 60_000)

  test('shelving is time-limited, silences the shelved alarm and expires with an event', () => {
    const run = overloadedCorridor()
    const alarmId = loadingAlarm('overload')
    expect(lifecycle(run, { alarmIds: [alarmId], action: 'shelve' }).reason).toContain('shelveSeconds is required')
    expect(lifecycle(run, { alarmIds: [alarmId], action: 'acknowledge', shelveSeconds: 60 }).reason).toContain('not allowed')
    expect(lifecycle(run, { alarmIds: ['branch:g-a:no-such-condition'], action: 'acknowledge' }).reason).toContain('Grid alarm not found')
    expect(lifecycle(run, { alarmIds: [alarmId], action: 'unshelve' }).reason).toContain('not shelved')
    expect(lifecycle(run, { alarmIds: [alarmId], action: 'shelve', shelveSeconds: 60, reason: 'known overload' }).ok).toBe(true)
    expect(run.grid.alarms.records.get(alarmId)).toMatchObject({ acknowledged: true, shelvedUntilElapsedMs: 90_000 })
    expect(run.grid.projection.activeAlarmCount).toBe([...run.grid.alarms.records.values()].filter(record => record.active && record.shelvedUntil === null).length)
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:l', targetDemandMw: 400, emergency: true }).ok).toBe(true)
    run.advanceTo(88_000)
    // The clear happened while shelved: no cleared event, only the record changes.
    expect(run.grid.alarms.records.get(alarmId)!.active).toBe(false)
    expect(alarmTransitions(run).filter(transition => transition.alarmId === alarmId).map(transition => transition.type)).toEqual(['electric-grid.alarm.raised'])
    run.advanceTo(92_000)
    expect(run.signals.filter(signal => signal.payload.alarmId === alarmId).map(signal => signal.type))
      .toEqual(['electric-grid.alarm.raised', 'electric-grid.alarm.shelved', 'electric-grid.alarm.shelve-expired'])
    expect(run.grid.alarms.records.get(alarmId)?.shelvedUntil ?? null).toBe(null)
  })

  test('the alarm lifecycle survives a persistence round trip', () => {
    const run = overloadedCorridor()
    const emergency = loadingAlarm('above-emergency')
    const overload = loadingAlarm('overload')
    lifecycle(run, { alarmIds: [emergency], action: 'acknowledge' })
    lifecycle(run, { alarmIds: [overload], action: 'shelve', shelveSeconds: 600 })
    run.advanceTo(40_000)
    const stored = parseElectricGridRuntimeState(JSON.parse(JSON.stringify(runtimeStateForElectricGrids(new Map([[run.grid.definition.gridId, run.grid]])))))
    const restored = createGridRuntimeInstance({
      definition: run.grid.definition,
      at: isoAt(40_000),
      restored: restoredGridRuntimeStateFor(stored, run.grid.definition.gridId, run.grid.definition.definitionDigest)!,
    })
    expect([...restored.alarms.records.values()]).toEqual([...run.grid.alarms.records.values()])
    // Restoring re-raises nothing; the lifecycle continues as in the uninterrupted Grid.
    const lifecycleOf = (records: Iterable<GridAlarmRecord>) => [...records].map(record => ({
      id: record.id, active: record.active, acknowledged: record.acknowledged, shelvedUntil: record.shelvedUntil, raisedAt: record.raisedAt, clearedAt: record.clearedAt, occurrences: record.occurrences,
    }))
    advanceGrid(restored, 0, isoAt(40_000))
    expect(restored.signalQueue).toEqual([])
    for (let ms = 42_000; ms <= 120_000; ms += 2_000) advanceGrid(restored, 2, isoAt(ms))
    run.advanceTo(120_000)
    expect(lifecycleOf(restored.alarms.records.values())).toEqual(lifecycleOf(run.grid.alarms.records.values()))
    expect(restored.alarms.records.get(emergency)).toMatchObject({ active: true, acknowledged: true })
    expect(restored.alarms.records.get(overload)!.shelvedUntilElapsedMs).toBe(630_000)
  })

  test('projection counts, the Grid object alert and the AC non-convergence hook come from the records', () => {
    const run = overloadedCorridor()
    const active = [...run.grid.alarms.records.values()].filter(record => record.active)
    expect(run.grid.projection.activeAlarmCount).toBe(active.length)
    for (const island of run.grid.projection.islands) {
      expect(island.alarmCount).toBe(active.filter(record => record.scope === 'island' && record.assetId === island.id).length)
    }
    const object = { id: 'grid:test-corridor', packId: 'electric-grid', revision: 1, operational: { status: 'normal', priority: 'normal' }, alerts: [], timestamps: { createdAt: isoAt(0), updatedAt: isoAt(0) } }
    const packData = { type: 'electric-grid', schemaVersion: 1, model: { ref: 'test' }, operatingPoint: { ref: 'test' }, automation: { ref: 'test' }, electricalPorts: [], projection: run.grid.projection }
    const projected = projectGridObject({ object: { ...object, packData } as never, grid: run.grid, at: isoAt(30_000) })
    const oldest = active.reduce((first, record) => record.raisedAtElapsedMs < first.raisedAtElapsedMs ? record : first)
    expect(projected.alerts).toEqual([expect.objectContaining({ severity: 'critical', acknowledged: false, raisedAt: oldest.raisedAt })])
    lifecycle(run, { alarmIds: active.map(record => record.id), action: 'acknowledge' })
    expect(projectGridObject({ object: { ...object, packData } as never, grid: run.grid, at: isoAt(30_000) }).alerts[0]!.acknowledged).toBe(true)

    // Every network solution notes its AC load flow, replacing an earlier note (electric-grid-ac-runtime.test.ts
    // raises and clears the alarm on a real non-convergence); the overloaded corridor's converges.
    const islandId = run.grid.islandPlan!.islands.find(island => island.energized)!.id
    noteGridAcSolution(run.grid, islandId, { converged: false, reason: 'mismatch 3.2 MW after 20 iterations' })
    run.advanceTo(32_000)
    expect(run.grid.alarms.acNonConvergence.size).toBe(0)
    expect(run.grid.alarms.records.get(gridAlarmId('island', islandId, 'ac-non-convergence'))).toBeUndefined()
  })

  test('alarms.list filters by priority, state and island, most urgent first', () => {
    const run = overloadedCorridor()
    const grids = new Map([[run.grid.definition.gridId, run.grid]])
    const list = (input: Readonly<Record<string, unknown>>) => answerElectricGridQuery({
      request: { capabilityId: 'world.electric-grid.alarms.list', input: { gridId: run.grid.definition.gridId, ...input } },
      grids,
    }) as { counts: { active: number; activeByPriority: Record<string, number> }; total: number; alarms: ReadonlyArray<{ id: string; priority: number; active: boolean; shelved: boolean; islandId: string | null; assetLabel: string; mapAssetId: string | null }> }
    const all = list({})
    expect(all.total).toBe(run.grid.alarms.records.size)
    // Each alarm names its asset and the Grid Asset that locates it on the map.
    expect(all.alarms.find(alarm => alarm.id === loadingAlarm('overload'))).toMatchObject({ assetLabel: 'branch:g-a', mapAssetId: 'branch:g-a' })
    expect(all.alarms.map(alarm => alarm.priority)).toEqual([...all.alarms.map(alarm => alarm.priority)].sort())
    expect(list({ priorities: [1] }).alarms.every(alarm => alarm.priority === 1)).toBe(true)
    expect(all.counts.activeByPriority['1']).toBe(list({ priorities: [1], states: ['active'] }).total)
    lifecycle(run, { alarmIds: [loadingAlarm('overload')], action: 'shelve', shelveSeconds: 60 })
    expect(list({ states: ['shelved'] }).alarms.map(alarm => alarm.id)).toEqual([loadingAlarm('overload')])
    expect(list({ states: ['active'] }).alarms.some(alarm => alarm.shelved)).toBe(false)
    const islandId = run.grid.busStates.get('bus:a')!.islandId!
    expect(list({ islandId }).alarms.every(alarm => alarm.islandId === islandId)).toBe(true)
    expect(() => list({ islandId: 'island:none' })).toThrow('Grid island not found')
  })

  test('the adapter emits alarm transitions and protection trips as journalled interaction signals', async () => {
    const scenario = scenarios.find(candidate => candidate.id === 'test-grid')!
    const connection = await createLocalElectricGridPackRuntimeAdapter().connect({
      simulationRunId: 'run-grid-alarms' as SimulationRunId,
      scenario: { scenarioId: scenario.id, runtimeIds: [electricGridRuntimeId], connections: [], world: scenario.world, initialObjects: scenario.initialObjects, runtimeConfigByRuntimeId: {}, runtimeConfig: {} },
    })
    try {
      const emitted: PackRuntimeEvent[] = []
      const unsubscribe = connection.subscribe(emission => emitted.push(...emission.events))
      const send = (kind: string, payload: Readonly<Record<string, unknown>>) => connection.sendCommand({
        id: `command:${crypto.randomUUID()}` as CommandId,
        simulationRunId: 'run-grid-alarms' as SimulationRunId,
        actorId: 'actor:operator' as ActorId,
        kind,
        targetObjectIds: ['grid:norway' as ObjectId],
        payload,
        issuedAt: isoAt(0),
      }, {})
      const unitId = norway.model.generators[0]!.id
      expect((await send(gridTripGeneratorCommandKind, { assetId: unitId })).ok).toBe(true)
      const signals = emitted.flatMap(event => event.type === 'interaction.signal' ? [event.signal] : [])
      expect(signals.map(signal => signal.type)).toEqual(expect.arrayContaining(['electric-grid.protection.tripped', 'electric-grid.alarm.raised']))
      const raised = signals.find(signal => signal.type === 'electric-grid.alarm.raised' && (signal.payload as { alarmId: string }).alarmId === gridAlarmId('generator', unitId, 'tripped'))!
      expect(raised).toMatchObject({ simulationRunId: 'run-grid-alarms', severity: 'warning', source: { kind: 'simulation', id: electricGridRuntimeId } })
      expect(raised.id).toMatch(/^electric-grid:[0-9a-f]{40}$/)
      emitted.length = 0
      expect((await send(gridAlarmLifecycleCommandKind, { alarmIds: [gridAlarmId('generator', unitId, 'tripped')], action: 'acknowledge' })).ok).toBe(true)
      expect(emitted.flatMap(event => event.type === 'interaction.signal' ? [event.signal.type] : [])).toEqual(['electric-grid.alarm.acknowledged'])
      unsubscribe()
    } finally {
      await connection.close()
    }
  })
})

// <scope>:<asset key>:<condition>: the scope once, the asset id without its own scope prefix, and a
// condition of lowercase words joined by hyphens.
const alarmIdGrammar = /^(island|branch|generator|hvdc):(?!(?:island|branch|generator|hvdc):(?:island|branch|generator|hvdc):)(.+):([a-z0-9]+(?:-[a-z0-9]+)*)$/

const expectAlarmIdGrammar = (id: string, scope: GridAlarmScope, assetId: string, condition: string): void => {
  const match = alarmIdGrammar.exec(id)
  expect(match).not.toBeNull()
  expect(match![1]).toBe(scope)
  expect(match![3]).toBe(condition)
  expect(id.startsWith(`${scope}:${scope}:`)).toBe(false)
  // Grid Model asset ids carry their scope prefix, so the alarm id is the asset id and the condition.
  expect(id).toBe(assetId.startsWith(`${scope}:`) ? `${assetId}:${condition}` : `${scope}:${assetId}:${condition}`)
}

describe('electric grid alarm id grammar', () => {
  test('every alarm condition of the Nordic Automation names its scope once', () => {
    const automation = norway.automation
    const settings = automation.alarms
    const conditions: ReadonlyArray<readonly [GridAlarmScope, string, ReadonlyArray<string>]> = [
      ['island', `island:${norway.model.buses[0]!.id}`, [
        ...settings.islandFrequency.flatMap(band => [`under-frequency-${band.id}`, `over-frequency-${band.id}`]),
        'formed', 'de-energised', 'unserved-load', 'ac-non-convergence',
        ...['fcr-n', 'fcr-d-up', 'fcr-d-down', 'afrr-up', 'afrr-down', 'mfrr-up', 'mfrr-down'].map(product => `reserve-deficit-${product}`),
        ...automation.lfdd.stages.map(stage => `lfdd-${stage.id}-operated`),
      ]],
      ['branch', norway.model.branches[0]!.id, ['tripped', ...settings.branchLoading.map(band => `loading-${band.id}`)]],
      ['generator', norway.model.generators[0]!.id, ['tripped']],
      ['hvdc', 'hvdc:nordlink', ['tripped']],
    ]
    for (const [scope, assetId, names] of conditions) {
      for (const condition of names) expectAlarmIdGrammar(gridAlarmId(scope, assetId, condition), scope, assetId, condition)
    }
    expect(gridAlarmId('hvdc', 'hvdc:nordlink', 'tripped')).toBe('hvdc:nordlink:tripped')
    expect(gridAlarmId('island', 'island:bus:osm-way-1@420', 'de-energised')).toBe('island:bus:osm-way-1@420:de-energised')
    // Hand-built test assets without a scope prefix keep the whole id as their key.
    expect(gridAlarmId('branch', 'g-a', 'tripped')).toBe('branch:g-a:tripped')
  })

  test('raised records on the Norway Model follow the grammar in every scope', () => {
    const winter = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:norway', model: { ref: norwayGridModelRef }, operatingPoint: { ref: norwayWinterPeakOperatingPointRef }, automation: { ref: nordicFrequencyAutomationRef },
    }))
    const run = steppedGrid(winter)
    run.advanceTo(4_000, [1_000])
    const model = winter.model
    // A radial load bus without generation: opening its only branch de-energises an island with demand.
    const generatorBuses = new Set(model.generators.map(generator => generator.busId))
    const loadBuses = new Set(model.loads.map(load => load.busId))
    const radial = model.buses.find(bus => loadBuses.has(bus.id) && !generatorBuses.has(bus.id)
      && model.branches.filter(branch => branch.fromBusId === bus.id || branch.toBusId === bus.id).length === 1)!
    const radialBranch = model.branches.find(branch => branch.fromBusId === radial.id || branch.toBusId === radial.id)!
    expect(run.command(gridOpenBranchCommandKind, { assetId: radialBranch.id }).ok).toBe(true)
    const link = model.hvdcLinks.find(candidate => run.grid.hvdcLinks.get(candidate.id)!.state === 'deblocked')!
    expect(run.command(gridTripHvdcCommandKind, { assetId: link.id }).ok).toBe(true)
    const unit = model.generators.find(generator => run.grid.generators.get(generator.id)!.state === 'online')!
    expect(run.command(gridTripGeneratorCommandKind, { assetId: unit.id }).ok).toBe(true)
    run.advanceTo(30_000, [1_000])
    const records = [...run.grid.alarms.records.values()]
    expect(new Set(records.map(record => record.scope))).toEqual(new Set(['island', 'branch', 'generator', 'hvdc']))
    for (const record of records) {
      expect(record.id).toBe(gridAlarmId(record.scope, record.assetId, record.condition))
      expectAlarmIdGrammar(record.id, record.scope, record.assetId, record.condition)
    }
    expect(run.grid.alarms.records.get(`${link.id}:tripped`)).toMatchObject({ scope: 'hvdc', assetId: link.id, active: true })
    const deadIsland = run.grid.busStates.get(radial.id)!.islandId
    expect(run.grid.alarms.records.get(`${deadIsland}:de-energised`)).toMatchObject({ scope: 'island', assetId: deadIsland, active: true })
  }, 60_000)
})
