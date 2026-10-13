import { runHistorianStatusSchema } from '../../features/historian/policy.ts'
import {
  inspectionViewSchema,
  moduleCapabilityCollectionSchema,
  moduleCapabilityInvocationSchema,
  moduleDefinitionCollectionSchema,
  moduleIdSchema,
  moduleResourceCollectionSchema,
  resourceRenameInputSchema,
  sourceDocumentPathSchema,
  sourceRevisionSchema,
  workspaceIdSchema,
  workspaceModuleManifestSchema,
  workspaceDefinitionRevisionReferenceSchema,
  type ModuleCapabilityDescriptor,
  type ModuleFeaturedDefinitionCollection,
  type ModuleResourceDescriptor
} from '@leitbild/contracts'
import { createModuleCapabilityRegistry } from '@leitbild/module-runtime'
import { mapSymbolsInput, mapSymbolsOutput, searchMapSymbols } from '../map-symbols/catalog.ts'
import { z } from 'zod'
import { capabilityJsonSchema } from '../../simulation/capabilities.ts'
import { isCapabilityRejection } from '../../simulation/capability-rejection.ts'
import {
  isoTimestampSchema,
  matchesLiteralSearch,
  agentRestrictionsSchema,
  agentRestrictionsStateSchema,
  operationalObjectSchema,
  procedureCatalogSchema,
  procedureControlStateSchema,
  procedureDocumentSchema,
  procedureIdSchema,
  procedureRunIdSchema,
  procedureRunStartCommandKind,
  procedureRunStartPayloadSchema,
  procedureRunTransitionCommandKind,
  procedureRunTransitionPayloadSchema,
  procedureSourceIdSchema,
  procedureStepIdSchema,
  recordingSampleSchema,
  recordingSeriesDescriptorSchema,
  recordingSeriesQuerySchema,
  scenarioGuidanceSchema,
  simulationClockStateSchema,
  simulationRunEventSchema,
  simulationRunIdSchema,
  type OperationalObject
} from '../model/index.ts'
import { describeScenarioAuthoring, scenarioAuthoringCatalogSchema, scenarioAuthoringDescriptionSchema, scenarioAuthoringDetailSchema } from '../scenarios/authoring.ts'
import { scenarioDefinitionSchema } from '../scenarios/definition.ts'
import { scenarioRevisionIdSchema } from '../scenarios/library.ts'
import { CommandIdempotencyConflictError } from '../simulation-runs/command-idempotency.ts'
import { drivenRunsOf, runWaitInputSchema, runWaitMaxMs, runWaitResultSchema, waitForRunChange } from '../simulation-runs/run-wait.ts'

/** A wait naming a procedure Run also answers with that run's current step. */
const runWaitAnswerSchema = runWaitResultSchema.extend({
  next: procedureStepViewSchema.optional(),
  nextUnavailable: z.string().optional(),
})
import { executionAdvanceInputSchema,executionSetInputSchema,runCopyInputSchema,runCopyOriginSchema,runExecutionStateSchema } from '../simulation-runs/execution.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import { aiRoleRunRefusal, hiddenInRoleRun, isRoleGateRefusal, roleRequiredRefusal, roleRunOpenCapabilityIds } from '../simulation-runs/role-gates.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../workspaces/runtime-registry.ts'
import { apiError,json,readJson } from './responses.ts'
import {
  buildSimulationRunActorForAccess,
} from './simulation-run-routes.ts'
import {
  composeProcedureRunView,
  composeProcedureStepView,
  procedureStepNotFoundCode,
  procedureStepViewSchema,
  type ProcedureStepView,
  type ProcedureStepViewPorts,
} from '../../features/procedures/step-view.ts'

const WORLD_MODULE_ID = moduleIdSchema.parse('world')

/** A refusal a validator named with its own code (e.g. a role Run's Pack check); otherwise invalid_request. */
const zodErrorCode = (error: z.ZodError): string => {
  for (const issue of error.issues) {
    const code = issue.code === 'custom' ? (issue.params as { readonly code?: unknown } | undefined)?.code : undefined
    if (typeof code === 'string') return code
  }
  return 'invalid_request'
}

export const worldModuleManifest = workspaceModuleManifestSchema.parse({
  module: {
    id: WORLD_MODULE_ID,
    title: 'World',
    description: 'Shared scenarios, Simulation Runs, operational state, and simulation mechanics.',
  },
  endpoints: {
    workspace: '/internal/workspaces/{workspaceId}',
    definitions: '/internal/workspaces/{workspaceId}/definitions',
    resources: '/internal/workspaces/{workspaceId}/resources',
    capabilities: '/internal/workspaces/{workspaceId}/capabilities',
    invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
    featuredDefinitions: '/internal/featured-definitions',
    activity: '/internal/activity',
  },
  ui: {
    workspace: '/workspaces/{workspaceId}/world',
  },
})

/**
 * Serves World's featured and listed Scenarios from bundled memory. It takes no Workspace
 * registry, so a landing page reading it never loads a Workspace runtime.
 */
export const handleWorldFeaturedDefinitions = (
  request: Request,
  url: URL,
  featured: ModuleFeaturedDefinitionCollection,
): Response | null =>
  url.pathname === worldModuleManifest.endpoints.featuredDefinitions && request.method === 'GET' ? json(featured) : null

const lifecycleInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
const emptyInputSchema = z.object({}).strict()
const scenarioAuthoringDescribeInputSchema = z.object({
  packIds: z.array(z.string().trim().min(1).max(128)).min(1).optional(),
  detail: scenarioAuthoringDetailSchema.default('catalog'),
}).strict()
const runScenarioSourceSchema = z.object({ source: scenarioDefinitionSchema, definition: workspaceDefinitionRevisionReferenceSchema }).strict()
const readObjectInputSchema = z.object({
  objectId: z.string().trim().min(1).max(128),
}).strict()
const searchObjectsInputSchema = z.object({
  packId: z.string().trim().min(1).max(128).optional(),
  kind: z.string().trim().min(1).max(128).optional(),
  status: z.string().trim().min(1).max(128).optional(),
  lifecycle: z.enum(['active', 'inactive', 'resolved', 'removed']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  text: z.string().trim().max(256).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
}).strict()
const readChangesInputSchema = z.object({
  afterSequence: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
}).strict()
const procedureCatalogInputSchema = z.object({
  sourceId: procedureSourceIdSchema.optional(),
  refresh: z.boolean().default(false),
}).strict()
const procedureStepReadInputSchema = z.object({
  runId: procedureRunIdSchema.optional().describe('A procedure Run, as world.procedure.runs.list lists it; omit for the one active Run you drive.'),
  stepId: procedureStepIdSchema.optional().describe('A step of the run\'s procedure; omit for its current step.'),
}).strict()
const procedureEvidenceInputSchema = z.object({
  sourceId: procedureSourceIdSchema.optional(),
  sourceRevision: sourceRevisionSchema,
  sourcePath: sourceDocumentPathSchema,
  section: z.string().min(1).optional(),
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().optional(),
}).strict()
const procedureEvidenceOutputSchema = z.object({
  revision: sourceRevisionSchema, path: sourceDocumentPathSchema, title: z.string(),
  headings: z.array(z.object({ title: z.string(), anchor: z.string(), line: z.number().int(), level: z.number().int() })),
  parent: z.string().nullable(), children: z.array(z.object({ path: z.string(), title: z.string(), summary: z.string(), parent: z.string().nullable(), hub: z.boolean() })),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(), totalLines: z.number().int().positive(),
  content: z.string(), nextLine: z.number().int().positive().optional(), section: z.string().optional(), sectionComplete: z.boolean().optional(),
})
const procedureDocumentInputSchema = z.object({
  sourceId: procedureSourceIdSchema.optional(),
  procedureId: procedureIdSchema,
  sourceRevision: sourceRevisionSchema.optional(),
  sourcePath: sourceDocumentPathSchema.optional(),
  stepId: procedureStepIdSchema.optional().describe('An exact step id from this document; returns that step and its referenced tag definitions, retaining document context and cross-step targets.'),
  includeSource: z.boolean().default(false).describe('Include the complete original Markdown as well as parsed content only when source inspection needs it.'),
}).strict().superRefine((input, ctx) => {
  if (input.sourcePath !== undefined && input.sourceRevision === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'sourcePath requires sourceRevision',
    })
  }
})
const procedureDocumentReadSchema = procedureDocumentSchema.omit({ rawMarkdown: true }).extend({
  rawMarkdown: z.string().optional(),
  totalSteps: z.number().int().nonnegative(),
  totalTags: z.number().int().nonnegative(),
  selectedStepId: procedureStepIdSchema.optional(),
})
const historyTimestampSchema = z.string().datetime({ offset: true })
const listHistorySeriesInputSchema = z.object({
  runtimeId: z.string().trim().min(1).max(128).optional(),
  subjectId: z.string().trim().min(1).max(128).optional(),
  signalId: z.string().trim().min(1).max(512).optional(),
  text: z.string().trim().min(1).max(256).describe('Literal metadata search: every whitespace-separated term must match. Use one signal concept per query and batch separate focused queries for different series.').optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(500).default(30).describe('Page size. Start small after filtering and request another page only when hasMore and the task needs it.'),
}).strict()
const readHistorySamplesInputSchema = recordingSeriesQuerySchema.safeExtend({
  runtimeId: z.string().trim().min(1).max(128),
  seriesId: z.string().trim().min(1).max(128),
  limit: z.number().int().positive().max(10_000).default(500).describe('Raw page size only; not a summary or tool-use limit.'),
})
const createScenarioInputSchema = z.object({ source: scenarioDefinitionSchema }).strict()
const setAgentRestrictionsInputSchema = z.object({
  restrictions: agentRestrictionsSchema,
  expectedRevision: z.number().int().nonnegative(),
}).strict()
const scenarioWriteInputJsonSchema = z.toJSONSchema(createScenarioInputSchema, { unrepresentable: 'any' })

import { scenarioPreviewSchema,scenarioWriteResultSchema } from '../scenarios/authoring-preview.ts'

const scenarioStartResultSchema = z.object({
  id: simulationRunIdSchema,
  uiPath: z.string().min(1),
}).strict()

const definitionDeleteResultSchema = z.object({
  deleted: z.literal(true),
  definitionId: z.string().min(1),
}).strict()

