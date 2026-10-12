import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { gridCloseBranchCommandKind, gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridBlockHvdcCommandKind, gridDeblockHvdcCommandKind, gridSetHvdcSetpointCommandKind } from '../src/packs/electric-grid/commands/hvdc.ts'
import { gridShedLoadCommandKind } from '../src/packs/electric-grid/commands/load.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { nordicFrequencyAutomationRef, norwayGridModelRef, norwaySummerLowOperatingPointRef, norwayWinterPeakOperatingPointRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { gridElectricalPortsAt } from '../src/packs/electric-grid/electrical-ports.ts'
import { answerElectricGridQuery } from '../src/packs/electric-grid/queries/index.ts'
import type { CompiledGridDefinition, GridBusDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { drainGridSignals } from '../src/packs/electric-grid/runtime/grid-signals.ts'
import { gridAcState } from '../src/packs/electric-grid/runtime/ac-load-flow.ts'
import { applyGridCommand } from '../src/packs/electric-grid/runtime/apply-command.ts'
import { dispatchGridFromLiveIslands } from '../src/packs/electric-grid/runtime/dispatch.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { gridDcFlowsMw } from '../src/packs/electric-grid/runtime/power-flow.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { largestIslandInjectionSumMw, largestKclResidualMw } from './fixtures/grid-invariants.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { gridDefinitionForModel, handBuiltModel, syntheticHydroUnit, testLine, testLoad } from './fixtures/synthetic-grid.ts'

// The AC load flow of the running Grid: after every DC balance, each energised island is solved by
// the fast-decoupled load flow; buses, branches, ports and the projection carry its voltages,
// reactive power and losses, and an island that does not converge publishes no voltage at all.

const startsAtMs = Date.parse('2026-01-12T07:00:00.000Z')
const iso = (seconds: number): IsoTimestamp => new Date(startsAtMs + seconds * 1_000).toISOString() as IsoTimestamp

const norwayAt = (operatingPointRef: string): CompiledGridDefinition => compileGridDefinition(gridDefinitionSchema.parse({
  id: 'grid:norway', model: { ref: norwayGridModelRef }, operatingPoint: { ref: operatingPointRef }, automation: { ref: nordicFrequencyAutomationRef },
}))


/** Golden-list voltage band of the regenerated model (norway-grid-golden.json thresholds). */
const minimumBusVoltagePu = 0.9
const maximumBusVoltagePu = 1.1

const expectConvergedEverywhere = (grid: GridRuntimeInstance): void => {
  const energised = grid.islandPlan!.islands.filter(island => island.energized)
  expect(energised.length).toBeGreaterThan(0)
  for (const island of energised) expect(grid.acOutcomeByIsland.get(island.id)?.converged).toBe(true)
  expect(grid.projection.voltageModel).toBe('ac-fdlf')
  expect(grid.projection.notConvergedIslandCount).toBe(0)
  for (const bus of grid.busStates.values()) {
    if (!bus.energized) {
      expect(bus).toMatchObject({ voltagePu: 0, voltageModel: 'de-energised' })
      continue
    }
    expect(bus.voltageModel).toBe('ac-fdlf')
    expect(bus.voltagePu!).toBeGreaterThanOrEqual(minimumBusVoltagePu)
    expect(bus.voltagePu!).toBeLessThanOrEqual(maximumBusVoltagePu)
  }
}

describe('Grid AC load flow on every tick', () => {
  const cases = [
    { operatingPointRef: norwaySummerLowOperatingPointRef, definition: () => norwayAt(norwaySummerLowOperatingPointRef) },
    { operatingPointRef: norwayWinterPeakOperatingPointRef, definition: () => norwayAt(norwayWinterPeakOperatingPointRef) },
  ]
  for (const { operatingPointRef, definition } of cases) {
    test(`converges in every energised island at ${operatingPointRef} and publishes its voltages and losses`, () => {
      const grid = createGridRuntimeInstance({ definition: definition(), at: iso(0) })
      advanceGrid(grid, 0, iso(0))
      expectConvergedEverywhere(grid)
      for (let tick = 1; tick <= 30; tick += 1) {
        advanceGrid(grid, 2, iso(tick * 2))
        expectConvergedEverywhere(grid)
      }
      const ac = gridAcState(grid)!
      const model = grid.definition.model
      let branchLossesMw = 0
      model.branches.forEach((branch, index) => {
        const state = grid.branches.get(branch.id)!
        if (state.state !== 'closed' || !grid.busStates.get(branch.fromBusId)!.energized) {
          expect(state.lossesMw).toBe(0)
          return
        }
        // Flow and loading are the AC ones: the from-end power and the larger end apparent power.
        expect(state.flowModel).toBe('ac')
        expect(state.flowMw).toBe(ac.branchFromActiveMw[index]!)
        const apparentMva = Math.max(Math.hypot(ac.branchFromActiveMw[index]!, ac.branchFromReactiveMvar[index]!), Math.hypot(ac.branchToActiveMw[index]!, ac.branchToReactiveMvar[index]!))
        expect(state.apparentPowerMva).toBe(apparentMva)
        expect(state.loadingPercent).toBe(apparentMva / (branch.ratingMw * state.availability) * 100)
        // Losses are the AC power entering both ends; voltages and reactive power are the AC ones.
        expect(Math.abs(state.lossesMw - (ac.branchFromActiveMw[index]! + ac.branchToActiveMw[index]!))).toBeLessThan(1e-9 * Math.max(1, state.lossesMw) + 1e-9)
        expect(state.lossesMw).toBeGreaterThanOrEqual(0)
        expect(state.voltageFromPu).toBe(grid.busStates.get(branch.fromBusId)!.voltagePu)
        expect(state.reactiveFromMvar).toBe(ac.branchFromReactiveMvar[index]!)
        branchLossesMw += state.lossesMw
      })
      expect(branchLossesMw).toBeGreaterThan(0)
      const hvdcLossesMw = [...grid.hvdcLinks.values()].reduce((sum, link) => sum + link.lossesMw, 0)
      expect(grid.projection.lossesMw).toBeCloseTo(branchLossesMw + hvdcLossesMw, 6)
      const { voltageMinPu, voltageMaxPu } = grid.projection
      expect(voltageMinPu!).toBeLessThan(1)
      expect(voltageMaxPu!).toBeGreaterThan(voltageMinPu!)
      const main = grid.projection.islands.find(island => island.energized)!
      expect(main).toMatchObject({ voltageModel: 'ac-fdlf', flowModel: 'ac' })
      console.info(`${operatingPointRef}: AC losses ${branchLossesMw.toFixed(1)} MW, V ${voltageMinPu}–${voltageMaxPu} pu after 60 s`)
    })
  }

  test('starts the winter peak without a trip: relays act on the AC flows from the Operating Point dispatch', () => {
    const grid = createGridRuntimeInstance({ definition: norwayAt(norwayWinterPeakOperatingPointRef), at: iso(0) })
    advanceGrid(grid, 0, iso(0))
    const signals = [...drainGridSignals(grid)]
    for (let tick = 1; tick <= 150; tick += 1) {
      advanceGrid(grid, 2, iso(tick * 2))
      signals.push(...drainGridSignals(grid))
    }
    expect(signals.filter(signal => signal.type === 'electric-grid.protection.tripped')).toEqual([])
    expect([...grid.branches.values()].filter(state => state.state === 'tripped')).toEqual([])
    expect([...grid.generators.values()].filter(state => state.state === 'tripped')).toEqual([])
    // The overloads the Operating Point starts with raise alarms at once; none is above its emergency rating.
    const active = [...grid.alarms.records.values()].filter(record => record.active)
    console.info(`winter start, 300 s: ${active.map(record => `${record.assetId} ${record.condition} ${record.value?.toFixed(1)} %`).join('; ')}`)
    expect(active.every(record => record.scope === 'branch' && (record.condition === 'loading-overload' || record.condition === 'loading-high'))).toBe(true)
  }, 120_000)

  test('reports the AC bus voltage at a connection point', () => {
    const scenario = scenarios.find(candidate => candidate.id === 'halden-power-complex')!
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:halden-four-unit', model: { ref: 'electric-grid.halden.four-unit' }, operatingPoint: { ref: norwaySummerLowOperatingPointRef }, automation: { ref: nordicFrequencyAutomationRef },
    }))
    const grid = createGridRuntimeInstance({ definition, at: iso(0), connections: scenario.connections })
    for (const connection of grid.externalConnections.values()) {
      connection.connected = true
      connection.systemActivePowerMw = 1_100
    }
    dispatchGridFromLiveIslands(grid, startsAtMs)
    advanceGrid(grid, 0, iso(0))
    advanceGrid(grid, 2, iso(2))
    const ports = gridElectricalPortsAt({ grid, at: iso(2) })
    expect(ports.length).toBe(4)
    for (const port of ports) {
      const point = definition.model.connectionPoints.find(candidate => candidate.id === port.id)!
      const bus = grid.busStates.get(point.busId)!
      expect(bus.voltageModel).toBe('ac-fdlf')
      expect(port.state).toMatchObject({ energized: true, voltagePu: bus.voltagePu })
      expect(port.state!.voltagePu).not.toBe(1)
    }
  })
})

