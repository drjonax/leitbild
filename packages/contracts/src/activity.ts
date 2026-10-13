import { z } from 'zod'
import { moduleIdSchema, workspaceIdSchema } from './ids.ts'
import { moduleQueryOutcomeSchema } from './modules.ts'

/**
 * One fact a Module states about a Workspace right now, written for people:
 * the Host shows `label` beside the Workspace without understanding it.
 * `active` marks work that uses the server at this moment, such as a
 * simulation advancing; `count` is the number the label states.
 */
export const workspaceActivityItemSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  label: z.string().trim().min(1).max(80),
  count: z.number().int().nonnegative(),
  active: z.boolean(),
}).strict()
export type WorkspaceActivityItem = z.infer<typeof workspaceActivityItemSchema>

const uniqueKeys = (items: ReadonlyArray<{ readonly key: string }>, ctx: z.RefinementCtx): void => {
  const seen = new Set<string>()
  items.forEach((item, index) => {
    if (seen.has(item.key)) ctx.addIssue({ code: 'custom', path: ['items', index, 'key'], message: `duplicate activity key: ${item.key}` })
    seen.add(item.key)
  })
}

export const moduleWorkspaceActivitySchema = z.object({
  workspaceId: workspaceIdSchema,
  items: z.array(workspaceActivityItemSchema).min(1).max(4),
}).strict().superRefine((workspace, ctx) => uniqueKeys(workspace.items, ctx))
export type ModuleWorkspaceActivity = z.infer<typeof moduleWorkspaceActivitySchema>

/**
 * A Module's activity in every Workspace, independent of any one Workspace.
 * A Module answers from what it already holds in memory or can list without
 * loading a Workspace runtime; a Workspace with nothing to report is left out.
 */
export const moduleActivitySchema = z.object({
  workspaces: z.array(moduleWorkspaceActivitySchema).max(10_000),
}).strict().superRefine((activity, ctx) => {
  const seen = new Set<string>()
  activity.workspaces.forEach((workspace, index) => {
    if (seen.has(workspace.workspaceId)) {
      ctx.addIssue({ code: 'custom', path: ['workspaces', index, 'workspaceId'], message: `duplicate Workspace: ${workspace.workspaceId}` })
    }
    seen.add(workspace.workspaceId)
  })
})
export type ModuleActivity = z.infer<typeof moduleActivitySchema>

export const workspaceActivityEntrySchema = workspaceActivityItemSchema.extend({ moduleId: moduleIdSchema }).strict()
export type WorkspaceActivityEntry = z.infer<typeof workspaceActivityEntrySchema>

/** Every installed Module's activity per Workspace, with one outcome per Module. */
export const workspaceActivityCatalogSchema = z.object({
  modules: z.array(moduleQueryOutcomeSchema),
  workspaces: z.array(z.object({
    workspaceId: workspaceIdSchema,
    items: z.array(workspaceActivityEntrySchema).min(1),
  }).strict()),
}).strict().superRefine((catalog, ctx) => {
  const seen = new Set<string>()
  catalog.workspaces.forEach((workspace, index) => {
    if (seen.has(workspace.workspaceId)) {
      ctx.addIssue({ code: 'custom', path: ['workspaces', index, 'workspaceId'], message: `duplicate Workspace: ${workspace.workspaceId}` })
    }
    seen.add(workspace.workspaceId)
  })
})
export type WorkspaceActivityCatalog = z.infer<typeof workspaceActivityCatalogSchema>
