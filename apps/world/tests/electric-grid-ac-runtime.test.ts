import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { gridShedLoadCommandKind } from '../src/packs/electric-grid/commands/load.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { nordicFrequencyAutomationRef, norwayGridModelRef, norwaySummerLowOperatingPointRef, norwayWinterPeakOperatingPointRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { gridElectricalPortsAt } from '../src/packs/electric-grid/electrical-ports.ts'
import type { CompiledGridDefinition, GridBusDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { gridAcState } from '../src/packs/electric-grid/runtime/ac-load-flow.ts'
import { applyGridCommand } from '../src/packs/electric-grid/runtime/apply-command.ts'
import { dispatchGridFromLiveIslands } from '../src/packs/electric-grid/runtime/dispatch.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { gridAutomationSchema } from '../src/packs/electric-grid/schemas/grid-automation.ts'
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

/**
 * Winter runs without branch relays: the runtime's DC flows load Flesaker – Mjøndalen to 118 % of
 * its rating where the AC flow is 106 % (golden powerFlowOverloads), above the thermal element's
 * steady trip level (115.8 %), so its thermal element trips it at the first sample; the flow it
 * shifts trips four more instantaneously (above 150 %) and splits off a 17-bus 132 kV pocket whose
 * units all reach their reactive limits: an AC failure the runtime reports (see the weak-link case
 * below), caused by the DC loading, not by the Operating Point's AC state.
 */
const withoutBranchProtection = (definition: CompiledGridDefinition): CompiledGridDefinition =>
  ({ ...definition, automation: gridAutomationSchema.parse({ ...definition.automation, branchProtection: { enabled: false } }) })

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
    { operatingPointRef: norwayWinterPeakOperatingPointRef, definition: () => withoutBranchProtection(norwayAt(norwayWinterPeakOperatingPointRef)) },
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
      expect(main).toMatchObject({ voltageModel: 'ac-fdlf' })
      console.info(`${operatingPointRef}: AC losses ${branchLossesMw.toFixed(1)} MW, V ${voltageMinPu}–${voltageMaxPu} pu after 60 s`)
    })
  }

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
const weakBus = (id: string, longitude: number): GridBusDefinition => ({ id, label: id, nominalKv: 300, location: [longitude, 60] })
const weakLinkModel = handBuiltModel({
  id: 'test-weak-link',
  title: 'Weak link',
  description: 'A load beyond the AC transfer limit of its only line',
  buses: [weakBus('bus:g', 8), weakBus('bus:l', 10), weakBus('bus:boundary-SE3@300', 7)],
  branches: [
    testLine({ id: 'branch:g-l', fromBusId: 'bus:g', toBusId: 'bus:l', nominalKv: 300, ratingMw: 5_000, emergencyRatingMw: 6_000, reactancePu: 0.5, resistancePu: 0.01 }),
    testLine({ id: 'branch:tie', fromBusId: 'bus:g', toBusId: 'bus:boundary-SE3@300', nominalKv: 300, ratingMw: 5_000, emergencyRatingMw: 6_000, reactancePu: 0.01, resistancePu: 0.001 }),
  ],
  generators: [syntheticHydroUnit({ id: 'generator:g', label: 'G', busId: 'bus:g', location: [8, 60], capacityMw: 1_400, rampRateMwPerMinute: 300 })],
  loads: [testLoad({ id: 'load:l', busId: 'bus:l', location: [10, 60], demandMw: 1_000 })],
  connectionPoints: [{ id: 'weak-bay', label: 'Weak bay', busId: 'bus:l', nominalKv: 300, maximumExportMw: 100, maximumImportMw: 100 }],
  externalSystems: [{
    id: 'external:nordic-remainder', label: 'Nordic remainder', area: 'nordic-remainder', synchronous: true, boundaryBusIds: ['bus:boundary-SE3@300'],
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
    // Without an AC solution the island carries the DC loss estimate r·P²/S_base on its branches.
    const line = grid.branches.get('branch:g-l')!
    expect(line.lossesMw).toBe(0.01 * line.flowMw * line.flowMw / 100)
    expect(grid.loads.get('load:l')!.voltagePu).toBeNull()
    expect(grid.projection).toMatchObject({ voltageModel: 'ac-fdlf', voltageMinPu: null, voltageMaxPu: null, notConvergedIslandCount: 1 })
    expect(grid.projection.islands[0]).toMatchObject({ voltageModel: 'not-converged', voltageMinPu: null, voltageMaxPu: null })
    const alarm = [...grid.alarms.records.values()].find(record => record.active && record.id.includes('ac-non-convergence'))!
    expect(alarm.message).toContain(island.id)
    // The port stays energised with its frequency, and reports no voltage.
    expect(gridElectricalPortsAt({ grid, at: iso(2) })[0]!.state).toMatchObject({ energized: true, voltagePu: null, frequencyHz: grid.busStates.get('bus:l')!.frequencyHz })

    // Shedding the load to 40 MW, within the line's AC limit, lets the island converge again.
    const shed = applyGridCommand(grid, {
      id: 'command:ac-shed' as CommandId, simulationRunId: 'run:ac' as SimulationRunId, actorId: 'actor:ac-test' as ActorId,
      kind: gridShedLoadCommandKind, targetObjectIds: [grid.definition.gridId as ObjectId], payload: { assetId: 'load:l', targetDemandMw: 40 }, issuedAt: iso(2),
    })
    expect(shed.ok).toBe(true)
    for (let second = 4; second <= 60; second += 2) advanceGrid(grid, 2, iso(second))
    expect(grid.acOutcomeByIsland.get(island.id)?.converged).toBe(true)
    expect(grid.busStates.get('bus:l')!.voltagePu!).toBeLessThan(1)
    expect(grid.alarms.records.get(alarm.id)!.active).toBe(false)
    expect(grid.projection.notConvergedIslandCount).toBe(0)
  })
})
