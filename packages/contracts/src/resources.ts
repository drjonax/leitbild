import { z } from 'zod'
import {
  capabilityIdSchema,
  definitionTypeSchema,
  isoTimestampSchema,
  moduleIdSchema,
  resourceIdSchema,
  resourceTypeSchema,
  workspaceIdSchema,
} from './ids.ts'
import { accessContextSchema, actorContextSchema } from './access.ts'
import { moduleQueryOutcomeSchema } from './modules.ts'
import { relativeUiPathSchema } from './ui.ts'
import {
  workspaceDefinitionRevisionReferenceSchema,
} from './definitions.ts'

export const workspaceResourceReferenceSchema = z.object({
  workspaceId: workspaceIdSchema,
  moduleId: moduleIdSchema,
  type: resourceTypeSchema,
  id: resourceIdSchema,
}).strict().superRefine((reference, ctx) => {
  if (!reference.type.startsWith(`${reference.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['type'], message: 'Resource type must be namespaced by its owning Module' })
  }
})
export type WorkspaceResourceReference = z.infer<typeof workspaceResourceReferenceSchema>

const uniqueReferences = (
  references: ReadonlyArray<WorkspaceResourceReference>,
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string | number>,
): void => {
  const seen = new Set<string>()
  references.forEach((reference, index) => {
    const key = `${reference.workspaceId}:${reference.moduleId}:${reference.type}:${reference.id}`
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [...path, index], message: 'duplicate Resource reference' })
    seen.add(key)
  })
}

const resourceCollectionScopeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all'), except: z.array(workspaceResourceReferenceSchema).default([]) }).strict(),
  z.object({ mode: z.literal('selected'), only: z.array(workspaceResourceReferenceSchema).min(1) }).strict(),
])

// A Room Scope is the only durable boundary on what an Assistant Room may
// discover and invoke. Access is open inside it; narrower run-owned
// restrictions are enforced by the target Module itself.
export const workspaceRoomScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }).strict(),
  z.object({ kind: z.literal('resource'), resource: workspaceResourceReferenceSchema }).strict(),
  z.object({
    kind: z.literal('collection'),
    collection: workspaceResourceReferenceSchema,
    members: resourceCollectionScopeSchema,
  }).strict(),
]).superRefine((scope, ctx) => {
  if (scope.kind !== 'collection') return
  const members = scope.members.mode === 'all' ? scope.members.except : scope.members.only
  uniqueReferences(members, ctx, ['members', scope.members.mode === 'all' ? 'except' : 'only'])
  members.forEach((reference, index) => {
    if (reference.workspaceId !== scope.collection.workspaceId) {
      ctx.addIssue({
        code: 'custom',
        path: ['members', scope.members.mode === 'all' ? 'except' : 'only', index, 'workspaceId'],
        message: 'Room Scope members must belong to the same Workspace',
      })
    }
  })
})
export type WorkspaceRoomScope = z.infer<typeof workspaceRoomScopeSchema>

// A transient subject can be a live Resource or an exact immutable Definition
// Revision. It is browser attention, not a durable relationship or grant.
export const workspaceSubjectReferenceSchema = z.union([
  workspaceDefinitionRevisionReferenceSchema,
  workspaceResourceReferenceSchema,
])
export type WorkspaceSubjectReference = z.infer<typeof workspaceSubjectReferenceSchema>

// Same-origin Host -> Module UI message. Multiple subjects let an Agent see
// the few things currently open without copying them into Room history.
export const workspaceSubjectFocusMessageSchema = z.object({
  type: z.literal('leitbild:subject-focus'),
  subjects: z.array(workspaceSubjectReferenceSchema).max(4),
}).strict()
export type WorkspaceSubjectFocusMessage = z.infer<typeof workspaceSubjectFocusMessageSchema>

const jsonSchemaSchema = z.record(z.string(), z.unknown())

// What a Capability's successful result publishes for other Modules to
// present, declared by its owning Module: `embedded-view` is an embedded view
// publication in the result's `view` (embedded-views.ts), which an Agent can
// present with its answer.
export const capabilityPublicationSchema = z.enum(['embedded-view'])
export type CapabilityPublication = z.infer<typeof capabilityPublicationSchema>

export const moduleCapabilityDescriptorSchema = z.object({
  id: capabilityIdSchema,
  moduleId: moduleIdSchema,
  kind: z.enum(['command', 'query']),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workspace') }).strict(),
    z.object({ kind: z.literal('definition'), definitionType: definitionTypeSchema }).strict(),
    z.object({ kind: z.literal('resource'), resourceType: resourceTypeSchema }).strict(),
  ]),
  title: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(2048),
  // Search-only vocabulary supplied by the owning Module. These terms help a
  // caller find an operation without turning labels or aliases into authority.
  searchTerms: z.array(z.string().trim().min(1).max(128)).optional(),
  risk: z.enum(['read', 'write', 'destructive']),
  // Reads exposing conversation evidence must opt out unless they honor a
  // comparison's historical conversation boundary.
  comparisonUnavailableReason: z.string().min(1).optional(),
  idempotent: z.boolean(),
  // Present only when the transport accepts a caller-supplied key for an
  // uncertain retry. This is distinct from semantic repeat safety.
  acceptsIdempotencyKey: z.literal(true).optional(),
  schedulable: z.boolean().optional(),
  publishes: z.array(capabilityPublicationSchema).min(1).optional(),
  inputSchema: jsonSchemaSchema,
  outputSchema: jsonSchemaSchema,
}).strict().superRefine((capability, ctx) => {
  if (capability.publishes !== undefined && new Set(capability.publishes).size !== capability.publishes.length) {
    ctx.addIssue({ code: 'custom', path: ['publishes'], message: 'A Capability names each publication once' })
  }
  if (capability.publishes?.includes('embedded-view') && capability.scope.kind !== 'resource') {
    ctx.addIssue({ code: 'custom', path: ['publishes'], message: 'An embedded view is published about the Resource a Capability is invoked on' })
  }
  if (!capability.id.startsWith(`${capability.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['id'], message: 'Capability id must be namespaced by its owning Module' })
  }
  if (capability.scope.kind === 'resource' && !capability.scope.resourceType.startsWith(`${capability.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'resourceType'], message: 'Resource type must be owned by the Capability Module' })
  }
  if (capability.scope.kind === 'definition' && !capability.scope.definitionType.startsWith(`${capability.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'definitionType'], message: 'Definition type must be owned by the Capability Module' })
  }
})
export type ModuleCapabilityDescriptor = z.infer<typeof moduleCapabilityDescriptorSchema>
export type ModuleCapabilityDescriptorInput = z.input<typeof moduleCapabilityDescriptorSchema>

