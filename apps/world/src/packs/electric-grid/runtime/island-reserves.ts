import type { GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import { externalFrequencyEquivalent, externalReserveVolumes } from './island-input.ts'
import { connectedGridLoadMw } from './load-service.ts'
import { allocateIslandReserves, upwardReserveMw } from './reserve-allocation.ts'
import { generatorOnline } from './state/arrays.ts'
import { writeReserves } from './state/views.ts'
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
  const generators = grid.arrays.generators
  const loads = grid.arrays.loads
  let islandLoadMw = 0
  for (let loadPosition = 0; loadPosition < structure.loadIndices.length; loadPosition += 1) {
    const load = structure.loadIndices[loadPosition]!
    islandLoadMw += connectedGridLoadMw(loads, load)
  }
  const externalSystems = grid.definition.index.externalSystems
  // The allocation is a pure function of these inputs: when none changed since the island's last
  // allocation, the units keep it (most advances: set-points move only by command or dispatch).
  const length = structure.generatorIndices.length * 3 + 1 + structure.externalIndices.length * 6
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
  let position = 0
  const record = (value: number): void => {
    if (inputs![position] !== value) {
      inputs![position] = value
      changed = true
    }
    position += 1
  }
  for (let generatorPosition = 0; generatorPosition < structure.generatorIndices.length; generatorPosition += 1) {
    const generator = structure.generatorIndices[generatorPosition]!
    record(generators.lifecycle[generator] === generatorOnline ? 1 : 0)
    record(generators.availableMw[generator]!)
    record(generators.targetMw[generator]!)
  }
  record(islandLoadMw)
  for (let systemPosition = 0; systemPosition < structure.externalIndices.length; systemPosition += 1) {
    const system = structure.externalIndices[systemPosition]!
    const reserves = externalReserveVolumes(grid, externalSystems[system]!)
    for (let field = 0; field < reserves.length; field += 1) record(reserves[field]!)
  }
  if (!changed) return
  const allocation = allocateIslandReserves({
    automation: grid.definition.automation,
    units: Array.from(structure.generatorIndices, generator => {
      const definition = grid.definition.model.generators[generator]!
      return {
        definition,
        synchronised: generators.lifecycle[generator] === generatorOnline,
        minimumMw: generatorMinimumStableMw(definition),
        availableMw: generators.availableMw[generator]!,
        targetMw: generators.targetMw[generator]!,
      }
    }),
    area: {
      islandLoadMw,
      externals: Array.from(structure.externalIndices, system => {
        const equivalent = externalFrequencyEquivalent(grid, externalSystems[system]!)
        return { reserves: equivalent.reserves, loadMw: equivalent.loadMw }
      }),
    },
  })
  for (let generatorPosition = 0; generatorPosition < structure.generatorIndices.length; generatorPosition += 1) {
    const generator = structure.generatorIndices[generatorPosition]!
    const reserves = allocation.allocations.get(grid.definition.model.generators[generator]!.id)!
    writeReserves(generators, generator, reserves)
    generators.reserveMw[generator] = upwardReserveMw(reserves)
  }
}
