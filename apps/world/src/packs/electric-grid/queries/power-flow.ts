import { z } from 'zod'
import type { GridBranchDefinition, GridHvdcLinkDefinition } from '../grid-model.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { defineGridQuery, gridBusIslandId, gridFor, requireGridIsland } from './common.ts'
import { branchDefinitionSchema, branchSwitchingStateSchema, hvdcLinkDefinitionSchema, hvdcLinkOperatingStateSchema } from './schemas.ts'

const finite = z.number().finite()

const powerFlowPayloadSchema = z.object({
  gridId: z.string().min(1),
  sort: z.enum(['model', 'loading']).default('model').describe('model: stable Model order for paging; loading: most loaded first.'),
  minLoadingPercent: finite.nonnegative().optional().describe('Only branches loaded at or above this percent of their derated rating.'),
  islandId: z.string().min(1).optional().describe('Only branches with an end bus in this island (world.electric-grid.islands.list).'),
  includeDefinition: z.boolean().default(false).describe('Add each branch\'s full Model definition (electrical parameters and provenance).'),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
}).strict()

// Compact rows keep a 100-row page small for Agent context; endpoints, voltage class and electrical
// parameters come with includeDefinition, and exact state with world.electric-grid.asset.get.
const powerFlowRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: branchDefinitionSchema.shape.kind,
  ratingMw: finite,
  state: branchSwitchingStateSchema,
  availability: finite.describe('Available fraction of the rating (derate).'),
  flowMw: finite.describe('Active power flow to 0.1 MW, positive from the definition\'s fromBusId to toBusId.'),
  loadingPercent: finite.describe('|flowMw| over ratingMw × availability, to 0.1 %.'),
  definition: branchDefinitionSchema.optional(),
}).strict()

const hvdcRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: hvdcLinkOperatingStateSchema,
  ratingMw: finite,
  setpointMw: finite.describe('Transfer set-point (MW), positive from fromBusId: positive exports from Norway.'),
  transferMw: finite.describe('Power sent at the sending converter to 0.1 MW, signed like the set-point; it ramps towards it.'),
  lossesMw: finite.describe('Converter and cable losses to 0.1 MW.'),
  loadingPercent: finite.describe('|transferMw| over ratingMw, to 0.1 %.'),
  definition: hvdcLinkDefinitionSchema.optional(),
}).strict()

const tenths = (value: number): number => Math.round(value * 10) / 10

const powerFlowResultSchema = z.object({
  gridId: z.string(),
  total: z.number().int().nonnegative().describe('Branches matching the filters.'),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  sort: z.enum(['model', 'loading']),
  branches: z.array(powerFlowRowSchema),
  hvdcLinks: z.array(hvdcRowSchema).describe('Every HVDC link matching the loading and island filters (a converter in the island), not paged, in the same order.'),
}).strict()

const rowFor = (grid: GridRuntimeInstance, definition: GridBranchDefinition, includeDefinition: boolean): z.infer<typeof powerFlowRowSchema> => {
  const state = grid.branches.get(definition.id)!
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    ratingMw: definition.ratingMw,
    state: state.state,
    availability: state.availability,
    flowMw: tenths(state.flowMw),
    loadingPercent: tenths(state.loadingPercent),
    ...(includeDefinition ? { definition } : {}),
  }
}

const hvdcRowFor = (grid: GridRuntimeInstance, definition: GridHvdcLinkDefinition, includeDefinition: boolean): z.infer<typeof hvdcRowSchema> => {
  const state = grid.hvdcLinks.get(definition.id)!
  return {
    id: definition.id,
    label: definition.label,
    state: state.state,
    ratingMw: definition.ratingMw,
    setpointMw: state.setpointMw,
    transferMw: tenths(state.transferMw),
    lossesMw: tenths(state.lossesMw),
    loadingPercent: tenths(Math.abs(state.transferMw) / definition.ratingMw * 100),
    ...(includeDefinition ? { definition } : {}),
  }
}

export const gridPowerFlowQuery = defineGridQuery({
  id: 'world.electric-grid.power-flow.snapshot',
  title: 'Get power-flow snapshot',
  description: 'Returns a bounded page of compact branch rows: rating, closed/open/tripped, derate, flow (0.1 MW, positive from fromBusId to toBusId) and loading (0.1 % of the derated rating), optionally filtered by minimum loading and island and sorted by loading. Every HVDC link follows in its own rows: deblocked/blocked/tripped, set-point and transfer (positive exports from Norway), losses and loading. Endpoints and electrical parameters come with includeDefinition.',
  searchTerms: ['power flow', 'branch flow', 'loading', 'overload', 'congestion', 'corridor', 'constraint', 'HVDC', 'interconnector', 'kraftflyt', 'belastning', 'overlast', 'flaskehals', 'snitt', 'linje', 'utenlandsforbindelse'],
  input: powerFlowPayloadSchema,
  output: powerFlowResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const islandId = payload.islandId === undefined ? undefined : requireGridIsland(grid, payload.islandId)
    const matched = grid.definition.model.branches.filter(definition =>
      (payload.minLoadingPercent === undefined || grid.branches.get(definition.id)!.loadingPercent >= payload.minLoadingPercent)
      && (islandId === undefined || gridBusIslandId(grid, definition.fromBusId) === islandId || gridBusIslandId(grid, definition.toBusId) === islandId))
    const ordered = payload.sort === 'loading'
      ? [...matched].sort((left, right) => grid.branches.get(right.id)!.loadingPercent - grid.branches.get(left.id)!.loadingPercent)
      : matched
    const hvdcLoadingPercent = (definition: GridHvdcLinkDefinition): number => Math.abs(grid.hvdcLinks.get(definition.id)!.transferMw) / definition.ratingMw * 100
    const hvdcMatched = grid.definition.index.hvdcLinks.filter(definition =>
      (payload.minLoadingPercent === undefined || hvdcLoadingPercent(definition) >= payload.minLoadingPercent)
      && (islandId === undefined || gridBusIslandId(grid, definition.fromBusId) === islandId || gridBusIslandId(grid, definition.toBusId) === islandId))
    const hvdcOrdered = payload.sort === 'loading' ? [...hvdcMatched].sort((left, right) => hvdcLoadingPercent(right) - hvdcLoadingPercent(left)) : hvdcMatched
    return {
      gridId: payload.gridId,
      total: ordered.length,
      offset: payload.offset,
      limit: payload.limit,
      sort: payload.sort,
      branches: ordered.slice(payload.offset, payload.offset + payload.limit).map(definition => rowFor(grid, definition, payload.includeDefinition)),
      hvdcLinks: hvdcOrdered.map(definition => hvdcRowFor(grid, definition, payload.includeDefinition)),
    }
  },
})
