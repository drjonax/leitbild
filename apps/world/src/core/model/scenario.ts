import { z } from 'zod'
import { electricalConnectionDefinitionSchema,type ElectricalConnectionDefinition } from './electrical.ts'
import { geoJsonPointSchema,type GeoJsonPoint } from './geo.ts'
import { idSchema,objectIdSchema,signalIdSchema,type ObjectId,type SignalId } from './ids.ts'
import { interactionEndpointSchema,type InteractionEndpoint } from './interactions.ts'
import { operationalObjectSchema,type OperationalObject } from './object.ts'
import { scenarioRecordingSelectionSchema,type ScenarioRecordingSelection } from './recording.ts'
import { roleDeclarationIssues,runRolesSchema,scenarioRolePresetSchema,scenarioRoleSchema,scenarioSideSchema,type RoleDeclarationIssue,type RunRoles,type ScenarioRole,type ScenarioRolePreset,type ScenarioSide } from './roles.ts'
import { sidedObjectAudienceIssue,type ObjectAudience } from './audience.ts'
import { isoTimestampSchema,type IsoTimestamp } from './time.ts'

export interface ScenarioWorldDefinition {
  readonly startsAt: IsoTimestamp
  readonly environment: Record<string, unknown>
}

export type MapLayerId = string

export interface StartingMapView {
  readonly center: GeoJsonPoint
  readonly zoom: number
  readonly layers: ReadonlyArray<MapLayerId>
}

export interface StartingRailSection {
  readonly categoryId: string
  readonly visible: boolean
  readonly collapsed: boolean
  readonly visibleFields: ReadonlyArray<string>
}

export interface StartingRailView {
  readonly sections: ReadonlyArray<StartingRailSection>
}

export interface StartingView {
  readonly map: StartingMapView
  readonly rail: StartingRailView
}

export interface ScenarioGuidance {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly objectIds: ReadonlyArray<ObjectId>
  readonly dismissible: boolean
  readonly tone?: 'default' | 'update'
}

export interface ScenarioTimelineProgressState {
  readonly startedAt: IsoTimestamp
  readonly firedCueIds: ReadonlyArray<string>
}

export interface ScenarioExecutionState {
  readonly scenarioId: string
  readonly agentRestrictions: AgentRestrictionsState
  /** The Run's roles, copied from its Compiled Scenario; absent in open mode. */
  readonly roles?: RunRoles
  readonly guidance?: ScenarioGuidance
  readonly highlightedObjectIds: ReadonlyArray<ObjectId>
  readonly timeline?: ScenarioTimelineProgressState
}

export interface AgentRestrictions {
  readonly operationIds: ReadonlyArray<string>
  readonly objects: ReadonlyArray<{
    readonly objectId: ObjectId
    readonly deny: ReadonlyArray<'inspect' | 'change'>
  }>
}

export interface AgentRestrictionsState extends AgentRestrictions {
  readonly revision: number
}

export interface ScenarioTimeRef {
  readonly kind: 'after_scenario_start'
  readonly seconds: number
}

export type ScenarioTimelineAction =
  | {
      readonly type: 'show_guidance'
      readonly guidance: ScenarioGuidance
    }
  | {
      readonly type: 'hide_guidance'
      readonly guidanceId?: string
    }
  | {
      readonly type: 'highlight_objects'
      readonly objectIds: ReadonlyArray<ObjectId>
    }
  | {
      readonly type: 'clear_highlights'
      readonly objectIds?: ReadonlyArray<ObjectId>
    }
  | {
      readonly type: 'emit_signal'
      readonly signal: {
        readonly id: SignalId
        readonly source: InteractionEndpoint
        readonly targets: ReadonlyArray<InteractionEndpoint>
        readonly signalType: string
        readonly payload: unknown
        readonly severity?: 'info' | 'notice' | 'warning' | 'critical'
        readonly correlationId?: string
        readonly causationId?: string
        readonly ttlMs?: number
      }
    }
  | {
      readonly type: 'invoke_capability'
      readonly capabilityId: string
      readonly input: unknown
    }

export interface ScenarioTimelineCue {
  readonly id: string
  readonly at: ScenarioTimeRef
  readonly title?: string
  readonly actions: ReadonlyArray<ScenarioTimelineAction>
}