const simulationRunDeleteResultSchema = z.object({
  deleted: z.literal(true),
  simulationRunId: simulationRunIdSchema,
}).strict()

const simulationRunSummarySchema = z.object({
  id: simulationRunIdSchema,
  name: z.string().trim().min(1).max(256).nullable(),
  title: z.string().trim().min(1).max(256),
  scenarioId: z.string().min(1).nullable(),
  scenarioTitle: z.string().min(1).nullable(),
  scenarioRevisionId: z.string().min(1).nullable(),
  createdAt: isoTimestampSchema.nullable(),
  loaded: z.boolean(),
  snapshotSeq: z.number().int().nonnegative().nullable(),
  objectCount: z.number().int().nonnegative().nullable(),
  clock: simulationClockStateSchema.nullable(),
  activeCapabilityIds: z.array(z.string().min(1)),
  origin: runCopyOriginSchema.nullable(),
  loadError: z.string().min(1).optional(),
}).strict()

const runtimeHealthSchema = z.object({
  runtimeId: z.string().min(1),
  state: z.enum(['ready', 'degraded', 'failed']),
  failureCount: z.number().int().nonnegative(),
  lastSuccessfulInteractionAt: isoTimestampSchema,
  lastFailure: z.object({
    at: isoTimestampSchema,
    operation: z.string().min(1),
    message: z.string().min(1),
  }).strict().optional(),
}).strict()

const operationalObjectSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  packId: z.string().min(1),
  label: z.string().min(1),
  lifecycle: z.string().min(1),
  revision: z.number().int().nonnegative(),
  status: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  intent: z.string().min(1).optional(),
  updatedAt: isoTimestampSchema,
}).strict()

const objectSearchResultSchema = z.object({
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  objects: z.array(operationalObjectSummarySchema),
}).strict()

const simulationRunContextSchema = z.object({
  subject: z.object({
    workspaceId: workspaceIdSchema,
    simulationRunId: simulationRunIdSchema,
    scenarioId: z.string().min(1),
    scenarioRevisionId: z.string().min(1),
  }).strict(),
  briefing: z.object({
    title: z.string().min(1),
    summary: z.string().min(1).optional(),
    objectives: z.array(z.string().min(1)),
  }).strict(),
  situation: z.object({
    observedAt: isoTimestampSchema,
    sequence: z.number().int().nonnegative(),
    runtimeHealth: z.array(runtimeHealthSchema),
    historian: runHistorianStatusSchema.nullable(),
    clock: simulationClockStateSchema.optional(),
    guidance: scenarioGuidanceSchema.optional(),
    procedures: procedureControlStateSchema,
    execution: z.object({
      origin: runCopyOriginSchema.nullable(),
      state: runExecutionStateSchema,
    }).strict(),
  }).strict(),
  objects: z.object({
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    selection: z.literal('one-per-pack-kind'),
    byPack: z.record(z.string(), z.number().int().nonnegative()),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    byStatus: z.record(z.string(), z.number().int().nonnegative()),
    items: z.array(operationalObjectSummarySchema),
  }).strict(),
  affordances: z.object({
    workspaceId: workspaceIdSchema.nullable(),
    simulationRunId: simulationRunIdSchema,
    scenarioId: z.string().min(1).nullable(),
    scenarioRevisionId: z.string().min(1).nullable(),
    activePackIds: z.array(z.string().min(1)),
    runtimes: z.array(z.object({
      id: z.string().min(1),
      packId: z.string().min(1),
      clock: z.enum(['simulation', 'live', 'none']),
    }).strict()),
    wikiRefs: z.array(z.object({
      label: z.string().min(1),
      path: z.string().min(1),
    }).passthrough()),
    recording: z.object({
      selections: z.array(z.record(z.string(), z.unknown())),
      profiles: z.array(z.record(z.string(), z.unknown())),
    }).strict(),
  }).strict(),
}).strict()

const simulationChangesSchema = z.object({
  afterSequence: z.number().int().nonnegative(),
  currentSequence: z.number().int().nonnegative(),
  events: z.array(simulationRunEventSchema),
  hasMore: z.boolean(),
  nextSequence: z.number().int().nonnegative(),
}).strict()

const simulationHistorySeriesSchema = z.object({
  status: runHistorianStatusSchema.nullable(),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  series: z.array(recordingSeriesDescriptorSchema.extend({ runtimeId: z.string().min(1) }).strict()),
}).strict()

const compactHistorySampleSchema = recordingSampleSchema.omit({ seriesId: true }).extend({
  sequence: z.number().int().positive(),
}).strict()

const simulationHistoryWindowSchema = z.object({
  series: recordingSeriesDescriptorSchema.extend({ runtimeId: z.string().min(1) }).strict(),
  windowSummary: z.object({
    sampleCount: z.number().int().nonnegative(),
    seriesCount: z.number().int().nonnegative(),
    qualityCounts: z.object({ good: z.number().int().nonnegative(), uncertain: z.number().int().nonnegative(), bad: z.number().int().nonnegative() }).strict(),
    firstSample: compactHistorySampleSchema.nullable(),
    lastSample: compactHistorySampleSchema.nullable(),
    distinctValueCount: z.number().int().nonnegative(),
    numericMinimum: z.number().finite().nullable(),
    numericMaximum: z.number().finite().nullable(),
    numericAverage: z.number().finite().nullable().describe('Sample-weighted arithmetic mean, including every retained numeric sample quality; not a time-weighted or continuous-process average.'),
  }).strict(),
  retainedFromSequence: z.number().int().positive().nullable(),
  retainedFromObservedAt: historyTimestampSchema.nullable(),
  retainedToObservedAt: historyTimestampSchema.nullable(),
  retainedFromSimulationTime: historyTimestampSchema.nullable(),
  retainedToSimulationTime: historyTimestampSchema.nullable(),
  retentionGap: z.boolean(),
}).strict()
const simulationHistorySamplesSchema = z.discriminatedUnion('mode', [
  simulationHistoryWindowSchema.extend({ mode: z.literal('summary') }),
  simulationHistoryWindowSchema.extend({ mode: z.literal('raw'), samples: z.array(compactHistorySampleSchema), hasMore: z.boolean(), nextBeforeSequence: z.number().int().positive().nullable() }),
])

const SCENARIO_DEFINITION_TYPE = 'world.scenario'

const scenarioUiPath = (workspaceId: string, scenarioId: string, revisionId: string): string =>
  `/workspaces/${encodeURIComponent(workspaceId)}/world/scenarios/new?definition=${encodeURIComponent(scenarioId)}&revision=${encodeURIComponent(revisionId)}`

const definitionsFor = async (registry: SimulationRunRegistry) => {
  const scenarios = await registry.listScenarios()
  return moduleDefinitionCollectionSchema.parse({
    definitions: scenarios.map(scenario => ({
      ref: {
        workspaceId: registry.workspaceId,
        moduleId: WORLD_MODULE_ID,
        type: SCENARIO_DEFINITION_TYPE,
        id: scenario.id,
      },
      title: scenario.title,
      ...(scenario.description === undefined ? {} : { description: scenario.description }),
      uiPath: scenarioUiPath(registry.workspaceId, scenario.id, scenario.currentRevisionId),
      currentRevisionId: scenario.currentRevisionId,
      capabilityIds: worldCapabilities.idsForDefinitionType(SCENARIO_DEFINITION_TYPE),
      inspectionCapabilityId: 'world.scenario.inspect',
      primaryCapabilityId: 'world.scenario.start',
      deleteCapabilityId: 'world.scenario.delete',
    })),
  }).definitions
}

const resourcesFor = async (registry: SimulationRunRegistry): Promise<ReadonlyArray<ModuleResourceDescriptor>> => {
  const observedAt = new Date().toISOString()
  const simulationRuns = await registry.listKnown()
  const executionByRun = new Map(await Promise.all(simulationRuns
    .filter(simulationRun => simulationRun.loadError === undefined)
    .map(async simulationRun => [simulationRun.id, await registry.executionOverview(simulationRun.id)] as const)))
  const runRef = (id: string) => ({
    workspaceId: registry.workspaceId,
    moduleId: WORLD_MODULE_ID,
    type: 'world.simulation-run' as const,
    id,
  })
  const familyRef = (id: string) => ({
    workspaceId: registry.workspaceId,
    moduleId: WORLD_MODULE_ID,
    type: 'world.run-family' as const,
    id,
  })
  type ListedRun = (typeof simulationRuns)[number]
  const families = new Map<string, ListedRun[]>()
  const copiesBySource = new Map<string, ListedRun[]>()
  for (const run of simulationRuns) {
    const familyId = run.origin?.familyId ?? run.id
    const family = families.get(familyId)
    if (family) family.push(run)
    else families.set(familyId, [run])
    if (run.origin !== null) {
      const siblings = copiesBySource.get(run.origin.sourceRunId)
      if (siblings) siblings.push(run)
      else copiesBySource.set(run.origin.sourceRunId, [run])
    }
  }
  return moduleResourceCollectionSchema.parse({
    resources: [
      ...[...families].map(([familyId, members]) => {
        const original = members.find(member => member.id === familyId)
        const oldest = [...members].sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? ''))[0]!
        return {
          ref: familyRef(familyId),
          title: `${original?.title ?? oldest.title} · Run family`,
          description: 'The original simulation and its independent what-if copies.',
          links: members.map(member => ({ rel: 'contains', ref: runRef(member.id), title: member.title })),
          capabilityIds: [],
          summary: [{ key: 'member-count', label: 'Runs', kind: 'count' as const, value: members.length }],
          observedAt,
        }
      }),
      ...simulationRuns.map(simulationRun => {
      const viewers = registry.leaseSummary(simulationRun.id).leasesByKind.realtime
      const execution = executionByRun.get(simulationRun.id)
      const status = simulationRun.loadError !== undefined
        ? 'Unavailable'
        : execution?.playback === 'playing' && execution.pace === 'maximum'
          ? `Fast-forward · ${execution.acceleration?.measuredSpeed.toFixed(1) ?? '0.0'}×`
          : execution?.playback === 'paused'
            ? 'Paused'
            : 'Running'
      return {
        ref: {
          workspaceId: registry.workspaceId,
          moduleId: WORLD_MODULE_ID,
          type: 'world.simulation-run',
          id: simulationRun.id,
        },
        title: simulationRun.title,
        ...(simulationRun.loadError === undefined ? {} : { description: simulationRun.loadError }),
        ...(simulationRun.scenarioId === null || simulationRun.scenarioRevisionId === null ? {} : {
          sourceDefinition: {
            workspaceId: registry.workspaceId,
            moduleId: WORLD_MODULE_ID,
            type: SCENARIO_DEFINITION_TYPE,
            id: simulationRun.scenarioId,
            revisionId: simulationRun.scenarioRevisionId,
          },
        }),
        links: [
          { rel: 'member-of', ref: familyRef(simulationRun.origin?.familyId ?? simulationRun.id) },
          ...(simulationRun.origin === null ? [] : [{ rel: 'copy-of', ref: runRef(simulationRun.origin.sourceRunId) }]),
          ...(copiesBySource.get(simulationRun.id) ?? [])
            .map(candidate => ({ rel: 'copy', ref: runRef(candidate.id), title: candidate.title })),
        ],
        uiPath: `/workspaces/${encodeURIComponent(registry.workspaceId)}/world/runs/${encodeURIComponent(simulationRun.id)}`,
        // A role Run offers no AI restrictions and no Inspect: AI is refused on
        // it, and the Host renders those controls only from these fields.
        capabilityIds: [
          ...worldCapabilities.idsForResourceType('world.simulation-run'),
          ...simulationRun.activeCapabilityIds,
        ].filter(capabilityId => simulationRun.roles === null || !hiddenInRoleRun(capabilityId)),
        ...(simulationRun.roles === null ? { inspectionCapabilityId: 'world.simulation-run.inspect' } : {}),
        deleteCapabilityId: 'world.simulation-run.delete',
        renameCapabilityId: 'world.simulation-run.rename',
        summary: [
          ...(simulationRun.createdAt === null ? [] : [{
            key: 'started-at',
            label: 'Started',
            kind: 'timestamp' as const,
            value: simulationRun.createdAt,
          }]),
          { key: 'status', label: 'Status', kind: 'status' as const, value: status },
          ...(simulationRun.origin === null ? [] : [{
            key: 'lineage', label: 'Lineage', kind: 'status' as const, value: 'What-if copy',
          }]),
          { key: 'viewer-count', label: 'Viewers', kind: 'count' as const, value: viewers },
          ...(simulationRun.roles === null ? [] : [{
            key: 'roles', label: 'Roles', kind: 'count' as const, value: simulationRun.roles.roles.length,
          }]),
          // A sided Run's object count would tell every reader how much each side has.
          ...(simulationRun.objectCount === null || simulationRun.roles?.sides !== undefined ? [] : [{
            key: 'object-count',
            label: 'Objects',
            kind: 'count' as const,
            value: simulationRun.objectCount,
          }]),
        ],
        observedAt,
      }
    }),
    ],
  }).resources
}

