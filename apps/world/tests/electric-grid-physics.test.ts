import { describe, expect, test } from 'bun:test'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import type { ActorId, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { gridCloseBranchCommandKind, gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridRearmLfddStageCommandKind, gridRestoreLfddStageCommandKind } from '../src/packs/electric-grid/commands/frequency.ts'
import { gridSetHvdcSetpointCommandKind } from '../src/packs/electric-grid/commands/hvdc.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { nordicFrequencyAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition, gridAutomationPreset } from '../src/packs/electric-grid/definitions.ts'
import { gridElectricalPortsAt } from '../src/packs/electric-grid/electrical-ports.ts'
import type { CompiledGridDefinition, GridBranchDefinition, GridBusDefinition, GridGeneratorDefinition, GridLoadDefinition, GridModelDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { answerElectricGridQuery } from '../src/packs/electric-grid/queries/index.ts'
import { gridAlarmId } from '../src/packs/electric-grid/runtime/alarms.ts'
import { gridAcState } from '../src/packs/electric-grid/runtime/ac-load-flow.ts'
import { applyGridCommand } from '../src/packs/electric-grid/runtime/apply-command.ts'
import { dispatchGridFromLiveIslands } from '../src/packs/electric-grid/runtime/dispatch.ts'
import { generatorKineticEnergyMws } from '../src/packs/electric-grid/runtime/generator-dynamics.ts'
import { createGridRuntimeInstance, type GridIsland, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { gridAutomationSchema } from '../src/packs/electric-grid/schemas/grid-automation.ts'
import { balanceSeparablePart, separableBranch } from './fixtures/grid-split.ts'
import { gridDefinitionForModel, handBuiltModel, syntheticHydroUnit, testLine, testLoad } from './fixtures/synthetic-grid.ts'
import { gridDcFlowsMw } from '../src/packs/electric-grid/runtime/power-flow.ts'
import { largestIslandInjectionSumMw, largestKclResidualMw } from './fixtures/grid-invariants.ts'
import { scenarios } from './fixtures/scenarios.ts'

const start = Date.parse('2026-01-15T10:00:00.000Z')
const iso = (seconds: number): IsoTimestamp => new Date(start + seconds * 1_000).toISOString() as IsoTimestamp
const nordic = gridAutomationPreset(nordicFrequencyAutomationRef)

const definitionFor = (modelRef: string): CompiledGridDefinition => compileGridDefinition(gridDefinitionSchema.parse({
  id: modelRef === 'electric-grid.halden.four-unit' ? 'grid:halden-four-unit' : 'grid:norway',
  model: { ref: modelRef },
  operatingPoint: { ref: modelRef === 'electric-grid.halden.four-unit' ? 'electric-grid.norway.winter-weekday-peak' : norwayRuntimeTestOperatingPointRef },
  automation: { ref: 'electric-grid.frequency.nordic-2025' },
}))

/**
 * Halden's 4.4 GW at the winter Operating Point loads NO1 corridors far above their ratings in
 * today's v2 data (DQ1), so these frequency tests run the Nordic Automation without branch
 * protection: overloads raise alarms but trip nothing.
 */
const withoutBranchProtection = (definition: CompiledGridDefinition): CompiledGridDefinition =>
  ({ ...definition, automation: gridAutomationSchema.parse({ ...definition.automation, branchProtection: { enabled: false } }) })

/** A Grid with its own clock: `advance(dt)` moves it dt seconds on. */
const runningGrid = (definition: CompiledGridDefinition, connections?: Parameters<typeof createGridRuntimeInstance>[0]['connections']) => {
  const grid = createGridRuntimeInstance({ definition, at: iso(0), ...(connections === undefined ? {} : { connections }) })
  let seconds = 0
  advanceGrid(grid, 0, iso(0))
  return {
    grid,
    now: (): number => seconds,
    advance: (dtSeconds: number): void => {
      seconds += dtSeconds
      advanceGrid(grid, dtSeconds, iso(seconds))
    },
  }
}

const islandOfBus = (grid: GridRuntimeInstance, busId: string): GridIsland => {
  const islandId = grid.busStates.get(busId)!.islandId
  return grid.islandPlan!.islands.find(island => island.id === islandId)!
}

/** KCL at every bus from the solved injections and branch flows (MW). */
/**
 * The largest online generator of the bus's island that can run at `targetMw` (between its minimum
 * stable generation and its availability); its set-point is moved there and the others carry the
 * difference pro rata.
 */
const lossUnitWith = (grid: GridRuntimeInstance, busId: string, targetMw: number): GridGeneratorDefinition => {
  const islandId = grid.busStates.get(busId)!.islandId
  const units = grid.definition.model.generators.filter(generator => grid.busStates.get(generator.busId)!.islandId === islandId && grid.generators.get(generator.id)!.state === 'online')
  const lost = [...units]
    .filter(unit => unit.minimumStableMw <= targetMw && grid.generators.get(unit.id)!.availableMw >= targetMw)
    .sort((a, b) => b.capacityMw - a.capacityMw)[0]!
  const lostState = grid.generators.get(lost.id)!
  const shiftMw = lostState.targetMw - targetMw
  // Hydro units carry the difference: wind already runs at all it has.
  const others = units.filter(unit => unit !== lost && unit.kind === 'hydro')
  const otherTargetMw = others.reduce((sum, unit) => sum + grid.generators.get(unit.id)!.targetMw, 0)
  for (const unit of others) {
    const state = grid.generators.get(unit.id)!
    state.targetMw += shiftMw * state.targetMw / otherTargetMw
  }
  lostState.targetMw = targetMw
  return lost
}

const tripUnit = (grid: GridRuntimeInstance, unitId: string): void => {
  const state = grid.generators.get(unitId)!
  state.state = 'tripped'
  state.targetMw = 0
}

/** Frequency trace of the island holding `busId`: nadir from the sub-step extremes, sampled frequency per call. */
const traceIsland = (run: ReturnType<typeof runningGrid>, busId: string, dtSeconds: number, untilSeconds: number) => {
  let nadirHz = Number.POSITIVE_INFINITY
  let nadirAtSeconds = 0
  let maximumRocof = 0
  const samples = new Map<number, number>()
  const from = run.now()
  while (run.now() - from < untilSeconds - 1e-9) {
    run.advance(dtSeconds)
    const island = islandOfBus(run.grid, busId)
    if (island.minimumHz! < nadirHz) {
      nadirHz = island.minimumHz!
      nadirAtSeconds = run.now() - from
    }
    maximumRocof = Math.max(maximumRocof, Math.abs(island.rocofHzPerSecond!))
    samples.set(Math.round((run.now() - from) * 1_000) / 1_000, island.frequency!.frequencyHz!)
  }
  return { nadirHz, nadirAtSeconds, maximumRocof, samples }
}

const command = (kind: string, payload: unknown) => ({
  id: `command:${crypto.randomUUID()}` as CommandId,
  simulationRunId: 'run-physics' as SimulationRunId,
  actorId: 'actor:physics-test' as ActorId,
  kind,
  targetObjectIds: ['grid:test' as ObjectId],
  payload,
  issuedAt: iso(0),
})

describe('electric grid physics invariants', () => {
  test('closes KCL and every island balance below 1e-6 MW over 24 h', () => {
    // The balance closes by construction whatever the integration step, so this day-long run uses
    // the Nordic Automation with a 1 s sub-step (the schema's longest) and without branch relays,
    // whose every sample is a network solution (1,440 a day per second of sampling interval), to
    // stay within the test budget; electric-grid-protection.test.ts covers the relays.
    const automation = gridAutomationSchema.parse({ ...nordic, simulation: { subStepSeconds: 1, maximumCatchUpSeconds: 120 }, branchProtection: { enabled: false } })
    const run = runningGrid({ ...definitionFor('electric-grid.norway.transmission'), automation })
    let largestKcl = 0
    let largestIsland = 0
    let lowestHz = Number.POSITIVE_INFINITY
    let highestHz = 0
    for (let tick = 0; tick < 24 * 60; tick += 1) {
      run.advance(60)
      largestKcl = Math.max(largestKcl, largestKclResidualMw(run.grid))
      largestIsland = Math.max(largestIsland, largestIslandInjectionSumMw(run.grid), run.grid.diagnostics.energyAudit.lastMaximumIslandMismatchMw)
      lowestHz = Math.min(lowestHz, run.grid.projection.frequencyMinHz!)
      highestHz = Math.max(highestHz, run.grid.projection.frequencyMaxHz!)
    }
    const audit = run.grid.diagnostics.energyAudit
    console.info(`24 h Norway: max KCL residual ${largestKcl.toExponential(2)} MW, max island injection sum ${largestIsland.toExponential(2)} MW, `
      + `∫|mismatch| ${audit.cumulativeMismatchMwh.toExponential(2)} MWh, supplied ${audit.suppliedEnergyMwh.toFixed(0)} MWh = served ${audit.servedEnergyMwh.toFixed(0)} + losses ${audit.lossEnergyMwh.toFixed(0)} MWh, f ${lowestHz.toFixed(4)}–${highestHz.toFixed(4)} Hz`)
    expect(largestKcl).toBeLessThan(1e-6)
    expect(largestIsland).toBeLessThan(1e-6)
    expect(audit.cumulativeMismatchMwh).toBeLessThan(1e-6)
  }, 120_000)

  test('nadir and f(120 s) after a 267 MW trip do not depend on the adapter step', () => {
    const results = [0.5, 1, 2, 10, 60].map(dtSeconds => {
      const run = runningGrid(definitionFor('electric-grid.norway.transmission'))
      const busId = run.grid.definition.model.loads[0]!.busId
      const lost = lossUnitWith(run.grid, busId, 267)
      for (let step = 0; step < 30; step += 1) run.advance(10)
      tripUnit(run.grid, lost.id)
      run.advance(0)
      const trace = traceIsland(run, busId, dtSeconds, 120)
      return { dtSeconds, nadirHz: trace.nadirHz, at120Hz: trace.samples.get(120)! }
    })
    console.info(`dt-independence: ${results.map(result => `dt ${result.dtSeconds} s: nadir ${result.nadirHz.toFixed(5)} Hz, f(120 s) ${result.at120Hz.toFixed(5)} Hz`).join('; ')}`)
    const reference = results[0]!
    for (const result of results) {
      expect(Math.abs(result.nadirHz - reference.nadirHz)).toBeLessThan(0.005)
      expect(Math.abs(result.at120Hz - reference.at120Hz)).toBeLessThan(0.005)
    }
  }, 120_000)

  test('AGC and mFRR restore frequency after a 267 MW trip', () => {
    const run = runningGrid(definitionFor('electric-grid.norway.transmission'))
    const busId = run.grid.definition.model.loads[0]!.busId
    const lost = lossUnitWith(run.grid, busId, 267)
    for (let step = 0; step < 30; step += 1) run.advance(10)
    tripUnit(run.grid, lost.id)
    run.advance(0)
    const trace = traceIsland(run, busId, 2, 1_800)
    const restoredAt = [...trace.samples].find(([seconds]) => [...trace.samples].every(([later, hz]) => later < seconds || Math.abs(hz - 50) < 0.01))?.[0]
    console.info(`267 MW trip, Norway main island: nadir ${trace.nadirHz.toFixed(4)} Hz at ${trace.nadirAtSeconds.toFixed(1)} s, f(60 s) ${trace.samples.get(60)!.toFixed(4)} Hz, `
      + `|Δf| < 10 mHz from ${restoredAt} s, f(1800 s) ${trace.samples.get(1_800)!.toFixed(4)} Hz`)
    expect(trace.nadirHz).toBeGreaterThan(49.0)
    expect(restoredAt).toBeDefined()
    expect(restoredAt!).toBeLessThan(1_200)
    expect(run.grid.frequencyEvents.some(event => event.kind === 'lfdd-stage-operated')).toBe(false)
  }, 120_000)

  test('a dead island serves nothing and reports no voltage and no frequency', () => {
    const run = runningGrid(definitionFor('electric-grid.norway.transmission'))
    const { model, index } = run.grid.definition
    const load = [...model.loads].sort((a, b) => b.demandMw - a.demandMw)[0]!
    const loadsAtBus = model.loads.filter(candidate => candidate.busId === load.busId)
    const generatorsAtBus = index.generatorsByBus.get(load.busId) ?? []
    for (const generator of generatorsAtBus) tripUnit(run.grid, generator.id)
    for (const branch of index.branchesByBus.get(load.busId) ?? []) run.grid.branches.get(branch.id)!.state = 'open'
    run.advance(2)
    const bus = run.grid.busStates.get(load.busId)!
    const island = islandOfBus(run.grid, load.busId)
    expect(island.energized).toBe(false)
    expect(bus).toMatchObject({ energized: false, voltagePu: 0, frequencyHz: null, netInjectionMw: 0 })
    for (const candidate of loadsAtBus) {
      const state = run.grid.loads.get(candidate.id)!
      expect(state).toMatchObject({ servedMw: 0, serviceState: 'outage', frequencyHz: null, voltagePu: 0 })
      expect(state.demandMw).toBeGreaterThan(0)
    }
    const projected = run.grid.projection.islands.find(candidate => candidate.id === island.id)!
    expect(projected).toMatchObject({ energized: false, frequencyHz: null, rocofHzPerSecond: null, servedLoadMw: 0, alarmCount: 1 })
    expect(run.grid.projection.unservedLoadMw).toBeGreaterThanOrEqual(loadsAtBus.reduce((sum, candidate) => sum + run.grid.loads.get(candidate.id)!.demandMw, 0) - 1e-9)
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)
  })

  test('a split child inherits its parent frequency and frequency-control state exactly', () => {
    const run = runningGrid(definitionFor('electric-grid.norway.transmission'))
    const { model } = run.grid.definition
    const mainBus = model.loads[0]!.busId
    const separable = separableBranch(run.grid, mainBus)
    balanceSeparablePart(run.grid, separable, () => { for (let step = 0; step < 12; step += 1) run.advance(10) })
    const split: GridBranchDefinition = separable.branch
    const lost = lossUnitWith(run.grid, mainBus, 267)
    for (let step = 0; step < 30; step += 1) run.advance(10)
    tripUnit(run.grid, lost.id)
    run.advance(0)
    run.advance(20)
    const parent = islandOfBus(run.grid, mainBus)
    const parentHz = parent.frequency!.frequencyHz!
    expect(Math.abs(parentHz - 50)).toBeGreaterThan(0.01)
    const unitStatesBefore = structuredClone(parent.frequency!.units)
    run.grid.branches.get(split.id)!.state = 'open'
    run.advance(0)
    const children = [split.fromBusId, split.toBusId].map(busId => islandOfBus(run.grid, busId))
    expect(new Set(children.map(child => child.id)).size).toBe(2)
    expect(children.map(child => child.id)).toContain(parent.id)
    for (const child of children) {
      expect(child.energized).toBe(true)
      expect(child.frequency!.frequencyHz).toBe(parentHz)
      for (const [unitId, unit] of Object.entries(child.frequency!.units)) expect(unit).toEqual(unitStatesBefore[unitId]!)
    }
    console.info(`split: ${parent.id} at ${parentHz.toFixed(5)} Hz → ${children.map(child => `${child.id} ${child.frequency!.frequencyHz!.toFixed(5)} Hz (${Object.keys(child.frequency!.units).length} units)`).join(', ')}`)
    run.advance(30)
    const separated = [split.fromBusId, split.toBusId].map(busId => islandOfBus(run.grid, busId))
    expect(Math.abs(separated[0]!.frequency!.frequencyHz! - separated[1]!.frequency!.frequencyHz!)).toBeGreaterThan(1e-6)
    // Closing again merges the islands at the kinetic-energy-weighted frequency, under the larger island's id.
    const kineticEnergyMws = (island: GridIsland): number => Object.keys(island.frequency!.units).reduce((sum, unitId) => {
      const definition = run.grid.definition.index.assetById.get(unitId)!.definition as GridGeneratorDefinition
      return sum + (run.grid.generators.get(unitId)!.state === 'online' ? generatorKineticEnergyMws(definition) : 0)
    }, 0) + Object.keys(island.frequency!.externals).reduce((sum, systemId) =>
      sum + run.grid.definition.index.externalSystems.find(system => system.id === systemId)!.inertiaGws! * 1_000, 0)
    const weights = separated.map(kineticEnergyMws)
    const expectedHz = (separated[0]!.frequency!.frequencyHz! * weights[0]! + separated[1]!.frequency!.frequencyHz! * weights[1]!) / (weights[0]! + weights[1]!)
    run.grid.branches.get(split.id)!.state = 'closed'
    run.advance(0)
    const merged = islandOfBus(run.grid, split.fromBusId)
    expect(islandOfBus(run.grid, split.toBusId).id).toBe(merged.id)
    expect(merged.id).toBe(parent.id)
    expect(merged.frequency!.frequencyHz!).toBeCloseTo(expectedHz, 12)
    console.info(`merge: ${separated.map(island => `${island.id} ${island.frequency!.frequencyHz!.toFixed(5)} Hz`).join(' + ')} → ${merged.frequency!.frequencyHz!.toFixed(5)} Hz`)
  })

  test('LFDD stages latch, shed the lowest priority first, and reconnect only by command', () => {
    const bus = (id: string, index: number, kind: GridBusDefinition['kind'] = 'substation'): GridBusDefinition => ({ id, label: id, kind, nominalKv: 132, location: [10 + index * 0.1, 60] as const })
    const line = (id: string, fromBusId: string, toBusId: string): GridBranchDefinition =>
      testLine({ id, fromBusId, toBusId, nominalKv: 132, ratingMw: 600, reactancePu: 0.05, resistancePu: 0.005 })
    const hydro = (id: string, busId: string, capacityMw: number): GridGeneratorDefinition =>
      syntheticHydroUnit({ id, label: id, busId, location: [10, 60], capacityMw, rampRateMwPerMinute: capacityMw })
    const load = (id: string, demandMw: number, priority: GridLoadDefinition['priority']): GridLoadDefinition =>
      testLoad({ id, busId: 'bus:b', location: [10.1, 60], demandMw, priority })
    const model: GridModelDefinition = handBuiltModel({
      id: 'lfdd-island', title: 'LFDD test island', description: 'Two buses: hydro units on one, loads of three priorities on the other.',
      buses: [bus('bus:a', 0), bus('bus:b', 1)],
      branches: [line('a-b', 'bus:a', 'bus:b')],
      generators: [hydro('big', 'bus:a', 250), ...Array.from({ length: 8 }, (_, index) => hydro(`small-${index}`, 'bus:a', 50))],
      loads: [load('low', 100, 'low'), load('normal', 200, 'normal'), load('critical', 100, 'critical')],
    })
    const definition = { ...gridDefinitionForModel(model), gridId: 'grid:test' }
    const run = runningGrid(definition)
    run.advance(10)
    tripUnit(run.grid, 'big')
    run.advance(0)
    const trace = traceIsland(run, 'bus:b', 1, 600)
    const island = islandOfBus(run.grid, 'bus:b')
    const stages = island.frequency!.lfdd.stages
    const operated = Object.entries(stages).filter(([, stage]) => stage.status === 'operated').map(([stageId]) => stageId)
    const shed = (id: string) => run.grid.loads.get(id)!.lfddShedMw
    console.info(`LFDD: nadir ${trace.nadirHz.toFixed(3)} Hz, stages ${operated.join(', ')}, shed low ${shed('low').toFixed(1)} / normal ${shed('normal').toFixed(1)} / critical ${shed('critical').toFixed(1)} MW, f(600 s) ${island.frequency!.frequencyHz!.toFixed(4)} Hz`)
    expect(operated.length).toBeGreaterThan(0)
    expect(shed('low')).toBeGreaterThan(0)
    expect(shed('critical')).toBe(0)
    if (shed('normal') > 0) expect(shed('low')).toBeCloseTo(run.grid.loads.get('low')!.demandMw, 9)
    // Latched: frequency is back in the normal band yet the feeders stay open.
    expect(Math.abs(island.frequency!.frequencyHz! - 50)).toBeLessThan(0.1)
    expect(run.grid.loads.get('low')!.serviceState).toBe('shed')
    const transitions = run.grid.frequencyEvents.filter(event => event.kind === 'lfdd-stage-operated').length
    expect(transitions).toBe(operated.length)
    const shedBeforeMw = shed('low') + shed('normal')
    const stageShedMw = Object.entries(stages[operated[0]!]!.shedFractionByLoad).reduce((sum, [loadId, fraction]) => sum + fraction * run.grid.loads.get(loadId)!.demandMw, 0)
    // islands.list publishes each stage's latch, so an operator sees what to restore and re-arm.
    const listedStages = () => (answerElectricGridQuery({
      request: { capabilityId: 'world.electric-grid.islands.list', input: { gridId: 'grid:test' } },
      grids: new Map([[run.grid.definition.gridId, run.grid]]),
    }) as { readonly islands: ReadonlyArray<{ readonly id: string; readonly lfddStages: ReadonlyArray<{ readonly id: string; readonly status: string; readonly disconnectedMw: number }> }> })
      .islands.find(candidate => candidate.id === island.id)!.lfddStages
    expect(listedStages().map(stage => stage.id)).toEqual(definition.automation.lfdd.stages.map(stage => stage.id))
    expect(listedStages().filter(stage => stage.status === 'operated').map(stage => stage.id)).toEqual(operated)
    expect(listedStages().find(stage => stage.id === operated[0])!.disconnectedMw).toBeCloseTo(stageShedMw, 1)
    const restore = applyGridCommand(run.grid, command(gridRestoreLfddStageCommandKind, { islandId: island.id, stageId: operated[0] }))
    expect(restore).toEqual({ ok: true })
    expect(islandOfBus(run.grid, 'bus:b').frequency!.lfdd.stages[operated[0]!]!.status).toBe('disarmed')
    expect(listedStages().find(stage => stage.id === operated[0])).toMatchObject({ status: 'disarmed', disconnectedMw: 0 })
    run.advance(60)
    // The fixture's demand is flat, so restoring the stage reconnects exactly its share.
    expect(shed('low') + shed('normal')).toBeCloseTo(shedBeforeMw - stageShedMw, 6)
    expect(applyGridCommand(run.grid, command(gridRestoreLfddStageCommandKind, { islandId: island.id, stageId: operated[0] })).ok).toBe(false)
    expect(applyGridCommand(run.grid, command(gridRearmLfddStageCommandKind, { islandId: island.id, stageId: operated[0] }))).toEqual({ ok: true })
    expect(islandOfBus(run.grid, 'bus:b').frequency!.lfdd.stages[operated[0]!]!.status).toBe('armed')
    expect(listedStages().find(stage => stage.id === operated[0])!.status).toBe('armed')
  })
})

describe('HVDC links', () => {
  test('ramp to their set-point and move power between islands as an injection pair with converter losses', () => {
    const bus = (id: string, index: number, kind: GridBusDefinition['kind'] = 'substation'): GridBusDefinition => ({ id, label: id, kind, nominalKv: 420, location: [10 + index * 0.1, 60] as const })
    const hydro = (id: string, busId: string): GridGeneratorDefinition =>
      syntheticHydroUnit({ id, label: id, busId, location: [10, 60], capacityMw: 600, rampRateMwPerMinute: 600 })
    const load = (id: string, busId: string): GridLoadDefinition => testLoad({ id, busId, demandMw: 400 })
    const provenance = { sources: ['test:hand-built'], method: 'curated' as const, confidence: 'high' as const, note: 'Physics test model.' }
    const model: GridModelDefinition = handBuiltModel({
      id: 'hvdc-pair', title: 'HVDC pair', description: 'Two AC islands joined only by an HVDC link, and a link to an asynchronous neighbour.',
      buses: [bus('bus:west', 0), bus('bus:east', 1), bus('bus:boundary-DE', 2, 'boundary')],
      branches: [],
      generators: [hydro('west-unit', 'bus:west'), ...Array.from({ length: 3 }, (_, index) => hydro(`east-unit-${index}`, 'bus:east'))],
      loads: [load('west-load', 'bus:west'), load('east-load', 'bus:east')],
      externalSystems: [{ id: 'external:DE', label: 'Germany', area: 'DE', synchronous: false, boundaryBusIds: ['bus:boundary-DE'], provenance }],
      hvdcLinks: [
        { id: 'hvdc:west-east', label: 'West–East', fromBusId: 'bus:west', toBusId: 'bus:east', ratingMw: 700, lossPercent: 2, rampMwPerMinute: 60, osmWayIds: [], provenance },
        { id: 'hvdc:east-de', label: 'East–Germany', fromBusId: 'bus:east', toBusId: 'bus:boundary-DE', ratingMw: 1_400, lossPercent: 3, rampMwPerMinute: 600, osmWayIds: [], provenance },
      ],
    })
    const run = runningGrid({ ...gridDefinitionForModel(model), gridId: 'grid:test' })
    const setpoint = (assetId: string, setpointMw: number) => applyGridCommand(run.grid, command(gridSetHvdcSetpointCommandKind, { assetId, setpointMw }))
    expect(setpoint('hvdc:west-east', 800)).toMatchObject({ ok: false, reason: expect.stringContaining('outside its ±700 MW rating') })
    expect(setpoint('hvdc:west-east', -100)).toEqual({ ok: true })
    expect(setpoint('hvdc:east-de', 200)).toEqual({ ok: true })
    run.advance(60)
    expect(run.grid.hvdcLinks.get('hvdc:west-east')!.transferMw).toBeCloseTo(-60, 9)
    expect(run.grid.hvdcLinks.get('hvdc:east-de')!.transferMw).toBeCloseTo(200, 9)
    run.advance(60)
    const link = run.grid.hvdcLinks.get('hvdc:west-east')!
    expect(link.transferMw).toBeCloseTo(-100, 9)
    expect(link.lossesMw).toBeCloseTo(2, 9)
    // East sends 100 MW west (98 MW arrive) and 200 MW to Germany outside the AC model: an HVDC terminal in no island.
    expect(run.grid.busStates.has('bus:boundary-DE')).toBe(false)
    expect(run.grid.hvdcTerminals.get('bus:boundary-DE')!.deliveredMw).toBeCloseTo(200 * (1 - 0.03), 9)
    expect(run.grid.busStates.get('bus:west')!.netInjectionMw).toBeCloseTo(0, 6)
    const west = islandOfBus(run.grid, 'bus:west')
    const east = islandOfBus(run.grid, 'bus:east')
    expect(west.id).not.toBe(east.id)
    for (let step = 0; step < 60; step += 1) run.advance(10)
    const westOutputMw = run.grid.generators.get('west-unit')!.dispatchMw
    const eastOutputMw = [0, 1, 2].reduce((sum, index) => sum + run.grid.generators.get(`east-unit-${index}`)!.dispatchMw, 0)
    const servedMw = (id: string) => run.grid.loads.get(id)!.servedMw
    console.info(`HVDC: west unit ${westOutputMw.toFixed(2)} MW for ${servedMw('west-load').toFixed(2)} MW served; east units ${eastOutputMw.toFixed(2)} MW for ${servedMw('east-load').toFixed(2)} MW served + 100 MW west + 200 MW to DE`)
    // Each island balances its own units, its load and the converter injections at its bus.
    expect(westOutputMw + 98 - servedMw('west-load')).toBeCloseTo(0, 6)
    expect(eastOutputMw - 100 - 200 - servedMw('east-load')).toBeCloseTo(0, 6)
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)
    expect(run.grid.frequencyEvents.some(event => event.kind === 'lfdd-stage-operated')).toBe(false)
  })
})

describe('a synchronous external equivalent with several boundary buses', () => {
  test('keeps Norwegian components it ties together at one frequency and closes each through its own boundary buses', () => {
    // North and south are joined by one corridor; north is tied to SE2, south to SE3 by two ties.
    const bus = (id: string, index: number, kind: GridBusDefinition['kind'] = 'substation'): GridBusDefinition => ({ id, label: id, kind, nominalKv: 420, location: [10 + index * 0.5, 60 + index] as const })
    const line = (id: string, fromBusId: string, toBusId: string, ratingMw: number): GridBranchDefinition =>
      testLine({ id, fromBusId, toBusId, nominalKv: 420, ratingMw, reactancePu: 0.01, resistancePu: 0.001 })
    const provenance = { sources: ['test:hand-built'], method: 'curated' as const, confidence: 'high' as const, note: 'Physics test model.' }
    const model = handBuiltModel({
      id: 'two-boundaries', title: 'Two boundaries', description: 'North and south Norway, each tied to the Nordic equivalent.',
      buses: [bus('bus:north', 0), bus('bus:south', 1), bus('bus:boundary-SE2@420', 2, 'boundary'), bus('bus:boundary-SE3@420', 3, 'boundary')],
      branches: [
        line('corridor', 'bus:north', 'bus:south', 1_500),
        line('tie-se2', 'bus:north', 'bus:boundary-SE2@420', 1_000),
        line('tie-se3-a', 'bus:south', 'bus:boundary-SE3@420', 1_500),
        line('tie-se3-b', 'bus:south', 'bus:boundary-SE3@420', 500),
      ],
      generators: [
        ...Array.from({ length: 4 }, (_, index) => syntheticHydroUnit({ id: `north-${index}`, label: `North ${index}`, busId: 'bus:north', location: [10, 60], capacityMw: 400 })),
        ...Array.from({ length: 4 }, (_, index) => syntheticHydroUnit({ id: `south-${index}`, label: `South ${index}`, busId: 'bus:south', location: [10.5, 61], capacityMw: 400 })),
      ],
      loads: [testLoad({ id: 'north-load', busId: 'bus:north', demandMw: 600 }), testLoad({ id: 'south-load', busId: 'bus:south', demandMw: 1_000 })],
      externalSystems: [{
        id: 'external:nordic-remainder', label: 'Nordic remainder', area: 'nordic-remainder', synchronous: true,
        boundaryBusIds: ['bus:boundary-SE2@420', 'bus:boundary-SE3@420'],
        inertiaGws: 171, loadMw: 43_100, fcrNMwPerHz: 3_720, fcrDUpMw: 899, fcrDDownMw: 868, afrrUpMw: 138, afrrDownMw: 138,
        areaParticipation: [{ area: 'SE2', share: 0.2, boundaryBusIds: ['bus:boundary-SE2@420'] }, { area: 'SE3', share: 0.8, boundaryBusIds: ['bus:boundary-SE3@420'] }],
        provenance,
      }],
    })
    const run = runningGrid({ ...gridDefinitionForModel(model), gridId: 'grid:test' })
    run.advance(10)
    const islandIds = () => new Set(['bus:north', 'bus:south', 'bus:boundary-SE2@420', 'bus:boundary-SE3@420'].map(busId => run.grid.busStates.get(busId)!.islandId))
    expect(islandIds().size).toBe(1)

    expect(applyGridCommand(run.grid, command(gridOpenBranchCommandKind, { assetId: 'corridor' })).ok).toBe(true)
    run.advance(10)
    const plan = run.grid.topologyPlan!
    // Two AC components, one synchronous island at one frequency.
    expect(plan.components).toHaveLength(2)
    expect(plan.islands).toHaveLength(1)
    expect(islandIds().size).toBe(1)
    expect(run.grid.busStates.get('bus:north')!.frequencyHz).toBe(run.grid.busStates.get('bus:south')!.frequencyHz)
    // Each component closes its own balance: north through SE2, south through both SE3 ties.
    for (const component of plan.components) {
      const sumMw = component.buses.reduce((sum, busId) => sum + run.grid.busStates.get(busId)!.netInjectionMw, 0)
      expect(Math.abs(sumMw)).toBeLessThan(1e-6)
    }
    // The two SE3 ties share the south's closing flow (here by their equal reactance).
    expect(run.grid.branches.get('tie-se3-a')!.flowMw).toBeCloseTo(run.grid.branches.get('tie-se3-b')!.flowMw, 9)

    // More northern output leaves through SE2: the south does not see it in its tie flows.
    const se2Before = run.grid.branches.get('tie-se2')!.flowMw
    const se3Before = run.grid.branches.get('tie-se3-a')!.flowMw + run.grid.branches.get('tie-se3-b')!.flowMw
    for (let index = 0; index < 4; index += 1) run.grid.generators.get(`north-${index}`)!.targetMw += 25
    for (let step = 0; step < 60; step += 1) run.advance(10)
    const se2After = run.grid.branches.get('tie-se2')!.flowMw
    const se3After = run.grid.branches.get('tie-se3-a')!.flowMw + run.grid.branches.get('tie-se3-b')!.flowMw
    console.info(`two boundaries: SE2 export ${se2Before.toFixed(1)} → ${se2After.toFixed(1)} MW, SE3 export ${se3Before.toFixed(1)} → ${se3After.toFixed(1)} MW after +100 MW in the north`)
    expect(se2After - se2Before).toBeGreaterThan(50)
    expect(run.grid.busStates.get('bus:north')!.frequencyHz).toBe(run.grid.busStates.get('bus:south')!.frequencyHz)

    // The corridor closes again between two components of one island: the angle across it lies in the
    // external network, which the equivalent does not model, so synchro-check allows it.
    expect(applyGridCommand(run.grid, command(gridCloseBranchCommandKind, { assetId: 'corridor' }))).toEqual({ ok: true })
    run.advance(1)
    expect(run.grid.topologyPlan!.components).toHaveLength(1)
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)
  })
})