export interface ScenarioTimeline {
  readonly cues: ReadonlyArray<ScenarioTimelineCue>
}

export interface CompiledScenario {
  readonly id: string
  readonly schemaVersion: 1
  readonly title: string
  readonly description?: string
  readonly objectives?: ReadonlyArray<string>
  readonly agentRestrictions: AgentRestrictions
  readonly roles?: ReadonlyArray<ScenarioRole>
  readonly rolePresets?: ReadonlyArray<ScenarioRolePreset>
  /** Visibility keys for the roles' pictures; absent when the Scenario declares none. */
  readonly sides?: ReadonlyArray<ScenarioSide>
  readonly packs: ReadonlyArray<string>
  readonly packRuntimes: Record<string, string>
  readonly packConfigs: Record<string, unknown>
  readonly connections: ReadonlyArray<ElectricalConnectionDefinition>
  readonly world: ScenarioWorldDefinition
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly view: StartingView
  readonly recording: ReadonlyArray<ScenarioRecordingSelection>
  readonly timeline?: ScenarioTimeline
}

export const scenarioWorldDefinitionSchema = z.object({
  startsAt: isoTimestampSchema,
  environment: z.record(z.string(), z.unknown()).default({}),
})

export const mapLayerIdSchema = z.string().min(1)

export const startingMapViewSchema = z.object({
  center: geoJsonPointSchema,
  zoom: z.number().finite().min(0).max(24),
  layers: z.array(mapLayerIdSchema),
})

export const startingRailSectionSchema = z.object({
  categoryId: idSchema,
  visible: z.boolean().default(true),
  collapsed: z.boolean().default(false),
  visibleFields: z.array(idSchema).default([]),
})

export const startingRailViewSchema = z.object({
  sections: z.array(startingRailSectionSchema).default([]),
})

export const startingViewSchema = z.object({
  map: startingMapViewSchema,
  rail: startingRailViewSchema,
}).strict()

export const scenarioGuidanceSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  message: z.string().min(1),
  objectIds: z.array(objectIdSchema).default([]),
  dismissible: z.boolean().default(true),
  tone: z.enum(['default', 'update']).default('default'),
}).strict()

export const scenarioTimelineProgressStateSchema = z.object({
  startedAt: isoTimestampSchema,
  firedCueIds: z.array(idSchema).default([]),
}).strict()

export const scenarioExecutionStateSchema = z.object({
  scenarioId: idSchema,
  agentRestrictions: z.lazy(() => agentRestrictionsStateSchema),
  roles: runRolesSchema.optional(),
  guidance: scenarioGuidanceSchema.optional(),
  highlightedObjectIds: z.array(objectIdSchema).default([]),
  timeline: scenarioTimelineProgressStateSchema.optional(),
}).strict().superRefine((state, ctx) => {
  if (state.roles === undefined) return
  for (const issue of roleDeclarationIssues(state.roles.roles, state.roles.presets, state.roles.sides)) {
    const [field, ...rest] = issue.path
    ctx.addIssue({ code: 'custom', path: ['roles', field === 'rolePresets' ? 'presets' : field ?? 'roles', ...rest], message: issue.message, ...issueParams(issue) })
  }
  if (!agentRestrictionsAreEmpty(state.agentRestrictions)) {
    ctx.addIssue({ code: 'custom', path: ['agentRestrictions'], message: agentRestrictionsInRoleRunMessage })
  }
})

/** A role-declaration issue's refusal code, as zod issue params callers read. */
export const issueParams = (issue: Pick<RoleDeclarationIssue, 'code'>): { readonly params?: { readonly code: string } } =>
  issue.code === undefined ? {} : { params: { code: issue.code } }

const operationIdSchema = z.string().regex(/^[a-z][a-z0-9-]*(?:[._-][a-z0-9-]+)+$/)

const agentRestrictionsBaseSchema = z.object({
  operationIds: z.array(operationIdSchema).default([]),
  objects: z.array(z.object({
    objectId: objectIdSchema,
    deny: z.array(z.enum(['inspect', 'change'])).min(1),
  }).strict()).default([]),
}).strict()

