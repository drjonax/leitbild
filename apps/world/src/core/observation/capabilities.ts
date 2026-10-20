/**
 * The exact query Capabilities a Pack declares observation content through
 * (WorldPack.observation). World core defines their input and output schemas
 * and which objects each call inspects; assembly refuses a Pack whose
 * Capability differs, so no Pack writes access code.
 */
import { z } from 'zod'
import { defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import type { SimulationCapability } from '../../simulation/protocol.ts'
import { observableRefSchema, refObjectId } from '../model/alerts.ts'
import { idSchema, objectIdSchema, type ObjectId } from '../model/ids.ts'
import { observableSchema, observationSchema } from './model.ts'
import { topologyGraphSchema } from './topology.ts'

const revisionSchema = z.string().min(1).max(128)
const unchangedSchema = z.object({ objectId: objectIdSchema, revision: revisionSchema, unchanged: z.literal(true) }).strict()

export const observationElementSchema = z.object({
  id: z.string().min(1).max(200),
  class: z.string().min(1).max(60),
  label: z.string().min(1).max(300),
  shortLabel: z.string().min(1).max(24).optional(),
  group: z.string().min(1).max(200).optional(),
}).strict()

export const observationDeclarationSchema = z.object({
  objectId: objectIdSchema,
  /** Changes whenever anything declared changes: plant model digest, grid build id, weather probe set. */
  revision: revisionSchema,
  observables: z.array(observableSchema).max(4096),
  elements: z.array(observationElementSchema).max(20_000).default([]),
}).strict().superRefine((declaration, context) => {
  const refs = declaration.observables.map(observable => observable.ref)
  if (new Set(refs).size !== refs.length) context.addIssue({ code: 'custom', message: 'duplicate observable ref' })
  if (refs.some(ref => refObjectId(ref) !== declaration.objectId)) context.addIssue({ code: 'custom', message: 'an observable belongs to the declaring object' })
  const elements = declaration.elements.map(element => element.id)
  if (new Set(elements).size !== elements.length) context.addIssue({ code: 'custom', message: 'duplicate element id' })
})

const shape = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O, inspect: (input: z.output<I>) => ReadonlyArray<ObjectId>) =>
  ({ input, output, inspectObjectIds: (raw: unknown) => inspect(input.parse(raw)) })

export const observationShapes = {
  declarations: shape(
    z.object({
      objectIds: z.array(objectIdSchema).min(1).max(16),
      elementIds: z.array(z.string().min(1).max(200)).max(256).optional(),
      /** objectId → the revision the caller holds; the Pack answers `unchanged` for it. */
      known: z.record(idSchema, revisionSchema).optional(),
    }).strict(),
    z.object({ declarations: z.array(z.union([observationDeclarationSchema, unchangedSchema])) }).strict(),
    input => input.objectIds,
  ),
  read: shape(
    z.union([
      z.object({ refs: z.array(observableRefSchema).min(1).max(64) }).strict(),
      z.object({ lead: z.object({ objectId: objectIdSchema, count: z.number().int().min(1).max(16) }).strict() }).strict(),
    ]),
    z.object({ observations: z.array(observationSchema), unknown: z.array(observableRefSchema) }).strict(),
    input => 'refs' in input ? [...new Set(input.refs.map(refObjectId))] : [input.lead.objectId],
  ),
  topology: shape(
    z.object({ objectId: objectIdSchema, known: revisionSchema.optional() }).strict(),
    z.union([topologyGraphSchema, unchangedSchema]),
    input => [input.objectId],
  ),
} as const

export type ObservationCapabilityKind = keyof typeof observationShapes
export type ObservationDeclaration = z.output<typeof observationDeclarationSchema>

/** A Pack's observation Capability: system audience, the core shape, the core inspect rule. */
export const defineObservationCapability = (
  kind: ObservationCapabilityKind,
  meta: { readonly id: string; readonly title: string; readonly description: string },
): SimulationCapability => defineSimulationQueryCapability({ ...meta, audience: 'system', ...observationShapes[kind] })