describe('reserves dimensioned per synchronous area', () => {
  const build = (withEquivalent: boolean): GridModelDefinition => {
    const bus = (id: string, index: number, kind: GridBusDefinition['kind'] = 'substation'): GridBusDefinition => ({ id, label: id, kind, nominalKv: 420, location: [10 + index * 0.5, 60] as const })
    const provenance = { sources: ['test:hand-built'], method: 'curated' as const, confidence: 'high' as const, note: 'Physics test model.' }
    return handBuiltModel({
      id: withEquivalent ? 'area-tied' : 'area-detached', title: 'Reserve area', description: 'Four hydro units and a load, with or without the Nordic equivalent.',
      buses: [bus('bus:a', 0), ...(withEquivalent ? [bus('bus:boundary-SE3@420', 1, 'boundary')] : [])],
      branches: withEquivalent ? [testLine({ id: 'tie', fromBusId: 'bus:a', toBusId: 'bus:boundary-SE3@420', nominalKv: 420, ratingMw: 1_500, reactancePu: 0.01, resistancePu: 0.001 })] : [],
      generators: Array.from({ length: 4 }, (_, index) => syntheticHydroUnit({ id: `unit-${index}`, label: `Unit ${index}`, busId: 'bus:a', location: [10, 60], capacityMw: 400 })),
      loads: [testLoad({ id: 'load', busId: 'bus:a', demandMw: 1_000 })],
      ...(withEquivalent ? { externalSystems: [{
        id: 'external:nordic-remainder', label: 'Nordic remainder', area: 'nordic-remainder' as const, synchronous: true, boundaryBusIds: ['bus:boundary-SE3@420'],
        areaParticipation: [{ area: 'SE3' as const, share: 1, boundaryBusIds: ['bus:boundary-SE3@420'] }],
        inertiaGws: 171, loadMw: 43_100, fcrNMwPerHz: 3_720, fcrDUpMw: 899, fcrDDownMw: 868, afrrUpMw: 138, afrrDownMw: 138, provenance,
      }] } : {}),
    })
  }
  const unitReserves = (run: ReturnType<typeof runningGrid>) => [0, 1, 2, 3].map(index => run.grid.generators.get(`unit-${index}`)!.reserves)

  test('a detached island holds its units\' own droop and headroom and no share of the Nordic volumes', () => {
    const run = runningGrid({ ...gridDefinitionForModel(build(false)), gridId: 'grid:test' })
    for (let step = 0; step < 3; step += 1) run.advance(10)
    // Droop 4 % on 400 MW: 200 MW/Hz, so FCR-N over 0.1 Hz is 20 MW and FCR-D up over 0.5 Hz another 80 MW.
    for (const reserves of unitReserves(run)) {
      expect(reserves.fcrNMw).toBeCloseTo(20, 9)
      expect(reserves.fcrDUpMw).toBeCloseTo(80, 9)
      const state = run.grid.generators.get('unit-0')!
      // aFRR takes the rest of the headroom above the set-point, mFRR nothing is left for.
      expect(reserves.afrrUpMw).toBeCloseTo(state.availableMw - state.targetMw - 20 - 80, 6)
    }
    expect([...run.grid.alarms.records.keys()].filter(id => id.includes('reserve-deficit'))).toEqual([])
  })

  test('an island in the Nordic synchronous area holds the area volume less the equivalent\'s share, and reports a real shortfall', () => {
    const run = runningGrid({ ...gridDefinitionForModel(build(true)), gridId: 'grid:test' })
    for (let step = 0; step < 3; step += 1) run.advance(10)
    // 600 MW Nordic FCR-N less the equivalent's 372 MW leaves 228 MW for four units that offer 20 MW each by droop.
    expect(unitReserves(run).reduce((sum, reserves) => sum + reserves.fcrNMw, 0)).toBeCloseTo(80, 9)
    const deficit = run.grid.alarms.records.get(gridAlarmId('island', run.grid.busStates.get('bus:a')!.islandId!, 'reserve-deficit-fcr-n'))
    expect(deficit).toMatchObject({ active: true })
    expect(deficit!.value).toBeCloseTo(600 - 372 - 80, 6)
  })
})

