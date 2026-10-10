import type { GridModelDefinition } from '../grid-model.ts'
import { gridIslandIsEnergized } from '../runtime/island-energization.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { defineGridQuery, gridFor, gridPayloadSchema, solvedTopologyFor, type ElectricGridQuery } from './common.ts'
import { gridMapGeometryFor, type GridMapGeometry } from './map-geometry.ts'
import { gridMapStateResultSchema, type GridMapStateResult } from './map-schemas.ts'

// Compact live map state of a Grid: one array per quantity, aligned with the asset order of
// world.electric-grid.map.geometry. Values are rounded to what a map can show.

export interface GridMapIslandState {
  readonly islands: ReadonlyArray<{ readonly id: string; readonly energized: boolean; readonly frequencyHz: number | null }>
  /** Index into islands per bus, in model order. */
  readonly busIsland: ReadonlyArray<number>
}

/**
 * The map's only read of island membership, energisation and frequency. It derives them from
 * the solved topology today; the island-lifecycle runtime replaces the derivation with its
 * stored per-island state, so the map follows the runtime's own decision.
 */
export const gridMapIslandState = (grid: GridRuntimeInstance): GridMapIslandState => {
  const plan = solvedTopologyFor(grid)
  const islands = plan.islands.map(island => {
    const energized = gridIslandIsEnergized(grid, island)
    const frequencyHz = energized ? grid.frequencyByIsland.get(island.id) : null
    if (frequencyHz === undefined) throw new Error(`Grid ${grid.definition.gridId} has no frequency for energised island ${island.id}`)
    return { id: island.id, energized, frequencyHz }
  })
  const islandIndex = new Map(plan.islands.map((island, position) => [island.id, position]))
  const busIsland = grid.definition.model.buses.map(bus => {
    const islandId = plan.islandIdByBus.get(bus.id)
    const position = islandId === undefined ? undefined : islandIndex.get(islandId)
    if (position === undefined) throw new Error(`Grid ${grid.definition.gridId} bus ${bus.id} is in no solved island`)
    return position
  })
  return { islands, busIsland }
}

const tenths = (value: number): number => Math.round(value * 10) / 10
const hundredths = (value: number): number => Math.round(value * 100) / 100

const stateFor = (grid: GridRuntimeInstance, geometry: GridMapGeometry): Omit<GridMapStateResult, 'gridId'> => {
  const model: GridModelDefinition = grid.definition.model
  const { islands, busIsland } = gridMapIslandState(grid)
  const branchCount = model.branches.length
  const loadingPercent = new Array<number>(branchCount)
  const flowMw = new Array<number>(branchCount)
  const closed = new Array<0 | 1>(branchCount)
  const availability = new Array<number>(branchCount)
  model.branches.forEach((branch, position) => {
    const state = grid.branches.get(branch.id)!
    loadingPercent[position] = tenths(state.loadingPercent)
    flowMw[position] = Math.round(state.flowMw)
    closed[position] = state.state === 'closed' ? 1 : 0
    availability[position] = hundredths(state.availability)
  })
  const generatorStates = model.generators.map(generator => grid.generators.get(generator.id)!)
  const loadStates = model.loads.map(load => grid.loads.get(load.id)!)
  return {
    geometryDigest: geometry.geometryDigest,
    revision: grid.tick,
    elapsedMs: grid.elapsedMs,
    islands: [...islands],
    buses: {
      island: [...busIsland],
      energized: busIsland.map(position => islands[position]!.energized ? 1 : 0),
    },
    branches: { loadingPercent, flowMw, closed, availability },
    generators: {
      dispatchMw: generatorStates.map(state => Math.round(state.dispatchMw)),
      state: generatorStates.map(state => state.state),
    },
    loads: {
      demandMw: loadStates.map(state => tenths(state.demandMw)),
      servedMw: loadStates.map(state => tenths(state.servedMw)),
      shedMw: loadStates.map(state => tenths(state.shedMw)),
    },
  }
}

export const createGridMapStateQuery = (geometryFor: (model: GridModelDefinition) => GridMapGeometry): ElectricGridQuery => defineGridQuery({
  id: 'world.electric-grid.map.state',
  title: 'Get Grid map state',
  description: 'Returns compact live state of one Grid as arrays in world.electric-grid.map.geometry order: branch loading, flow, switching state and availability; bus island and energisation; generator dispatch and state; load demand, served and shed. Fetch it when the Grid object revision changes.',
  searchTerms: ['map state', 'live map', 'loading', 'flow', 'energised', 'islands', 'kartstatus', 'belastning', 'flyt', 'spenningssatt', 'øydrift'],
  input: gridPayloadSchema,
  output: gridMapStateResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    return { gridId: payload.gridId, ...stateFor(grid, geometryFor(grid.definition.model)) }
  },
})

export const gridMapStateQuery = createGridMapStateQuery(gridMapGeometryFor)
