import { z } from 'zod'
import { gridDataError, parseGridData, type GridDataIssue } from './data-issues.ts'
import { gridIdPatterns } from './grid-ids.ts'
import {
  gridBranchSchema,
  gridBusSchema,
  gridConnectionPointSchema,
  gridExternalSystemSchema,
  gridGeneratorSchema,
  gridHvdcLinkSchema,
  gridLoadSchema,
  gridModelSchema,
  gridShuntSchema,
  gridSourceInputSchema,
  type GridModelV2,
} from './grid-model.ts'

// The only Grid composition fragment: one level, an explicit base Grid Model, additive only.
// It appends assets to the base collections below; it cannot remove, patch or inherit assets,
// and adds no storage. HVDC ramp groups stay the base Model's: an addition neither adds a group
// nor puts its own links into one.

/** The base collections an addition appends to, in Grid Model v2 order. */
const additiveCollections = ['buses', 'branches', 'hvdcLinks', 'externalSystems', 'generators', 'loads', 'shunts', 'connectionPoints'] as const
type AdditiveCollection = typeof additiveCollections[number]

const subject = 'Grid Model Addition v2'
const definitionRef = z.string().regex(gridIdPatterns.definitionRef, 'must be an electric-grid definition ref')

export const gridModelAdditionSchema = z.object({
  schemaVersion: z.literal(2),
  id: definitionRef,
  title: z.string().min(1),
  description: z.string().min(1),
  baseModelRef: definitionRef,
  /** Inputs this addition's provenance cites beyond the base model's source build. */
  sourceInputs: z.array(gridSourceInputSchema),
  buses: z.array(gridBusSchema),
  branches: z.array(gridBranchSchema),
  hvdcLinks: z.array(gridHvdcLinkSchema),
  externalSystems: z.array(gridExternalSystemSchema),
  generators: z.array(gridGeneratorSchema),
  loads: z.array(gridLoadSchema),
  shunts: z.array(gridShuntSchema),
  connectionPoints: z.array(gridConnectionPointSchema),
  hvdcRampGroups: z.never({ error: 'HVDC ramp groups belong to the base Grid Model; a Model Addition cannot add or change one' }).optional(),
}).strict().superRefine((addition, context) => {
  if (addition.baseModelRef === addition.id) context.addIssue({ code: 'custom', path: ['baseModelRef'], message: 'an addition cannot be its own base' })
})
export type GridModelAdditionV2 = z.infer<typeof gridModelAdditionSchema>

export const validateGridModelAddition = (json: unknown, source: string): GridModelAdditionV2 =>
  parseGridData(gridModelAdditionSchema, json, source, subject)

/** What an addition's baseModelRef resolves to. */
export type GridModelArtifact =
  | { readonly kind: 'model'; readonly model: GridModelV2 }
  | { readonly kind: 'addition'; readonly addition: GridModelAdditionV2 }

/** Maps an issue on the composed model back to the addition file where the addition caused it. */
const additionIssue = (issue: GridDataIssue, base: GridModelV2): GridDataIssue => {
  const [collection, index, ...rest] = issue.path
  if (typeof index === 'number' && (additiveCollections as ReadonlyArray<PropertyKey>).includes(collection as PropertyKey)) {
    const baseLength = base[collection as AdditiveCollection].length
    if (index >= baseLength) return { path: [collection as PropertyKey, index - baseLength, ...rest], message: issue.message }
  }
  if (collection === 'sourceBuild' && index === 'inputs' && typeof rest[0] === 'number' && rest[0] >= base.sourceBuild.inputs.length) {
    return { path: ['sourceInputs', rest[0] - base.sourceBuild.inputs.length, ...rest.slice(1)], message: issue.message }
  }
  return { path: ['baseModelRef'], message: `composed with ${base.id}, ${issue.path.map(String).join('.')}: ${issue.message}` }
}

/** Composes an addition onto its base Grid Model and validates the result as a Grid Model v2. */
export const composeGridModel = (config: {
  readonly addition: GridModelAdditionV2
  readonly base: GridModelArtifact | undefined
  readonly source: string
}): GridModelV2 => {
  const { addition, base, source } = config
  const reject = (message: string): never => { throw gridDataError(source, subject, [{ path: ['baseModelRef'], message }]) }
  if (base === undefined) return reject(`unknown Grid Model ${addition.baseModelRef}`)
  if (base.kind === 'addition') return reject(`${addition.baseModelRef} is itself a Model Addition; additions compose onto a base Grid Model only`)
  if (base.model.id !== addition.baseModelRef) return reject(`resolved base ${base.model.id} is not ${addition.baseModelRef}`)
  const model = base.model
  const composed = {
    ...model,
    id: addition.id,
    title: addition.title,
    description: addition.description,
    sourceBuild: { id: model.sourceBuild.id, inputs: [...model.sourceBuild.inputs, ...addition.sourceInputs] },
    ...Object.fromEntries(additiveCollections.map(collection => [collection, [...model[collection], ...addition[collection]]])),
  }
  const parsed = gridModelSchema.safeParse(composed)
  if (!parsed.success) throw gridDataError(source, subject, parsed.error.issues.map(issue => additionIssue(issue, model)))
  return parsed.data
}