describe('synchro-check on closing a loop', () => {
  // Hydro units at A feed a load at B over two parallel lines: a short one (x 0.02 pu) and a long
  // one (x 0.25 pu). With only the long one closed, A–B differ by P·x in DC; the AC load flow,
  // where it converges, has them further apart as B's voltage sags.
  const loopRun = (loadMw: number) => {
    const bus = (id: string, index: number): GridBusDefinition => ({ id, label: id, kind: 'substation', nominalKv: 420, location: [10 + index * 0.5, 60] as const })
    const line = (id: string, reactancePu: number): GridBranchDefinition =>
      testLine({ id, fromBusId: 'bus:a', toBusId: 'bus:b', nominalKv: 420, ratingMw: 2_000, reactancePu, resistancePu: 0 })
    const model: GridModelDefinition = handBuiltModel({
      id: 'loop-closing', title: 'Loop-closing test', description: 'Hydro units at A feed a load at B over a short and a long line.',
      buses: [bus('bus:a', 0), bus('bus:b', 1)],
      branches: [line('short', 0.02), line('long', 0.25)],
      generators: Array.from({ length: 4 }, (_, index) => syntheticHydroUnit({
        id: `hydro-${index}`, label: `Hydro ${index}`, busId: 'bus:a', location: [10, 60], capacityMw: 150, rampRateMwPerMinute: 150,
      })),
      loads: [testLoad({ id: 'load', busId: 'bus:b', location: [10.5, 60], demandMw: loadMw })],
    })
    const run = runningGrid({ ...gridDefinitionForModel(model), gridId: 'grid:test' })
    run.advance(10)
    const send = (kind: string, assetId: string) => {
      const result = applyGridCommand(run.grid, command(kind, { assetId }))
      if (result.ok) run.advance(0)
      return result
    }
    const acDegrees = (): number => {
      const angles = gridAcState(run.grid)!.angleRad
      return Math.abs(angles[0]! - angles[1]!) * 180 / Math.PI
    }
    const dcDegrees = (): number => Math.abs(run.grid.busStates.get('bus:a')!.angleRad - run.grid.busStates.get('bus:b')!.angleRad) * 180 / Math.PI
    const evaluate = (actions: ReadonlyArray<Readonly<Record<string, unknown>>>) => answerElectricGridQuery({
      request: { capabilityId: 'world.electric-grid.remedial-actions.evaluate', input: { gridId: 'grid:test', contingencies: 'all-branches', actions } },
      grids: new Map([[run.grid.definition.gridId, run.grid]]),
    }) as Promise<{ readonly after: { readonly baseCase: { readonly overloadedCount: number } } }>
    const converged = (): boolean => run.grid.acOutcomeByIsland.get(run.grid.islandPlan!.islands[0]!.id)!.converged
    return { run, send, acDegrees, dcDegrees, evaluate, converged, limit: run.grid.definition.automation.synchroCheck.maximumAngleDifferenceDegrees }
  }

  test('reads the angle from the AC load flow where the island converged, and names that basis', async () => {
    // 130 MW over the long line: 20.3° apart in AC, above the 20° limit, though 18.6° in DC.
    const { send, acDegrees, dcDegrees, evaluate, converged, limit } = loopRun(130)
    expect(send(gridOpenBranchCommandKind, 'long').ok).toBe(true)
    const shortOnlyDegrees = acDegrees()
    expect(shortOnlyDegrees).toBeLessThan(limit)
    expect(send(gridCloseBranchCommandKind, 'long')).toEqual({ ok: true })

    expect(send(gridOpenBranchCommandKind, 'short').ok).toBe(true)
    expect(converged()).toBe(true)
    const longOnlyDegrees = acDegrees()
    expect(longOnlyDegrees).toBeGreaterThan(limit)
    expect(dcDegrees()).toBeLessThan(limit)
    const rejected = send(gridCloseBranchCommandKind, 'short')
    if (rejected.ok) throw new Error('closing the short line across a wide AC angle must be rejected')
    expect(rejected.reason).toContain(`voltage angles differ by Δθ ${longOnlyDegrees.toFixed(1)}° (AC load flow), above the ${limit}° loop-closing limit`)
    console.info(`loop closing (converged): ${shortOnlyDegrees.toFixed(2)}° across the long line closes; ${longOnlyDegrees.toFixed(2)}° AC (${dcDegrees().toFixed(2)}° DC) across the short line is rejected`)
    // A remedial evaluation of the close reads the same AC angle.
    await expect(evaluate([{ kind: 'close-branch', assetId: 'short' }]))
      .rejects.toThrow(`close-branch short would be rejected by synchro-check: both ends are in one energised island and their voltage angles differ by Δθ ${longOnlyDegrees.toFixed(1)}° (AC load flow), above the ${limit}° loop-closing limit`)
  })

  test('reads the angle from the DC solution where the island did not converge, and names that basis', async () => {
    // 300 MW is beyond the long line's AC transfer limit (about V²/2x = 200 MW): no AC solution, 43.7° in DC.
    const { run, send, dcDegrees, evaluate, converged, limit } = loopRun(300)
    expect(send(gridOpenBranchCommandKind, 'short').ok).toBe(true)
    expect(converged()).toBe(false)
    const longOnlyDegrees = dcDegrees()
    expect(longOnlyDegrees).toBeGreaterThan(limit)
    const rejected = send(gridCloseBranchCommandKind, 'short')
    if (rejected.ok) throw new Error('closing the short line across a wide DC angle must be rejected')
    expect(rejected.reason).toContain(`voltage angles differ by Δθ ${longOnlyDegrees.toFixed(1)}° (DC solution: the island's AC load flow did not converge), above the ${limit}° loop-closing limit`)
    expect(run.grid.branches.get('short')!.state).toBe('open')
    console.info(`loop closing (not converged): ${longOnlyDegrees.toFixed(2)}° DC across the short line is rejected`)
    await expect(evaluate([{ kind: 'close-branch', assetId: 'short' }]))
      .rejects.toThrow(`close-branch short would be rejected by synchro-check: both ends are in one energised island and their voltage angles differ by Δθ ${longOnlyDegrees.toFixed(1)}° (DC solution: the island's AC load flow did not converge), above the ${limit}° loop-closing limit`)
    // After shedding most of the load the angle, measured on the case's DC solution after that action, lets it close.
    const relieved = await evaluate([{ kind: 'shed-load', assetId: 'load', targetDemandMw: 50, emergency: true }, { kind: 'close-branch', assetId: 'short' }])
    expect(relieved.after.baseCase.overloadedCount).toBe(0)
    await expect(evaluate([{ kind: 'shed-load', assetId: 'load', targetDemandMw: 200, emergency: true }, { kind: 'close-branch', assetId: 'short' }]))
      .rejects.toThrow(/after the earlier actions and their voltage angles differ by Δθ 28\.6° \(DC solution of the case after the earlier actions\)/)
  })
})