// Two 300 kV buses over a 0.5 pu line: from 1 pu it delivers at most V²/(2X) = 100 MW to a load at
// unity power factor, so a 1,000 MW load cannot be served in AC although the DC balance closes
// (angle 5 rad). The generator bus is tied to a Nordic equivalent, so shedding the load leaves the
// island near 50 Hz.
const weakBus = (id: string, longitude: number, kind: GridBusDefinition['kind'] = 'substation'): GridBusDefinition => ({ id, label: id, kind, nominalKv: 300, location: [longitude, 60] })
const weakLinkModel = handBuiltModel({
  id: 'test-weak-link',
  title: 'Weak link',
  description: 'A load beyond the AC transfer limit of its only line',
  buses: [weakBus('bus:g', 8), weakBus('bus:l', 10), weakBus('bus:boundary-SE3@300', 7, 'boundary')],
  branches: [
    testLine({ id: 'branch:g-l', fromBusId: 'bus:g', toBusId: 'bus:l', nominalKv: 300, ratingMw: 5_000, emergencyRatingMw: 6_000, reactancePu: 0.5, resistancePu: 0.01 }),
    testLine({ id: 'branch:tie', fromBusId: 'bus:g', toBusId: 'bus:boundary-SE3@300', nominalKv: 300, ratingMw: 5_000, emergencyRatingMw: 6_000, reactancePu: 0.01, resistancePu: 0.001 }),
  ],
  generators: [syntheticHydroUnit({ id: 'generator:g', label: 'G', busId: 'bus:g', location: [8, 60], capacityMw: 1_400, rampRateMwPerMinute: 300 })],
  loads: [testLoad({ id: 'load:l', busId: 'bus:l', location: [10, 60], demandMw: 1_000 })],
  connectionPoints: [{ id: 'weak-bay', label: 'Weak bay', busId: 'bus:l', nominalKv: 300, maximumExportMw: 100, maximumImportMw: 100 }],
  externalSystems: [{
    id: 'external:nordic-remainder', label: 'Nordic remainder', area: 'nordic-remainder', synchronous: true, boundaryBusIds: ['bus:boundary-SE3@300'],
    areaParticipation: [{ area: 'SE3', share: 1, boundaryBusIds: ['bus:boundary-SE3@300'] }],
    inertiaGws: 171, loadMw: 43_100, fcrNMwPerHz: 3_720, fcrDUpMw: 899, fcrDDownMw: 868, afrrUpMw: 138, afrrDownMw: 138,
    provenance: { sources: ['test'], method: 'curated', confidence: 'low' },
  }],
})