const requireScenarioDefinitionId = (
  invocation: z.infer<typeof moduleCapabilityInvocationSchema>,
): string => {
  if (invocation.definition === undefined) throw new Error('Scenario Capability requires a Definition')
  if (invocation.definition.type !== SCENARIO_DEFINITION_TYPE) throw new Error('Capability requires a World Scenario Definition')
  return invocation.definition.id
}

const requireSimulationRunResource = (
  invocation: z.infer<typeof moduleCapabilityInvocationSchema>,
): ReturnType<typeof simulationRunIdSchema.parse> => {
  if (invocation.resource === undefined) throw new Error('Simulation Run Capability requires a Resource')
  if (invocation.resource.type !== 'world.simulation-run') throw new Error('Capability requires a World Simulation Run Resource')
  return simulationRunIdSchema.parse(invocation.resource.id)
}

const countBy = (values: ReadonlyArray<string>): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

const summarizeOperationalObject = (object: OperationalObject) => ({
  id: object.id,
  kind: object.kind,
  packId: object.packId,
  label: object.label,
  lifecycle: object.lifecycle,
  revision: object.revision,
  status: object.operational.status,
  ...(object.operational.priority === undefined ? {} : { priority: object.operational.priority }),
  ...(object.operational.intent === undefined ? {} : { intent: object.operational.intent }),
  updatedAt: object.timestamps.updatedAt,
})

const representativeOperationalObjects = (objects: ReadonlyArray<OperationalObject>) => {
  const priorityRank = { low: 0, normal: 1, high: 2, critical: 3 } as const
  const selected = new Map<string, OperationalObject>()
  for (const object of objects) {
    const key = `${object.packId}\u0000${object.kind}`
    const previous = selected.get(key)
    if (!previous) {
      selected.set(key, object)
      continue
    }
    const rank = priorityRank[object.operational.priority ?? 'normal']
    const previousRank = priorityRank[previous.operational.priority ?? 'normal']
    if (rank > previousRank || (rank === previousRank && object.timestamps.updatedAt > previous.timestamps.updatedAt)) {
      selected.set(key, object)
    }
  }
  return [...selected.values()]
    .map(summarizeOperationalObject)
    .sort((left, right) => left.packId.localeCompare(right.packId) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
}

const serializableInspection = (value: unknown) =>
  inspectionViewSchema.parse(JSON.parse(JSON.stringify(value)) as unknown)

// Installed Capability definitions are immutable; runtime state is not cached.
// A replacement/installation has a new definition identity and is compiled anew.
const runtimeDescriptorCache = new WeakMap<object, ModuleCapabilityDescriptor>()
const runtimeCapabilityDescriptorsFor = (
  registry: SimulationRunRegistry,
): ReadonlyArray<ModuleCapabilityDescriptor> => {
  const byId = new Map<string, ModuleCapabilityDescriptor>()
  for (const { capability } of registry.installedCapabilities) {
    const descriptor = runtimeDescriptorCache.get(capability) ?? moduleCapabilityCollectionSchema.parse({ capabilities: [{
      id: capability.id,
      moduleId: WORLD_MODULE_ID,
      kind: capability.kind,
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: capability.title,
      description: capability.description,
      ...(capability.searchTerms === undefined ? {} : { searchTerms: capability.searchTerms }),
      risk: capability.risk,
      idempotent: capability.idempotent,
      ...(capability.kind === 'command' ? { acceptsIdempotencyKey: true as const } : {}),
      ...(capability.schedulable === undefined ? {} : { schedulable: capability.schedulable }),
      inputSchema: capabilityJsonSchema(capability.input),
      outputSchema: capabilityJsonSchema(capability.output),
    }] }).capabilities[0]!
    runtimeDescriptorCache.set(capability, descriptor)
    const existing = byId.get(descriptor.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor)) {
      throw new Error(`alternative Pack Runtimes disagree on Capability ${descriptor.id}`)
    }
    byId.set(descriptor.id, descriptor)
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

const workspacePackCapabilityDescriptorsFor = (registry: SimulationRunRegistry): ReadonlyArray<ModuleCapabilityDescriptor> => moduleCapabilityCollectionSchema.parse({ capabilities: registry.workspaceCapabilities.map(capability => ({
  id: capability.id, moduleId: WORLD_MODULE_ID, kind: capability.kind, scope: { kind: 'workspace' },
  title: capability.title, description: capability.description, risk: capability.risk, idempotent: capability.idempotent,
  ...(capability.searchTerms === undefined ? {} : { searchTerms: capability.searchTerms }),
  inputSchema: capabilityJsonSchema(capability.input), outputSchema: capabilityJsonSchema(capability.output),
})) }).capabilities

const scenarioSections = (definition: {
  readonly objectives?: ReadonlyArray<string>
  readonly packs: ReadonlyArray<string>
  readonly packRuntimes: Readonly<Record<string, unknown>>
  readonly packConfigs: Readonly<Record<string, unknown>>
  readonly connections: ReadonlyArray<unknown>
  readonly recording: ReadonlyArray<unknown>
  readonly world: unknown
  readonly initialObjects: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly packId: string
    readonly label: string
    readonly lifecycle: string
    readonly operational: { readonly status: string }
  }>
  readonly view: unknown
  readonly timeline?: unknown
}) => [{
  id: 'scenario-setup',
  title: 'Scenario setup',
  data: {
    objectives: definition.objectives ?? [],
    world: definition.world,
    view: definition.view,
  },
}, {
  id: 'packs-and-runtimes',
  title: 'Packs and runtime configuration',
  data: {
    packs: definition.packs,
    packRuntimes: definition.packRuntimes,
    packConfigs: definition.packConfigs,
    recording: definition.recording,
    connections: definition.connections,
  },
}, {
  id: 'assets',
  title: 'Initial assets',
  description: 'Initial operational assets compiled from the Scenario Items above.',
  data: {
    summary: {
      operationalObjects: definition.initialObjects.length,
      byPack: countBy(definition.initialObjects.map(object => object.packId)),
      byKind: countBy(definition.initialObjects.map(object => object.kind)),
    },
    operationalObjects: definition.initialObjects,
  },
}, {
  id: 'timeline',
  title: 'Scenario timeline',
  description: 'Configured future cues are shown here for design inspection; agent-safe Simulation Context remains separate.',
  data: definition.timeline ?? { cues: [] },
}]

type ApiRunRuntime = Awaited<ReturnType<SimulationRunRegistry['load']>>
type ApiInvocation = z.infer<typeof moduleCapabilityInvocationSchema>

// Projections must respect the same exact-subject inspection boundary as live
// queries. A procedure's comments and branch evidence can contain plant readings.
const deniedInspectionSubjects = (runtime: ApiRunRuntime, invocation: ApiInvocation): ReadonlySet<string> =>
  new Set(invocation.access.actor.kind === 'ai'
    ? runtime.snapshot().scenario?.agentRestrictions.objects.filter(entry => entry.deny.includes('inspect')).map(entry => entry.objectId) ?? []
    : [])

const visibleProcedureState = (runtime: ApiRunRuntime, invocation: ApiInvocation) => {
  const procedures = runtime.snapshot().procedures ?? { runs: [] }
  const denied = deniedInspectionSubjects(runtime, invocation)
  return denied.size === 0 ? procedures : { runs: procedures.runs.filter(run => !denied.has(run.scope.plantId)) }
}

const procedureStepViewError = (status: number, code: string, message: string): Error =>
  Object.assign(new Error(message), { status, code })

// "Continue" names no Run: the one active Run its caller drives, if exactly one.
const drivenActiveRun = (runtime: ApiRunRuntime, invocation: ApiInvocation) => {
  const caller = buildSimulationRunActorForAccess(invocation.access).id
  const runs = visibleProcedureState(runtime, invocation).runs
  const driven = runs.filter(run => run.status === 'active' && run.driver?.actorId === caller)
  if (driven.length === 1) return driven[0]!
  const name = (run: typeof runs[number]) => `${run.procedureId} on ${run.scope.label ?? run.scope.plantId} (${run.runId})`
  if (driven.length > 1) throw procedureStepViewError(409, 'procedure_run_ambiguous', `You drive ${driven.length} active procedure runs: ${driven.map(name).join('; ')}. Name runId.`)
  const active = runs.filter(run => run.status === 'active')
  throw procedureStepViewError(404, 'procedure_run_not_found', active.length === 0
    ? 'You drive no active procedure run, and none is active; start one with world.procedure.run.start.'
    : `You drive no active procedure run. Active: ${active.map(run => `${name(run)}${run.driver === undefined ? ', nobody drives' : run.driver.kind === 'person' ? ', a person drives' : ', another AI agent drives'}`).join('; ')}. Name runId, and claim it first to work it.`)
}

/**
 * A procedure Run's step as its caller may read it: one shared builder for
 * step.read and for the step an AI agent's accepted transition leads to.
 */
const procedureStepViewFor = async (
  runtime: ApiRunRuntime, invocation: ApiInvocation,
  input: { readonly runId?: string | undefined; readonly stepId?: string | undefined },
  mode: 'step' | 'next',
): Promise<ProcedureStepView> => {
  const run = input.runId === undefined ? drivenActiveRun(runtime, invocation) : runtime.snapshot().procedures?.runs.find(candidate => candidate.runId === input.runId)
  if (!run) throw procedureStepViewError(404, 'procedure_run_not_found', `No procedure run ${input.runId} in this Simulation Run; world.procedure.runs.list lists them.`)
  if (deniedInspectionSubjects(runtime, invocation).has(run.scope.plantId)) {
    throw procedureStepViewError(403, 'agent_access_restricted', `AI inspection access is restricted for: ${run.scope.plantId}`)
  }
  const document = await runtime.procedureDocument({
    sourceId: run.sourceId, procedureId: run.procedureId, sourceRevision: run.sourceRevision, sourcePath: run.sourcePath,
  })
  const actor = buildSimulationRunActorForAccess(invocation.access)
  const ports: ProcedureStepViewPorts = {
    sequence: () => runtime.snapshot().seq,
    clock: () => {
      const clock = runtime.snapshot().clock
      if (!clock) throw new Error('Simulation Run clock is not initialized')
      return clock
    },
    observations: () => runtime.procedureObservations(actor, run.scope.plantId),
  }
  // A transfer or END leaves no step of this run to work.
  if (mode === 'next' && run.status !== 'active') return composeProcedureRunView({ run, document, ports })
  try {
    return await composeProcedureStepView({ run, document, ports, ...(input.stepId === undefined ? {} : { stepId: input.stepId }) })
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === procedureStepNotFoundCode) throw procedureStepViewError(404, procedureStepNotFoundCode, error.message)
    throw error
  }
}