const validateAgentRestrictions = (restrictions: AgentRestrictions, ctx: z.RefinementCtx): void => {
  const operations = new Set<string>()
  restrictions.operationIds.forEach((id, index) => {
    if (operations.has(id)) ctx.addIssue({ code: 'custom', path: ['operationIds', index], message: `duplicate operation restriction: ${id}` })
    operations.add(id)
  })
  const objects = new Set<string>()
  restrictions.objects.forEach((entry, index) => {
    if (objects.has(entry.objectId)) ctx.addIssue({ code: 'custom', path: ['objects', index, 'objectId'], message: `duplicate object restriction: ${entry.objectId}` })
    objects.add(entry.objectId)
    if (new Set(entry.deny).size !== entry.deny.length) ctx.addIssue({ code: 'custom', path: ['objects', index, 'deny'], message: 'duplicate restriction effect' })
  })
}

export const agentRestrictionsSchema = agentRestrictionsBaseSchema.superRefine(validateAgentRestrictions)

export const agentRestrictionsAreEmpty = (restrictions: AgentRestrictions): boolean =>
  restrictions.operationIds.length === 0 && restrictions.objects.length === 0

/** A role Run carries no AI restrictions: AI is refused on role Runs, and the
 * restrictions' execution-state copy would carry object ids to every screen. */
export const agentRestrictionsInRoleRunMessage =
  'agent_restrictions_in_role_run: a Scenario that declares roles cannot restrict AI access, because AI is refused on role Runs'

export const agentRestrictionsStateSchema = agentRestrictionsBaseSchema.extend({
  revision: z.number().int().nonnegative(),
}).strict().superRefine(validateAgentRestrictions)

export const scenarioTimeRefSchema = z.object({
  kind: z.literal('after_scenario_start'),
  seconds: z.number().finite().nonnegative(),
}).strict()