describe('Grid AC load flow that does not converge', () => {
  test('publishes no voltage, marks the island and raises its alarm, and clears it once the island converges', () => {
    const grid = createGridRuntimeInstance({ definition: gridDefinitionForModel(weakLinkModel), at: iso(0) })
    advanceGrid(grid, 0, iso(0))
    advanceGrid(grid, 2, iso(2))
    const island = grid.islandPlan!.islands.find(candidate => candidate.energized)!
    const outcome = grid.acOutcomeByIsland.get(island.id)!
    expect(outcome.converged).toBe(false)
    for (const busId of ['bus:g', 'bus:l', 'bus:boundary-SE3@300']) {
      expect(grid.busStates.get(busId)).toMatchObject({ energized: true, voltagePu: null, voltageModel: 'not-converged', reactiveInjectionMvar: null })
    }
    expect(grid.branches.get('branch:g-l')).toMatchObject({ voltageFromPu: null, voltageToPu: null, reactiveFromMvar: null, reactiveToMvar: null })
    // Without an AC solution flows, loading and losses are the DC ones, labelled so.
    const line = grid.branches.get('branch:g-l')!
    expect(line).toMatchObject({ flowModel: 'dc', flowMw: gridDcFlowsMw(grid)[0]!, apparentPowerMva: Math.abs(gridDcFlowsMw(grid)[0]!) })
    expect(line.loadingPercent).toBe(line.apparentPowerMva / 5_000 * 100)
    expect(line.lossesMw).toBe(0.01 * line.flowMw * line.flowMw / 100)
    expect(grid.loads.get('load:l')!.voltagePu).toBeNull()
    expect(grid.projection).toMatchObject({ voltageModel: 'ac-fdlf', voltageMinPu: null, voltageMaxPu: null, notConvergedIslandCount: 1 })
    expect(grid.projection.islands[0]).toMatchObject({ voltageModel: 'not-converged', voltageMinPu: null, voltageMaxPu: null, flowModel: 'dc' })
    const alarm = [...grid.alarms.records.values()].find(record => record.active && record.id.includes('ac-non-convergence'))!
    // The message names the island after its anchor bus's station, as the alarm list does.
    expect(alarm.message).toStartWith(`Island at ${grid.definition.index.busById.get(grid.islandPlan!.plan.islands[island.planIndex]!.anchorBusId)!.label}: `)
    // The port stays energised with its frequency, and reports no voltage.
    expect(gridElectricalPortsAt({ grid, at: iso(2) })[0]!.state).toMatchObject({ energized: true, voltagePu: null, frequencyHz: grid.busStates.get('bus:l')!.frequencyHz })

    // Shedding the load to 40 MW, within the line's AC limit, lets the island converge again.
    const shed = applyGridCommand(grid, {
      id: 'command:ac-shed' as CommandId, simulationRunId: 'run:ac' as SimulationRunId, actorId: 'actor:ac-test' as ActorId,
      kind: gridShedLoadCommandKind, targetObjectIds: [grid.definition.gridId as ObjectId], payload: { assetId: 'load:l', targetDemandMw: 40, emergency: true }, issuedAt: iso(2),
    })
    expect(shed.ok).toBe(true)
    for (let second = 4; second <= 60; second += 2) advanceGrid(grid, 2, iso(second))
    expect(grid.acOutcomeByIsland.get(island.id)?.converged).toBe(true)
    expect(grid.busStates.get('bus:l')!.voltagePu!).toBeLessThan(1)
    expect(grid.alarms.records.get(alarm.id)!.active).toBe(false)
    expect(grid.projection.notConvergedIslandCount).toBe(0)
  })
})

