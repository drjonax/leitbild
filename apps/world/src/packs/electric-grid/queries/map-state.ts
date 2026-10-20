import type { GridModelDefinition } from '../grid-model.ts'
import { gridIslandFlowModel } from '../runtime/ac-load-flow.ts'
import type { GridLoadState, GridRuntimeInstance } from '../runtime/instance.ts'
import { gridIslandFrequencyHz, solvedGridIslands } from '../runtime/island-lifecycle.ts'
import { gridLoadingBands } from '../loading-bands.ts'
import { defineGridQuery, gridFor, gridPayloadSchema, type ElectricGridQuery } from './common.ts'
import { gridMapGeometryFor, type GridMapGeometry } from './map-geometry.ts'
import { gridMapStateResultSchema, type GridMapStateResult } from './map-schemas.ts'

// Compact live map state of a Grid: one array per quantity, aligned with the asset order of
// world.electric-grid.map.geometry. Values are rounded to what a map can show.

export interface GridMapIslandState {
  /** Stable islands in plan order. */
  readonly islands: ReadonlyArray<{ readonly id: string; readonly energized: boolean; readonly frequencyHz: number | null; readonly flowModel: 'ac' | 'dc' | null }>
  /** Index into islands per bus, in model order; null at an HVDC terminal and a separated boundary bus, which lie in no island. */
  readonly busIsland: ReadonlyArray<number | null>
  /** Grid solve counter; it increases with every solve. */
  readonly tick: number
}

/** The map's only read of island membership, energisation and frequency: the runtime's stable island state. */
export const gridMapIslandState = (grid: GridRuntimeInstance): GridMapIslandState => {
  const plan = solvedGridIslands(grid)
  const islands = plan.islands.map(island => ({ id: island.id, energized: island.energized, frequencyHz: gridIslandFrequencyHz(island), flowModel: gridIslandFlowModel(grid, island) }))
  // The compiled network numbers buses in model order, and stable islands align with plan islands.
  const busIsland = Array.from(plan.plan.islandIndexOfBus, island => island < 0 ? null : island)
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
  const tripped = new Array<0 | 1>(branchCount)
  const availability = new Array<number>(branchCount)
  const flowModel = new Array<'ac' | 'dc' | null>(branchCount)
  model.branches.forEach((branch, position) => {
    const state = grid.branches.get(branch.id)!
    loadingPercent[position] = tenths(state.loadingPercent)
    flowMw[position] = Math.round(state.flowMw)
    flowModel[position] = state.flowModel
    closed[position] = state.state === 'closed' ? 1 : 0
    tripped[position] = state.state === 'tripped' ? 1 : 0
    availability[position] = hundredths(state.availability)
  })
  const generatorStates = model.generators.map(generator => grid.generators.get(generator.id)!)
  const linkStates = model.hvdcLinks.map(link => grid.hvdcLinks.get(link.id)!)
  const loadGroups = geometry.payload.loads.map(group => group.loadIds.map(id => grid.loads.get(id)!))
  const summed = (value: (state: GridLoadState) => number): number[] => loadGroups.map(group => tenths(group.reduce((sum, state) => sum + value(state), 0)))
  return {
    geometryDigest: geometry.geometryDigest,
    revision: tick,
    elapsedMs: grid.elapsedMs,
    islands: [...islands],
    buses: {
      island: [...busIsland],
      // A separated boundary bus lies in no island but its external system holds it energised.
      energized: busIsland.map((position, bus) => position === null ? grid.arrays.buses.energized[bus] === 1 ? 1 : 0 : islands[position]!.energized ? 1 : 0),
    },
    branches: { loadingPercent, flowMw, flowModel, closed, tripped, availability },
    loadingBands: gridLoadingBands(grid.definition.automation.alarms),
    generators: {
      dispatchMw: generatorStates.map(state => Math.round(state.dispatchMw)),
      state: generatorStates.map(state => state.state),
    },
    loads: {
      demandMw: summed(state => state.demandMw),
      servedMw: summed(state => state.servedMw),
      shedMw: summed(state => state.shedMw),
    },
    hvdcLinks: {
      state: linkStates.map(state => state.state),
      transferMw: linkStates.map(state => Math.round(state.transferMw)),
      setpointMw: linkStates.map(state => Math.round(state.setpointMw)),
    },
  }
}

export const createGridMapStateQuery = (geometryFor: (model: GridModelDefinition) => GridMapGeometry): ElectricGridQuery => defineGridQuery({
  id: 'world.electric-grid.map.state',
  title: 'Get Grid map state',
  description: 'Returns compact live state of one Grid as arrays in world.electric-grid.map.geometry order: branch loading, flow, switching state (closed, or tripped by protection) and availability; bus island and energisation; generator dispatch and state; load demand, served and shed summed per bus; HVDC link state, transfer and set-point. Fetch it when the Grid object revision changes.',
  searchTerms: ['map state', 'live map', 'loading', 'flow', 'energised', 'islands', 'kartstatus', 'belastning', 'flyt', 'spenningssatt', 'øydrift'],
  input: gridPayloadSchema,
  output: gridMapStateResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    return { gridId: payload.gridId, ...stateFor(grid, geometryFor(grid.definition.model)) }
  },
})

export const gridMapStateQuery = createGridMapStateQuery(gridMapGeometryFor)
