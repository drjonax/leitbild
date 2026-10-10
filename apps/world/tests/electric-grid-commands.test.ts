import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import {
  gridClearDerateCommandKind,
  gridCloseBranchCommandKind,
  gridDerateBranchCommandKind,
  gridOpenBranchCommandKind,
} from '../src/packs/electric-grid/commands/branch.ts'
import {
  gridDispatchGeneratorCommandKind,
  gridResetGeneratorTripCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridStartGeneratorCommandKind,
  gridStopGeneratorCommandKind,
  gridTripGeneratorCommandKind,
} from '../src/packs/electric-grid/commands/generator.ts'
import {
  gridRestoreLoadCommandKind,
  gridSetEvChargingDemandCommandKind,
  gridShedLoadCommandKind,
} from '../src/packs/electric-grid/commands/load.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { norwayGridModelRef, norwayNormalOperatingPointRef, norwayStandardAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import type { GridGeneratorDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { applyGridCommand } from '../src/packs/electric-grid/runtime/apply-command.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { gridIslandIsEnergized } from '../src/packs/electric-grid/runtime/island-energization.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { topologyPlanForGrid } from '../src/packs/electric-grid/runtime/topology.ts'
import { generatorMinimumStableMw, generatorStartupSeconds } from '../src/packs/electric-grid/runtime/unit-commitment.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { electricGridRuntimeId } from '../src/packs/electric-grid/sim/constants.ts'
import {
  electricGridRuntimeStateSchema,
  restoredGridRuntimeStateFor,
  runtimeStateForElectricGrids,
} from '../src/packs/electric-grid/sim/runtime-state.ts'
import type { PackRuntimeEvent } from '../src/simulation/protocol.ts'
import { scenarios } from './fixtures/scenarios.ts'

const startsAtMs = Date.parse('2026-01-01T10:00:00.000Z')
const isoAt = (seconds: number): IsoTimestamp => new Date(startsAtMs + seconds * 1_000).toISOString() as IsoTimestamp

const definition = compileGridDefinition(gridDefinitionSchema.parse({
  id: 'grid:norway',
  model: { ref: norwayGridModelRef },
  operatingPoint: { ref: norwayNormalOperatingPointRef },
  automation: { ref: norwayStandardAutomationRef },
}))

const kvilldalId = 'generator:kvilldal-kraftverk-way-638639750'
const evLoadId = 'load:oslo-ev'

/** A low-level Grid driven like the adapter: each accepted command is followed by a zero-length tick. */
const harness = () => {
  const grid = createGridRuntimeInstance({ definition, at: isoAt(0) })
  let seconds = 0
  advanceGrid(grid, 0, isoAt(seconds))
  const send = (kind: string, payload: Readonly<Record<string, unknown>>) => {
    const result = applyGridCommand(grid, {
      id: `command:${crypto.randomUUID()}` as CommandId,
      simulationRunId: 'run:grid-commands' as SimulationRunId,
      actorId: 'actor:grid-commands-test' as ActorId,
      kind,
      targetObjectIds: [grid.definition.gridId as ObjectId],
      payload,
      issuedAt: isoAt(seconds),
    } satisfies CommandEnvelope)
    if (result.ok) advanceGrid(grid, 0, isoAt(seconds))
    return result
  }
  const step = (durationSeconds: number, dtSeconds = 2) => {
    const end = seconds + durationSeconds
    while (seconds < end) {
      const dt = Math.min(dtSeconds, end - seconds)
      seconds += dt
      advanceGrid(grid, dt, isoAt(seconds))
    }
  }
  return { grid, send, step }
}

const reasonOf = (result: ReturnType<typeof applyGridCommand>): string => {
  if (result.ok) throw new Error('expected the command to be rejected')
  return result.reason
}

const generatorDefinition = (id: string): GridGeneratorDefinition => definition.model.generators.find(generator => generator.id === id)!

