import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { gridRearmLfddStageCommandKind, gridRestoreLfddStageCommandKind } from '../src/packs/electric-grid/commands/frequency.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { nordicFrequencyAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition, gridAutomationPreset } from '../src/packs/electric-grid/definitions.ts'
import { gridElectricalPortsAt } from '../src/packs/electric-grid/electrical-ports.ts'
import type { CompiledGridDefinition, GridBranchDefinition, GridGeneratorDefinition, GridLoadDefinition, GridModelDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { applyGridCommand } from '../src/packs/electric-grid/runtime/apply-command.ts'
import { dispatchGridFromLiveIslands } from '../src/packs/electric-grid/runtime/dispatch.ts'
import { generatorKineticEnergyMws } from '../src/packs/electric-grid/runtime/generator-dynamics.ts'
import { setHvdcSetpoint } from '../src/packs/electric-grid/runtime/hvdc.ts'
import { createGridRuntimeInstance, type GridIsland, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { compiledGridNetworkFor } from '../src/packs/electric-grid/runtime/network/compiled-network.ts'
import { findGridIslands } from '../src/packs/electric-grid/runtime/network/islands.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { gridAutomationSchema } from '../src/packs/electric-grid/schemas/grid-automation.ts'
import { gridDefinitionForModel } from './fixtures/synthetic-grid.ts'
import { scenarios } from './fixtures/scenarios.ts'

const start = Date.parse('2026-01-15T10:00:00.000Z')
const iso = (seconds: number): IsoTimestamp => new Date(start + seconds * 1_000).toISOString() as IsoTimestamp
const nordic = gridAutomationPreset(nordicFrequencyAutomationRef)

const definitionFor = (modelRef: string): CompiledGridDefinition => compileGridDefinition(gridDefinitionSchema.parse({
  id: modelRef === 'electric-grid.halden.four-unit' ? 'grid:halden-four-unit' : 'grid:norway',
  model: { ref: modelRef },
  operatingPoint: { ref: 'electric-grid.norway.normal' },
  automation: { ref: 'electric-grid.frequency.nordic-2025' },
}))

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
const largestKclResidualMw = (grid: GridRuntimeInstance): number => {
  const residuals = new Map([...grid.busStates].map(([busId, state]) => [busId, state.netInjectionMw]))
  for (const branch of grid.definition.model.branches) {
    const flowMw = grid.branches.get(branch.id)!.flowMw
    residuals.set(branch.fromBusId, residuals.get(branch.fromBusId)! - flowMw)
    residuals.set(branch.toBusId, residuals.get(branch.toBusId)! + flowMw)
  }
  return Math.max(...[...residuals.values()].map(Math.abs))
}

/** Sum of all injections of each energised island (MW); balance closes by construction. */
const largestIslandInjectionSumMw = (grid: GridRuntimeInstance): number => {
  const sums = new Map<string, number>()
  for (const state of grid.busStates.values()) if (state.energized) sums.set(state.islandId, (sums.get(state.islandId) ?? 0) + state.netInjectionMw)
  return Math.max(0, ...[...sums.values()].map(Math.abs))
}

/** The largest generator of the bus's island; its set-point is moved to `targetMw` and the others carry the difference pro rata. */
const lossUnitWith = (grid: GridRuntimeInstance, busId: string, targetMw: number): GridGeneratorDefinition => {
  const islandId = grid.busStates.get(busId)!.islandId
  const units = grid.definition.model.generators.filter(generator => grid.busStates.get(generator.busId)!.islandId === islandId && grid.generators.get(generator.id)!.state === 'online')
  const lost = [...units].sort((a, b) => b.capacityMw - a.capacityMw)[0]!
  const lostState = grid.generators.get(lost.id)!
  const shiftMw = lostState.targetMw - targetMw
  const others = units.filter(unit => unit !== lost)
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
    // the Nordic Automation with a 1 s sub-step (the schema's longest) to stay within the test budget.
    const automation = gridAutomationSchema.parse({ ...nordic, simulation: { subStepSeconds: 1, maximumCatchUpSeconds: 120 } })
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
    const network = compiledGridNetworkFor(model)
    const mainBus = model.loads[0]!.busId
    const lost = lossUnitWith(run.grid, mainBus, 267)
    for (let step = 0; step < 30; step += 1) run.advance(10)
    tripUnit(run.grid, lost.id)
    run.advance(0)
    run.advance(20)
    const parent = islandOfBus(run.grid, mainBus)
    const parentHz = parent.frequency!.frequencyHz!
    expect(Math.abs(parentHz - 50)).toBeGreaterThan(0.01)
    // A branch whose opening leaves generation and load on both sides.
    const closed = Uint8Array.from(model.branches, branch => run.grid.branches.get(branch.id)!.state === 'closed' ? 1 : 0)
    const parentBuses = new Set(model.buses.filter(bus => run.grid.busStates.get(bus.id)!.islandId === parent.id).map(bus => bus.id))
    const sides = (branchIndex: number) => {
      const flags = closed.slice()
      flags[branchIndex] = 0
      const found = findGridIslands(network, flags)
      const parts = new Map<number, { generators: number; loads: number }>()
      for (const busId of parentBuses) {
        const part = found.islandOfBus[network.busIndexById.get(busId)!]!
        const entry = parts.get(part) ?? { generators: 0, loads: 0 }
        entry.generators += run.grid.definition.index.generatorsByBus.get(busId)?.filter(generator => run.grid.generators.get(generator.id)!.state === 'online').length ?? 0
        entry.loads += run.grid.definition.index.loadsByBus.get(busId)?.length ?? 0
        parts.set(part, entry)
      }
      return [...parts.values()]
    }
    const splitIndex = model.branches.findIndex((branch, index) => closed[index] === 1 && parentBuses.has(branch.fromBusId)
      && (() => {
        const parts = sides(index)
        return parts.length === 2 && parts.every(part => part.generators > 0 && part.loads > 0)
      })())
    expect(splitIndex).toBeGreaterThanOrEqual(0)
    const split: GridBranchDefinition = model.branches[splitIndex]!
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
    }, 0)
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
    const bus = (id: string, index: number) => ({ id, label: id, nominalKv: 132, location: [10 + index * 0.1, 60] as const })
    const line = (id: string, fromBusId: string, toBusId: string): GridBranchDefinition => ({
      id, label: id, kind: 'ac_line', fromBusId, toBusId, nominalKv: 132, ratingMw: 600, emergencyRatingMw: 600,
      reactancePu: 0.05, resistancePu: 0.005, weatherExposure: 'low',
    })
    const hydro = (id: string, busId: string, capacityMw: number): GridGeneratorDefinition => ({
      id, label: id, kind: 'hydro', busId, location: [10, 60], capacityMw, availableMw: capacityMw, reserveMw: 0, rampRateMwPerMinute: capacityMw, inertiaSeconds: 3,
    })
    const load = (id: string, demandMw: number, priority: GridLoadDefinition['priority']): GridLoadDefinition => ({
      id, label: id, kind: 'industry', busId: 'bus:b', location: [10.1, 60], demandMw, criticalMw: 0, reactiveDemandMvar: 0, priority, controllable: false,
    })
    const model: GridModelDefinition = {
      id: 'lfdd-island', title: 'LFDD test island', description: 'Two buses: hydro units on one, loads of three priorities on the other.', nominalFrequencyHz: 50,
      fidelity: { powerFlow: 'dc', voltage: 'not-modelled', frequency: 'island-swing', recommendedMaximumBusCount: 1000 },
      sourceBuild: { id: 'physics-test', generatedAt: '2026-10-10T00:00:00.000Z' }, sourceIds: [],
      buses: [bus('bus:a', 0), bus('bus:b', 1)],
      branches: [line('a-b', 'bus:a', 'bus:b')],
      generators: [hydro('big', 'bus:a', 250), ...Array.from({ length: 8 }, (_, index) => hydro(`small-${index}`, 'bus:a', 50))],
      loads: [load('low', 100, 'low'), load('normal', 200, 'normal'), load('critical', 100, 'critical')],
      storage: [], connectionPoints: [],
    }
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
    const restore = applyGridCommand(run.grid, command(gridRestoreLfddStageCommandKind, { islandId: island.id, stageId: operated[0] }))
    expect(restore).toEqual({ ok: true })
    expect(islandOfBus(run.grid, 'bus:b').frequency!.lfdd.stages[operated[0]!]!.status).toBe('disarmed')
    run.advance(60)
    // Demand moves with the daily profile meanwhile, so the comparison holds to 0.1 MW.
    expect(shed('low') + shed('normal')).toBeCloseTo(shedBeforeMw - stageShedMw, 1)
    expect(applyGridCommand(run.grid, command(gridRestoreLfddStageCommandKind, { islandId: island.id, stageId: operated[0] })).ok).toBe(false)
    expect(applyGridCommand(run.grid, command(gridRearmLfddStageCommandKind, { islandId: island.id, stageId: operated[0] }))).toEqual({ ok: true })
    expect(islandOfBus(run.grid, 'bus:b').frequency!.lfdd.stages[operated[0]!]!.status).toBe('armed')
  })
})

