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

/** A declared observable reading exactly this value: what a command reads once the action that writes it has acted. */
const readingSchema = z.object({ ref: observableRefSchema, value: z.union([z.boolean(), z.number().finite(), z.string().min(1).max(80)]) }).strict()

/**
 * What an element leads with once it has been stopped (D-E, amending D-86): `lead`, what verifies the stop, first. It
 * has been stopped while every reading of one of the `when` sets holds (the commands one action that stops it writes,
 * as that action wrote them). Static: World reads the `when` refs each sample, so no Run stores a stop.
 */
export const stoppedLeadSchema = z.object({
  when: z.array(z.array(readingSchema).min(1).max(16)).min(1).max(4),
  lead: z.array(observableRefSchema).min(1).max(16),
}).strict()
  .refine(stopped => new Set(stopped.lead).size === stopped.lead.length, { message: 'a stop leads with each value once', path: ['lead'] })

export const observationElementSchema = z.object({
  id: z.string().min(1).max(200),
  class: z.string().min(1).max(60),
  label: z.string().min(1).max(300),
  shortLabel: z.string().min(1).max(24).optional(),
  group: z.string().min(1).max(200).optional(),
  /** The element this one is part of (a device its equipment bundles: a vessel's relief valve); its default carries the parent's lead values. */
  parent: z.string().min(1).max(200).optional(),
  /**
   * What the element's detail leads with, in order, other elements' values among them (a steam generator's feed lines'
   * flows), as its Pack judges now (Q22): where that changes (an operating mode), the declaration's revision changes.
   */
  lead: z.array(observableRefSchema).min(1).max(16).optional(),
  stopped: stoppedLeadSchema.optional(),
}).strict()
  .refine(element => element.parent !== element.id, { message: 'an element is not its own parent', path: ['parent'] })
  .refine(element => element.lead === undefined || new Set(element.lead).size === element.lead.length, { message: 'an element leads with each value once', path: ['lead'] })

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
  // Labels are object-local; World qualifies them with the object's label (R25).
  const labels = declaration.observables.map(observable => observable.label)
  if (new Set(labels).size !== labels.length) context.addIssue({ code: 'custom', message: 'duplicate observable label' })
  const elements = declaration.elements.map(element => element.id)
  if (new Set(elements).size !== elements.length) context.addIssue({ code: 'custom', message: 'duplicate element id' })
})

/** The most refs one read names: a whole-unit overview's values and bindings with its lead, in one call. */
export const OBSERVATION_READ_REFS = 256

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
  /**
   * Values by ref and, in the same call, an object's lead: what it leads with now, as its Pack ranks it (mode-aware), so
   * a sample asks each object once. `lead` answers those refs first first; each one's observation is in `observations`
   * with the refs' own, once.
   */
  read: shape(
    z.object({
      refs: z.array(observableRefSchema).max(OBSERVATION_READ_REFS),
      lead: z.object({ objectId: objectIdSchema, count: z.number().int().min(1).max(16) }).strict().optional(),
    }).strict().refine(input => input.refs.length > 0 || input.lead !== undefined, { message: 'read refs, a lead or both', path: ['refs'] }),
    z.object({ observations: z.array(observationSchema), unknown: z.array(observableRefSchema), lead: z.array(observableRefSchema).max(16).optional() }).strict(),
    input => [...new Set([...input.refs.map(refObjectId), ...input.lead === undefined ? [] : [input.lead.objectId]])],
  ),
  topology: shape(
    z.object({ objectId: objectIdSchema, known: revisionSchema.optional() }).strict(),
    z.union([topologyGraphSchema, unchangedSchema]),
    input => [input.objectId],
  ),
} as const

export type ObservationCapabilityKind = keyof typeof observationShapes
export type ObservationDeclaration = z.output<typeof observationDeclarationSchema>
export type StoppedLead = z.output<typeof stoppedLeadSchema>

/** A Pack's observation Capability: system audience, the core shape, the core inspect rule. */
export const defineObservationCapability = (
  kind: ObservationCapabilityKind,
  meta: { readonly id: string; readonly title: string; readonly description: string },
): SimulationCapability => defineSimulationQueryCapability({ ...meta, audience: 'system', ...observationShapes[kind] })