describe('HVDC converters on an island whose AC load flow does not converge', () => {
  // The weak-link island with an HVDC link from its load bus to Germany: the island stays
  // energised while its AC voltage is unsolved, so the converters keep their set-points.
  const provenance = { sources: ['test:hand-built'], method: 'curated' as const, confidence: 'high' as const, note: 'Unsolved AC island with an HVDC link.' }
  const model = {
    ...weakLinkModel,
    id: 'test-weak-link-hvdc',
    buses: [...weakLinkModel.buses, weakBus('bus:boundary-DE', 11, 'boundary')],
    externalSystems: [...weakLinkModel.externalSystems, { id: 'external:DE', label: 'Germany', area: 'DE' as const, synchronous: false, boundaryBusIds: ['bus:boundary-DE'], provenance }],
    hvdcLinks: [{ id: 'hvdc:weak-de', label: 'Weak–Germany', fromBusId: 'bus:l', toBusId: 'bus:boundary-DE', ratingMw: 200, lossPercent: 2, rampMwPerMinute: 600, osmWayIds: [], provenance }],
  }
  const command = (grid: GridRuntimeInstance, kind: string, payload: Readonly<Record<string, unknown>>, seconds: number) => applyGridCommand(grid, {
    id: `command:${kind}-${seconds}` as CommandId, simulationRunId: 'run:ac-hvdc' as SimulationRunId, actorId: 'actor:ac-hvdc-test' as ActorId,
    kind, targetObjectIds: [grid.definition.gridId as ObjectId], payload, issuedAt: iso(seconds),
  })

  test('keep their set-points and raise no HVDC event; only the AC non-convergence alarm marks the island', () => {
    const grid = createGridRuntimeInstance({ definition: gridDefinitionForModel(model), at: iso(0) })
    advanceGrid(grid, 0, iso(0))
    expect(command(grid, gridSetHvdcSetpointCommandKind, { assetId: 'hvdc:weak-de', setpointMw: -60 }, 0).ok).toBe(true)
    const signals = [...drainGridSignals(grid)]
    for (let second = 2; second <= 30; second += 2) {
      advanceGrid(grid, 2, iso(second))
      signals.push(...drainGridSignals(grid))
      const island = grid.islandPlan!.islands.find(candidate => candidate.energized)!
      expect(grid.acOutcomeByIsland.get(island.id)!.converged).toBe(false)
      expect(grid.busStates.get('bus:l')).toMatchObject({ energized: true, voltagePu: null, voltageModel: 'not-converged' })
    }
    // Ramped to its set-point at 600 MW/min, still deblocked: a numerical non-convergence is no loss of AC voltage.
    expect(grid.hvdcLinks.get('hvdc:weak-de')).toMatchObject({ state: 'deblocked', setpointMw: -60, transferMw: -60, trip: null })
    expect(signals.filter(signal => signal.type.startsWith('electric-grid.hvdc.') || signal.type === 'electric-grid.protection.tripped')).toEqual([])
    const active = [...grid.alarms.records.values()].filter(record => record.active)
    expect(active.some(record => record.condition === 'ac-non-convergence')).toBe(true)
    expect(active.filter(record => record.scope === 'hvdc')).toEqual([])
    // Operators act on the converters as on any energised island: block, deblock and a new set-point apply.
    expect(command(grid, gridBlockHvdcCommandKind, { assetId: 'hvdc:weak-de' }, 30).ok).toBe(true)
    advanceGrid(grid, 0, iso(30))
    expect(command(grid, gridDeblockHvdcCommandKind, { assetId: 'hvdc:weak-de' }, 30).ok).toBe(true)
    expect(command(grid, gridSetHvdcSetpointCommandKind, { assetId: 'hvdc:weak-de', setpointMw: -40 }, 30).ok).toBe(true)
    advanceGrid(grid, 10, iso(40))
    expect(grid.projection.notConvergedIslandCount).toBe(1)
    expect(grid.hvdcLinks.get('hvdc:weak-de')).toMatchObject({ state: 'deblocked', transferMw: -40, trip: null })
    // The HVDC import still enters the DC balance, which closes exactly.
    expect(largestIslandInjectionSumMw(grid)).toBeLessThan(1e-6)
    const listed = answerElectricGridQuery({ request: { capabilityId: 'world.electric-grid.islands.list', input: { gridId: grid.definition.gridId } }, grids: new Map([[grid.definition.gridId, grid]]) }) as { islands: ReadonlyArray<{ hvdcImportMw: number; flowModel: string | null }> }
    expect(listed.islands[0]).toMatchObject({ hvdcImportMw: 40 * 0.98, flowModel: 'dc' })
  })
})

