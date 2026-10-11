import { z } from 'zod'
import { matchesLiteralSearch } from '../../../core/model/index.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import type { GridAssetIndexEntry, GridHvdcLinkDefinition } from '../grid-model.ts'
import { gridDemandSampleClock } from '../runtime/demand.ts'
import { gridAssetSnapshotFor, type GridRuntimeInstance } from '../runtime/instance.ts'
import { gridTablesFor } from '../runtime/state/tables.ts'
import { assetListItemSchema, assetPresentationFor, hvdcPresentationFor } from './asset-presentation.ts'
import { assetKindSchema, defineGridQuery, gridBusIslandId, gridFor, requireGridIsland } from './common.ts'
import {
  branchDefinitionSchema,
  branchStateSchema,
  busDefinitionSchema,
  busStateSchema,
  demandProfileDefinitionSchema,
  demandSampleSchema,
  generatorDefinitionSchema,
  generatorStateSchema,
  hvdcLinkDefinitionSchema,
  hvdcLinkStateSchema,
  hvdcTerminalStateSchema,
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
  'deblocked', 'blocked',
])
type AssetStatus = z.infer<typeof assetStatusSchema>

const searchPayloadSchema = z.object({
  gridId: z.string().min(1),
  text: z.string().max(200).default(''),
  kinds: z.array(assetKindSchema).max(6).optional(),
  status: z.array(assetStatusSchema).min(1).max(20).optional()
    .describe('Match any of these states: bus energized/de-energized; branch closed/open/tripped/derated; generator online/offline/starting/stopping/tripped; load normal/constrained/shed/outage; storage idle/charging/discharging/unavailable; HVDC link deblocked/blocked/tripped. An HVDC terminal (the bus of an external system reached only by HVDC, in no island) matches no state.'),
  islandId: z.string().min(1).optional().describe('Only assets in this island (world.electric-grid.islands.list); a branch or HVDC link matches when either end is in it. An HVDC terminal lies in no island.'),
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
  z.object({ ...listItemFields, kind: z.literal('bus'), definition: busDefinitionSchema, state: z.union([busStateSchema, hvdcTerminalStateSchema]).optional() }).strict(),
  z.object({ ...listItemFields, kind: z.literal('branch'), definition: branchDefinitionSchema, state: branchStateSchema }).strict(),
  z.object({ ...listItemFields, kind: z.literal('generator'), definition: generatorDefinitionSchema, state: generatorStateSchema }).strict(),
  z.object({
    ...listItemFields,
    kind: z.literal('load'),
    definition: loadDefinitionSchema,
    state: loadStateSchema,
    demandProfile: z.object({ definition: demandProfileDefinitionSchema, sample: demandSampleSchema }).strict()
      .describe('The daily profile the load follows and the demand sample its profileFactor is at.'),
  }).strict(),
  z.object({ ...listItemFields, kind: z.literal('storage'), definition: storageDefinitionSchema, state: storageStateSchema }).strict(),
  z.object({ ...listItemFields, kind: z.literal('hvdc'), definition: hvdcLinkDefinitionSchema, state: hvdcLinkStateSchema }).strict(),
])
const assetDetailResultSchema = z.object({ gridId: z.string(), asset: assetDetailSchema }).strict()

/** The demand profile a load follows, and the demand sample its profile factor is at. */
const demandProfileOf = (grid: GridRuntimeInstance, loadId: string) => {
  const tables = gridTablesFor(grid.definition)
  return {
    definition: grid.definition.model.demandProfiles[tables.loadDemandProfile[tables.loadIndexById.get(loadId)!]!]!,
    sample: gridDemandSampleClock(grid.demandSample),
  }
}

/** A Model asset, or an HVDC link, which the Model keeps apart from its AC assets. */
type SearchEntry = GridAssetIndexEntry | { readonly id: string; readonly label: string; readonly kind: 'hvdc'; readonly definition: GridHvdcLinkDefinition }

/** The Model's assets in Model order, then its HVDC links. */
const searchEntries = (grid: GridRuntimeInstance): ReadonlyArray<SearchEntry> => [
  ...grid.definition.index.assets,
  ...grid.definition.index.hvdcLinks.map(link => ({ id: link.id, label: link.label, kind: 'hvdc' as const, definition: link })),
]

const busIdsOf = (entry: SearchEntry): ReadonlyArray<string> => entry.kind === 'bus'
  ? [entry.id]
  : entry.kind === 'branch' || entry.kind === 'hvdc' ? [entry.definition.fromBusId, entry.definition.toBusId] : [entry.definition.busId]

