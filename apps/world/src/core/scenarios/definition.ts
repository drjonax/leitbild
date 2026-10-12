import { z } from 'zod'
import { agentRestrictionsAreEmpty, agentRestrictionsInRoleRunMessage, agentRestrictionsSchema, electricalConnectionSpecSchema, idSchema, objectContextSchema, objectIdSchema, roleDeclarationIssues, scenarioRecordingSelectionSchema, scenarioRolePresetSchema, scenarioRoleSchema, scenarioSideSchema } from '../model/index.ts'
import { issueParams, scenarioTimelineSchema } from '../model/scenario.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const scenarioItemSchema = z.object({
  type: z.string().min(1),
  id: objectIdSchema,
  label: z.string().min(1),
  context: objectContextSchema.optional(),
}).passthrough()
const startingMapViewSchema = z.object({
  center: lonLatSchema,
  zoom: z.number().finite().min(0).max(24),
  hiddenLayers: z.array(z.string().min(1)).default([]),
}).strict()

const startingRailSectionSchema = z.object({
  categoryId: idSchema,
  visible: z.boolean().default(true),
  collapsed: z.boolean().default(false),
  visibleFields: z.array(idSchema).default([]),
}).strict()

const startingRailViewSchema = z.object({
  sections: z.array(startingRailSectionSchema).default([]),
}).strict()

const scenarioViewSchema = z.object({
  map: startingMapViewSchema,
  rail: startingRailViewSchema.optional(),
}).strict()

const scenarioPackSelectionSchema = z.object({
  id: idSchema,
  runtime: idSchema.optional(),
  config: z.unknown().default({}),
  items: z.array(scenarioItemSchema).default([]),
  recording: scenarioRecordingSelectionSchema.omit({ packId: true }).optional(),
}).strict()

export const scenarioDefinitionSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  objectives: z.array(z.string().min(1)).default([]),
  agentRestrictions: agentRestrictionsSchema.default({ operationIds: [], objects: [] }),
  /** Play perspectives; a Scenario without them runs in open mode. */
  roles: z.array(scenarioRoleSchema).min(1).optional(),
  rolePresets: z.array(scenarioRolePresetSchema).min(1).optional(),
  /** Visibility keys: what each role sees. Needs roles; without sides every role sees everything. */
  sides: z.array(scenarioSideSchema).min(1).optional(),
  packs: z.array(scenarioPackSelectionSchema).min(1),
  world: z.object({
    startsAt: z.string().datetime(),
    environment: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
  view: scenarioViewSchema,
  connections: z.array(electricalConnectionSpecSchema).default([]),
  timeline: scenarioTimelineSchema.optional(),
}).strict().superRefine((source, ctx) => {
  const checkIds = (values: ReadonlyArray<string>, path: Array<string | number>) => {
    const seen = new Set<string>()
    values.forEach((id, index) => { if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [...path, index], message: `duplicate id: ${id}` }); seen.add(id) })
  }
  checkIds(source.view.rail?.sections.map(section => section.categoryId) ?? [], ['view', 'rail', 'sections'])
  // A preset may name a role a Pack derives; compile checks every member against the merged roles.
  for (const issue of roleDeclarationIssues(source.roles, source.rolePresets, source.sides, 'declared')) {
    ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message, ...issueParams(issue) })
  }
  if (source.roles !== undefined && !agentRestrictionsAreEmpty(source.agentRestrictions)) {
    ctx.addIssue({ code: 'custom', path: ['agentRestrictions'], message: agentRestrictionsInRoleRunMessage, params: { code: 'agent_restrictions_in_role_run' } })
  }
  const packs = new Set<string>()
  const items = new Set<string>()
  source.packs.forEach((selection, index) => {
    if (packs.has(selection.id)) ctx.addIssue({ code: 'custom', path: ['packs', index, 'id'], message: `duplicate Pack: ${selection.id}` })
    packs.add(selection.id)
    selection.items.forEach((item, itemIndex) => {
      if (items.has(item.id)) ctx.addIssue({ code: 'custom', path: ['packs', index, 'items', itemIndex, 'id'], message: `duplicate item: ${item.id}` })
      items.add(item.id)
    })
  })
  const connectionIds = new Set<string>()
  const connectedEndpoints = new Set<string>()
  source.connections.forEach((connection, index) => {
    if (connectionIds.has(connection.id)) {
      ctx.addIssue({ code: 'custom', path: ['connections', index, 'id'], message: `duplicate electrical connection id: ${connection.id}` })
    }
    connectionIds.add(connection.id)
    for (const [role, endpoint] of [['system', connection.system], ['network', connection.network]] as const) {
      const key = `${endpoint.objectId}\u0000${endpoint.portId}`
      if (connectedEndpoints.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['connections', index, role], message: `electrical port is connected more than once: ${endpoint.objectId}:${endpoint.portId}` })
      }
      connectedEndpoints.add(key)
    }
  })
})

export type ScenarioDefinition = z.infer<typeof scenarioDefinitionSchema>