describe('Halden coupling to the Nordic synchronous area', () => {
  const halden = () => {
    const scenario = scenarios.find(candidate => candidate.id === 'halden-power-complex')!
    const run = runningGrid(withoutBranchProtection(definitionFor('electric-grid.halden.four-unit')), scenario.connections)
    for (const connection of run.grid.externalConnections.values()) {
      connection.connected = true
      connection.systemActivePowerMw = 1_100
    }
    dispatchGridFromLiveIslands(run.grid, start)
    run.advance(0)
    return run
  }
  const switchyard = 'bus:curated-halden-pwr-switchyard@420'
  const se3Boundary = 'bus:boundary-SE3@420'
  /** Flow over each real 420 kV SE3 tie (Hasle–Borgvik, Halden–Skogssäter) towards Sweden (MW). */
  const se3TieExports = (grid: GridRuntimeInstance) => grid.definition.index.branchesByBus.get(se3Boundary)!.map(branch => ({
    label: branch.label,
    exportMw: (branch.toBusId === se3Boundary ? 1 : -1) * grid.branches.get(branch.id)!.flowMw,
    lossesMw: grid.branches.get(branch.id)!.lossesMw,
  }))
  /** Export towards each Nordic area over all its ties (MW), from the flows at the Norwegian ends. */
  const exportByArea = (grid: GridRuntimeInstance): ReadonlyMap<string, number> => {
    const nordic = grid.definition.index.externalSystems.find(system => system.synchronous)!
    return new Map(nordic.areaParticipation!.map(entry => [entry.area, entry.boundaryBusIds.reduce((sum, busId) =>
      sum + grid.definition.index.branchesByBus.get(busId)!.reduce((ties, branch) =>
        ties + (branch.toBusId === busId ? 1 : -1) * grid.branches.get(branch.id)!.flowMw, 0), 0)]))
  }
  const nordicImportMw = (grid: GridRuntimeInstance): number => grid.definition.index.externalSystems
    .filter(system => system.synchronous).reduce((sum, system) => sum + grid.externalSystems.get(system.id)!.importMw, 0)

  test('Halden at 4×1,100 MW holds 50.0 ± 0.1 Hz with the Nordic exchange at its schedule', () => {
    const run = halden()
    let lowestHz = Number.POSITIVE_INFINITY
    let highestHz = 0
    for (let step = 0; step < 360; step += 1) {
      run.advance(10)
      const island = islandOfBus(run.grid, switchyard)
      lowestHz = Math.min(lowestHz, island.minimumHz!)
      highestHz = Math.max(highestHz, island.maximumHz!)
    }
    const ties = se3TieExports(run.grid)
    const island = run.grid.projection.islands.find(candidate => candidate.id === islandOfBus(run.grid, switchyard).id)!
    console.info(`Halden 4×1,100 MW, 1 h: f ${lowestHz.toFixed(4)}–${highestHz.toFixed(4)} Hz; Nordic import ${nordicImportMw(run.grid).toFixed(1)} MW; `
      + `(schedule ${(-run.grid.definition.operatingPoint.externalExchanges.reduce((sum, exchange) => sum + exchange.scheduledExportMw, 0)).toFixed(1)} MW); SE3 ties ${ties.map(tie => `${tie.label} ${tie.exportMw.toFixed(1)} MW`).join(', ')}; island losses ${island.lossesMw} MW of ${island.servedLoadMw} MW served`)
    expect(lowestHz).toBeGreaterThan(49.9)
    expect(highestHz).toBeLessThan(50.1)
    // The units' surplus displaces Norwegian hydro: the exchange stays at its measured schedule within
    // the FCR-N and aFRR the Nordic equivalent activates for the area.
    const nordic = run.grid.definition.index.externalSystems.filter(system => system.synchronous)
    const responseMw = nordic.reduce((sum, system) => sum + system.fcrNMwPerHz! * 0.1 + system.afrrUpMw!, 0)
    const scheduledExportMw = run.grid.definition.operatingPoint.externalExchanges.reduce((sum, exchange) => sum + exchange.scheduledExportMw, 0)
    expect(Math.abs(nordicImportMw(run.grid) + scheduledExportMw)).toBeLessThan(responseMw)
    // The exchange enters the Nordic area by its area participation: almost all of it over the SE3
    // ties next to Halden, little over the northern ties and the Finnmark tie to Finland.
    const byArea = exportByArea(run.grid)
    const exportMw = [...byArea.values()].reduce((sum, value) => sum + value, 0)
    console.info(`Halden 4×1,100 MW, export by area: ${[...byArea].map(([area, value]) => `${area} ${value.toFixed(1)} MW`).join(', ')}`)
    expect(byArea.get('SE3')! / exportMw).toBeGreaterThan(0.8)
    expect(Math.abs(byArea.get('FI')!) / exportMw).toBeLessThan(0.03)
    // In the DC balance the ties carry exactly what leaves the boundary bus, less half their losses,
    // which it carries as load.
    const boundary = run.grid.busStates.get(se3Boundary)!
    const dcFlows = gridDcFlowsMw(run.grid)
    const dcTieExportMw = run.grid.definition.model.branches.reduce((sum, branch, index) =>
      branch.toBusId === se3Boundary ? sum + dcFlows[index]! : branch.fromBusId === se3Boundary ? sum - dcFlows[index]! : sum, 0)
    expect(dcTieExportMw).toBeCloseTo(-boundary.netInjectionMw, 6)
  }, 120_000)

  test('a Halden unit trip keeps the nadir at or above 49.0 Hz without load shedding', () => {
    const run = halden()
    for (let step = 0; step < 30; step += 1) run.advance(10)
    // The unit's generator breaker opens: the bay now draws station service (about 4 % of rating).
    const unit = [...run.grid.externalConnections.values()][0]!
    unit.systemActivePowerMw = -45
    run.advance(0)
    const trace = traceIsland(run, switchyard, 0.2, 600)
    const quasiSteadyHz = trace.samples.get(60)!
    console.info(`Halden unit trip (1,145 MW step): nadir ${trace.nadirHz.toFixed(4)} Hz at ${trace.nadirAtSeconds.toFixed(1)} s, max |RoCoF| ${trace.maximumRocof.toFixed(4)} Hz/s, `
      + `f(30 s) ${trace.samples.get(30)!.toFixed(4)}, f(60 s) ${quasiSteadyHz.toFixed(4)}, f(300 s) ${trace.samples.get(300)!.toFixed(4)}, f(600 s) ${trace.samples.get(600)!.toFixed(4)} Hz`)
    expect(trace.nadirHz).toBeGreaterThanOrEqual(49.0)
    expect(run.grid.frequencyEvents.some(event => event.kind === 'lfdd-stage-operated')).toBe(false)
    expect([...run.grid.loads.values()].every(load => load.lfddShedMw === 0)).toBe(true)
  }, 120_000)

  test('isolating the Halden switchyard de-energises all four ports within one tick', () => {
    const run = halden()
    run.advance(10)
    expect(gridElectricalPortsAt({ grid: run.grid, at: iso(run.now()) }).every(port => port.state?.energized === true)).toBe(true)
    for (const branch of run.grid.definition.index.branchesByBus.get(switchyard)!) run.grid.branches.get(branch.id)!.state = 'open'
    run.advance(2)
    const ports = gridElectricalPortsAt({ grid: run.grid, at: iso(run.now()) })
    expect(ports).toHaveLength(4)
    for (const port of ports) {
      expect(port.state).toMatchObject({ energized: false, voltagePu: 0, frequencyHz: null, activePowerMw: 0 })
    }
    expect(islandOfBus(run.grid, switchyard).energized).toBe(false)
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)
  })
})