describe('Nordic boundary ties opening and closing in any order', () => {
  const command = (grid: GridRuntimeInstance, kind: string, assetId: string, seconds: number) => applyGridCommand(grid, {
    id: `command:${kind}-${assetId}-${seconds}` as CommandId, simulationRunId: 'run:ties' as SimulationRunId, actorId: 'actor:ties-test' as ActorId,
    kind, targetObjectIds: [grid.definition.gridId as ObjectId], payload: { assetId }, issuedAt: iso(seconds),
  })

  test('every later advance succeeds with KCL and island balance intact, and a stranded boundary bus stays held by the remainder', () => {
    const grid = createGridRuntimeInstance({ definition: norwayAt(norwaySummerLowOperatingPointRef), at: iso(0) })
    let seconds = 0
    const advance = (dtSeconds: number): void => {
      seconds += dtSeconds
      advanceGrid(grid, dtSeconds, iso(seconds))
      expect(largestKclResidualMw(grid)).toBeLessThan(1e-6)
      expect(largestIslandInjectionSumMw(grid)).toBeLessThan(1e-6)
      expect(grid.diagnostics.energyAudit.lastMaximumIslandMismatchMw).toBeLessThan(1e-6)
    }
    /** The published fields of a bus state (a view of getters). */
    const busState = (busId: string) => {
      const state = grid.busStates.get(busId)!
      return { islandId: state.islandId, energized: state.energized, voltagePu: state.voltagePu, voltageModel: state.voltageModel, frequencyHz: state.frequencyHz }
    }
    advance(0)
    const nordic = grid.definition.index.externalSystems.find(system => system.synchronous)!
    const ties = nordic.boundaryBusIds.flatMap(busId => grid.definition.index.branchesByBus.get(busId)!)
    expect(ties.length).toBe(8)
    const boundaryOf = (tieId: string): string => nordic.boundaryBusIds.find(busId => grid.definition.index.branchesByBus.get(busId)!.some(branch => branch.id === tieId))!
    const norwegianIsland = () => grid.islandPlan!.islands.find(island => island.energized)!
    for (const tie of ties) {
      expect(command(grid, gridOpenBranchCommandKind, tie.id, seconds).ok).toBe(true)
      advance(0)
      advance(2)
      const boundary = boundaryOf(tie.id)
      const stranded = grid.definition.index.branchesByBus.get(boundary)!.every(branch => grid.branches.get(branch.id)!.state !== 'closed')
      // Without a closed tie the boundary bus lies in no island; the remainder, coupled through the other ties, holds it at Norway's frequency.
      if (stranded) expect(busState(boundary)).toMatchObject({ islandId: null, energized: true, voltagePu: 1, voltageModel: 'external', frequencyHz: norwegianIsland().frequency!.frequencyHz })
      expect(grid.projection.islandCount).toBe(1)
      expect(command(grid, gridCloseBranchCommandKind, tie.id, seconds).ok).toBe(true)
      advance(0)
      advance(2)
      expect(busState(boundary)).toMatchObject({ islandId: norwegianIsland().id, energized: true })
    }
    for (const tie of ties) expect(command(grid, gridOpenBranchCommandKind, tie.id, seconds).ok).toBe(true)
    advance(0)
    for (let tick = 0; tick < 5; tick += 1) advance(2)
    // Separated from every Norwegian island, the remainder holds its boundary buses at nominal frequency.
    for (const busId of nordic.boundaryBusIds) expect(busState(busId)).toMatchObject({ islandId: null, energized: true, frequencyHz: 50 })
    expect(grid.projection.islandCount).toBe(1)
    // Closing checks the solved islands, so each close is followed by a zero-length solve, as the adapter does.
    // The first close waits until Norway's own reserves bring it within the synchro-check's 0.1 Hz of the remainder.
    const firstTie = ties[0]!
    let rejections = 0
    while (Math.abs(norwegianIsland().frequency!.frequencyHz! - 50) > 0.1) {
      const result = command(grid, gridCloseBranchCommandKind, firstTie.id, seconds)
      if (result.ok) throw new Error(`closing ${firstTie.id} at ${norwegianIsland().frequency!.frequencyHz} Hz passed the synchro-check`)
      expect(result.reason).toContain('external:nordic-remainder, separated from every Norwegian island and so at its nominal 50.000 Hz')
      rejections += 1
      if (seconds > 1_800) throw new Error('Norway did not return within 0.1 Hz of nominal in 30 minutes')
      for (let tick = 0; tick < 5; tick += 1) advance(2)
    }
    expect(rejections).toBeGreaterThan(0)
    for (const tie of ties) {
      expect(command(grid, gridCloseBranchCommandKind, tie.id, seconds).ok).toBe(true)
      advance(0)
    }
    for (let tick = 0; tick < 5; tick += 1) advance(2)
    for (const busId of nordic.boundaryBusIds) expect(busState(busId)).toMatchObject({ islandId: norwegianIsland().id, energized: true })
  }, 120_000)
})