describe('electric grid generator commands', () => {
  test('dispatch rejects targets outside minimum stable generation and availability instead of clamping', () => {
    const { grid, send } = harness()
    const state = grid.generators.get(kvilldalId)!
    const minimumStableMw = generatorMinimumStableMw(generatorDefinition(kvilldalId))
    const targetBefore = state.targetMw
    expect(reasonOf(send(gridDispatchGeneratorCommandKind, { assetId: kvilldalId, targetMw: 1e9 }))).toContain('exceeds the available capacity')
    expect(reasonOf(send(gridDispatchGeneratorCommandKind, { assetId: kvilldalId, targetMw: minimumStableMw - 1 }))).toContain('below the minimum stable generation')
    expect(state.targetMw).toBe(targetBefore)
    expect(send(gridDispatchGeneratorCommandKind, { assetId: kvilldalId, targetMw: state.availableMw }).ok).toBe(true)
    expect(state.targetMw).toBe(state.availableMw)
    expect(reasonOf(send(gridDispatchGeneratorCommandKind, { assetId: kvilldalId, targetMw: state.availableMw }))).toContain('already dispatched')
    expect(reasonOf(send(gridDispatchGeneratorCommandKind, { assetId: 'generator:missing', targetMw: 10 }))).toContain('not found')
  })

  test('trip removes output at once and a second trip is rejected', () => {
    const { grid, send } = harness()
    expect(send(gridTripGeneratorCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(grid.generators.get(kvilldalId)).toMatchObject({ state: 'tripped', dispatchMw: 0, targetMw: 0 })
    expect(reasonOf(send(gridTripGeneratorCommandKind, { assetId: kvilldalId }))).toContain('already tripped')
    expect(reasonOf(send(gridDispatchGeneratorCommandKind, { assetId: kvilldalId, targetMw: 500 }))).toContain('only an online unit')
  })

  test('availability is bounded by installed capacity and by minimum stable generation while running', () => {
    const { grid, send } = harness()
    const generator = generatorDefinition(kvilldalId)
    const state = grid.generators.get(kvilldalId)!
    expect(reasonOf(send(gridSetGeneratorAvailabilityCommandKind, { assetId: kvilldalId, availableMw: 99_999 }))).toContain('exceeds the installed capacity')
    expect(reasonOf(send(gridSetGeneratorAvailabilityCommandKind, { assetId: kvilldalId, availableMw: state.availableMw }))).toContain('already has')
    expect(reasonOf(send(gridSetGeneratorAvailabilityCommandKind, { assetId: kvilldalId, availableMw: 0 }))).toContain('minimum stable generation')
    const reducedMw = generatorMinimumStableMw(generator) + 10
    expect(send(gridSetGeneratorAvailabilityCommandKind, { assetId: kvilldalId, availableMw: reducedMw }).ok).toBe(true)
    expect(state.availableMw).toBe(reducedMw)
    expect(state.targetMw).toBeLessThanOrEqual(reducedMw)
    expect(send(gridTripGeneratorCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(send(gridSetGeneratorAvailabilityCommandKind, { assetId: kvilldalId, availableMw: 0 }).ok).toBe(true)
    expect(state).toMatchObject({ state: 'tripped', availableMw: 0 })
  })

  test('a tripped unit is reset, started, synchronises after its start-up time, and loads to minimum stable generation', () => {
    const { grid, send, step } = harness()
    const generator = generatorDefinition(kvilldalId)
    const state = grid.generators.get(kvilldalId)!
    const startupSeconds = generatorStartupSeconds(generator)!
    expect(startupSeconds).toBe(300)
    expect(reasonOf(send(gridResetGeneratorTripCommandKind, { assetId: kvilldalId }))).toContain('not tripped')
    expect(reasonOf(send(gridStartGeneratorCommandKind, { assetId: kvilldalId }))).toContain('already online')
    expect(send(gridTripGeneratorCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(reasonOf(send(gridStartGeneratorCommandKind, { assetId: kvilldalId }))).toContain('reset its trip')
    expect(send(gridResetGeneratorTripCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(state.state).toBe('offline')
    expect(send(gridStartGeneratorCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(state.state).toBe('starting')
    expect(reasonOf(send(gridStartGeneratorCommandKind, { assetId: kvilldalId }))).toContain('already starting')
    expect(reasonOf(send(gridDispatchGeneratorCommandKind, { assetId: kvilldalId, targetMw: 500 }))).toContain('starting')

    step(startupSeconds - 2)
    expect(state).toMatchObject({ state: 'starting', dispatchMw: 0 })
    step(2)
    expect(state.state).toBe('online')
    expect(state.synchronisesAtElapsedMs).toBeNull()
    expect(state.targetMw).toBeCloseTo(generatorMinimumStableMw(generator))
    step(60)
    expect(state.dispatchMw).toBeGreaterThanOrEqual(generatorMinimumStableMw(generator) - 1e-6)
    expect(send(gridDispatchGeneratorCommandKind, { assetId: kvilldalId, targetMw: 600 }).ok).toBe(true)
  })

  test('start-up time follows the generation kind', () => {
    const thermal = definition.model.generators.find(generator => generator.kind === 'thermal')!
    const { grid, send, step } = harness()
    const state = grid.generators.get(thermal.id)!
    expect(send(gridStopGeneratorCommandKind, { assetId: thermal.id }).ok).toBe(true)
    step(600)
    expect(state.state).toBe('offline')
    expect(send(gridStartGeneratorCommandKind, { assetId: thermal.id }).ok).toBe(true)
    step(generatorStartupSeconds(thermal)! - 10, 10)
    expect(state.state).toBe('starting')
    step(10, 10)
    expect(state.state).toBe('online')
  })

  test('stop unloads an online unit at its ramp rate before it goes offline, and aborts a start', () => {
    const { grid, send, step } = harness()
    const generator = generatorDefinition(kvilldalId)
    const state = grid.generators.get(kvilldalId)!
    const dispatchBeforeMw = state.dispatchMw
    expect(send(gridStopGeneratorCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(state).toMatchObject({ state: 'stopping', targetMw: 0 })
    expect(reasonOf(send(gridStopGeneratorCommandKind, { assetId: kvilldalId }))).toContain('stopping')
    step(2)
    expect(state.dispatchMw).toBeCloseTo(Math.max(0, dispatchBeforeMw - generator.rampRateMwPerMinute * 2 / 60))
    step(Math.ceil(dispatchBeforeMw / generator.rampRateMwPerMinute * 60) + 4)
    expect(state).toMatchObject({ state: 'offline', dispatchMw: 0 })
    expect(reasonOf(send(gridTripGeneratorCommandKind, { assetId: kvilldalId }))).toContain('already offline')
    expect(send(gridStartGeneratorCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(send(gridStopGeneratorCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(state).toMatchObject({ state: 'offline', synchronisesAtElapsedMs: null })
  })

  test('a unit without enough availability for minimum stable generation cannot start', () => {
    const { grid, send } = harness()
    const generator = generatorDefinition(kvilldalId)
    expect(send(gridTripGeneratorCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(send(gridSetGeneratorAvailabilityCommandKind, { assetId: kvilldalId, availableMw: generatorMinimumStableMw(generator) / 2 }).ok).toBe(true)
    expect(send(gridResetGeneratorTripCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(reasonOf(send(gridStartGeneratorCommandKind, { assetId: kvilldalId }))).toContain('below what it needs to run')
    expect(grid.generators.get(kvilldalId)!.state).toBe('offline')
  })
})

/** The first branch whose opening separates two energised islands, the smaller with load and two or more units. */
const separableBridge = (grid: GridRuntimeInstance) => {
  const baseIslandCount = topologyPlanForGrid(grid).islands.length
  for (const branch of definition.model.branches) {
    const state = grid.branches.get(branch.id)!
    state.state = 'open'
    const plan = topologyPlanForGrid(grid)
    const from = plan.islands.find(island => island.busSet.has(branch.fromBusId))!
    const to = plan.islands.find(island => island.busSet.has(branch.toBusId))!
    state.state = 'closed'
    if (plan.islands.length === baseIslandCount || from.id === to.id) continue
    if (!gridIslandIsEnergized(grid, from) || !gridIslandIsEnergized(grid, to)) continue
    const small = from.buses.length <= to.buses.length ? from : to
    if (small.loads.length > 0 && small.generators.length >= 2) {
      topologyPlanForGrid(grid)
      return { branch, small }
    }
  }
  throw new Error('the Norway Grid Model has no separable energised island with two units')
}

describe('electric grid branch commands', () => {
  test('rejects switching that changes nothing', () => {
    const { grid, send } = harness()
    const branchId = definition.model.branches[0]!.id
    expect(reasonOf(send(gridCloseBranchCommandKind, { assetId: branchId }))).toContain('already closed')
    expect(send(gridOpenBranchCommandKind, { assetId: branchId }).ok).toBe(true)
    expect(reasonOf(send(gridOpenBranchCommandKind, { assetId: branchId }))).toContain('already open')
    expect(reasonOf(send(gridClearDerateCommandKind, { assetId: branchId }))).toContain('not derated')
    expect(send(gridDerateBranchCommandKind, { assetId: branchId, availability: 0.5 }).ok).toBe(true)
    expect(reasonOf(send(gridDerateBranchCommandKind, { assetId: branchId, availability: 0.5 }))).toContain('already has availability 0.5')
    expect(send(gridClearDerateCommandKind, { assetId: branchId }).ok).toBe(true)
    expect(grid.branches.get(branchId)!.availability).toBe(1)
    expect(reasonOf(send(gridOpenBranchCommandKind, { assetId: kvilldalId }))).toContain('branch Grid Asset not found')
  })

  test('synchro-check blocks closing between energised islands apart by more than synchroCheckHz and reports the measured difference', () => {
    const { grid, send, step } = harness()
    const { branch, small } = separableBridge(grid)
    expect(send(gridOpenBranchCommandKind, { assetId: branch.id }).ok).toBe(true)
    expect(send(gridCloseBranchCommandKind, { assetId: branch.id }).ok).toBe(true)

    expect(send(gridOpenBranchCommandKind, { assetId: branch.id }).ok).toBe(true)
    const units = [...small.generators].sort((left, right) => right.capacityMw - left.capacityMw)
    for (const unit of units.slice(0, -1)) expect(send(gridTripGeneratorCommandKind, { assetId: unit.id }).ok).toBe(true)
    step(120)
    const fromHz = grid.busStates.get(branch.fromBusId)!.frequencyHz
    const toHz = grid.busStates.get(branch.toBusId)!.frequencyHz
    const slipHz = Math.abs(fromHz - toHz)
    expect(slipHz).toBeGreaterThan(definition.automation.synchroCheckHz)
    const reason = reasonOf(send(gridCloseBranchCommandKind, { assetId: branch.id }))
    expect(reason).toContain('synchro-check blocks closing')
    expect(reason).toContain(`differ by ${slipHz.toFixed(3)} Hz`)
    expect(reason).toContain(`${definition.automation.synchroCheckHz} Hz limit`)
    expect(grid.branches.get(branch.id)!.state).toBe('open')
  })

  test('dead-bus closing energises an island without a voltage source', () => {
    const { grid, send, step } = harness()
    const load = definition.model.loads.find(candidate => (definition.index.generatorsByBus.get(candidate.busId) ?? []).length === 0
      && (definition.index.branchesByBus.get(candidate.busId) ?? []).length >= 2)!
    const branches = definition.index.branchesByBus.get(load.busId)!
    for (const branch of branches) expect(send(gridOpenBranchCommandKind, { assetId: branch.id }).ok).toBe(true)
    step(60)
    const island = topologyPlanForGrid(grid).islands.find(candidate => candidate.busSet.has(load.busId))!
    expect(gridIslandIsEnergized(grid, island)).toBe(false)
    expect(send(gridCloseBranchCommandKind, { assetId: branches[0]!.id }).ok).toBe(true)
  })
})

describe('electric grid load commands', () => {
  test('shed-load sets an absolute limit counted as unserved manual shedding, and repeating it changes nothing', () => {
    const { grid, send } = harness()
    const state = grid.loads.get(evLoadId)!
    const unservedBeforeMw = grid.projection.unservedLoadMw
    const targetMw = Math.round(state.demandMw - 50)
    expect(send(gridShedLoadCommandKind, { assetId: evLoadId, targetDemandMw: targetMw }).ok).toBe(true)
    expect(state).toMatchObject({ manualDemandLimitMw: targetMw, serviceState: 'shed', shedCauses: ['manual'], lfddShedMw: 0 })
    expect(state.curtailedMw).toBeCloseTo(state.demandMw - targetMw)
    expect(state.servedMw).toBeCloseTo(targetMw)
    expect(grid.projection.unservedLoadMw - unservedBeforeMw).toBeCloseTo(state.curtailedMw)
    const snapshot = structuredClone(state)
    expect(reasonOf(send(gridShedLoadCommandKind, { assetId: evLoadId, targetDemandMw: targetMw }))).toContain('already limited')
    expect(state).toEqual(snapshot)
  })

  test('shed-load never sheds critical demand, only sheds controllable loads, and rejects a limit that sheds nothing', () => {
    const { grid, send } = harness()
    const load = definition.model.loads.find(candidate => candidate.id === evLoadId)!
    expect(reasonOf(send(gridShedLoadCommandKind, { assetId: evLoadId, targetDemandMw: load.criticalMw - 1 }))).toContain('critical demand')
    expect(reasonOf(send(gridShedLoadCommandKind, { assetId: evLoadId, targetDemandMw: grid.loads.get(evLoadId)!.demandMw + 1 }))).toContain('would shed nothing')
    expect(reasonOf(send(gridShedLoadCommandKind, { assetId: 'load:grenland-industry', targetDemandMw: 400 }))).toContain('not controllable')
    expect(reasonOf(send(gridRestoreLoadCommandKind, { assetId: evLoadId }))).toContain('not shed manually')
  })

  test('restore-load lifts the shedding limit and keeps the EV charging schedule', () => {
    const { grid, send } = harness()
    const state = grid.loads.get(evLoadId)!
    expect(send(gridSetEvChargingDemandCommandKind, { assetId: evLoadId, demandMw: 100 }).ok).toBe(true)
    expect(send(gridShedLoadCommandKind, { assetId: evLoadId, targetDemandMw: 60 }).ok).toBe(true)
    expect(state.curtailedMw).toBeGreaterThan(0)
    expect(send(gridRestoreLoadCommandKind, { assetId: evLoadId }).ok).toBe(true)
    expect(state).toMatchObject({ nominalDemandMw: 100, manualDemandLimitMw: null, curtailedMw: 0, shedCauses: [] })
    expect(state.serviceState).not.toBe('shed')
  })

  test('EV charging demand stays between critical and modelled demand', () => {
    const { grid, send } = harness()
    const load = definition.model.loads.find(candidate => candidate.id === evLoadId)!
    const maximumMw = load.demandMw * definition.operatingPoint.loadScale
    expect(reasonOf(send(gridSetEvChargingDemandCommandKind, { assetId: evLoadId, demandMw: 1e9 }))).toContain('exceeds the modelled demand')
    expect(reasonOf(send(gridSetEvChargingDemandCommandKind, { assetId: evLoadId, demandMw: load.criticalMw - 1 }))).toContain('below the critical demand')
    expect(reasonOf(send(gridSetEvChargingDemandCommandKind, { assetId: evLoadId, demandMw: grid.loads.get(evLoadId)!.nominalDemandMw }))).toContain('already')
    expect(reasonOf(send(gridSetEvChargingDemandCommandKind, { assetId: 'load:bergen-urban', demandMw: 10 }))).toContain('not controllable')
    expect(send(gridSetEvChargingDemandCommandKind, { assetId: evLoadId, demandMw: maximumMw / 2 }).ok).toBe(true)
    expect(grid.loads.get(evLoadId)!.nominalDemandMw).toBe(maximumMw / 2)
    expect(grid.projection.totalLoadMw).toBeLessThan(10_000)
  })
})

describe('electric grid command state persistence', () => {
  test('restores generator lifecycles and manual shedding limits', () => {
    const { grid, send } = harness()
    expect(send(gridTripGeneratorCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(send(gridResetGeneratorTripCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(send(gridStartGeneratorCommandKind, { assetId: kvilldalId }).ok).toBe(true)
    expect(send(gridShedLoadCommandKind, { assetId: evLoadId, targetDemandMw: 80 }).ok).toBe(true)
    const stored = electricGridRuntimeStateSchema.parse(JSON.parse(JSON.stringify(runtimeStateForElectricGrids(new Map([[grid.definition.gridId, grid]])))))
    const restored = createGridRuntimeInstance({
      definition,
      at: isoAt(0),
      restored: restoredGridRuntimeStateFor(stored, grid.definition.gridId, definition.definitionDigest)!,
    })
    expect(restored.generators.get(kvilldalId)).toMatchObject({ state: 'starting', synchronisesAtElapsedMs: grid.generators.get(kvilldalId)!.synchronisesAtElapsedMs })
    expect(restored.loads.get(evLoadId)!.manualDemandLimitMw).toBe(80)
  })
})

const connectAdapter = async () => {
  const scenario = scenarios.find(candidate => candidate.id === 'test-grid')!
  return await createLocalElectricGridPackRuntimeAdapter().connect({
    simulationRunId: 'run:grid-commands' as SimulationRunId,
    scenario: {
      scenarioId: scenario.id,
      runtimeIds: [electricGridRuntimeId],
      connections: [],
      world: scenario.world,
      initialObjects: scenario.initialObjects,
      runtimeConfigByRuntimeId: {},
      runtimeConfig: {},
    },
  })
}

describe('electric grid command Capabilities', () => {
  test('publish absolute, idempotent commands with consequence risk and bilingual search terms', () => {
    const commands = createLocalElectricGridPackRuntimeAdapter().capabilities.filter(capability => capability.kind === 'command')
    expect(commands.map(capability => capability.id)).not.toContain('world.electric-grid.return-generator-to-service')
    expect(commands.map(capability => capability.id)).toEqual(expect.arrayContaining([
      gridResetGeneratorTripCommandKind, gridStartGeneratorCommandKind, gridStopGeneratorCommandKind,
    ]))
    expect(commands.every(capability => capability.idempotent && capability.schedulable === true)).toBe(true)
    expect(commands.filter(capability => capability.risk === 'destructive').map(capability => capability.id).sort())
      .toEqual([gridOpenBranchCommandKind, gridShedLoadCommandKind, gridTripGeneratorCommandKind].sort())
    expect(commands.every(capability => (capability.searchTerms?.length ?? 0) >= 8)).toBe(true)
    const shed = commands.find(capability => capability.id === gridShedLoadCommandKind)!
    expect(shed.searchTerms).toEqual(expect.arrayContaining(['load shedding', 'lastfrakobling', 'UFLS', 'frekvens', 'reserve']))
    expect(commands.find(capability => capability.id === gridOpenBranchCommandKind)!.searchTerms).toContain('effektbryter')
  })

  test('labels the Grid change a command causes with the provenance of its actor', async () => {
    const connection = await connectAdapter()
    try {
      const emitted: PackRuntimeEvent[] = []
      const unsubscribe = connection.subscribe(emission => emitted.push(...emission.events))
      const sourceAfter = async (actorId: string, kind: string, payload: Readonly<Record<string, unknown>>) => {
        emitted.length = 0
        const result = await connection.sendCommand({
          id: `command:${crypto.randomUUID()}` as CommandId,
          simulationRunId: 'run:grid-commands' as SimulationRunId,
          actorId: actorId as ActorId,
          kind,
          targetObjectIds: ['grid:norway' as ObjectId],
          payload,
          issuedAt: isoAt(0),
        })
        expect(result.ok).toBe(true)
        const upsert = emitted.find(event => event.type === 'object.upserted')!
        expect(upsert.provenance.causedByCommandId).toBe(result.commandId)
        return upsert.provenance.source
      }
      const branchId = definition.model.branches[0]!.id
      expect(await sourceAfter('actor:ai:agent-7', gridDerateBranchCommandKind, { assetId: branchId, availability: 0.5 })).toBe('ai')
      expect(await sourceAfter('actor:scenario-timeline', gridDerateBranchCommandKind, { assetId: branchId, availability: 0.6 })).toBe('system')
      expect(await sourceAfter('actor:human:user-1', gridDerateBranchCommandKind, { assetId: branchId, availability: 0.7 })).toBe('operator')
      expect(await sourceAfter('actor:operator', gridClearDerateCommandKind, { assetId: branchId })).toBe('operator')
      unsubscribe()
    } finally {
      await connection.close()
    }
  })
})