const statusesOf = (grid: GridRuntimeInstance, entry: SearchEntry): ReadonlyArray<AssetStatus> => {
  if (entry.kind === 'bus') {
    // An HVDC terminal is outside Norwegian energisation.
    if (grid.hvdcTerminals.has(entry.id)) return []
    return [grid.busStates.get(entry.id)!.energized ? 'energized' : 'de-energized']
  }
  if (entry.kind === 'hvdc') return [grid.hvdcLinks.get(entry.id)!.state]
  if (entry.kind === 'branch') {
    const state = grid.branches.get(entry.id)!
    return [state.state, ...(state.availability < 1 ? ['derated' as const] : [])]
  }
  if (entry.kind === 'generator') return [grid.generators.get(entry.id)!.state]
  if (entry.kind === 'load') return [grid.loads.get(entry.id)!.serviceState]
  return [grid.storage.get(entry.id)!.state]
}

/** The sorted quantity of one asset, or null when the asset does not carry it. */
const sortValueOf = (grid: GridRuntimeInstance, entry: SearchEntry, sort: 'loading' | 'dispatch' | 'shed'): number | null => {
  if (sort === 'loading') return entry.kind === 'branch' ? grid.branches.get(entry.id)!.loadingPercent : null
  if (sort === 'dispatch') return entry.kind === 'generator' ? grid.generators.get(entry.id)!.dispatchMw : null
  if (entry.kind !== 'load') return null
  return grid.loads.get(entry.id)!.unservedMw
}

export const gridAssetSearchQuery = defineGridQuery({
  id: 'world.electric-grid.assets.search',
  title: 'Search Grid Assets',
  description: 'Searches stable private Grid Assets (buses, branches, generators, loads, storage and HVDC links) by text, kind, state, island and branch loading, sorted by Model order, loading, dispatch or unserved demand, with bounded pagination, live status, map targets and applicable operations. Example: tripped units are kinds [generator] with status [tripped] (branches tripped by protection match tripped too); overloaded corridors are kinds [branch] with minLoadingPercent 100 and sort loading.',
  searchTerms: ['search', 'find', 'assets', 'tripped units', 'overloaded lines', 'generators', 'loads', 'substations', 'søk', 'finn', 'komponenter', 'utfall', 'overbelastet', 'stasjon', 'kraftverk'],
  input: searchPayloadSchema,
  output: assetSearchResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const islandId = payload.islandId === undefined ? undefined : requireGridIsland(grid, payload.islandId)
    const statuses = payload.status === undefined ? undefined : new Set(payload.status)
    const matched = searchEntries(grid).filter(entry =>
      (payload.kinds === undefined || payload.kinds.includes(entry.kind))
      && (statuses === undefined || statusesOf(grid, entry).some(status => statuses.has(status)))
      && (islandId === undefined || busIdsOf(entry).some(busId => gridBusIslandId(grid, busId) === islandId))
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
      assets: ordered.slice(payload.offset, payload.offset + payload.limit).map(entry => entry.kind === 'hvdc'
        ? hvdcPresentationFor(grid, entry.definition)
        : assetPresentationFor(grid, gridAssetSnapshotFor(grid, entry.id)!)),
    }
  },
})

export const gridAssetGetQuery = defineGridQuery({
  id: 'world.electric-grid.asset.get',
  title: 'Get Grid Asset',
  description: 'Returns the Model definition with provenance, the current state, map target and applicable operations of one Grid Asset. Branch flow is positive from fromBusId to toBusId; storage and generator output are positive into the Grid; an HVDC link (kind hvdc) transfers positive from its Norwegian converter fromBusId, so positive exports from Norway. The bus of an external system reached only by HVDC is an HVDC terminal in no island: its state names the system\'s area and the links ending there.',
  searchTerms: ['asset detail', 'definition', 'provenance', 'state', 'parameters', 'detaljer', 'kilde', 'tilstand'],
  input: assetPayloadSchema,
  output: assetDetailResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const link = grid.definition.index.hvdcLinks.find(candidate => candidate.id === payload.assetId)
    if (link) {
      return { gridId: payload.gridId, asset: { ...hvdcPresentationFor(grid, link), definition: link, state: grid.hvdcLinks.get(link.id)! } }
    }
    const asset = gridAssetSnapshotFor(grid, payload.assetId)
    if (!asset) return rejectCapabilityTarget(
      `Grid Asset not found: ${payload.assetId}. Discover exact asset ids with world.electric-grid.assets.search.`,
    )
    const demandProfile = asset.kind === 'load' ? { demandProfile: demandProfileOf(grid, asset.id) } : {}
    return {
      gridId: payload.gridId,
      asset: { ...assetPresentationFor(grid, asset), definition: asset.definition, ...(asset.state === undefined ? {} : { state: asset.state }), ...demandProfile },
    }
  },
})
