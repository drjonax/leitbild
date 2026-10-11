// Finds a branch whose opening separates part of the Norway Grid from the Nordic synchronous area,
// and re-dispatches that part to its own load so the separation starts nearly balanced.
import type { GridBranchDefinition, GridGeneratorDefinition } from '../../src/packs/electric-grid/grid-model.ts'
import { generatorKineticEnergyMws } from '../../src/packs/electric-grid/runtime/generator-dynamics.ts'
import type { GridRuntimeInstance } from '../../src/packs/electric-grid/runtime/instance.ts'
import { compiledGridNetworkFor } from '../../src/packs/electric-grid/runtime/network/compiled-network.ts'
import { findGridIslands } from '../../src/packs/electric-grid/runtime/network/islands.ts'

export interface SeparablePart {
  readonly busIds: ReadonlyArray<string>
  readonly units: ReadonlyArray<GridGeneratorDefinition>
  readonly availableMw: number
  readonly minimumMw: number
  readonly loadMw: number
  readonly kineticEnergyMws: number
  readonly boundaries: number
}

const partsWithout = (grid: GridRuntimeInstance, islandBuses: ReadonlySet<string>, closed: Uint8Array, branchIndex: number): ReadonlyArray<SeparablePart> => {
  const { index } = grid.definition
  const network = compiledGridNetworkFor(grid.definition.model)
  const flags = closed.slice()
  flags[branchIndex] = 0
  const found = findGridIslands(network, flags)
  const parts = new Map<number, { busIds: string[]; units: GridGeneratorDefinition[]; availableMw: number; minimumMw: number; loadMw: number; kineticEnergyMws: number; boundaries: number }>()
  for (const busId of islandBuses) {
    const part = found.islandOfBus[network.busIndexById.get(busId)!]!
    const entry = parts.get(part) ?? { busIds: [], units: [], availableMw: 0, minimumMw: 0, loadMw: 0, kineticEnergyMws: 0, boundaries: 0 }
    entry.busIds.push(busId)
    if (index.synchronousExternalByBus.has(busId)) entry.boundaries += 1
    for (const generator of index.generatorsByBus.get(busId) ?? []) {
      const state = grid.generators.get(generator.id)!
      if (state.state !== 'online') continue
      entry.units.push(generator)
      entry.availableMw += state.availableMw
      entry.minimumMw += generator.minimumStableMw
      entry.kineticEnergyMws += generatorKineticEnergyMws(generator)
    }
    for (const load of index.loadsByBus.get(busId) ?? []) entry.loadMw += grid.loads.get(load.id)!.demandMw
    parts.set(part, entry)
  }
  return [...parts.values()]
}

/**
 * The branch of the island holding `busId` whose opening separates a part without Nordic ties
 * that can hold its own load: two or more online units whose availability exceeds it by 20 % and
 * whose minimum stable generation stays 20 % below it. Among those, the part with the most kinetic energy.
 */
export const separableBranch = (grid: GridRuntimeInstance, busId: string): { readonly branch: GridBranchDefinition; readonly part: SeparablePart } => {
  const { model } = grid.definition
  const closed = Uint8Array.from(model.branches, branch => grid.branches.get(branch.id)!.state === 'closed' ? 1 : 0)
  const islandId = grid.busStates.get(busId)!.islandId
  const islandBuses = new Set(model.buses.filter(bus => grid.busStates.get(bus.id)!.islandId === islandId).map(bus => bus.id))
  let best: { readonly branch: GridBranchDefinition; readonly part: SeparablePart } | null = null
  model.branches.forEach((branch, index) => {
    if (closed[index] !== 1 || !islandBuses.has(branch.fromBusId)) return
    const parts = partsWithout(grid, islandBuses, closed, index)
    // One part keeps the Nordic ties; the other separates from the synchronous area.
    if (parts.length !== 2 || parts.filter(part => part.boundaries === 0).length !== 1) return
    const part = parts.find(candidate => candidate.boundaries === 0)!
    if (part.units.length < 2 || !(part.availableMw > 1.2 * part.loadMw && part.minimumMw < 0.8 * part.loadMw)) return
    if (best === null || part.kineticEnergyMws > best.part.kineticEnergyMws) best = { branch, part }
  })
  if (best === null) throw new Error('the Grid has no separable part that can hold its own load')
  return best
}

/**
 * Re-dispatches the part's units to its own load: the flow over the branch into the part is the
 * shortfall its units take up, pro rata of their range; `settle` advances the Grid between rounds.
 */
export const balanceSeparablePart = (grid: GridRuntimeInstance, split: { readonly branch: GridBranchDefinition; readonly part: SeparablePart }, settle: () => void): void => {
  const { branch, part } = split
  const intoPartMw = (): number => (part.busIds.includes(branch.toBusId) ? 1 : -1) * grid.branches.get(branch.id)!.flowMw
  for (let round = 0; round < 4; round += 1) {
    const rangeMw = part.units.reduce((sum, unit) => sum + grid.generators.get(unit.id)!.availableMw - unit.minimumStableMw, 0)
    const shiftMw = intoPartMw()
    for (const unit of part.units) {
      const state = grid.generators.get(unit.id)!
      state.targetMw = Math.min(state.availableMw, Math.max(unit.minimumStableMw, state.targetMw + shiftMw * (state.availableMw - unit.minimumStableMw) / rangeMw))
    }
    settle()
  }
}
