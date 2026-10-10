import { z } from 'zod'
import { gridProjectionSchema } from '../model.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { defineGridQuery, genericObjectSchema, gridFor, gridPayloadSchema } from './common.ts'

const summaryResultSchema = z.object({
  gridId: z.string(),
  model: genericObjectSchema,
  operatingPoint: genericObjectSchema,
  automation: genericObjectSchema,
  projection: gridProjectionSchema,
  assetCounts: z.record(z.string(), z.number().int().nonnegative()),
  diagnostics: genericObjectSchema,
  constrainedBranches: z.array(genericObjectSchema),
  generators: z.array(genericObjectSchema),
  affectedLoads: z.array(genericObjectSchema),
}).strict()

const summaryFor = (grid: GridRuntimeInstance) => {
  const counts = {
    bus: grid.definition.model.buses.length,
    branch: grid.definition.model.branches.length,
    generator: grid.definition.model.generators.length,
    load: grid.definition.model.loads.length,
    storage: grid.definition.model.storage.length,
  }
  const constrainedBranches = grid.definition.model.branches
    .map(definition => ({ id: definition.id, label: definition.label, kind: definition.kind, state: grid.branches.get(definition.id)! }))
    .sort((left, right) => right.state.loadingPercent - left.state.loadingPercent)
    .slice(0, 8)
  const generators = grid.definition.model.generators
    .map(definition => ({ id: definition.id, label: definition.label, kind: definition.kind, state: grid.generators.get(definition.id)! }))
    .sort((left, right) => right.state.dispatchMw - left.state.dispatchMw)
    .slice(0, 12)
  const affectedLoads = grid.definition.model.loads
    .map(definition => ({ id: definition.id, label: definition.label, kind: definition.kind, state: grid.loads.get(definition.id)! }))
    .sort((left, right) => right.state.shedMw - left.state.shedMw)
    .slice(0, 8)
  return {
    gridId: grid.definition.gridId,
    model: {
      id: grid.definition.model.id,
      title: grid.definition.model.title,
      description: grid.definition.model.description,
      sourceIds: grid.definition.model.sourceIds,
      sourceBuild: grid.definition.model.sourceBuild,
      fidelity: grid.definition.model.fidelity,
    },
    operatingPoint: { ...grid.definition.operatingPoint },
    automation: { ...grid.definition.automation },
    projection: grid.projection,
    assetCounts: counts,
    diagnostics: {
      model: grid.definition.index.diagnostics,
      runtime: { ...grid.diagnostics },
    },
    constrainedBranches,
    generators,
    affectedLoads,
  }
}

export const gridSummaryQuery = defineGridQuery({
  id: 'world.electric-grid.grid.summary',
  title: 'Get Grid summary',
  description: 'Returns bounded operational, asset-count, fidelity, and model diagnostics for one Grid.',
  input: gridPayloadSchema,
  output: summaryResultSchema,
  answer: (payload, grids) => summaryFor(gridFor(grids, payload.gridId)),
})
