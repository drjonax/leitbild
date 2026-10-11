import type { GridGeneratorDefinition } from '../grid-model.ts'
import { generatorIsVoltageForming } from './generator-dynamics.ts'
import { queueGridSignal } from './grid-signals.ts'
import type { GridIslandPlan, GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import { gridIslandAtBus, refreshGridIslandEnergisation, solvedGridIslands } from './island-lifecycle.ts'
import { connectedGridLoadMw } from './load-service.ts'
import { allocateIslandReserves, upwardReserveMw } from './reserve-allocation.ts'

// Restoration: a dead island is energised either by a black-start capable synchronous unit inside it
// or by dead-bus closing from an energised neighbour (close-branch). Any other unit needs a live
// bus to synchronise to.

/** A black-start capable synchronous unit: it can build up voltage on a dead busbar. */
export const generatorCanEnergiseDeadIsland = (definition: GridGeneratorDefinition): boolean =>
  definition.blackStartCapable && generatorIsVoltageForming(definition)

/** Why start-generator may not start this unit, or null: in a dead island only a black-start capable unit can start. */
export const deadIslandStartRejection = (grid: GridRuntimeInstance, definition: GridGeneratorDefinition): string | null => {
  const islands = solvedGridIslands(grid)
  const island = gridIslandAtBus(islands, definition.busId)
  if (island.energized || generatorCanEnergiseDeadIsland(definition)) return null
  const candidates = islands.plan.islands[island.planIndex]!.generators
    .filter(candidate => generatorCanEnergiseDeadIsland(candidate) && grid.generators.get(candidate.id)!.state === 'offline')
    .map(candidate => candidate.id)
  const capability = definition.synchronous ? 'is not black-start capable' : 'is converter-connected and cannot form voltage'
  const options = candidates.length === 0
    ? 'it holds no offline black-start capable unit, so close a branch from an energised island'
    : `start a black-start capable unit in it (${candidates.slice(0, 3).join(', ')}${candidates.length > 3 ? ` and ${candidates.length - 3} more` : ''}) or close a branch from an energised island`
  return `generator ${definition.id} ${capability}, and its island ${island.id} is de-energised: ${options} first`
}

/**
 * Whether a starting unit may synchronise now: onto a live bus, or, as a black-start unit, onto a
 * dead one. A unit whose bus lost supply during its start-up cannot synchronise; its start is
 * aborted and recorded.
 */
export const startingUnitMaySynchronise = (grid: GridRuntimeInstance, definition: GridGeneratorDefinition): boolean => {
  if (generatorCanEnergiseDeadIsland(definition)) return true
  const islands = grid.islandPlan
  if (islands === null) throw new Error(`Grid ${grid.definition.gridId} has no islands yet; unit commitment runs inside an advance`)
  if (gridIslandAtBus(islands, definition.busId).energized) return true
  queueGridSignal(grid, {
    type: 'electric-grid.generator.start-aborted',
    severity: 'warning',
    key: `start-aborted|${definition.id}|${grid.elapsedMs}`,
    payload: {
      gridId: grid.definition.gridId,
      assetId: definition.id,
      label: definition.label,
      reason: 'its island was de-energised when it was due to synchronise, and it is not black-start capable',
      elapsedSeconds: grid.elapsedMs / 1_000,
    },
  })
  return false
}

/**
 * A black-started island runs detached from any synchronous area: its units are allocated their
 * full droop and headroom as FCR, aFRR and mFRR, as dispatch allocates a detached island, so the
 * unit's governor and AGC carry the load pick-up.
 */
const allocateBlackStartReserves = (grid: GridRuntimeInstance, structure: GridTopologyIsland): void => {
  const allocation = allocateIslandReserves({
    automation: grid.definition.automation,
    units: structure.generators.map(definition => {
      const state = grid.generators.get(definition.id)!
      return { definition, synchronised: state.state === 'online', minimumMw: definition.minimumStableMw, availableMw: state.availableMw, targetMw: state.targetMw }
    }),
    area: { islandLoadMw: structure.loads.reduce((sum, load) => sum + connectedGridLoadMw(grid.loads.get(load.id)!), 0), externals: [] },
  })
  for (const definition of structure.generators) {
    const state = grid.generators.get(definition.id)!
    state.reserves = allocation.allocations.get(definition.id)!
    state.reserveMw = upwardReserveMw(state.reserves)
  }
}

/** Energisation after unit commitment changed: islands energised from dead by a synchronising unit get their reserves allocated. */
export const energiseGridIslandsAfterCommitment = (grid: GridRuntimeInstance, islands: GridIslandPlan): void => {
  const dead = new Set(islands.islands.filter(island => !island.energized).map(island => island.id))
  refreshGridIslandEnergisation(grid, islands)
  for (const island of islands.islands) {
    if (island.energized && dead.has(island.id)) allocateBlackStartReserves(grid, islands.plan.islands[island.planIndex]!)
  }
}