// An AI agent's accepted transition answers with the step it leads to, so the
// agent decides that step without another read. The command stands whatever
// this read finds.
const nextProcedureStep = async (runtime: ApiRunRuntime, invocation: ApiInvocation, runId: string, after: string): Promise<{ readonly next: ProcedureStepView } | { readonly nextUnavailable: string }> => {
  try {
    return { next: await procedureStepViewFor(runtime, invocation, { runId }, 'next') }
  } catch (error) {
    return { nextUnavailable: `${after}; reading the run's current step failed: ${error instanceof Error ? error.message : String(error)}. Read it with world.procedure.run.step.read.` }
  }
}

// A start names its pin: the run, and the source revision it was started (or resumed) at.
const startedProcedureRun = async (runtime: ApiRunRuntime, invocation: ApiInvocation) => {
  const input = procedureRunStartPayloadSchema.parse(invocation.input)
  const run = runtime.snapshot().procedures?.runs.find(candidate => candidate.status === 'active' && candidate.procedureId === input.procedureId
    && candidate.scope.plantId === input.scope.plantId && (input.sourceId === undefined || candidate.sourceId === input.sourceId))
  if (!run) return { nextUnavailable: 'The start was accepted; its run is no longer active. world.procedure.runs.list lists runs.' }
  return {
    pinned: { runId: run.runId, sourceId: run.sourceId, sourceRevision: run.sourceRevision, sourcePath: run.sourcePath },
    ...(invocation.access.actor.kind === 'ai' ? await nextProcedureStep(runtime, invocation, run.runId, 'The start was accepted') : {}),
  }
}

const visibleChangeEvents = (
  runtime: ApiRunRuntime, invocation: ApiInvocation,
  page: ReturnType<ApiRunRuntime['events']>,
): ReturnType<ApiRunRuntime['events']> => {
  const denied = deniedInspectionSubjects(runtime, invocation)
  if (denied.size === 0) return page
  // Resolve historical run ids from the committed journal, not only the live
  // projection: reset and object deletion remove runs, but not their evidence.
  const scopes = new Map(runtime.snapshot().procedures?.runs.map(run => [run.runId, run.scope.plantId]) ?? [])
  const journal = runtime.events()
  for (const event of journal) {
    if (event.type === 'procedure.run.started') scopes.set(event.run.runId, event.run.scope.plantId)
  }
  const deniedCommands = new Set(journal.filter(event => {
    if (event.type !== 'command.issued') return false
    if (event.command.targetObjectIds.some(id => denied.has(id))) return true
    // Older procedure command envelopes did not declare their plant target.
    if (!event.command.kind.startsWith('world.procedure.') || typeof event.command.payload !== 'object' || event.command.payload === null) return false
    const payload = event.command.payload as { runId?: string; scope?: { plantId?: string } }
    const scope = payload.scope?.plantId ?? (payload.runId === undefined ? undefined : scopes.get(payload.runId))
    return scope !== undefined && denied.has(scope)
  }).flatMap(event => event.type === 'command.issued' ? [event.command.id] : []))
  return page.filter(event => {
    if (event.type === 'procedure.run.started') return !denied.has(event.run.scope.plantId)
    if (event.type === 'procedure.run.reset') return !denied.has(event.scope.plantId)
    if (event.type.startsWith('procedure.') && 'runId' in event) {
      const scope = scopes.get(event.runId)
      return scope !== undefined && !denied.has(scope)
    }
    if (event.type === 'object.upserted') return !denied.has(event.object.id)
    if (event.type === 'object.deleted' || event.type === 'telemetry.sampled') return !denied.has(event.objectId)
    if (event.type === 'command.issued') return !deniedCommands.has(event.command.id)
    if (event.type === 'command.result') return !deniedCommands.has(event.result.commandId)
    if (event.type === 'interaction.signal.received' || event.type === 'notification.emitted') {
      const interaction = event.type === 'interaction.signal.received' ? event.signal : event.notification
      return ![interaction.source, ...interaction.targets].some(endpoint => endpoint.kind === 'object' && denied.has(endpoint.id))
    }
    return true
  })
}

