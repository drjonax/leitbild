import type { GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import { externalFrequencyEquivalent, islandAssetStates, islandMembers } from './island-input.ts'
import { connectedGridLoadMw } from './load-service.ts'
import { allocateIslandReserves, upwardReserveMw } from './reserve-allocation.ts'
import { generatorMinimumStableMw } from './unit-commitment.ts'

const allocationInputs = new WeakMap<GridRuntimeInstance, WeakMap<GridTopologyIsland, Float64Array>>()

/**
 * Allocates an energised island's reserves to its online units from their present set-points:
 * each unit offers its headroom (availability − set-point) and footroom (set-point − minimum
 * stable generation) within its droop and product eligibility, against the requirement of the
 * island's synchronous area (allocateIslandReserves); a detached island uses its own units' droop
 * and room. Called before every frequency advance and at dispatch, so a unit started into a live
 * island, a trimmed set-point or a black-started island picking up load holds reserve from its
 * present room. A pure function of set-points, availability, lifecycle and connected demand, which
 * change only at segment boundaries, so the advance does not depend on the adapter step.
 */
export const allocateGridIslandReserves = (grid: GridRuntimeInstance, structure: GridTopologyIsland): void => {
  const states = islandAssetStates(grid, structure)
  const islandLoadMw = states.loads.reduce((sum, state) => sum + connectedGridLoadMw(state), 0)
  const externals = islandMembers(grid, structure).externals.map(system => {
    const equivalent = externalFrequencyEquivalent(grid, system)
    return { reserves: equivalent.reserves, loadMw: equivalent.loadMw }
  })
  // The allocation is a pure function of these inputs: when none changed since the island's last
  // allocation, the units keep it (most advances: set-points move only by command or dispatch).
  const length = structure.generators.length * 3 + 1 + externals.length * 6
  let byIsland = allocationInputs.get(grid)
  if (byIsland === undefined) {
    byIsland = new WeakMap()
    allocationInputs.set(grid, byIsland)
  }
  let inputs = byIsland.get(structure)
  let changed = inputs === undefined || inputs.length !== length
  if (inputs === undefined || inputs.length !== length) {
    inputs = new Float64Array(length)
    byIsland.set(structure, inputs)
  }
  const record = (position: number, value: number): void => {
    if (inputs![position] !== value) {
      inputs![position] = value
      changed = true
    }
  }
  const generatorStates = states.generators
  for (let index = 0; index < generatorStates.length; index += 1) {
    const state = generatorStates[index]!
    record(index * 3, state.state === 'online' ? 1 : 0)
    record(index * 3 + 1, state.availableMw)
    record(index * 3 + 2, state.targetMw)
  }
  let position = generatorStates.length * 3
  record(position++, islandLoadMw)
  for (const external of externals) {
    const reserves = external.reserves
    record(position++, reserves.fcrNMw)
    record(position++, reserves.fcrDUpMw)
    record(position++, reserves.fcrDDownMw)
    record(position++, reserves.afrrUpMw)
    record(position++, reserves.afrrDownMw)
    record(position++, external.loadMw)
  }
  if (!changed) return
  const allocation = allocateIslandReserves({
    automation: grid.definition.automation,
    units: structure.generators.map((definition, index) => {
      const state = states.generators[index]!
      return { definition, synchronised: state.state === 'online', minimumMw: generatorMinimumStableMw(definition), availableMw: state.availableMw, targetMw: state.targetMw }
    }),
    area: { islandLoadMw, externals },
  })
  structure.generators.forEach((definition, index) => {
    const state = states.generators[index]!
    state.reserves = allocation.allocations.get(definition.id)!
    state.reserveMw = upwardReserveMw(state.reserves)
  })
}