describe('HVDC links', () => {
  test('ramp to their set-point and move power between islands as an injection pair with converter losses', () => {
    const bus = (id: string, index: number) => ({ id, label: id, nominalKv: 420, location: [10 + index * 0.1, 60] as const })
    const hydro = (id: string, busId: string): GridGeneratorDefinition => ({
      id, label: id, kind: 'hydro', busId, location: [10, 60], capacityMw: 600, availableMw: 600, reserveMw: 0, rampRateMwPerMinute: 600, inertiaSeconds: 3,
    })
    const load = (id: string, busId: string): GridLoadDefinition => ({
      id, label: id, kind: 'industry', busId, location: [10, 60], demandMw: 400, criticalMw: 0, reactiveDemandMvar: 0, priority: 'normal', controllable: false,
    })
    const provenance = { sources: ['test:hand-built'], method: 'curated' as const, confidence: 'high' as const, note: 'Physics test model.' }
    const model: GridModelDefinition = {
      id: 'hvdc-pair', title: 'HVDC pair', description: 'Two AC islands joined only by an HVDC link, and a link to an asynchronous neighbour.', nominalFrequencyHz: 50,
      fidelity: { powerFlow: 'dc', voltage: 'not-modelled', frequency: 'island-swing', recommendedMaximumBusCount: 1000 },
      sourceBuild: { id: 'physics-test', generatedAt: '2026-10-10T00:00:00.000Z' }, sourceIds: [],
      buses: [bus('bus:west', 0), bus('bus:east', 1), bus('bus:boundary-DE', 2)],
      branches: [],
      generators: [hydro('west-unit', 'bus:west'), ...Array.from({ length: 3 }, (_, index) => hydro(`east-unit-${index}`, 'bus:east'))],
      loads: [load('west-load', 'bus:west'), load('east-load', 'bus:east')],
      storage: [], connectionPoints: [],
      externalSystems: [{ id: 'external:DE', label: 'Germany', area: 'DE', synchronous: false, boundaryBusIds: ['bus:boundary-DE'], provenance }],
      hvdcLinks: [
        { id: 'hvdc:west-east', label: 'West–East', fromBusId: 'bus:west', toBusId: 'bus:east', ratingMw: 700, lossPercent: 2, rampMwPerMinute: 60, osmWayIds: [], provenance },
        { id: 'hvdc:east-de', label: 'East–Germany', fromBusId: 'bus:east', toBusId: 'bus:boundary-DE', ratingMw: 1_400, lossPercent: 3, rampMwPerMinute: 600, osmWayIds: [], provenance },
      ],
    }
    const run = runningGrid({ ...gridDefinitionForModel(model), gridId: 'grid:test' })
    expect(() => setHvdcSetpoint(run.grid, 'hvdc:west-east', 800)).toThrow(/outside its ±700 MW rating/)
    setHvdcSetpoint(run.grid, 'hvdc:west-east', -100)
    setHvdcSetpoint(run.grid, 'hvdc:east-de', 200)
    run.advance(60)
    expect(run.grid.hvdcLinks.get('hvdc:west-east')!.transferMw).toBeCloseTo(-60, 9)
    expect(run.grid.hvdcLinks.get('hvdc:east-de')!.transferMw).toBeCloseTo(200, 9)
    run.advance(60)
    const link = run.grid.hvdcLinks.get('hvdc:west-east')!
    expect(link.transferMw).toBeCloseTo(-100, 9)
    expect(link.lossesMw).toBeCloseTo(2, 9)
    // East sends 100 MW west (98 MW arrive) and 200 MW to Germany outside the AC model.
    expect(run.grid.busStates.get('bus:boundary-DE')!.energized).toBe(false)
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

describe('Halden coupling to the Nordic synchronous area', () => {
  const halden = () => {
    const scenario = scenarios.find(candidate => candidate.id === 'halden-power-complex')!
    const run = runningGrid(definitionFor('electric-grid.halden.four-unit'), scenario.connections)
    for (const connection of run.grid.externalConnections.values()) {
      connection.connected = true
      connection.systemActivePowerMw = 1_100
    }
    dispatchGridFromLiveIslands(run.grid, start)
    run.advance(0)
    return run
  }
  const switchyard = 'bus:halden-pwr-switchyard-420'
  const tieIds = ['branch:tie-hasle-borgvik', 'branch:tie-halden-skogssater']

  test('Halden at 4×1,100 MW exports over the SE3 ties at 50.0 ± 0.1 Hz', () => {
    const run = halden()
    let lowestHz = Number.POSITIVE_INFINITY
    let highestHz = 0
    for (let step = 0; step < 360; step += 1) {
      run.advance(10)
      const island = islandOfBus(run.grid, switchyard)
      lowestHz = Math.min(lowestHz, island.minimumHz!)
      highestHz = Math.max(highestHz, island.maximumHz!)
    }
    const nordicRemainder = run.grid.externalSystems.get('external:nordic-remainder')!
    // Ties run from the Norwegian stations to the SE3 boundary: positive flow exports.
    const tieFlows = tieIds.map(id => run.grid.branches.get(id)!.flowMw)
    console.info(`Halden 4×1,100 MW, 1 h: f ${lowestHz.toFixed(4)}–${highestHz.toFixed(4)} Hz; export ${(-nordicRemainder.importMw).toFixed(1)} MW `
      + `(scheduled ${(-nordicRemainder.scheduledImportMw).toFixed(1)} MW) over Hasle–Borgvik ${tieFlows[0]!.toFixed(1)} MW and Halden–Skogssäter ${tieFlows[1]!.toFixed(1)} MW; `
      + `island losses ${run.grid.projection.islands.find(island => island.id === islandOfBus(run.grid, switchyard).id)!.lossesMw} MW`)
    expect(lowestHz).toBeGreaterThan(49.9)
    expect(highestHz).toBeLessThan(50.1)
    expect(nordicRemainder.importMw).toBeLessThan(0)
    expect(tieFlows.every(flow => flow > 0)).toBe(true)
    // The ties carry exactly what leaves the boundary bus: the equivalent's export plus its share of the tie losses.
    const boundary = run.grid.busStates.get('bus:boundary-SE3')!
    expect(tieFlows[0]! + tieFlows[1]!).toBeCloseTo(-boundary.netInjectionMw, 6)
    // The boundary bus carries half of each tie's losses as load, taken from the previous solve.
    const tieLossesMw = tieIds.reduce((sum, id) => sum + run.grid.branches.get(id)!.lossesMw, 0)
    expect(boundary.netInjectionMw).toBeCloseTo(nordicRemainder.importMw - tieLossesMw / 2, 2)
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
