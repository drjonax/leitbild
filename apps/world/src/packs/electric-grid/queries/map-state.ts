import type { GridModelDefinition } from '../grid-model.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { gridIslandFrequencyHz, solvedGridIslands } from '../runtime/island-lifecycle.ts'
import { defineGridQuery, gridFor, gridPayloadSchema, type ElectricGridQuery } from './common.ts'
import { gridMapGeometryFor, type GridMapGeometry } from './map-geometry.ts'
import { gridMapStateResultSchema, type GridMapStateResult } from './map-schemas.ts'

// Compact live map state of a Grid: one array per quantity, aligned with the asset order of
// world.electric-grid.map.geometry. Values are rounded to what a map can show.

export interface GridMapIslandState {
  /** Stable islands in plan order. */
  readonly islands: ReadonlyArray<{ readonly id: string; readonly energized: boolean; readonly frequencyHz: number | null }>
  /** Index into islands per bus, in model order. */
  readonly busIsland: ReadonlyArray<number>
  /** Grid solve counter; it increases with every solve. */
  readonly tick: number
}

/** The map's only read of island membership, energisation and frequency: the runtime's stable island state. */
export const gridMapIslandState = (grid: GridRuntimeInstance): GridMapIslandState => {
  const plan = solvedGridIslands(grid)
  const islands = plan.islands.map(island => ({ id: island.id, energized: island.energized, frequencyHz: gridIslandFrequencyHz(island) }))
  // The compiled network numbers buses in model order, and stable islands align with plan islands.
  const busIsland = Array.from(plan.plan.islandIndexOfBus)
  return { islands, busIsland, tick: grid.tick }
}

const tenths = (value: number): number => Math.round(value * 10) / 10
const hundredths = (value: number): number => Math.round(value * 100) / 100

const stateFor = (grid: GridRuntimeInstance, geometry: GridMapGeometry): Omit<GridMapStateResult, 'gridId'> => {
  const model: GridModelDefinition = grid.definition.model
  const { islands, busIsland, tick } = gridMapIslandState(grid)
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
    revision: tick,
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