export const scenarioTimelineActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('show_guidance'),
    guidance: scenarioGuidanceSchema,
  }).strict(),
  z.object({
    type: z.literal('hide_guidance'),
    guidanceId: idSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('highlight_objects'),
    objectIds: z.array(objectIdSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal('clear_highlights'),
    objectIds: z.array(objectIdSchema).optional(),
  }).strict(),
  z.object({
    type: z.literal('emit_signal'),
    signal: z.object({
      id: signalIdSchema,
      source: interactionEndpointSchema,
      targets: z.array(interactionEndpointSchema),
      signalType: idSchema,
      payload: z.unknown(),
      severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
      correlationId: idSchema.optional(),
      causationId: idSchema.optional(),
      ttlMs: z.number().finite().positive().optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('invoke_capability'),
    capabilityId: z.string().regex(/^world\.[a-z][a-z0-9-]*(?:[._-][a-z0-9-]+)+$/),
    input: z.custom<unknown>(value => value !== undefined, 'input is required'),
  }).strict(),
])

export const scenarioTimelineCueSchema = z.object({
  id: idSchema,
  at: scenarioTimeRefSchema,
  title: z.string().min(1).optional(),
  actions: z.array(scenarioTimelineActionSchema).min(1),
}).strict()

export const scenarioTimelineSchema = z.object({
  cues: z.array(scenarioTimelineCueSchema).default([]),
}).strict().superRefine((timeline, ctx) => {
  const seen = new Set<string>()
  for (const [index, cue] of timeline.cues.entries()) {
    if (seen.has(cue.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate scenario timeline cue id: ${cue.id}`,
        path: ['cues', index, 'id'],
      })
    }
    seen.add(cue.id)
  }
}).strict()

/**
 * A sided Scenario's initial objects each carry a valid audience, and its
 * guidance, which every side is shown, names only public objects.
 */
const sidedScenarioIssues = (
  sides: ReadonlyArray<ScenarioSide>,
  initialObjects: ReadonlyArray<{ readonly id: string; readonly audience?: ObjectAudience | undefined }>,
  timeline: { readonly cues: ReadonlyArray<{ readonly actions: ReadonlyArray<{ readonly type: string; readonly guidance?: { readonly id: string; readonly objectIds: ReadonlyArray<string> } }> }> } | undefined,
): ReadonlyArray<RoleDeclarationIssue> => {
  const issues: RoleDeclarationIssue[] = initialObjects.flatMap((object, index) => {
    const issue = sidedObjectAudienceIssue(object, undefined, sides)
    return issue === null ? [] : [{ path: ['initialObjects', index, 'audience'], code: issue.code, message: issue.message }]
  })
  const audiences = new Map<string, ObjectAudience | undefined>(initialObjects.map(object => [object.id, object.audience]))
  ;(timeline?.cues ?? []).forEach((cue, cueIndex) => cue.actions.forEach((action, actionIndex) => {
    if (action.type !== 'show_guidance' || action.guidance === undefined) return
    const guidance = action.guidance
    guidance.objectIds.forEach((objectId, objectIndex) => {
      if (audiences.get(objectId) === 'public') return
      issues.push({
        path: ['timeline', 'cues', cueIndex, 'actions', actionIndex, 'guidance', 'objectIds', objectIndex],
        code: 'guidance_references_sided_object',
        message: `guidance_references_sided_object: guidance ${guidance.id} names ${audiences.has(objectId) ? 'an object that is not public' : 'an object that is not an initial public object'}; every side is shown guidance, so it may name only public objects`,
      })
    })
  }))
  return issues
}

export const compiledScenarioSchema = z.object({
  id: idSchema,
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  objectives: z.array(z.string().trim().min(1).max(2048)).optional(),
  agentRestrictions: agentRestrictionsSchema,
  roles: z.array(scenarioRoleSchema).min(1).optional(),
  rolePresets: z.array(scenarioRolePresetSchema).min(1).optional(),
  sides: z.array(scenarioSideSchema).min(1).optional(),
  packs: z.array(idSchema).default([]),
  packRuntimes: z.record(z.string(), idSchema).default({}),
  packConfigs: z.record(z.string(), z.unknown()).default({}),
  connections: z.array(electricalConnectionDefinitionSchema).default([]),
  world: scenarioWorldDefinitionSchema,
  initialObjects: z.array(operationalObjectSchema),
  view: startingViewSchema,
  recording: z.array(scenarioRecordingSelectionSchema).default([]),
  timeline: scenarioTimelineSchema.optional(),
}).superRefine((scenario, ctx) => {
  for (const issue of roleDeclarationIssues(scenario.roles, scenario.rolePresets, scenario.sides)) {
    ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message, ...issueParams(issue) })
  }
  if (scenario.sides !== undefined) {
    for (const issue of sidedScenarioIssues(scenario.sides, scenario.initialObjects, scenario.timeline)) {
      ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message, ...issueParams(issue) })
    }
  }
  if (scenario.roles !== undefined && !agentRestrictionsAreEmpty(scenario.agentRestrictions)) {
    ctx.addIssue({ code: 'custom', path: ['agentRestrictions'], message: agentRestrictionsInRoleRunMessage, params: { code: 'agent_restrictions_in_role_run' } })
  }
  const objectIds = new Set(scenario.initialObjects.map(object => object.id))
  scenario.agentRestrictions.objects.forEach((entry, index) => {
    if (!objectIds.has(entry.objectId)) {
      ctx.addIssue({ code: 'custom', path: ['agentRestrictions', 'objects', index, 'objectId'], message: `AI restriction references unknown initial object: ${entry.objectId}` })
    }
  })
  const connectionIds = new Set<string>()
  const connectedPorts = new Set<string>()
  scenario.connections.forEach((connection, index) => {
    if (connectionIds.has(connection.id)) {
      ctx.addIssue({ code: 'custom', path: ['connections', index, 'id'], message: `duplicate electrical connection: ${connection.id}` })
    }
    connectionIds.add(connection.id)
    for (const [side, endpoint] of [['system', connection.system], ['network', connection.network]] as const) {
      const key = `${endpoint.objectId}:${endpoint.portId}`
      if (connectedPorts.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['connections', index, side], message: `electrical port is connected more than once: ${key}` })
      }
      connectedPorts.add(key)
    }
  })
  const packIds = new Set<string>()
  scenario.recording.forEach((selection, index) => {
    if (packIds.has(selection.packId)) {
      ctx.addIssue({ code: 'custom', path: ['recording', index, 'packId'], message: `duplicate recording selection for Pack: ${selection.packId}` })
    }
    packIds.add(selection.packId)
  })
})
