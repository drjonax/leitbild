import { z } from 'zod'
import {
  capabilityIdSchema,
  definitionIdSchema,
  definitionRevisionIdSchema,
  definitionTypeSchema,
  moduleIdSchema,
  workspaceIdSchema,
} from './ids.ts'
import { moduleQueryOutcomeSchema } from './modules.ts'
import { relativeUiPathSchema } from './ui.ts'

const requireModuleNamespacedType = (reference: { readonly moduleId: string; readonly type: string }, ctx: z.RefinementCtx): void => {
  if (!reference.type.startsWith(`${reference.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['type'], message: 'Definition type must be namespaced by its owning Module' })
  }
}

export const workspaceDefinitionReferenceSchema = z.object({
  workspaceId: workspaceIdSchema,
  moduleId: moduleIdSchema,
  type: definitionTypeSchema,
  id: definitionIdSchema,
}).strict().superRefine(requireModuleNamespacedType)
export type WorkspaceDefinitionReference = z.infer<typeof workspaceDefinitionReferenceSchema>

export const workspaceDefinitionRevisionReferenceSchema = workspaceDefinitionReferenceSchema.extend({
  revisionId: definitionRevisionIdSchema,
}).strict()
export type WorkspaceDefinitionRevisionReference = z.infer<typeof workspaceDefinitionRevisionReferenceSchema>

export const moduleDefinitionDescriptorSchema = z.object({
  ref: workspaceDefinitionReferenceSchema,
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().min(1).max(4096).optional(),
  category: z.string().trim().min(1).max(128).optional(),
  uiPath: relativeUiPathSchema.optional(),
  currentRevisionId: definitionRevisionIdSchema,
  capabilityIds: z.array(capabilityIdSchema),
  inspectionCapabilityId: capabilityIdSchema.optional(),
  primaryCapabilityId: capabilityIdSchema.optional(),
  deleteCapabilityId: capabilityIdSchema.optional(),
}).strict().superRefine((definition, ctx) => {
  const seen = new Set<string>()
  definition.capabilityIds.forEach((capabilityId, index) => {
    if (!capabilityId.startsWith(`${definition.ref.moduleId}.`)) {
      ctx.addIssue({ code: 'custom', path: ['capabilityIds', index], message: 'Definition Capability must be owned by the Definition Module' })
    }
    if (seen.has(capabilityId)) {
      ctx.addIssue({ code: 'custom', path: ['capabilityIds', index], message: `duplicate Capability: ${capabilityId}` })
    }
    seen.add(capabilityId)
  })
  for (const field of ['inspectionCapabilityId', 'primaryCapabilityId', 'deleteCapabilityId'] as const) {
    if (definition[field] !== undefined && !seen.has(definition[field])) {
      ctx.addIssue({ code: 'custom', path: [field], message: 'Card Capability must be included in Definition capabilityIds' })
    }
  }
})
export type ModuleDefinitionDescriptor = z.infer<typeof moduleDefinitionDescriptorSchema>

export const moduleDefinitionCollectionSchema = z.object({
  definitions: z.array(moduleDefinitionDescriptorSchema),
  nextCursor: z.string().min(1).max(1024).optional(),
}).strict()
export type ModuleDefinitionCollection = z.infer<typeof moduleDefinitionCollectionSchema>

export const workspaceDefinitionCatalogSchema = z.object({
  workspaceId: workspaceIdSchema,
  modules: z.array(moduleQueryOutcomeSchema),
  definitions: z.array(moduleDefinitionDescriptorSchema),
}).strict().superRefine((catalog, ctx) => {
  const seenModules = new Set<string>()
  catalog.modules.forEach((outcome, index) => {
    if (seenModules.has(outcome.moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['modules', index, 'moduleId'], message: `duplicate Module outcome: ${outcome.moduleId}` })
    }
    seenModules.add(outcome.moduleId)
  })
  const seenDefinitions = new Set<string>()
  catalog.definitions.forEach((definition, index) => {
    if (definition.ref.workspaceId !== catalog.workspaceId) {
      ctx.addIssue({ code: 'custom', path: ['definitions', index, 'ref', 'workspaceId'], message: 'Definition belongs to another Workspace' })
    }
    const key = `${definition.ref.moduleId}:${definition.ref.type}:${definition.ref.id}`
    if (seenDefinitions.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['definitions', index, 'ref'], message: `duplicate Definition: ${key}` })
    }
    seenDefinitions.add(key)
  })
})
export type WorkspaceDefinitionCatalog = z.infer<typeof workspaceDefinitionCatalogSchema>

/** A Definition named without a Workspace: the identity every Workspace seeds it under. */
export const moduleDefinitionIdentitySchema = z.object({
  moduleId: moduleIdSchema,
  type: definitionTypeSchema,
  id: definitionIdSchema,
}).strict().superRefine(requireModuleNamespacedType)
export type ModuleDefinitionIdentity = z.infer<typeof moduleDefinitionIdentitySchema>

const definitionIdentityKey = (identity: ModuleDefinitionIdentity): string =>
  `${identity.moduleId}:${identity.type}:${identity.id}`

/**
 * One image of a featured Definition. `width` and `height` are its intrinsic
 * size, so a page reserves its box before it loads; each source is the same
 * image at one pixel width, for a srcset.
 */
export const definitionPreviewSchema = z.object({
  alt: z.string().trim().min(1).max(300),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  sources: z.array(z.object({
    path: relativeUiPathSchema,
    width: z.number().int().positive().max(8192),
  }).strict()).min(1).max(4),
}).strict().superRefine((preview, ctx) => {
  const widths = new Set<number>()
  preview.sources.forEach((source, index) => {
    if (widths.has(source.width)) ctx.addIssue({ code: 'custom', path: ['sources', index, 'width'], message: `duplicate preview source width: ${source.width}` })
    widths.add(source.width)
  })
})
export type DefinitionPreview = z.infer<typeof definitionPreviewSchema>

// A preview is served from its Module's own asset namespace, one plain path
// with no dot segments, query or fragment.
const modulePreviewPathPattern = /^\/assets\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)*[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/

/**
 * A Definition a Module features for newcomers, independent of any Workspace.
 * `revisionId` is the exact revision every Workspace seeds for it.
 */
export const moduleFeaturedDefinitionSchema = z.object({
  definition: moduleDefinitionIdentitySchema,
  revisionId: definitionRevisionIdSchema,
  title: z.string().trim().min(1).max(256),
  summary: z.string().trim().min(1).max(200),
  about: z.string().trim().min(1).max(1024),
  tags: z.array(z.string().trim().min(1).max(32)).min(1).max(4),
  previews: z.array(definitionPreviewSchema).min(1).max(4),
}).strict().superRefine((featured, ctx) => {
  featured.previews.forEach((preview, previewIndex) => {
    preview.sources.forEach((source, sourceIndex) => {
      if (modulePreviewPathPattern.exec(source.path)?.[1] !== featured.definition.moduleId) {
        ctx.addIssue({
          code: 'custom',
          path: ['previews', previewIndex, 'sources', sourceIndex, 'path'],
          message: `preview must be served under /assets/${featured.definition.moduleId}/`,
        })
      }
    })
  })
})
export type ModuleFeaturedDefinition = z.infer<typeof moduleFeaturedDefinitionSchema>

/**
 * A Definition a Module lists beside its featured ones for quick access,
 * independent of any Workspace: no previews, one short summary and one or two
 * tags. `revisionId` is the exact revision every Workspace seeds for it.
 */
export const moduleListedDefinitionSchema = z.object({
  definition: moduleDefinitionIdentitySchema,
  revisionId: definitionRevisionIdSchema,
  title: z.string().trim().min(1).max(256),
  summary: z.string().trim().min(1).max(200),
  tags: z.array(z.string().trim().min(1).max(32)).min(1).max(2),
}).strict()
export type ModuleListedDefinition = z.infer<typeof moduleListedDefinitionSchema>

// A Definition is featured or listed, once.
const requireUniqueDefinitions = (
  collection: { readonly definitions: ReadonlyArray<ModuleFeaturedDefinition>; readonly listed: ReadonlyArray<ModuleListedDefinition> },
  ctx: z.RefinementCtx,
): void => {
  const seen = new Set<string>()
  const check = (list: 'definitions' | 'listed', items: ReadonlyArray<{ readonly definition: ModuleDefinitionIdentity }>): void => {
    items.forEach((item, index) => {
      const key = definitionIdentityKey(item.definition)
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: [list, index, 'definition'], message: `duplicate ${list === 'definitions' ? 'featured' : 'listed'} Definition: ${key}` })
      }
      seen.add(key)
    })
  }
  check('definitions', collection.definitions)
  check('listed', collection.listed)
}

/** One Module's featured Definitions and its listed ones; array order is the Module's ranking. */
export const moduleFeaturedDefinitionCollectionSchema = z.object({
  definitions: z.array(moduleFeaturedDefinitionSchema).max(12),
  listed: z.array(moduleListedDefinitionSchema).max(12),
}).strict().superRefine(requireUniqueDefinitions)
export type ModuleFeaturedDefinitionCollection = z.infer<typeof moduleFeaturedDefinitionCollectionSchema>

/** Every installed Module's featured and listed Definitions, with one outcome per Module. */
export const featuredDefinitionCatalogSchema = z.object({
  modules: z.array(moduleQueryOutcomeSchema),
  definitions: z.array(moduleFeaturedDefinitionSchema),
  listed: z.array(moduleListedDefinitionSchema),
}).strict().superRefine((catalog, ctx) => {
  const ready = new Set<string>()
  const seenModules = new Set<string>()
  catalog.modules.forEach((outcome, index) => {
    if (seenModules.has(outcome.moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['modules', index, 'moduleId'], message: `duplicate Module outcome: ${outcome.moduleId}` })
    }
    seenModules.add(outcome.moduleId)
    if (outcome.status === 'ready') ready.add(outcome.moduleId)
  })
  const requireReady = (list: 'definitions' | 'listed', items: ReadonlyArray<{ readonly definition: ModuleDefinitionIdentity }>): void => {
    items.forEach((item, index) => {
      if (!ready.has(item.definition.moduleId)) {
        ctx.addIssue({ code: 'custom', path: [list, index, 'definition', 'moduleId'], message: `${list === 'definitions' ? 'featured' : 'listed'} Definition has no ready Module outcome` })
      }
    })
  }
  requireReady('definitions', catalog.definitions)
  requireReady('listed', catalog.listed)
  requireUniqueDefinitions(catalog, ctx)
})
export type FeaturedDefinitionCatalog = z.infer<typeof featuredDefinitionCatalogSchema>