export const moduleResourceLinkSchema = z.object({
  rel: z.string().trim().min(1).max(128),
  ref: workspaceResourceReferenceSchema,
  title: z.string().trim().min(1).max(256).optional(),
}).strict()
export type ModuleResourceLink = z.infer<typeof moduleResourceLinkSchema>

const resourceSummaryKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
const resourceSummaryItemBase = {
  key: resourceSummaryKeySchema,
  label: z.string().trim().min(1).max(64),
}

export const resourceSummaryItemSchema = z.discriminatedUnion('kind', [
  z.object({ ...resourceSummaryItemBase, kind: z.literal('count'), value: z.number().int().nonnegative() }).strict(),
  z.object({ ...resourceSummaryItemBase, kind: z.literal('timestamp'), value: isoTimestampSchema }).strict(),
  z.object({ ...resourceSummaryItemBase, kind: z.literal('status'), value: z.string().trim().min(1).max(128) }).strict(),
])
export type ResourceSummaryItem = z.infer<typeof resourceSummaryItemSchema>

export const resourceRenameInputSchema = z.object({
  name: z.string().trim().min(1).max(256).nullable(),
  expectedTitle: z.string().trim().min(1).max(256),
}).strict()

export const moduleResourceDescriptorSchema = z.object({
  ref: workspaceResourceReferenceSchema,
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().min(1).max(2048).optional(),
  sourceDefinition: workspaceDefinitionRevisionReferenceSchema.optional(),
  links: z.array(moduleResourceLinkSchema).default([]),
  uiPath: relativeUiPathSchema.optional(),
  capabilityIds: z.array(capabilityIdSchema),
  inspectionCapabilityId: capabilityIdSchema.optional(),
  deleteCapabilityId: capabilityIdSchema.optional(),
  renameCapabilityId: capabilityIdSchema.optional(),
  summary: z.array(resourceSummaryItemSchema).max(8).default([]),
  observedAt: isoTimestampSchema,
}).strict().superRefine((resource, ctx) => {
  const seen = new Set<string>()
  resource.capabilityIds.forEach((capabilityId, index) => {
    if (!capabilityId.startsWith(`${resource.ref.moduleId}.`)) {
      ctx.addIssue({ code: 'custom', path: ['capabilityIds', index], message: 'Resource Capability must be owned by the Resource Module' })
    }
    if (seen.has(capabilityId)) {
      ctx.addIssue({ code: 'custom', path: ['capabilityIds', index], message: `duplicate Capability: ${capabilityId}` })
    }
    seen.add(capabilityId)
  })
  for (const field of ['inspectionCapabilityId', 'deleteCapabilityId', 'renameCapabilityId'] as const) {
    if (resource[field] !== undefined && !seen.has(resource[field])) {
      ctx.addIssue({ code: 'custom', path: [field], message: 'Card Capability must be included in Resource capabilityIds' })
    }
  }
  if (resource.sourceDefinition !== undefined && (
    resource.sourceDefinition.workspaceId !== resource.ref.workspaceId
    || resource.sourceDefinition.moduleId !== resource.ref.moduleId
  )) {
    ctx.addIssue({ code: 'custom', path: ['sourceDefinition'], message: 'Resource source Definition must belong to the same Module and Workspace' })
  }
  resource.links.forEach((link, index) => {
    if (link.ref.workspaceId !== resource.ref.workspaceId) {
      ctx.addIssue({ code: 'custom', path: ['links', index, 'ref', 'workspaceId'], message: 'Linked Resource must belong to the same Workspace' })
    }
  })
  const summaryKeys = new Set<string>()
  resource.summary.forEach((item, index) => {
    if (summaryKeys.has(item.key)) {
      ctx.addIssue({ code: 'custom', path: ['summary', index, 'key'], message: `duplicate Resource Summary key: ${item.key}` })
    }
    summaryKeys.add(item.key)
  })
})
export type ModuleResourceDescriptor = z.infer<typeof moduleResourceDescriptorSchema>

