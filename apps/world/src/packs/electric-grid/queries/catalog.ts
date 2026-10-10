import { z } from 'zod'
import { gridOperatingPointOverridesSchema } from '../config.ts'
import { electricGridDefinitionCatalog } from '../definition-refs.ts'
import { defineGridQuery } from './common.ts'

const emptyPayloadSchema = z.object({}).strict()
const titledRefSchema = z.object({ id: z.string(), title: z.string() }).strict()
export const modelFidelitySchema = z.object({
  powerFlow: z.string(),
  voltage: z.string(),
  frequency: z.string(),
  recommendedMaximumBusCount: z.number().int().positive(),
}).strict()
export const modelDiagnosticsSchema = z.object({
  assetCount: z.number().int().nonnegative(),
  topologyComponentCount: z.number().int().nonnegative(),
  isolatedBusCount: z.number().int().nonnegative(),
}).strict()
const compatibleDefinitionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  compatibleModelRefs: z.array(z.string()),
}).strict()
const catalogResultSchema = z.object({
  models: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    nominalFrequencyHz: z.number().positive(),
    fidelity: modelFidelitySchema,
    assetCounts: z.object({
      bus: z.number().int().nonnegative(),
      branch: z.number().int().nonnegative(),
      generator: z.number().int().nonnegative(),
      load: z.number().int().nonnegative(),
      storage: z.number().int().nonnegative(),
      connectionPoint: z.number().int().nonnegative(),
    }).strict(),
    connectionPoints: z.array(z.object({
      id: z.string(),
      label: z.string(),
      busId: z.string(),
      nominalKv: z.number().positive(),
      maximumExportMw: z.number().nonnegative(),
      maximumImportMw: z.number().nonnegative(),
    }).strict()),
  }).strict()),
  operatingPoints: z.array(compatibleDefinitionSchema),
  automations: z.array(compatibleDefinitionSchema),
  operatingPointOverridesSchema: z.record(z.string(), z.unknown()).describe('JSON Schema of the accepted Operating Point overrides.'),
  grids: z.array(z.object({
    id: z.string(),
    model: titledRefSchema,
    operatingPoint: titledRefSchema,
    automation: titledRefSchema,
    modelDiagnostics: modelDiagnosticsSchema,
  }).strict()),
}).strict()

interface CompatibleCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly compatibleModelRefs: ReadonlyArray<string>
}

const compatibleDefinition = (entry: CompatibleCatalogEntry): z.infer<typeof compatibleDefinitionSchema> => ({
  id: entry.id,
  title: entry.title,
  description: entry.description,
  compatibleModelRefs: [...entry.compatibleModelRefs],
})

export const gridCatalogQuery = defineGridQuery({
  id: 'world.electric-grid.catalog.list',
  title: 'List Grid catalog',
  description: 'Lists compatible Grid Models, Operating Points and Automations, the accepted Operating Point overrides, and the running Grids with their Model diagnostics. Per-Grid runtime state is read with grid.summary.',
  searchTerms: ['catalog', 'grid models', 'operating points', 'automation', 'running grids', 'katalog', 'nettmodell', 'driftspunkt'],
  input: emptyPayloadSchema,
  output: catalogResultSchema,
  answer: (_payload, grids) => ({
    models: electricGridDefinitionCatalog.models.map(model => ({
      id: model.id,
      title: model.title,
      description: model.description,
      nominalFrequencyHz: model.nominalFrequencyHz,
      fidelity: model.fidelity,
      assetCounts: model.assetCounts,
      connectionPoints: model.connectionPoints,
    })),
    operatingPoints: electricGridDefinitionCatalog.operatingPoints.map(compatibleDefinition),
    automations: electricGridDefinitionCatalog.automations.map(compatibleDefinition),
    operatingPointOverridesSchema: z.toJSONSchema(gridOperatingPointOverridesSchema),
    grids: [...grids.values()].map(grid => ({
      id: grid.definition.gridId,
      model: { id: grid.definition.model.id, title: grid.definition.model.title },
      operatingPoint: { id: grid.definition.operatingPoint.id, title: grid.definition.operatingPoint.title },
      automation: { id: grid.definition.automation.id, title: grid.definition.automation.title },
      modelDiagnostics: grid.definition.index.diagnostics,
    })),
  }),
})
