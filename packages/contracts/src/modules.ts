import { z } from 'zod'
import { moduleIdSchema, type ModuleId } from './ids.ts'
import { moduleFailureSchema } from './workspaces.ts'

export const coreModuleIds = ['world', 'agents'].map(value => moduleIdSchema.parse(value)) as readonly ModuleId[]

export const moduleQueryOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ moduleId: moduleIdSchema, status: z.literal('ready') }).strict(),
  z.object({ moduleId: moduleIdSchema, status: z.literal('failed'), failure: moduleFailureSchema }).strict(),
])
export type ModuleQueryOutcome = z.infer<typeof moduleQueryOutcomeSchema>

const relativePathTemplateSchema = z.string().min(1).max(512).superRefine((value, ctx) => {
  if (!value.startsWith('/')) ctx.addIssue({ code: 'custom', message: 'path template must start with /' })
  if (value.includes('://')) ctx.addIssue({ code: 'custom', message: 'path template must not contain an origin' })
  if (!value.includes('{workspaceId}')) ctx.addIssue({ code: 'custom', message: 'path template must contain {workspaceId}' })
})

// A Module-level path answers without any Workspace, so it carries no template.
const modulePathSchema = z.string().min(1).max(512).superRefine((value, ctx) => {
  if (!value.startsWith('/')) ctx.addIssue({ code: 'custom', message: 'Module path must start with /' })
  if (value.includes('://')) ctx.addIssue({ code: 'custom', message: 'Module path must not contain an origin' })
  if (value.includes('{') || value.includes('}')) ctx.addIssue({ code: 'custom', message: 'Module path must not contain a template' })
})

const invocationPathTemplateSchema = relativePathTemplateSchema.superRefine((value, ctx) => {
  if (!value.includes('{capabilityId}')) ctx.addIssue({ code: 'custom', message: 'invocation path must contain {capabilityId}' })
})

export const workspaceModuleManifestSchema = z.object({
  module: z.object({
    id: moduleIdSchema,
    title: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(2048).optional(),
  }).strict(),
  endpoints: z.object({
    workspace: relativePathTemplateSchema,
    definitions: relativePathTemplateSchema,
    resources: relativePathTemplateSchema,
    capabilities: relativePathTemplateSchema,
    invoke: invocationPathTemplateSchema,
    featuredDefinitions: modulePathSchema,
  }).strict(),
  ui: z.object({
    workspace: relativePathTemplateSchema,
  }).strict().optional(),
}).strict()
export type WorkspaceModuleManifest = z.infer<typeof workspaceModuleManifestSchema>

export const moduleRegistrationSchema = z.object({
  moduleId: moduleIdSchema,
  internalBaseUrl: z.url(),
  manifestPath: z.string().min(1).max(256).startsWith('/'),
}).strict()
export type ModuleRegistration = z.infer<typeof moduleRegistrationSchema>
