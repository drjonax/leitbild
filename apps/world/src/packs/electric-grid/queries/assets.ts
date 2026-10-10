import { z } from 'zod'
import { matchesLiteralSearch } from '../../../core/model/index.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { gridAssetSnapshotFor } from '../runtime/instance.ts'
import { assetListItemSchema, assetPresentationFor } from './asset-presentation.ts'
import { assetKindSchema, defineGridQuery, gridFor } from './common.ts'

const searchPayloadSchema = z.object({
  gridId: z.string().min(1),
  text: z.string().max(200).default(''),
  kinds: z.array(assetKindSchema).max(5).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
}).strict()
const assetPayloadSchema = z.object({ gridId: z.string().min(1), assetId: z.string().min(1) }).strict()
const assetSearchResultSchema = z.object({
  gridId: z.string(),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  assets: z.array(assetListItemSchema),
}).strict()
const assetDetailResultSchema = z.object({
  gridId: z.string(),
  asset: assetListItemSchema.extend({
    definition: z.record(z.string(), z.unknown()),
    state: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict()

export const gridAssetSearchQuery = defineGridQuery({
  id: 'world.electric-grid.assets.search',
  title: 'Search Grid Assets',
  description: 'Searches stable private Grid Assets with bounded pagination, live status, map targets, and applicable operations.',
  input: searchPayloadSchema,
  output: assetSearchResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const matched = grid.definition.index.assets.filter(asset =>
      (payload.kinds === undefined || payload.kinds.includes(asset.kind))
      && matchesLiteralSearch(payload.text, [asset.id, asset.label, asset.kind]))
    const page = matched.slice(payload.offset, payload.offset + payload.limit)
    return {
      gridId: payload.gridId,
      total: matched.length,
      offset: payload.offset,
      limit: payload.limit,
      assets: page.map(entry => assetPresentationFor(grid, gridAssetSnapshotFor(grid, entry.id)!)),
    }
  },
})

export const gridAssetGetQuery = defineGridQuery({
  id: 'world.electric-grid.asset.get',
  title: 'Get Grid Asset',
  description: 'Returns configuration, provenance, current state, map target, and applicable operations for one Grid Asset.',
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