describe('Halden switchyard after a total trip of its Plants', () => {
  test('isolating the de-loaded switchyard leaves it de-energised and every advance solves', () => {
    const scenario = scenarios.find(candidate => candidate.id === 'halden-power-complex')!
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:halden-four-unit', model: { ref: 'electric-grid.halden.four-unit' }, operatingPoint: { ref: norwaySummerLowOperatingPointRef }, automation: { ref: nordicFrequencyAutomationRef },
    }))
    const grid = createGridRuntimeInstance({ definition, at: iso(0), connections: scenario.connections })
    for (const connection of grid.externalConnections.values()) {
      connection.connected = true
      connection.systemPresent = true
      connection.systemActivePowerMw = 1_100
    }
    dispatchGridFromLiveIslands(grid, startsAtMs)
    let seconds = 0
    const advance = (dtSeconds: number): void => {
      seconds += dtSeconds
      advanceGrid(grid, dtSeconds, iso(seconds))
      expect(largestKclResidualMw(grid)).toBeLessThan(1e-6)
      expect(largestIslandInjectionSumMw(grid)).toBeLessThan(1e-6)
      for (const island of grid.islandPlan!.islands) if (island.energized) expect(grid.acOutcomeByIsland.has(island.id)).toBe(true)
    }
    advance(0)
    for (let tick = 0; tick < 5; tick += 1) advance(2)
    // All four Plants trip, then the six switchyard circuits open.
    for (const connection of grid.externalConnections.values()) {
      connection.connected = false
      connection.systemActivePowerMw = 0
    }
    advance(0)
    const switchyard = 'bus:curated-halden-pwr-switchyard@420'
    for (const branch of grid.definition.index.branchesByBus.get(switchyard)!) {
      const result = applyGridCommand(grid, {
        id: `command:isolate-${branch.id}` as CommandId, simulationRunId: 'run:ac' as SimulationRunId, actorId: 'actor:ac-test' as ActorId,
        kind: gridOpenBranchCommandKind, targetObjectIds: [grid.definition.gridId as ObjectId], payload: { assetId: branch.id }, issuedAt: iso(seconds),
      })
      expect(result.ok).toBe(true)
      advance(0)
    }
    for (let tick = 0; tick < 30; tick += 1) advance(2)
    expect(grid.busStates.get(switchyard)).toMatchObject({ energized: false, voltagePu: 0, voltageModel: 'de-energised' })
    expect(gridElectricalPortsAt({ grid, at: iso(seconds) }).every(port => port.state?.energized === false)).toBe(true)
  }, 120_000)
})