export const moduleResourceCollectionSchema = z.object({
  resources: z.array(moduleResourceDescriptorSchema),
  nextCursor: z.string().min(1).max(1024).optional(),
}).strict()
export type ModuleResourceCollection = z.infer<typeof moduleResourceCollectionSchema>

export const moduleCapabilityCollectionSchema = z.object({
  capabilities: z.array(moduleCapabilityDescriptorSchema),
}).strict()
export type ModuleCapabilityCollection = z.infer<typeof moduleCapabilityCollectionSchema>

export const workspaceResourceCatalogSchema = z.object({
  workspaceId: workspaceIdSchema,
  modules: z.array(moduleQueryOutcomeSchema),
  resources: z.array(moduleResourceDescriptorSchema),
}).strict().superRefine((catalog, ctx) => {
  const seenModules = new Set<string>()
  catalog.modules.forEach((outcome, index) => {
    if (seenModules.has(outcome.moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['modules', index, 'moduleId'], message: `duplicate Module outcome: ${outcome.moduleId}` })
    }
    seenModules.add(outcome.moduleId)
  })
  const seenResources = new Set<string>()
  catalog.resources.forEach((resource, index) => {
    if (resource.ref.workspaceId !== catalog.workspaceId) {
      ctx.addIssue({ code: 'custom', path: ['resources', index, 'ref', 'workspaceId'], message: 'Resource belongs to another Workspace' })
    }
    const key = `${resource.ref.moduleId}:${resource.ref.type}:${resource.ref.id}`
    if (seenResources.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['resources', index, 'ref'], message: `duplicate Resource: ${key}` })
    }
    seenResources.add(key)
  })
})
export type WorkspaceResourceCatalog = z.infer<typeof workspaceResourceCatalogSchema>

