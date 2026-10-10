import { z } from 'zod'
import { gridOperatingPointOverridesSchema } from '../config.ts'
import { electricGridDefinitionCatalog } from '../definition-refs.ts'
import { defineGridQuery, genericObjectSchema } from './common.ts'

const emptyPayloadSchema = z.object({}).strict()
const catalogResultSchema = z.object({
  models: z.array(genericObjectSchema),
  operatingPoints: z.array(genericObjectSchema),
  automations: z.array(genericObjectSchema),
  operatingPointOverridesSchema: genericObjectSchema,
  grids: z.array(genericObjectSchema),
}).strict()

export const gridCatalogQuery = defineGridQuery({
  id: 'world.electric-grid.catalog.list',
  title: 'List Grid catalog',
  description: 'Lists compatible Grid definitions, accepted overrides, and running Grids.',
  input: emptyPayloadSchema,
  output: catalogResultSchema,
  answer: (_payload, grids) => ({
    ...electricGridDefinitionCatalog,
    operatingPointOverridesSchema: z.toJSONSchema(gridOperatingPointOverridesSchema),
    grids: [...grids.values()].map(grid => ({
      id: grid.definition.gridId,
      model: { id: grid.definition.model.id, title: grid.definition.model.title },
      operatingPoint: { id: grid.definition.operatingPoint.id, title: grid.definition.operatingPoint.title },
      automation: { id: grid.definition.automation.id, title: grid.definition.automation.title },
      diagnostics: {
        model: grid.definition.index.diagnostics,
        runtime: { ...grid.diagnostics },
      },
    })),
  }),
})
