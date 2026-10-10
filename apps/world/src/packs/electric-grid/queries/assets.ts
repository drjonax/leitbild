import { z } from 'zod'
import { matchesLiteralSearch } from '../../../core/model/index.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import type { GridAssetIndexEntry } from '../grid-model.ts'
import { gridIslandIsEnergized } from '../runtime/island-energization.ts'
import { gridAssetSnapshotFor, type GridRuntimeInstance, type GridTopologyPlan } from '../runtime/instance.ts'
import { assetListItemSchema, assetPresentationFor } from './asset-presentation.ts'
import { assetKindSchema, defineGridQuery, gridFor, requireGridIsland, solvedTopologyFor } from './common.ts'
import {
  branchDefinitionSchema,
  branchStateSchema,
  busDefinitionSchema,
  busStateSchema,
  generatorDefinitionSchema,
  generatorStateSchema,
  loadDefinitionSchema,
  loadStateSchema,
  storageDefinitionSchema,
  storageStateSchema,
} from './schemas.ts'

const assetStatusSchema = z.enum([
  'energized', 'de-energized',
  'closed', 'open', 'derated',
  'online', 'offline', 'starting', 'stopping', 'tripped',
  'normal', 'constrained', 'shed', 'outage',
  'idle', 'charging', 'discharging', 'unavailable',
])
type AssetStatus = z.infer<typeof assetStatusSchema>

const searchPayloadSchema = z.object({
  gridId: z.string().min(1),
  text: z.string().max(200).default(''),
  kinds: z.array(assetKindSchema).max(5).optional(),
  status: z.array(assetStatusSchema).min(1).max(18).optional()
    .describe('Match any of these states: bus energized/de-energized; branch closed/open/derated; generator online/offline/starting/stopping/tripped; load normal/constrained/shed/outage; storage idle/charging/discharging/unavailable.'),
  islandId: z.string().min(1).optional().describe('Only assets in this island (world.electric-grid.islands.list); a branch matches when either end is in it.'),
  minLoadingPercent: z.number().finite().nonnegative().optional().describe('Only branches loaded at or above this percent of their derated rating.'),
  sort: z.enum(['model', 'loading', 'dispatch', 'shed']).default('model')
    .describe('model: Model order; loading: branches by loading; dispatch: generators by output; shed: loads by unserved demand. Assets without the sorted quantity follow in Model order.'),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
}).strict()
const assetPayloadSchema = z.object({ gridId: z.string().min(1), assetId: z.string().min(1) }).strict()
const assetSearchResultSchema = z.object({
  gridId: z.string(),
  total: z.number().int().nonnegative().describe('Assets matching the filters.'),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  assets: z.array(assetListItemSchema),
}).strict()

const listItemFields = assetListItemSchema.omit({ kind: true }).shape
const assetDetailSchema = z.discriminatedUnion('kind', [
  z.object({ ...listItemFields, kind: z.literal('bus'), definition: busDefinitionSchema, state: busStateSchema.optional() }).strict(),
  z.object({ ...listItemFields, kind: z.literal('branch'), definition: branchDefinitionSchema, state: branchStateSchema }).strict(),
  z.object({ ...listItemFields, kind: z.literal('generator'), definition: generatorDefinitionSchema, state: generatorStateSchema }).strict(),
  z.object({ ...listItemFields, kind: z.literal('load'), definition: loadDefinitionSchema, state: loadStateSchema }).strict(),
  z.object({ ...listItemFields, kind: z.literal('storage'), definition: storageDefinitionSchema, state: storageStateSchema }).strict(),
])
const assetDetailResultSchema = z.object({ gridId: z.string(), asset: assetDetailSchema }).strict()

const busIdsOf = (entry: GridAssetIndexEntry): ReadonlyArray<string> => entry.kind === 'bus'
  ? [entry.id]
  : entry.kind === 'branch' ? [entry.definition.fromBusId, entry.definition.toBusId] : [entry.definition.busId]

const statusesOf = (grid: GridRuntimeInstance, energizedByIsland: ReadonlyMap<string, boolean>, plan: GridTopologyPlan, entry: GridAssetIndexEntry): ReadonlyArray<AssetStatus> => {
  if (entry.kind === 'bus') return [energizedByIsland.get(plan.islandIdByBus.get(entry.id)!) ? 'energized' : 'de-energized']
  if (entry.kind === 'branch') {
    const state = grid.branches.get(entry.id)!
    return [state.state, ...(state.availability < 1 ? ['derated' as const] : [])]
  }
  if (entry.kind === 'generator') return [grid.generators.get(entry.id)!.state]
  if (entry.kind === 'load') return [grid.loads.get(entry.id)!.serviceState]
  return [grid.storage.get(entry.id)!.state]
}