const worldCapabilities = createModuleCapabilityRegistry<SimulationRunRegistry, Response>(WORLD_MODULE_ID, [
  {
    descriptor: {
      id: 'world.map.symbols', moduleId: WORLD_MODULE_ID, kind: 'query', scope: { kind: 'workspace' },
      title: 'Discover map icons', description: 'Search the locally installed Lucide catalogue by name or semantic tags. Return canonical icon IDs for Pack map symbols; optionally request SVG artwork for up to 32 specific IDs. No external network access.',
      risk: 'read', idempotent: true, inputSchema: z.toJSONSchema(mapSymbolsInput, { io: 'input' }), outputSchema: z.toJSONSchema(mapSymbolsOutput),
    },
    invoke: async (_registry, invocation) => json({ result: searchMapSymbols(invocation.input) }),
  },
  {
    descriptor: {
      id: 'world.scenario-authoring.describe',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'workspace' },
      title: 'Describe Scenario Authoring',
      description: 'Discovers World Pack scenario inputs. The default catalog is compact; request authoring for machine schemas of selected Packs or editor for UI form metadata.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(scenarioAuthoringDescribeInputSchema, { io: 'input' }),
      outputSchema: z.toJSONSchema(scenarioAuthoringDescriptionSchema),
    },
    invoke: async (registry, invocation) => {
      const input = scenarioAuthoringDescribeInputSchema.parse(invocation.input)
      const requested = new Set(input.packIds ?? registry.scenarioAuthoringCatalog.packs.map(pack => pack.id))
      const missing = [...requested].filter(packId => !registry.scenarioAuthoringCatalog.packs.some(pack => pack.id === packId))
      if (missing.length > 0) return apiError(400, 'scenario_authoring_pack_not_found', `Unknown Scenario authoring Pack${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
      const catalog = scenarioAuthoringCatalogSchema.parse({
        packs: registry.scenarioAuthoringCatalog.packs.filter(pack => requested.has(pack.id)),
        commands: registry.scenarioAuthoringCatalog.commands.filter(command => requested.has(command.packId)),
      })
      return json({ result: scenarioAuthoringDescriptionSchema.parse(describeScenarioAuthoring(catalog, input.detail)) })
    },
  },
  {
    descriptor: {
      id: 'world.scenario.create',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Scenario',
      description: 'Validates and saves a new editable Scenario Definition as an immutable revision.',
      risk: 'write',
      idempotent: false,
      inputSchema: scenarioWriteInputJsonSchema,
      outputSchema: capabilityJsonSchema(scenarioWriteResultSchema),
    },
    invoke: async (registry, invocation) => {
      const input = createScenarioInputSchema.parse(invocation.input)
      try {
        const revision = await registry.createScenario(input.source)
        return json({ result: {
          definition: {
            workspaceId: registry.workspaceId,
            moduleId: WORLD_MODULE_ID,
            type: SCENARIO_DEFINITION_TYPE,
            id: revision.definitionId,
            revisionId: revision.id,
          },
          title: revision.document.title,
          uiPath: scenarioUiPath(registry.workspaceId, revision.definitionId, revision.id),
        } }, { status: 201 })
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Definition already exists:')) {
          return apiError(409, 'scenario_already_exists', error.message)
        }
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'world.scenario.preview',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'workspace' },
      title: 'Preview Scenario',
      description: 'Validates an unsaved Scenario draft and returns its compiled asset and connection surface without creating a Definition.',
      risk: 'read',
      idempotent: true,
      inputSchema: scenarioWriteInputJsonSchema,
      outputSchema: capabilityJsonSchema(scenarioPreviewSchema),
    },
    invoke: async (registry, invocation) => {
      const input = createScenarioInputSchema.parse(invocation.input)
      const scenario = await registry.previewScenario(input.source)
      return json({ result: scenario })
    },
  },
  {
    descriptor: {
      id: 'world.scenario.update',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: SCENARIO_DEFINITION_TYPE },
      title: 'Update Scenario',
      description: 'Creates a new immutable revision from edited Scenario Definition content.',
      risk: 'write',
      idempotent: false,
      inputSchema: scenarioWriteInputJsonSchema,
      outputSchema: capabilityJsonSchema(scenarioWriteResultSchema),
    },
    invoke: async (registry, invocation) => {
      const input = createScenarioInputSchema.parse(invocation.input)
      const scenarioId = requireScenarioDefinitionId(invocation)
      if (input.source.id !== scenarioId) {
        return apiError(409, 'scenario_identity_mismatch', 'Edited Scenario id does not match the target Definition')
      }
      try {
        const revision = await registry.updateScenario(
          input.source,
          scenarioRevisionIdSchema.parse(invocation.definition!.revisionId),
        )
        return json({ result: {
          definition: { ...invocation.definition, revisionId: revision.id },
          title: revision.document.title,
          uiPath: scenarioUiPath(registry.workspaceId, revision.definitionId, revision.id),
        } })
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Definition Revision changed:')) {
          return apiError(409, 'scenario_revision_changed', error.message)
        }
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'world.scenario.read',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'definition', definitionType: SCENARIO_DEFINITION_TYPE },
      title: 'Read Scenario Definition',
      description: 'Reads the exact editable Scenario Definition for this current immutable revision without compiled assets or live Run state.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(runScenarioSourceSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const scenarioId = requireScenarioDefinitionId(invocation)
      const revision = await registry.currentScenario(scenarioId)
      if (!revision || String(revision.id) !== String(invocation.definition!.revisionId)) {
        return apiError(404, 'scenario_revision_not_found', 'Scenario Revision not found')
      }
      return json({ result: runScenarioSourceSchema.parse({
        source: revision.document,
        definition: invocation.definition,
      }) })
    },
  },
  {
    descriptor: {
      id: 'world.scenario.inspect',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'definition', definitionType: SCENARIO_DEFINITION_TYPE },
      title: 'Inspect Scenario',
      description: 'Shows the exact Scenario Revision configuration, Packs, initial assets, Plants, and timeline.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema, { io: 'input' }),
      outputSchema: z.toJSONSchema(inspectionViewSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const scenarioId = requireScenarioDefinitionId(invocation)
      const revision = await registry.currentScenario(scenarioId)
      if (!revision || String(revision.id) !== String(invocation.definition!.revisionId)) {
        return apiError(404, 'scenario_revision_not_found', 'Scenario Revision not found')
      }
      const definition = await registry.compileScenarioRevision(revision)
      return json({ result: serializableInspection({
        target: { kind: 'definition', definition: invocation.definition },
        title: revision.document.title,
        ...(revision.document.description === undefined ? {} : { description: revision.document.description }),
        observedAt: new Date().toISOString(),
        sections: [{
          id: 'identity',
          title: 'Identity and provenance',
          data: {
            scenarioId: revision.definitionId,
            revisionId: revision.id,
            digest: revision.digest,
            createdAt: revision.createdAt,
          },
        }, {
          id: 'authored-definition',
          title: 'Editable Scenario Definition',
          description: 'The Pack-grouped authored source retained with this immutable revision.',
          data: revision.document,
        }, ...scenarioSections(definition)],
      }) })
    },
  },
  {
    descriptor: {
      id: 'world.scenario.start',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: SCENARIO_DEFINITION_TYPE },
      title: 'Start Scenario',
      description: 'Creates a Simulation Run from the requested immutable Scenario Revision. A Run whose Definition declares roles starts paused and plays in realtime when the first screen holding roles joins, unless world.simulation-run.execution.set or world.simulation-run.execution.advance is used first.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(scenarioStartResultSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      if (!invocation.definition) throw new Error('Scenario Capability requires a Definition')
      const runtime = await registry.create({
        scenarioId: requireScenarioDefinitionId(invocation),
        scenarioRevisionId: scenarioRevisionIdSchema.parse(invocation.definition.revisionId),
      })
      const resource = {
        workspaceId: registry.workspaceId,
        moduleId: WORLD_MODULE_ID,
        type: 'world.simulation-run',
        id: runtime.id,
      }
      return json({
        result: { id: runtime.id, uiPath: `/workspaces/${encodeURIComponent(registry.workspaceId)}/world/runs/${encodeURIComponent(runtime.id)}` },
        createdResources: [resource],
      }, { status: 201 })
    },
  },
  {
    descriptor: {
      id: 'world.scenario.delete',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: SCENARIO_DEFINITION_TYPE },
      title: 'Delete Scenario',
      description: 'Removes this Scenario from the Workspace catalog. Existing Simulation Runs retain their pinned revision.',
      risk: 'destructive',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(definitionDeleteResultSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const scenarioId = requireScenarioDefinitionId(invocation)
      return await registry.deleteScenario(scenarioId, scenarioRevisionIdSchema.parse(invocation.definition!.revisionId))
        ? json({ result: { deleted: true, definitionId: scenarioId } })
        : apiError(404, 'scenario_not_found', 'Scenario not found')
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.inspect',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Inspect Simulation Run',
      description: 'Shows pinned Scenario configuration, current runtime state, operational asset summaries, and available Capabilities.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema, { io: 'input' }),
      outputSchema: z.toJSONSchema(inspectionViewSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const simulationRunId = requireSimulationRunResource(invocation)
      const [runtime, definition, summary, execution] = await Promise.all([
        registry.load(simulationRunId),
        registry.compiledScenarioForRun(simulationRunId),
        registry.summary(simulationRunId),
        registry.executionStatus(simulationRunId),
      ])
      const snapshot = runtime.snapshot()
      const leaseSummary = registry.leaseSummary(simulationRunId)
      const assetSummaries = snapshot.objects.map(object => ({
        id: object.id,
        label: object.label,
        kind: object.kind,
        packId: object.packId,
        lifecycle: object.lifecycle,
        revision: object.revision,
        status: object.operational.status,
        ...(object.operational.priority === undefined ? {} : { priority: object.operational.priority }),
        ...(object.operational.intent === undefined ? {} : { intent: object.operational.intent }),
        alerts: object.alerts.length,
        updatedAt: object.timestamps.updatedAt,
      }))
      return json({ result: serializableInspection({
        target: { kind: 'resource', resource: invocation.resource },
        title: summary.title,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        observedAt: new Date().toISOString(),
        sections: [{
          id: 'identity',
          title: 'Run identity and provenance',
          data: {
            ...summary,
            connections: leaseSummary,
          },
        }, {
          id: 'live-state',
          title: 'Current simulation state',
          data: {
            sequence: snapshot.seq,
            clock: snapshot.clock ?? null,
            scenario: snapshot.scenario ?? null,
            runtimeHealth: runtime.health(),
            historian: runtime.recordingStatus(),
            execution,
          },
        }, {
          id: 'live-assets',
          title: 'Current asset summaries',
          description: 'Compact live summaries; detailed object state remains available through Read Operational Object.',
          data: {
            total: assetSummaries.length,
            byPack: countBy(assetSummaries.map(object => String(object.packId))),
            byKind: countBy(assetSummaries.map(object => String(object.kind))),
            objects: assetSummaries,
          },
        }, ...scenarioSections(definition)],
      }) })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.scenario-source',
      moduleId: WORLD_MODULE_ID, kind: 'query', scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read pinned Scenario source', description: 'Read the exact editable Scenario Definition pinned by this Run, including authoring-only scenario instructions. Does not reconstruct source from physical state or merge runtime edits. Not part of the default assistant grants.',
      risk: 'read', idempotent: true, inputSchema: capabilityJsonSchema(emptyInputSchema), outputSchema: capabilityJsonSchema(runScenarioSourceSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const revision = await registry.scenarioRevisionForRun(requireSimulationRunResource(invocation))
      if (!revision) return apiError(404, 'scenario_revision_not_found', 'Pinned Scenario source is unavailable')
      return json({ result: runScenarioSourceSchema.parse({ source: revision.document, definition: { workspaceId: registry.workspaceId, moduleId: WORLD_MODULE_ID, type: SCENARIO_DEFINITION_TYPE, id: revision.definitionId, revisionId: revision.id } }) })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.background.set',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Set Background Execution',
      description: 'Keeps this loaded Run executing without viewers until disabled, unloaded, deleted or the service stops. Does not resume a paused clock or configure automatic restart.',
      risk: 'write',
      idempotent: true,
      inputSchema: capabilityJsonSchema(z.object({ background: z.boolean() }).strict()),
      outputSchema: capabilityJsonSchema(z.object({ simulationRunId: z.string(), leaseCount: z.number(), leasesByKind: z.object({ realtime: z.number(), api: z.number(), background: z.number(), 'maximum-pace': z.number() }) })),
    },
    invoke: async (registry, invocation) => {
      const input = z.object({ background: z.boolean() }).strict().parse(invocation.input)
      return json({ result: await registry.setBackgroundExecution(requireSimulationRunResource(invocation), input.background) })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.copy',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Copy Simulation Run',
      description: 'Creates an independent paused copy of this Run at one coherent simulation boundary. Copying does not change how either Run executes.',
      risk: 'write',
      idempotent: false,
      inputSchema: capabilityJsonSchema(runCopyInputSchema),
      outputSchema: capabilityJsonSchema(z.object({ id: simulationRunIdSchema, title: z.string().min(1) })),
    },
    invoke: async (registry, invocation) => {
      const input = runCopyInputSchema.parse(invocation.input)
      const created = await registry.copy(requireSimulationRunResource(invocation), input.name === undefined ? {} : { name: input.name })
      const resource = { workspaceId: registry.workspaceId, moduleId: WORLD_MODULE_ID, type: 'world.simulation-run', id: created.id }
      return json({
        result: { id: created.id, title: (await registry.summary(created.id)).title },
        createdResources: [resource],
      }, { status: 201 })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.execution.read', moduleId: WORLD_MODULE_ID, kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Run execution', description: 'Reads independent playback and pace state, simulation time, maximum-pace availability, and current or most recent acceleration progress.',
      risk: 'read', idempotent: true, inputSchema: capabilityJsonSchema(emptyInputSchema), outputSchema: capabilityJsonSchema(runExecutionStateSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      return json({ result: await registry.executionStatus(requireSimulationRunResource(invocation)) })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.execution.set', moduleId: WORLD_MODULE_ID, kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Set Run execution', description: 'Independently sets playback to playing or paused and pace to realtime or maximum. Omitted fields retain their current value; maximum pace uses exact shared Pack boundaries.',
      risk: 'write', idempotent: true, inputSchema: capabilityJsonSchema(executionSetInputSchema), outputSchema: capabilityJsonSchema(runExecutionStateSchema),
    },
    invoke: async (registry, invocation) => {
      const input = executionSetInputSchema.parse(invocation.input)
      const result = await registry.setExecution(requireSimulationRunResource(invocation), input)
      return json({ result }, { status: result.playback === 'playing' && result.pace === 'maximum' ? 202 : 200 })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.agent-restrictions.read', moduleId: WORLD_MODULE_ID, kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read AI restrictions', description: 'Reads the current AI restrictions for this Run. Scenario restrictions are only the initial value; this current state is authoritative.',
      risk: 'read', idempotent: true, inputSchema: capabilityJsonSchema(emptyInputSchema), outputSchema: capabilityJsonSchema(agentRestrictionsStateSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const restrictions = runtime.snapshot().scenario?.agentRestrictions
      if (!restrictions) return apiError(409, 'scenario_state_unavailable', 'Simulation Run scenario state is unavailable')
      return json({ result: restrictions })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.agent-restrictions.set', moduleId: WORLD_MODULE_ID, kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Set AI restrictions', description: 'Replaces the current AI restrictions for this Run. Human or system callers may grant or remove access without changing the source Scenario.',
      risk: 'write', idempotent: false, inputSchema: capabilityJsonSchema(setAgentRestrictionsInputSchema), outputSchema: capabilityJsonSchema(agentRestrictionsStateSchema),
    },
    invoke: async (registry, invocation) => {
      const input = setAgentRestrictionsInputSchema.parse(invocation.input)
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      try {
        return json({ result: await runtime.setAgentRestrictions(buildSimulationRunActorForAccess(invocation.access), input.restrictions, input.expectedRevision) })
      } catch (error) {
        const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined
        if (code === 'agent_restrictions_human_required') return apiError(403, code, error instanceof Error ? error.message : String(error))
        if (code === 'agent_restrictions_revision_conflict') return apiError(409, code, error instanceof Error ? error.message : String(error))
        if (code === 'agent_restrictions_object_not_found') return apiError(409, code, error instanceof Error ? error.message : String(error))
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.execution.advance', moduleId: WORLD_MODULE_ID, kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Advance Run by duration', description: 'Plays this Run at maximum pace for a fixed simulated duration, then pauses or plays in realtime. Playback can pause and resume the active target.',
      risk: 'write', idempotent: false, inputSchema: capabilityJsonSchema(executionAdvanceInputSchema), outputSchema: capabilityJsonSchema(runExecutionStateSchema),
    },
    invoke: async (registry, invocation) => json({ result: await registry.advanceExecution(requireSimulationRunResource(invocation), executionAdvanceInputSchema.parse(invocation.input)) }, { status: 202 }),
  },
  {
    descriptor: {
      id: 'world.simulation-run.rename',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Rename Simulation Run',
      description: 'Sets an independent Run display name. Null restores the pinned Scenario title. Does not modify simulation state or its source Scenario.',
      risk: 'write',
      idempotent: false,
      inputSchema: capabilityJsonSchema(resourceRenameInputSchema),
      outputSchema: capabilityJsonSchema(simulationRunSummarySchema),
    },
    invoke: async (registry, invocation) => {
      const input = resourceRenameInputSchema.parse(invocation.input)
      const summary = await registry.rename(requireSimulationRunResource(invocation), input.name, input.expectedTitle)
      return json({ result: summary })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.delete',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Delete Simulation Run',
      description: 'Permanently stops and deletes a Simulation Run and its persisted state, including active maximum-pace work.',
      risk: 'destructive',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(simulationRunDeleteResultSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const simulationRunId = requireSimulationRunResource(invocation)
      return await registry.delete(simulationRunId)
        ? json({ result: { deleted: true, simulationRunId } })
        : apiError(404, 'simulation_run_not_found', 'Simulation Run not found')
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.read',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Simulation Run',
      description: 'Reads the current summary of a selected Simulation Run.',
      risk: 'read',
      idempotent: true,
      inputSchema: capabilityJsonSchema(emptyInputSchema),
      outputSchema: capabilityJsonSchema(simulationRunSummarySchema),
    },
    invoke: async (registry, invocation) => {
      const simulationRunId = requireSimulationRunResource(invocation)
      const summary = await registry.summary(simulationRunId)
      return summary.scenarioId !== null
        ? json({ result: summary })
        : apiError(404, 'simulation_run_not_found', 'Simulation Run not found')
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.context',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Simulation Context',
      description: 'Returns an agent-safe briefing, current situation, operational-object summaries, and available Capabilities without exposing private Scenario Timeline content.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(simulationRunContextSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const simulationRunId = requireSimulationRunResource(invocation)
      const runtime = await registry.load(simulationRunId)
      const [definition, summary, execution] = await Promise.all([
        registry.compiledScenarioForRun(simulationRunId),
        registry.summary(simulationRunId),
        registry.executionStatus(simulationRunId),
      ])
      const snapshot = runtime.snapshot()
      const { capabilities: _capabilityDescriptors, ...affordances } = runtime.capabilities()
      const denied = deniedInspectionSubjects(runtime, invocation)
      const visibleObjects = snapshot.objects.filter(object => !denied.has(object.id))
      const contextObjects = representativeOperationalObjects(visibleObjects)
      return json({ result: {
        subject: {
          workspaceId: registry.workspaceId,
          simulationRunId,
          scenarioId: summary.scenarioId,
          scenarioRevisionId: summary.scenarioRevisionId,
        },
        briefing: {
          title: summary.title,
          ...(definition.description === undefined ? {} : { summary: definition.description }),
          objectives: definition.objectives ?? [],
        },
        situation: {
          observedAt: new Date().toISOString(),
          sequence: snapshot.seq,
          runtimeHealth: runtime.health(),
          historian: runtime.recordingStatus(),
          ...(snapshot.clock === undefined ? {} : { clock: snapshot.clock }),
          ...(snapshot.scenario?.guidance === undefined ? {} : { guidance: snapshot.scenario.guidance }),
          procedures: visibleProcedureState(runtime, invocation),
          execution: { origin: summary.origin, state: execution },
        },
        objects: {
          total: visibleObjects.length,
          returned: contextObjects.length,
          selection: 'one-per-pack-kind',
          byPack: countBy(visibleObjects.map(object => object.packId)),
          byKind: countBy(visibleObjects.map(object => object.kind)),
          byStatus: countBy(visibleObjects.map(object => object.operational.status)),
          items: contextObjects,
        },
        affordances,
      } })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.objects.search',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Search Operational Objects',
      description: 'Searches current operational-object summaries by Pack, kind, or text with bounded pagination.',
      risk: 'read',
      idempotent: true,
      inputSchema: capabilityJsonSchema(searchObjectsInputSchema),
      outputSchema: capabilityJsonSchema(objectSearchResultSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = searchObjectsInputSchema.parse(invocation.input)
      const denied = deniedInspectionSubjects(runtime, invocation)
      const objects = runtime.snapshot().objects
        .filter(object => !denied.has(object.id))
        .filter(object => input.packId === undefined || object.packId === input.packId)
        .filter(object => input.kind === undefined || object.kind === input.kind)
        .filter(object => input.status === undefined || object.operational.status === input.status)
        .filter(object => input.lifecycle === undefined || object.lifecycle === input.lifecycle)
        .filter(object => input.priority === undefined || object.operational.priority === input.priority)
        .filter(object => matchesLiteralSearch(input.text, [object.id, object.label, object.kind, object.packId, object.operational.status]))
        .map(summarizeOperationalObject)
        .sort((left, right) => left.id.localeCompare(right.id))
      return json({ result: {
        total: objects.length,
        offset: input.offset,
        limit: input.limit,
        objects: objects.slice(input.offset, input.offset + input.limit),
      } })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.read-object',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Operational Object',
      description: 'Reads current canonical projected state for one operational object discovered through context or object search.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(readObjectInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(operationalObjectSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = readObjectInputSchema.parse(invocation.input)
      const object = runtime.snapshot().objects.find(candidate => candidate.id === input.objectId)
      return object
        ? json({ result: object })
        : apiError(404, 'operational_object_not_found', 'Operational Object not found')
    },
  },
  {
    descriptor: {
      id: 'world.procedure.catalog.list',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'List procedure catalog',
      description: 'Lists the procedure documents available to this Simulation Run from its configured sources.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(procedureCatalogInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(procedureCatalogSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = procedureCatalogInputSchema.parse(invocation.input)
      return json({ result: await runtime.procedureCatalog({
        refresh: input.refresh,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      }) })
    },
  },
  {
    descriptor: {
      id: 'world.procedure.document.read',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read procedure document',
      description: 'Reads parsed procedure guidance, branches and tags without duplicating the original Markdown. Optional stepId selects one exact step and its referenced tags; document context, source identity and total counts remain. Request includeSource only for original-source inspection. This is authored guidance, not proof of physical conditions or executed actions. For an existing procedure Run, pass its sourceId, sourceRevision and sourcePath from world.procedure.runs.list; the current catalog may describe a newer revision.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(procedureDocumentInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(procedureDocumentReadSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = procedureDocumentInputSchema.parse(invocation.input)
      const document = await runtime.procedureDocument({
        procedureId: input.procedureId,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
        ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
      })
      const steps = input.stepId === undefined ? document.steps : document.steps.filter(step => step.id === input.stepId)
      if (input.stepId !== undefined && steps.length !== 1) return apiError(
        steps.length === 0 ? 404 : 409,
        steps.length === 0 ? 'procedure_step_not_found' : 'procedure_step_ambiguous',
        `Procedure ${document.procedureId} has ${steps.length} steps with id ${input.stepId}. Read the document without stepId to inspect its actual steps.`,
      )
      const referencedTags = new Set(steps.flatMap(step => step.tagIds))
      const { rawMarkdown, ...parsed } = document
      return json({ result: {
        ...parsed,
        steps,
        tags: input.stepId === undefined ? document.tags : document.tags.filter(tag => referencedTags.has(tag.id)),
        totalSteps: document.steps.length,
        totalTags: document.tags.length,
        ...(input.stepId === undefined ? {} : { selectedStepId: input.stepId }),
        ...(input.includeSource ? { rawMarkdown } : {}),
      } })
    },
  },
  {
    descriptor: {
      id: 'world.procedure.source.read',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read retained procedure basis',
      description: 'Reads exact source Markdown or a directly cited technical Basis owner retained with a selected procedure publication. Pass sourceId, sourceRevision and sourcePath from the procedure document or its Basis link. Optional section or line selection supports progressive reading. This never substitutes the latest wiki or current code for an unavailable historical source.',
      risk: 'read', idempotent: true,
      inputSchema: z.toJSONSchema(procedureEvidenceInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(procedureEvidenceOutputSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = procedureEvidenceInputSchema.parse(invocation.input)
      return json({ result: await runtime.procedureEvidence({
        sourceRevision: input.sourceRevision, sourcePath: input.sourcePath,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        ...(input.section === undefined ? {} : { section: input.section }),
        ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
        ...(input.lineCount === undefined ? {} : { lineCount: input.lineCount }),
      }) })
    },
  },
  {
    descriptor: {
      id: 'world.procedure.runs.list',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'List procedure runs',
      description: 'Lists current procedure execution state in this Simulation Run.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(procedureControlStateSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      return json({ result: visibleProcedureState(runtime, invocation) })
    },
  },
  {
    descriptor: {
      id: 'world.procedure.run.step.read',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read procedure run step',
      description: 'Run, continue or step through a live procedure: reads one step of a procedure Run to work through it. Input {runId?, stepId?}: omit runId for the one active Run you drive (refused, with the active runs named, unless there is exactly one), and stepId for its current step. Returns the run (driver, current step, step n of total); the step\'s checks, actions and cautions; its branches with index, outcome, target and whether an AI agent may select each (aiMaySelect, else personOnlyReason); each tag the step cites with its binding and its reading (formatted, quality) at the view\'s simulationTime, or why it is unavailable; World\'s observation and the step\'s decision so far; the CSF colours the procedure monitors; and sequence, to pass to world.simulation-run.wait. Select with world.procedure.run.transition; an AI agent\'s accepted transition returns this view of the next step. Readings are model values, not instrument validation.',
      searchTerms: ['continue procedure', 'run procedure', 'step through procedure', 'work through procedure', 'next procedure step', 'procedure placekeeping'],
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(procedureStepReadInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(procedureStepViewSchema),
    },
    invoke: async (registry, invocation) => {
      const input = procedureStepReadInputSchema.parse(invocation.input)
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      try {
        return json({ result: await procedureStepViewFor(runtime, invocation, input, 'step') })
      } catch (error) {
        const failure = error as Error & { status?: number; code?: string }
        if (typeof failure.status === 'number' && typeof failure.code === 'string') return apiError(failure.status, failure.code, failure.message)
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.wait',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Wait for a Run change',
      description: `Waits in your turn, at most ${runWaitMaxMs / 1_000} s of wall time, for the plant to respond or a person to act. Input {afterSequence?, maxWaitMs? (1000-${runWaitMaxMs}), simulationSeconds? (1-600), events? [{type, procedureRunId?, signalType?}] (up to 8), procedureRunId?}; name simulationSeconds, events or both. With procedureRunId the result also carries next: that run's current step as world.procedure.run.step.read returns it, so decide from it without another read. Returns at the first of: a durable event after afterSequence (a step read's sequence; omitted: from now) matching events, e.g. {"type":"interaction.signal.received","signalType":"process-plant.proposal.approved"}; simulationSeconds of plant time from now; someone else taking over, releasing, closing or resetting a procedure Run you drive (reason driver-changed: stop and report); or maxWaitMs (timeout). Waiting for plant time on a paused clock returns clock-paused at once: it never plays or advances time. If the Run is deleted, its Workspace removed or World stops, the wait fails at once with simulation_run_closed: stop. Returns reason, fromSequence, sequence, simulationTime, waitedMs, the matching events and driverChanged. Call it alone.`,
      searchTerms: ['wait for plant response', 'wait plant time', 'wait for approval', 'simulation seconds', 'procedure wait'],
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(runWaitInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(runWaitAnswerSchema),
    },
    invoke: async (registry, invocation) => {
      const input = runWaitInputSchema.parse(invocation.input)
      const simulationRunId = requireSimulationRunResource(invocation)
      const runtime = await registry.load(simulationRunId)
      const caller = buildSimulationRunActorForAccess(invocation.access).id
      const clock = () => {
        const current = runtime.snapshot().clock
        if (!current) throw new Error('Simulation Run clock is not initialized')
        return current
      }
      const result = await waitForRunChange({
        input,
        caller,
        driven: drivenRunsOf(caller, runtime.snapshot().procedures?.runs ?? [], runtime.events()),
        ports: {
          events: afterSequence => visibleChangeEvents(runtime, invocation, runtime.events({ afterSeq: afterSequence })),
          sequence: () => runtime.snapshot().seq,
          clock,
          subscribe: wake => runtime.subscribe(() => wake()),
          now: () => performance.now(),
          schedule: (callback, delayMs) => {
            const timer = setTimeout(callback, delayMs)
            return () => clearTimeout(timer)
          },
          // Deleting the Run unloads it; removing its Workspace or stopping World closes the registry.
          closed: () => registry.get(simulationRunId) !== runtime || registry.closing(),
        },
      })
      return json({ result: input.procedureRunId === undefined ? result
        : { ...result, ...(await nextProcedureStep(runtime, invocation, input.procedureRunId, `The wait ended (${result.reason})`)) } })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.changes',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Simulation Changes',
      description: 'Reads a bounded page of committed changes after a known simulation sequence so an Agent can stay current without re-reading the whole World.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(readChangesInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(simulationChangesSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = readChangesInputSchema.parse(invocation.input)
      const available = runtime.events({ afterSeq: input.afterSequence })
      const page = available.slice(0, input.limit)
      const events = visibleChangeEvents(runtime, invocation, page)
      const currentSequence = runtime.snapshot().seq
      return json({ result: {
        afterSequence: input.afterSequence,
        currentSequence,
        events,
        hasMore: available.length > page.length,
        nextSequence: page.at(-1)?.seq ?? input.afterSequence,
      } })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.history-series.list',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'List Simulation History Series',
      description: 'Discovers recorded historian series selected by Scenario Recording Profiles. Filter by runtime, subject, signal, or literal text; every text term must match somewhere in the metadata, so use one signal concept per query and batch separate focused queries for different series. If user vocabulary does not match, resolve the canonical subject or signal through the active Pack instead of dumping an unfiltered catalog. Treat the returned runtimeId and opaque series id as one reference and pass both unchanged to the sample reader. A live signal path is not a historian series id.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(listHistorySeriesInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(simulationHistorySeriesSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = listHistorySeriesInputSchema.parse(invocation.input)
      const denied = deniedInspectionSubjects(runtime, invocation)
      const series = runtime.recordingSeries()
        .filter(item => !denied.has(item.subjectId))
        .filter(item => input.runtimeId === undefined || item.runtimeId === input.runtimeId)
        .filter(item => input.subjectId === undefined || item.subjectId === input.subjectId)
        .filter(item => input.signalId === undefined || item.signalId === input.signalId)
        .filter(item => matchesLiteralSearch(input.text, [item.runtimeId, item.id, item.subjectId, item.signalId, item.title, item.quantity, item.unit]))
        .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId) || left.id.localeCompare(right.id))
      const page = series.slice(input.offset, input.offset + input.limit)
      return json({ result: {
        status: runtime.recordingStatus(),
        total: series.length,
        offset: input.offset,
        returned: page.length,
        hasMore: input.offset + page.length < series.length,
        series: page,
      } })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.history-samples.read',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Simulation History',
      description: 'Reads one exact historian series. Default summary returns retained-window counts, quality counts, endpoints and extrema without raw rows; choose raw for sequence-paginated samples. Obtain runtimeId and opaque seriesId together from world.simulation-run.history-series.list. Window summaries cover the whole requested time interval, independently of raw page size and cursor. Averages are sample-weighted, not time-weighted; bad/uncertain samples remain included and identified in qualityCounts. Bounds describe retained sampled evidence; retentionGap indicates requests older than those bounds, not complete capture or proof of pruning. Reads are live queries, not a snapshot across calls. Use current-state reads for a current sitrep; history is useful for change, timing, causes or trends.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(readHistorySamplesInputSchema, { io: 'input' }),
      outputSchema: capabilityJsonSchema(simulationHistorySamplesSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = readHistorySamplesInputSchema.parse(invocation.input)
      const availableSeries = runtime.recordingSeries()
      const series = availableSeries.find(item => item.runtimeId === input.runtimeId && item.id === input.seriesId)
      if (!series) {
        const matchingId = availableSeries.filter(item => item.id === input.seriesId)
        if (matchingId.length > 0) return apiError(422, 'historian_runtime_mismatch', 'Historian series exists under a different Pack runtime', {
          suppliedRuntimeId: input.runtimeId,
          matchingReferences: matchingId.slice(0, 20).map(item => ({
            runtimeId: item.runtimeId,
            id: item.id,
            subjectId: item.subjectId,
            signalId: item.signalId,
            title: item.title,
          })),
          matchingReferenceCount: matchingId.length,
          guidance: 'Use the returned runtimeId and id together as the historian series reference.',
        })
        return apiError(404, 'historian_series_not_found', 'Historian series not found', {
          nextOperation: 'world.simulation-run.history-series.list',
          guidance: 'Discover the exact runtimeId and opaque series id pair by filtering the series catalog; do not use a subject id or live signal path as either field.',
        })
      }
      const page = runtime.recordedSamples(input)
      const compact = ({ runtimeId: _runtimeId, seriesId: _seriesId, ...sample }: import('../model/recording.ts').RecordedSample) => sample
      return json({ result: {
        series,
        ...page,
        ...(page.mode === 'raw' ? { samples: page.samples.map(compact) } : {}),
        windowSummary: {
          ...page.windowSummary,
          firstSample: page.windowSummary.firstSample === null ? null : compact(page.windowSummary.firstSample),
          lastSample: page.windowSummary.lastSample === null ? null : compact(page.windowSummary.lastSample),
        },
      } })
    },
  },
])

const invokeCapability = async (
  registry: SimulationRunRegistry,
  capabilityId: string,
  rawInvocation: unknown,
): Promise<Response> => {
  const invocation = moduleCapabilityInvocationSchema.parse(rawInvocation)
  if (invocation.workspaceId !== registry.workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Invocation belongs to another Workspace')
  if (invocation.capabilityId !== capabilityId) return apiError(409, 'capability_scope_mismatch', 'Invocation Capability does not match the route')
  if (invocation.idempotencyKey !== undefined && worldCapabilities.descriptors.some(descriptor => descriptor.id === capabilityId)) return apiError(400, 'idempotency_not_supported', 'This Capability does not support keyed retries; inspect the Resource after an uncertain result.')

  const release = invocation.resource?.type === 'world.simulation-run' && capabilityId !== 'world.simulation-run.delete'
    ? registry.acquireLease(requireSimulationRunResource(invocation), 'api') : undefined
  try {
    // The Host broker carries no role set. In a role Run it serves people only
    // the open Run controls and serves AI nothing Run-scoped.
    if (invocation.resource?.type === 'world.simulation-run') {
      const ai = invocation.access.actor.kind === 'ai'
      if (ai || !roleRunOpenCapabilityIds.has(capabilityId)) {
        if (await registry.runRoles(requireSimulationRunResource(invocation)) !== null) throw ai ? aiRoleRunRefusal() : roleRequiredRefusal()
      }
    }
    if (invocation.access.actor.kind === 'ai' && invocation.resource?.type === 'world.simulation-run') {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const restrictions = runtime.snapshot().scenario?.agentRestrictions
      if (restrictions && capabilityId !== 'world.simulation-run.agent-restrictions.read') {
        if (restrictions.operationIds.includes(capabilityId)) {
          return apiError(403, 'agent_access_restricted', `AI access to operation ${capabilityId} is restricted for this Run`)
        }
        // Historian identity already carries subject provenance. Apply the same
        // exact-subject restriction as live inspection; no Pack-specific parsing.
        let objectId: string | undefined
        if (capabilityId === 'world.simulation-run.read-object') {
          objectId = readObjectInputSchema.parse(invocation.input).objectId
        } else if (capabilityId === 'world.simulation-run.history-series.list') {
          objectId = listHistorySeriesInputSchema.parse(invocation.input).subjectId
        } else if (capabilityId === 'world.simulation-run.history-samples.read') {
          const input = readHistorySamplesInputSchema.parse(invocation.input)
          objectId = runtime.recordingSeries().find(series => series.runtimeId === input.runtimeId && series.id === input.seriesId)?.subjectId
        }
        if (objectId !== undefined) {
          if (restrictions.objects.some(entry => entry.objectId === objectId && entry.deny.includes('inspect'))) {
            return apiError(403, 'agent_access_restricted', `AI inspection access is restricted for: ${objectId}`)
          }
        }
      }
    }

    const response = await worldCapabilities.invoke(capabilityId, registry, invocation)
    if (response) return response

    const workspaceCapability = registry.workspaceCapabilities.find(capability => capability.id === capabilityId)
    if (workspaceCapability) {
      if (invocation.idempotencyKey !== undefined) return apiError(400, 'idempotency_not_supported', 'This Workspace Capability does not support keyed retries')
      if (invocation.resource || invocation.definition) return apiError(400, 'capability_scope_mismatch', 'This Pack operation requires Workspace scope')
      const result = await workspaceCapability.invoke(workspaceCapability.input.parse(invocation.input))
      return json({ result: workspaceCapability.output.parse(result) })
    }

    const descriptor = runtimeCapabilityDescriptorsFor(registry).find(candidate => candidate.id === capabilityId)
    if (!descriptor) return apiError(404, 'capability_not_found', 'Capability not found')
    const simulationRunId = requireSimulationRunResource(invocation)
    const runtime = await registry.load(simulationRunId)
    if (!runtime.capabilities().capabilities.some(candidate => candidate.id === capabilityId)) {
      return apiError(409, 'capability_not_active', `Capability is not active in this Simulation Run: ${capabilityId}`)
    }
    const actor = buildSimulationRunActorForAccess(invocation.access)
    let outcome
    try {
      outcome = await runtime.invokeCapability(actor, {
        capabilityId,
        input: invocation.input,
        ...(invocation.expectedRevision === undefined ? {} : { expectedRevision: invocation.expectedRevision }),
        ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
      })
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === 'agent_access_restricted') {
        return apiError(403, 'agent_access_restricted', error.message)
      }
      throw error
    }
    if (outcome.kind === 'command' && !outcome.result.ok) {
      return apiError(409, 'simulation_command_rejected', outcome.result.reason)
    }
    if (outcome.kind === 'command' && capabilityId === procedureRunTransitionCommandKind && invocation.access.actor.kind === 'ai') {
      const { runId } = procedureRunTransitionPayloadSchema.parse(invocation.input)
      return json({ result: { ...outcome.result, ...(await nextProcedureStep(runtime, invocation, runId, 'The transition was accepted')) } })
    }
    if (outcome.kind === 'command' && capabilityId === procedureRunStartCommandKind) {
      return json({ result: { ...outcome.result, ...(await startedProcedureRun(runtime, invocation)) } })
    }
    return json({
      result: outcome.result,
    })
  } finally { release?.() }
}

export const handleWorldModuleApi = async (
  request: Request,
  url: URL,
  workspaces: WorldWorkspaceRuntimeRegistry,
): Promise<Response | null> => {
  try {
    if (url.pathname === '/.well-known/workspace-module' && request.method === 'GET') {
      return json(worldModuleManifest)
    }

    const workspaceMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)$/)
    if (workspaceMatch) {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(workspaceMatch[1] ?? ''))
      if (request.method === 'PUT') {
        const input = lifecycleInputSchema.parse(await readJson(request))
        if (input.workspaceId !== workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Lifecycle body and route disagree')
        const provisioned = await workspaces.provision(workspaceId)
        return json({ workspaceId, moduleId: WORLD_MODULE_ID }, { status: provisioned.created ? 201 : 200 })
      }
      if (request.method === 'DELETE') {
        await workspaces.remove(workspaceId)
        return new Response(null, { status: 204 })
      }
    }

    const resourcesMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/resources$/)
    if (resourcesMatch && request.method === 'GET') {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(resourcesMatch[1] ?? ''))
      return await workspaces.withRuntime(workspaceId, async runtime => json(moduleResourceCollectionSchema.parse({ resources: await resourcesFor(runtime.simulationRuns) })))
    }

    const definitionsMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/definitions$/)
    if (definitionsMatch && request.method === 'GET') {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(definitionsMatch[1] ?? ''))
      return await workspaces.withRuntime(workspaceId, async runtime => json(moduleDefinitionCollectionSchema.parse({ definitions: await definitionsFor(runtime.simulationRuns) })))
    }

    const capabilitiesMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/capabilities$/)
    if (capabilitiesMatch && request.method === 'GET') {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(capabilitiesMatch[1] ?? ''))
      return await workspaces.withRuntime(workspaceId, async runtime => json(moduleCapabilityCollectionSchema.parse({
        capabilities: [...worldCapabilities.descriptors, ...workspacePackCapabilityDescriptorsFor(runtime.simulationRuns), ...runtimeCapabilityDescriptorsFor(runtime.simulationRuns)],
      })))
    }

    const invocationMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/capabilities\/([^/]+)\/invoke$/)
    if (invocationMatch && request.method === 'POST') {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(invocationMatch[1] ?? ''))
      const capabilityId = decodeURIComponent(invocationMatch[2] ?? '')
      return await workspaces.withRuntime(workspaceId, async runtime => invokeCapability(runtime.simulationRuns, capabilityId, await readJson(request)))
    }

    return null
  } catch (error) {
    if (isCapabilityRejection(error)) return apiError(error.status, error.code, error.message)
    if (isRoleGateRefusal(error)) return apiError(error.status, error.code, error.message, error.details)
    if (error instanceof Error && 'code' in error && error.code === 'storage_budget_exceeded') return apiError(507, 'storage_budget_exceeded', error.message)
    if (error instanceof Error && 'code' in error && error.code === 'history_unavailable') return apiError(503, 'history_unavailable', error.message)
    if (error instanceof Error && 'code' in error && error.code === 'workspace_closing') return apiError(409, 'workspace_closing', error.message)
    if (error instanceof Error && 'code' in error && error.code === 'simulation_run_busy') return apiError(409, 'simulation_run_busy', error.message)
    if (error instanceof Error && 'code' in error && error.code === 'simulation_run_failed') return apiError(409, 'simulation_run_failed', error.message)
    if (error instanceof Error && 'code' in error && typeof error.code === 'string'
      && ['simulation_run_commit_uncertain', 'simulation_run_observer_failed', 'simulation_run_recovery_required', 'simulation_run_closed'].includes(error.code)) return apiError(409, error.code, error.message)
    if (error instanceof Error && 'code' in error && error.code === 'fast_forward_unsupported') return apiError(422, 'fast_forward_unsupported', error.message)
    if (error instanceof Error && 'code' in error && error.code === 'workspace_capacity_exceeded') return apiError(503, 'workspace_capacity_exceeded', error.message)
    if (error instanceof Error && 'code' in error && error.code === 'simulation_run_name_changed') {
      return apiError(409, 'simulation_run_name_changed', error.message)
    }
    if (error instanceof SyntaxError) return apiError(400, 'invalid_json', error.message)
    if (error instanceof z.ZodError) return apiError(400, zodErrorCode(error), error.message)
    if (error instanceof CommandIdempotencyConflictError) return apiError(error.status, error.code, error.message)
    if (error instanceof Error && error.message.startsWith('World Module not provisioned:')) {
      return apiError(404, 'workspace_not_found', 'World is not enabled in this Workspace')
    }
    if (error instanceof Error && error.message.startsWith('Simulation Run not found:')) {
      return apiError(404, 'simulation_run_not_found', 'Simulation Run not found')
    }
    throw error
  }
}