export const workspaceCapabilityCatalogSchema = z.object({
  workspaceId: workspaceIdSchema,
  modules: z.array(moduleQueryOutcomeSchema),
  capabilities: z.array(moduleCapabilityDescriptorSchema),
}).strict().superRefine((catalog, ctx) => {
  const seenModules = new Set<string>()
  catalog.modules.forEach((outcome, index) => {
    if (seenModules.has(outcome.moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['modules', index, 'moduleId'], message: `duplicate Module outcome: ${outcome.moduleId}` })
    }
    seenModules.add(outcome.moduleId)
  })
  const seenCapabilities = new Set<string>()
  catalog.capabilities.forEach((capability, index) => {
    if (seenCapabilities.has(capability.id)) {
      ctx.addIssue({ code: 'custom', path: ['capabilities', index, 'id'], message: `duplicate Capability: ${capability.id}` })
    }
    seenCapabilities.add(capability.id)
  })
})
export type WorkspaceCapabilityCatalog = z.infer<typeof workspaceCapabilityCatalogSchema>

export const invokeCapabilityInputSchema = z.object({
  definition: workspaceDefinitionRevisionReferenceSchema.optional(),
  resource: workspaceResourceReferenceSchema.optional(),
  input: z.unknown(),
  expectedRevision: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
}).strict().superRefine((invocation, ctx) => {
  if (invocation.definition !== undefined && invocation.resource !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['definition'], message: 'Capability invocation cannot target both a Definition and a Resource' })
  }
})
export type InvokeCapabilityInput = z.infer<typeof invokeCapabilityInputSchema>

// Public Host request shape. `actor` is attribution supplied by the calling
// client, not authentication; a future auth adapter can replace or validate
// it before the Host constructs the authoritative AccessContext.
export const workspaceCapabilityInvocationRequestSchema = invokeCapabilityInputSchema.extend({
  actor: actorContextSchema.optional(),
}).strict()
export type WorkspaceCapabilityInvocationRequest = z.infer<typeof workspaceCapabilityInvocationRequestSchema>

export const moduleCapabilityInvocationSchema = z.object({
  workspaceId: workspaceIdSchema,
  capabilityId: capabilityIdSchema,
  definition: workspaceDefinitionRevisionReferenceSchema.optional(),
  resource: workspaceResourceReferenceSchema.optional(),
  input: z.unknown(),
  expectedRevision: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
  access: accessContextSchema,
}).strict().superRefine((invocation, ctx) => {
  if (invocation.access.workspaceId !== invocation.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['access', 'workspaceId'], message: 'Access context belongs to another Workspace' })
  }
  if (invocation.resource !== undefined && invocation.resource.workspaceId !== invocation.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['resource', 'workspaceId'], message: 'Resource belongs to another Workspace' })
  }
  if (invocation.definition !== undefined && invocation.definition.workspaceId !== invocation.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['definition', 'workspaceId'], message: 'Definition belongs to another Workspace' })
  }
  if (invocation.definition !== undefined && invocation.resource !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['definition'], message: 'Capability invocation cannot target both a Definition and a Resource' })
  }
})
export type ModuleCapabilityInvocation = z.infer<typeof moduleCapabilityInvocationSchema>

export const moduleCapabilityInvocationResultSchema = z.object({
  result: z.unknown(),
  createdResources: z.array(workspaceResourceReferenceSchema).optional(),
}).strict()
export type ModuleCapabilityInvocationResult = z.infer<typeof moduleCapabilityInvocationResultSchema>