/** The sorted quantity of one asset, or null when the asset does not carry it. */
const sortValueOf = (grid: GridRuntimeInstance, entry: GridAssetIndexEntry, sort: 'loading' | 'dispatch' | 'shed'): number | null => {
  if (sort === 'loading') return entry.kind === 'branch' ? grid.branches.get(entry.id)!.loadingPercent : null
  if (sort === 'dispatch') return entry.kind === 'generator' ? grid.generators.get(entry.id)!.dispatchMw : null
  if (entry.kind !== 'load') return null
  const state = grid.loads.get(entry.id)!
  return state.demandMw - state.servedMw
}

export const gridAssetSearchQuery = defineGridQuery({
  id: 'world.electric-grid.assets.search',
  title: 'Search Grid Assets',
  description: 'Searches stable private Grid Assets by text, kind, state, island and branch loading, sorted by Model order, loading, dispatch or unserved demand, with bounded pagination, live status, map targets and applicable operations. Example: tripped units are kinds [generator] with status [tripped]; overloaded corridors are kinds [branch] with minLoadingPercent 100 and sort loading.',
  searchTerms: ['search', 'find', 'assets', 'tripped units', 'overloaded lines', 'generators', 'loads', 'substations', 'søk', 'finn', 'komponenter', 'utfall', 'overbelastet', 'stasjon', 'kraftverk'],
  input: searchPayloadSchema,
  output: assetSearchResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const plan = solvedTopologyFor(grid)
    const islandId = payload.islandId === undefined ? undefined : requireGridIsland(plan, payload.islandId)
    const statuses = payload.status === undefined ? undefined : new Set(payload.status)
    const energizedByIsland = new Map(statuses === undefined ? [] : plan.islands.map(island => [island.id, gridIslandIsEnergized(grid, island)]))
    const matched = grid.definition.index.assets.filter(entry =>
      (payload.kinds === undefined || payload.kinds.includes(entry.kind))
      && (statuses === undefined || statusesOf(grid, energizedByIsland, plan, entry).some(status => statuses.has(status)))
      && (islandId === undefined || busIdsOf(entry).some(busId => plan.islandIdByBus.get(busId) === islandId))
      && (payload.minLoadingPercent === undefined || (entry.kind === 'branch' && grid.branches.get(entry.id)!.loadingPercent >= payload.minLoadingPercent))
      && matchesLiteralSearch(payload.text, [entry.id, entry.label, entry.kind]))
    const sort = payload.sort
    const ordered = sort === 'model'
      ? matched
      : matched
        .map(entry => ({ entry, value: sortValueOf(grid, entry, sort) }))
        .sort((left, right) => left.value === null || right.value === null
          ? Number(left.value === null) - Number(right.value === null)
          : right.value - left.value)
        .map(item => item.entry)
    return {
      gridId: payload.gridId,
      total: ordered.length,
      offset: payload.offset,
      limit: payload.limit,
      assets: ordered.slice(payload.offset, payload.offset + payload.limit).map(entry => assetPresentationFor(grid, gridAssetSnapshotFor(grid, entry.id)!)),
    }
  },
})

export const gridAssetGetQuery = defineGridQuery({
  id: 'world.electric-grid.asset.get',
  title: 'Get Grid Asset',
  description: 'Returns the Model definition with provenance, the current state, map target and applicable operations of one Grid Asset. Branch flow is positive from fromBusId to toBusId; storage and generator output are positive into the Grid.',
  searchTerms: ['asset detail', 'definition', 'provenance', 'state', 'parameters', 'detaljer', 'kilde', 'tilstand'],
  input: assetPayloadSchema,
  output: assetDetailResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const asset = gridAssetSnapshotFor(grid, payload.assetId)
    if (!asset) return rejectCapabilityTarget(
      `Grid Asset not found: ${payload.assetId}. Discover exact asset ids with world.electric-grid.assets.search.`,
    )
    return {
      gridId: payload.gridId,
      asset: { ...assetPresentationFor(grid, asset), definition: asset.definition, ...(asset.state === undefined ? {} : { state: asset.state }) },
    }
  },
})
