import { z } from 'zod'
import {
  inspectionViewSchema,
  moduleCapabilityCollectionSchema,
  moduleCapabilityInvocationSchema,
  moduleDefinitionCollectionSchema,
  moduleFeaturedDefinitionCollectionSchema,
  moduleIdSchema,
  moduleResourceCollectionSchema,
  workspaceIdSchema,
  workspaceModuleManifestSchema,
  workspaceDefinitionRevisionReferenceSchema,
  workspaceResourceReferenceSchema,
  workspaceRoomScopeSchema,
  workspaceSubjectReferenceSchema,
  type ModuleResourceDescriptor,
  type WorkspaceId,
} from '@leitbild/contracts'
import { createModuleCapabilityRegistry } from '@leitbild/module-runtime'
import { asAIAgent } from '../agents/shared.ts'
import { runPromptDeckEntry, startRoomDefinition, validateRoomDefinition } from '../core/definitions/room-definition-service.ts'
import { AssistanceRoomError, createAssistanceRoom, ensureAssistanceRoom, openNewAssistanceRoom } from '../core/definitions/assistant-room.ts'
import type { RoomDefinitionLibrary } from '../core/definitions/room-definition-library.ts'
import { roomDefinitionSchema, type RoomDefinition } from '../core/definitions/room-definition-catalog.ts'
import type { AgentsModuleState } from '../core/workspaces/module-state.ts'
import type { WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { workspaceModulePaths } from '../core/paths.ts'
import { loadWorkspaceModuleSnapshots } from '../core/storage/module-snapshots.ts'
import { roomPacksInputSchema } from '../packs/activation.ts'
import { isPeopleCapabilityId } from '../core/people/people-capability-ids.ts'
import { invokePeopleCapability, peopleCapabilityDescriptors } from './people-capabilities.ts'

export const agentsModuleManifest = workspaceModuleManifestSchema.parse({
  module: {
    id: 'agents',
    title: 'Agents',
    description: 'Rooms, messages, coordination, AI Agent profiles, model execution, tools, context, and evaluations.',
  },
  endpoints: {
    workspace: '/internal/workspaces/{workspaceId}',
    definitions: '/internal/workspaces/{workspaceId}/definitions',
    resources: '/internal/workspaces/{workspaceId}/resources',
    capabilities: '/internal/workspaces/{workspaceId}/capabilities',
    invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
    featuredDefinitions: '/internal/featured-definitions',
  },
  ui: { workspace: '/workspaces/{workspaceId}/agents' },
})

// Agents features and lists no Definition for newcomers; it still answers the
// endpoint every Module publishes, with empty lists rather than an absent route.
const agentsFeaturedDefinitions = moduleFeaturedDefinitionCollectionSchema.parse({ definitions: [], listed: [] })

const AGENTS_MODULE_ID = moduleIdSchema.parse('agents')

const lifecycleSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
const createRoomSchema = z.object({ name: z.string().trim().min(1).max(128), roomPrompt: z.string().max(16_384).optional() }).strict()
const postMessageSchema = z.object({ content: z.string().min(1).max(1_000_000) }).strict()
const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  persona: z.string().max(64_000),
  tools: z.array(z.string().trim().min(1).max(128)).default([]),
  temperature: z.number().finite().optional(),
}).strict()
const readRoomSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
}).strict()
const runPromptDeckEntrySchema = z.object({
  entryId: z.string().trim().min(1).max(128),
}).strict()
const writeRoomDefinitionSchema = z.object({ definition: roomDefinitionSchema }).strict()
const emptyInputSchema = z.object({}).strict()
const assistantPromptSchema = z.string().trim().min(1).max(64_000)
const assistantFocusSchema = z.array(workspaceSubjectReferenceSchema).max(4).default([])
// 'reuse' joins the Scope's existing Assistance Room; 'new' starts a separate
// conversation that carries its own title and opens with the request. The
// title becomes the Room name, so it leaves headroom under the 100-character
// Room name limit for a uniqueness suffix.
const assistantOpenInputSchema = z.union([
  z.object({
    conversation: z.literal('reuse').default('reuse'),
    scope: workspaceRoomScopeSchema.default({ kind: 'workspace' }),
    title: z.string().trim().min(1).max(256).optional(),
    prompt: assistantPromptSchema.optional(),
    focusedSubjects: assistantFocusSchema,
  }).strict(),
  z.object({
    conversation: z.literal('new'),
    scope: workspaceRoomScopeSchema.default({ kind: 'workspace' }),
    title: z.string().trim().min(1).max(80),
    prompt: assistantPromptSchema,
    focusedSubjects: assistantFocusSchema,
  }).strict(),
])
const assistanceCreateInputSchema = z.object({
  scope: workspaceRoomScopeSchema,
  title: z.string().trim().min(1).max(128),
}).strict()
const setRoomScopeInputSchema = z.object({
  scope: workspaceRoomScopeSchema,
  expectedRevision: z.number().int().nonnegative(),
}).strict()
const assistantOpenResultSchema = z.object({
  resource: workspaceResourceReferenceSchema,
  uiPath: z.string().min(1),
  reused: z.boolean(),
}).strict()
const ROOM_DEFINITION_TYPE = 'agents.room-definition'

const json = (body: unknown, status = 200): Response => Response.json(body, { status })
const apiError = (status: number, code: string, message: string, retryable?: boolean): Response =>
  json({ error: { code, message, ...(retryable === undefined ? {} : { retryable }) } }, status)
const assistantError = (error: unknown): Response | undefined => error instanceof AssistanceRoomError
  ? apiError(error.status, error.code, error.message)
  : undefined

const readJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json()
  } catch (error) {
    throw new SyntaxError('Request body must be valid JSON', { cause: error })
  }
}

const requireModule = async (state: AgentsModuleState, workspaceId: WorkspaceId): Promise<void> => {
  if (!await state.has(workspaceId)) throw new Error(`Agents Workspace not found: ${workspaceId}`)
}

const scopeLinks = (scope: import('@leitbild/contracts').WorkspaceRoomScope) => {
  if (scope.kind === 'workspace') return []
  if (scope.kind === 'resource') return [{ rel: 'scope-resource', ref: scope.resource }]
  return [
    { rel: 'scope-collection', ref: scope.collection },
    ...(scope.members.mode === 'all'
      ? scope.members.except.map(ref => ({ rel: 'scope-excluded', ref }))
      : scope.members.only.map(ref => ({ rel: 'scope-member', ref }))),
  ]
}

const resourcesFor = async (
  workspaceId: WorkspaceId,
  registry: WorkspaceRuntimeRegistry,
): Promise<ReadonlyArray<ModuleResourceDescriptor>> => {
  const runtime = registry.tryGetLive(workspaceId)
  const saved = runtime ? null : await loadWorkspaceModuleSnapshots(workspaceModulePaths(workspaceId))
  const agents = runtime ? runtime.team.listByKind('ai').map(agent => ({ id: agent.id, name: agent.name, description: agent.getDescription?.(), state: agent.state.get() }))
    : (saved?.agents?.agents ?? []).map(agent => ({ id: agent.id, name: agent.config.name, description: agent.config.persona, state: 'Unloaded' }))
  const agentById = new Map(agents.map(agent => [agent.id, agent]))
  const rooms = runtime ? runtime.rooms.listAllRooms().map(profile => {
    const room = runtime.rooms.getRoom(profile.id)
    if (!room) throw new Error(`Room disappeared during Resource discovery: ${profile.id}`)
    return { profile, members: room.getParticipantIds(), paused: room.paused, deliveryMode: room.deliveryMode, messageCount: room.getMessageCount(), latestMessage: room.getRecent(1)[0] }
  }) : (saved?.rooms?.rooms ?? []).map(room => ({ ...room, messageCount: room.messages.length, latestMessage: room.messages.at(-1) }))
  const observedAt = new Date().toISOString()
  return moduleResourceCollectionSchema.parse({ resources: [
    ...rooms.map(room => {
      const profile = room.profile
      const memberIds = room.members
      const aiMemberCount = memberIds.filter(id => agentById.has(id)).length
      const latestMessage = room.latestMessage
      return {
        ref: { workspaceId, moduleId: AGENTS_MODULE_ID, type: 'agents.room', id: profile.id },
        title: profile.name,
        ...(profile.sourceDefinition === undefined ? {} : {
          sourceDefinition: {
            workspaceId,
            moduleId: AGENTS_MODULE_ID,
            type: ROOM_DEFINITION_TYPE,
            id: profile.sourceDefinition.id,
            revisionId: profile.sourceDefinition.revisionId,
          },
        }),
        links: [...scopeLinks(profile.scope), ...memberIds.flatMap(id => agentById.has(id) ? [{
          rel: 'member',
          ref: { workspaceId, moduleId: AGENTS_MODULE_ID, type: 'agents.agent', id },
          title: agentById.get(id)?.name,
        }] : [])],
        uiPath: `/workspaces/${encodeURIComponent(workspaceId)}/agents?room=${encodeURIComponent(profile.id)}`,
        capabilityIds: agentsCapabilities.idsForResourceType('agents.room'),
        inspectionCapabilityId: 'agents.room.inspect',
        deleteCapabilityId: 'agents.room.delete',
        summary: [
          {
            key: 'created-at',
            label: 'Created',
            kind: 'timestamp' as const,
            value: new Date(profile.createdAt).toISOString(),
          },
          {
            key: 'status',
            label: 'Status',
            kind: 'status' as const,
            value: room.paused ? 'Paused' : room.deliveryMode === 'broadcast' ? 'Broadcast' : 'Manual',
          },
          { key: 'member-count', label: 'Members', kind: 'count' as const, value: memberIds.length },
          { key: 'ai-member-count', label: 'AI agents', kind: 'count' as const, value: aiMemberCount },
          { key: 'message-count', label: 'Messages', kind: 'count' as const, value: room.messageCount },
          { key: 'scope-revision', label: 'Scope revision', kind: 'count' as const, value: profile.scopeRevision },
          ...(latestMessage === undefined ? [] : [{
            key: 'last-activity-at',
            label: 'Last activity',
            kind: 'timestamp' as const,
            value: new Date(latestMessage.timestamp).toISOString(),
          }]),
        ],
        observedAt,
      }
    }),
    ...agents.map(agent => ({
      ref: { workspaceId, moduleId: AGENTS_MODULE_ID, type: 'agents.agent', id: agent.id },
      title: agent.name,
      ...(agent.description ? { description: agent.description } : {}),
      links: rooms.filter(room => room.members.includes(agent.id)).map(room => ({
        rel: 'member-of',
        ref: { workspaceId, moduleId: AGENTS_MODULE_ID, type: 'agents.room', id: room.profile.id },
        title: room.profile.name,
      })),
      capabilityIds: agentsCapabilities.idsForResourceType('agents.agent'),
      summary: [
        { key: 'status', label: 'Status', kind: 'status' as const, value: agent.state },
        { key: 'room-count', label: 'Rooms', kind: 'count' as const, value: rooms.filter(room => room.members.includes(agent.id)).length },
      ],
      observedAt,
    })),
  ] }).resources
}

const definitionsFor = async (workspaceId: WorkspaceId, library: RoomDefinitionLibrary) => {
  const definitions = await library.list()
  return moduleDefinitionCollectionSchema.parse({ definitions: await Promise.all(definitions.map(async definition => {
    const revision = await library.getRevision(definition.currentRevisionId)
    if (!revision) throw new Error(`Room Definition Revision not found: ${definition.currentRevisionId}`)
    return {
      ref: {
        workspaceId,
        moduleId: AGENTS_MODULE_ID,
        type: ROOM_DEFINITION_TYPE,
        id: definition.id,
      },
      title: definition.title,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...(definition.category === undefined ? {} : { category: definition.category }),
      currentRevisionId: definition.currentRevisionId,
      capabilityIds: agentsCapabilities.idsForDefinitionType(ROOM_DEFINITION_TYPE),
      inspectionCapabilityId: 'agents.room-definition.inspect',
      ...(revision.document.assistance === undefined ? { primaryCapabilityId: 'agents.room-definition.start' } : {}),
      deleteCapabilityId: 'agents.room-definition.delete',
    }
  })) }).definitions
}

const requireRoomDefinitionId = (
  invocation: z.infer<typeof moduleCapabilityInvocationSchema>,
): string => {
  if (!invocation.definition) throw new Error('Room Definition Capability requires a Definition')
  if (invocation.definition.type !== ROOM_DEFINITION_TYPE) throw new Error('Capability requires an Agents Room Definition')
  return invocation.definition.id
}

const requireResourceId = (
  invocation: z.infer<typeof moduleCapabilityInvocationSchema>,
  resourceType: 'agents.room' | 'agents.agent',
): string => {
  if (!invocation.resource) throw new Error('Capability requires a Resource')
  if (invocation.resource.moduleId !== 'agents' || invocation.resource.type !== resourceType) {
    throw new Error(`Capability requires an ${resourceType} Resource`)
  }
  return invocation.resource.id
}

type AgentsWorkspaceRuntime = Awaited<ReturnType<WorkspaceRuntimeRegistry['getOrLoad']>>

const serializableInspection = (value: unknown) =>
  inspectionViewSchema.parse(JSON.parse(JSON.stringify(value)) as unknown)

const roomDefinitionSections = (definition: RoomDefinition) => [{
  id: 'room-configuration',
  title: 'Room configuration',
  data: {
    assistance: definition.assistance ?? null,
    prompt: definition.room.prompt ?? null,
    deliveryMode: definition.room.deliveryMode,
    packs: definition.room.packs,
  },
}, {
  id: 'configured-agents',
  title: 'Configured agents',
  description: 'Agent personas, tools, semantic Capability grants, and generation settings declared by this definition.',
  data: {
    total: definition.room.agents.length,
    agents: definition.room.agents,
  },
}, {
  id: 'prompt-deck',
  title: 'Prompt deck',
  data: {
    total: definition.deck.entries.length,
    entries: definition.deck.entries,
  },
}]

const definitionWriteResultSchema = z.object({
  definition: workspaceDefinitionRevisionReferenceSchema,
  title: z.string(),
}).strict()

const parseRoomDefinitionWrite = (runtime: AgentsWorkspaceRuntime, raw: unknown) => {
  const input = writeRoomDefinitionSchema.parse(raw)
  try {
    validateRoomDefinition(runtime, input.definition)
  } catch (error) {
    throw new z.ZodError([{ code: 'custom', path: ['definition'], message: error instanceof Error ? error.message : String(error) }])
  }
  return input
}

const agentsCapabilities = createModuleCapabilityRegistry<{ runtime: AgentsWorkspaceRuntime; library: RoomDefinitionLibrary; flush: () => Promise<void> }, Response>(AGENTS_MODULE_ID, [
  {
    descriptor: {
      id: 'agents.packs.list', moduleId: AGENTS_MODULE_ID,
      kind: 'query', scope: { kind: 'workspace' }, title: 'List installed Agent Packs',
      description: 'Lists exact installed and bundled Pack IDs available for agents.room.packs.set. Installation and per-Room activation are separate; this does not activate anything.',
      risk: 'read', idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema), outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      return json({ result: { packs: runtime.packCatalog.list().map(pack => ({
        id: pack.id, title: pack.descriptor.name, description: pack.descriptor.description, deployment: pack.deployment,
      })) } })
    },
  },
  {
    descriptor: {
      id: 'agents.room.packs.set', moduleId: AGENTS_MODULE_ID,
      kind: 'command', scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Set Room Packs',
      description: 'Replaces the installed Packs active in this Room. Read the current list with agents.room.read. Activation does not install Packs or select tools for an Agent. New tool invocations use the current activation; already admitted work may finish.',
      risk: 'write', idempotent: true,
      inputSchema: z.toJSONSchema(roomPacksInputSchema),
      outputSchema: z.toJSONSchema(roomPacksInputSchema),
    },
    invoke: async ({ runtime, flush }, invocation) => {
      const input = roomPacksInputSchema.parse(invocation.input)
      const result = runtime.setRoomPacks(requireResourceId(invocation, 'agents.room'), input.activePacks)
      if (!result.ok) return apiError(result.code === 'room_not_found' ? 404 : 400, result.code, result.message)
      await flush()
      return json({ result: { activePacks: result.activePacks } })
    },
  },
  {
    descriptor: {
      id: 'agents.assistance.open', moduleId: AGENTS_MODULE_ID,
      kind: 'command', scope: { kind: 'workspace' },
      title: 'Open assistance',
      description: 'Reuses or creates an ordinary Assistance Room for the Workspace or a selected Resource collection, optionally posting the first request. With conversation "new", starts a separate titled Assistance Room that opens with the request.',
      risk: 'write', idempotent: false,
      inputSchema: z.toJSONSchema(assistantOpenInputSchema),
      outputSchema: z.toJSONSchema(assistantOpenResultSchema),
    },
    invoke: async ({ runtime, library, flush }, invocation) => {
      const input = assistantOpenInputSchema.parse(invocation.input)
      if (input.focusedSubjects.some(subject => subject.workspaceId !== invocation.workspaceId)) {
        return apiError(409, 'workspace_scope_mismatch', 'Focused Subject belongs to another Workspace')
      }
      const scopeWorkspace = input.scope.kind === 'workspace'
        ? invocation.workspaceId
        : input.scope.kind === 'resource'
          ? input.scope.resource.workspaceId
          : input.scope.collection.workspaceId
      if (scopeWorkspace !== invocation.workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Room Scope belongs to another Workspace')
      try {
        const opened = input.conversation === 'new'
          ? await openNewAssistanceRoom(runtime, library, flush, {
            scope: input.scope,
            title: input.title,
            prompt: input.prompt,
            focusedSubjects: input.focusedSubjects,
          })
          : await ensureAssistanceRoom(runtime, library, flush, {
            scope: input.scope,
            title: input.title,
            prompt: input.prompt,
            focusedSubjects: input.focusedSubjects,
          })
        const resource = workspaceResourceReferenceSchema.parse({
          workspaceId: invocation.workspaceId,
          moduleId: AGENTS_MODULE_ID,
          type: 'agents.room',
          id: opened.room.id,
        })
        return json({
          result: assistantOpenResultSchema.parse({
            resource,
            uiPath: `/workspaces/${encodeURIComponent(invocation.workspaceId)}/agents?room=${encodeURIComponent(opened.room.id)}`,
            reused: !opened.created,
          }),
          ...(opened.created ? { createdResources: [resource] } : {}),
        }, opened.created ? 201 : 200)
      } catch (error) {
        return assistantError(error) ?? apiError(500, 'assistant_open_failed', error instanceof Error ? error.message : String(error))
      }
    },
  },
  {
    descriptor: {
      id: 'agents.assistance.create', moduleId: AGENTS_MODULE_ID,
      kind: 'command', scope: { kind: 'workspace' },
      title: 'Create assistance Room',
      description: 'Creates another ordinary Assistance Room with an explicit Room Scope.',
      risk: 'write', idempotent: false,
      inputSchema: z.toJSONSchema(assistanceCreateInputSchema),
      outputSchema: z.toJSONSchema(assistantOpenResultSchema),
    },
    invoke: async ({ runtime, library, flush }, invocation) => {
      const input = assistanceCreateInputSchema.parse(invocation.input)
      const scopeWorkspace = input.scope.kind === 'workspace'
        ? invocation.workspaceId
        : input.scope.kind === 'resource'
          ? input.scope.resource.workspaceId
          : input.scope.collection.workspaceId
      if (scopeWorkspace !== invocation.workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Room Scope belongs to another Workspace')
      try {
        const created = await createAssistanceRoom(runtime, library, flush, input.scope, input.title)
        const resource = workspaceResourceReferenceSchema.parse({ workspaceId: invocation.workspaceId, moduleId: AGENTS_MODULE_ID, type: 'agents.room', id: created.room.id })
        return json({ result: assistantOpenResultSchema.parse({ resource, uiPath: `/workspaces/${encodeURIComponent(invocation.workspaceId)}/agents?room=${encodeURIComponent(created.room.id)}`, reused: false }), createdResources: [resource] }, 201)
      } catch (error) {
        return assistantError(error) ?? apiError(500, 'assistance_create_failed', error instanceof Error ? error.message : String(error))
      }
    },
  },
  {
    descriptor: {
      id: 'agents.room-definition.create',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Room Definition',
      description: 'Validates and saves a reusable Room Definition as an immutable revision.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(writeRoomDefinitionSchema),
      outputSchema: z.toJSONSchema(definitionWriteResultSchema),
    },
    invoke: async ({ runtime, library }, invocation) => {
      const input = parseRoomDefinitionWrite(runtime, invocation.input)
      try {
        const revision = await library.create(input.definition)
        return json({ result: {
          definition: {
            workspaceId: invocation.workspaceId,
            moduleId: AGENTS_MODULE_ID,
            type: ROOM_DEFINITION_TYPE,
            id: revision.definitionId,
            revisionId: revision.id,
          },
          title: revision.document.title,
        } }, 201)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Definition already exists:')) {
          return apiError(409, 'room_definition_already_exists', error.message)
        }
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'agents.room.create',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Room',
      description: 'Creates a durable Room in the Workspace.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(createRoomSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      const input = createRoomSchema.parse(invocation.input)
      const room = await runtime.createRoom({
        name: input.name,
        createdBy: invocation.access.actor.id ?? 'system',
        ...(input.roomPrompt ? { roomPrompt: input.roomPrompt } : {}),
      })
      return json({
        result: room.value.profile,
        createdResources: [{
          workspaceId: invocation.workspaceId,
          moduleId: AGENTS_MODULE_ID,
          type: 'agents.room',
          id: room.value.profile.id,
        }],
      }, 201)
    },
  },
  {
    descriptor: {
      id: 'agents.room.inspect',
      comparisonUnavailableReason: 'Use conversation_read for conversation evidence within the captured task boundary.',
      moduleId: AGENTS_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Inspect Room',
      description: 'Shows Room configuration and state, member profiles, source definition, and recent activity summaries.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: z.toJSONSchema(inspectionViewSchema),
    },
    invoke: async ({ runtime, library }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const room = runtime.rooms.getRoom(requireResourceId(invocation, 'agents.room'))
      if (!room) return apiError(404, 'room_not_found', 'Room not found')
      const state = room.getRoomState()
      const members = room.getParticipantIds().map(id => {
        const agent = runtime.team.getAgent(id)
        if (!agent) return { id, unavailable: true }
        const ai = asAIAgent(agent)
        return {
          id: agent.id,
          name: agent.name,
          kind: agent.kind,
          ...(ai === undefined ? {} : { configuration: ai.getConfig() }),
        }
      })
      const recentMessages = room.getRecent(20)
      const sourceRevision = room.profile.sourceDefinition === undefined
        ? undefined
        : await library.getRevision(room.profile.sourceDefinition.revisionId)
      return json({ result: serializableInspection({
        target: { kind: 'resource', resource: invocation.resource },
        title: room.profile.name,
        observedAt: new Date().toISOString(),
        sections: [{
          id: 'identity',
          title: 'Room identity and provenance',
          data: room.profile,
        }, {
          id: 'live-state',
          title: 'Current Room state',
          data: state,
        }, {
          id: 'members',
          title: 'Members and Agent configuration',
          data: {
            total: members.length,
            aiAgents: members.filter(member => 'kind' in member && member.kind === 'ai').length,
            members,
          },
        }, {
          id: 'recent-activity',
          title: 'Recent activity',
          description: 'The latest 20 messages are summarized here; the Room remains the canonical conversation view.',
          data: {
            messageCount: room.getMessageCount(),
            messages: recentMessages.map(message => ({
              id: message.id,
              senderId: message.senderId,
              ...(message.senderName === undefined ? {} : { senderName: message.senderName }),
              type: message.type,
              timestamp: new Date(message.timestamp).toISOString(),
              contentPreview: message.content.length > 500 ? `${message.content.slice(0, 500)}…` : message.content,
            })),
          },
        }, ...(sourceRevision === undefined ? [] : [{
          id: 'source-definition',
          title: 'Pinned Room Definition',
          data: {
            revisionId: sourceRevision.id,
            definitionId: sourceRevision.definitionId,
            definition: sourceRevision.document,
          },
        }])],
      }) })
    },
  },
  {
    descriptor: {
      id: 'agents.room.scope.set',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Set Room Scope',
      description: 'Replaces the Resources and Definitions available to this Room using optimistic concurrency.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(setRoomScopeInputSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime, flush }, invocation) => {
      if (!['human', 'system'].includes(invocation.access.actor.kind)) {
        return apiError(403, 'room_scope_human_required', 'Only a human or system actor may replace a Room Scope')
      }
      const input = setRoomScopeInputSchema.parse(invocation.input)
      const room = runtime.rooms.getRoom(requireResourceId(invocation, 'agents.room'))
      if (!room) return apiError(404, 'room_not_found', 'Room not found')
      const scopeWorkspace = input.scope.kind === 'workspace'
        ? invocation.workspaceId
        : input.scope.kind === 'resource'
          ? input.scope.resource.workspaceId
          : input.scope.collection.workspaceId
      if (scopeWorkspace !== invocation.workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Room Scope belongs to another Workspace')
      try {
        const revision = room.setScope(input.scope, input.expectedRevision)
        await flush()
        return json({ result: { scope: room.profile.scope, revision } })
      } catch (error) {
        if (error instanceof Error && (error as Error & { code?: string }).code === 'scope_revision_conflict') {
          return apiError(409, 'scope_revision_conflict', error.message)
        }
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'agents.room.delete',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Delete Room',
      description: 'Permanently deletes a Room, its messages, memberships, Room-owned Agents, and Room-scoped triggers.',
      risk: 'destructive',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const roomId = requireResourceId(invocation, 'agents.room')
      return runtime.removeRoom(roomId)
        ? json({ result: { deleted: true, roomId } })
        : apiError(404, 'room_not_found', 'Room not found')
    },
  },
  {
    descriptor: {
      id: 'agents.room.read',
      comparisonUnavailableReason: 'Use conversation_read for conversation evidence within the captured task boundary.',
      moduleId: AGENTS_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Read Room',
      description: 'Reads the selected Room profile, state, and a bounded recent-message window.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(readRoomSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      const room = runtime.rooms.getRoom(requireResourceId(invocation, 'agents.room'))
      const input = readRoomSchema.parse(invocation.input)
      return room
        ? json({ result: {
            profile: room.profile,
            state: room.getRoomState(),
            messageCount: room.getMessageCount(),
            messages: room.getRecent(input.limit),
          } })
        : apiError(404, 'room_not_found', 'Room not found')
    },
  },
  {
    descriptor: {
      id: 'agents.room.post-message',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Post Room Message',
      description: 'Posts an attributed message to the selected Room.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(postMessageSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      const room = runtime.rooms.getRoom(requireResourceId(invocation, 'agents.room'))
      if (!room) return apiError(404, 'room_not_found', 'Room not found')
      const input = postMessageSchema.parse(invocation.input)
      const actor = invocation.access.actor
      const message = room.post({
        senderId: actor.id ?? 'anonymous',
        ...(actor.displayName === undefined ? {} : { senderName: actor.displayName }),
        content: input.content,
        type: 'chat',
      })
      return json({ result: message }, 201)
    },
  },
  {
    descriptor: {
      id: 'agents.room-definition.inspect',
      moduleId: AGENTS_MODULE_ID,
      kind: 'query',
      scope: { kind: 'definition', definitionType: ROOM_DEFINITION_TYPE },
      title: 'Inspect Room Definition',
      description: 'Shows the exact Room Definition configuration, agent personas, Packs, tools, and Prompt Deck.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: z.toJSONSchema(inspectionViewSchema),
    },
    invoke: async ({ library }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const definitionId = requireRoomDefinitionId(invocation)
      const revision = await library.getRevision(invocation.definition!.revisionId)
      if (!revision || revision.definitionId !== definitionId) {
        return apiError(404, 'room_definition_revision_not_found', 'Room Definition Revision not found')
      }
      return json({ result: serializableInspection({
        target: { kind: 'definition', definition: invocation.definition },
        title: revision.document.title,
        description: revision.document.description,
        observedAt: new Date().toISOString(),
        sections: [{
          id: 'identity',
          title: 'Identity and provenance',
          data: {
            definitionId: revision.definitionId,
            revisionId: revision.id,
            category: revision.document.category ?? null,
          },
        }, ...roomDefinitionSections(revision.document)],
      }) })
    },
  },
  {
    descriptor: {
      id: 'agents.room-definition.update',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: ROOM_DEFINITION_TYPE },
      title: 'Update Room Definition',
      description: 'Creates a new immutable revision from edited Room Definition content.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(writeRoomDefinitionSchema),
      outputSchema: z.toJSONSchema(definitionWriteResultSchema),
    },
    invoke: async ({ runtime, library }, invocation) => {
      const input = parseRoomDefinitionWrite(runtime, invocation.input)
      const definitionId = requireRoomDefinitionId(invocation)
      if (input.definition.id !== definitionId) {
        return apiError(409, 'room_definition_identity_mismatch', 'Edited Room Definition id does not match the target Definition')
      }
      try {
        const revision = await library.update(
          input.definition,
          invocation.definition!.revisionId,
        )
        return json({ result: {
          definition: { ...invocation.definition, revisionId: revision.id },
          title: revision.document.title,
        } })
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Definition Revision changed:')) {
          return apiError(409, 'room_definition_revision_changed', error.message)
        }
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'agents.room-definition.start',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: ROOM_DEFINITION_TYPE },
      title: 'Start Room',
      description: 'Creates a Room from the requested immutable Room Definition Revision.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime, library }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const definitionId = requireRoomDefinitionId(invocation)
      const revision = await library.getRevision(invocation.definition!.revisionId)
      if (!revision || revision.definitionId !== definitionId) {
        return apiError(404, 'room_definition_revision_not_found', 'Room Definition Revision not found')
      }
      if (revision.document.assistance !== undefined) {
        return apiError(409, 'assistance_subject_required', 'Assistance Room Definitions must be opened through an Assistance Capability')
      }
      const started = await startRoomDefinition(
        runtime,
        library,
        definitionId,
        invocation.definition!.revisionId,
      )
      const resource = {
        workspaceId: invocation.workspaceId,
        moduleId: AGENTS_MODULE_ID,
        type: 'agents.room',
        id: started.room.id,
      }
      return json({
        result: {
          room: started.room,
          revisionId: started.revisionId,
          uiPath: `/workspaces/${encodeURIComponent(invocation.workspaceId)}/agents?room=${encodeURIComponent(started.room.id)}`,
        },
        createdResources: [resource],
      }, 201)
    },
  },
  {
    descriptor: {
      id: 'agents.room-definition.delete',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: ROOM_DEFINITION_TYPE },
      title: 'Delete Room Definition',
      description: 'Removes this Room Definition from the Workspace catalog. Existing Rooms retain their pinned revision.',
      risk: 'destructive',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ library }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const definitionId = requireRoomDefinitionId(invocation)
      return await library.delete(definitionId, invocation.definition!.revisionId)
        ? json({ result: { deleted: true, definitionId } })
        : apiError(404, 'room_definition_not_found', 'Room Definition not found')
    },
  },
  {
    descriptor: {
      id: 'agents.prompt-deck.run-entry',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Run Prompt Deck Entry',
      description: 'Runs one declared Prompt Deck entry in a selected Room.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(runPromptDeckEntrySchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime, library }, invocation) => {
      const roomId = requireResourceId(invocation, 'agents.room')
      const input = runPromptDeckEntrySchema.parse(invocation.input)
      return json({ result: await runPromptDeckEntry(
        runtime,
        library,
        roomId,
        input.entryId,
      ) })
    },
  },
  {
    descriptor: {
      id: 'agents.agent.create',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Agent',
      description: 'Creates an AI Agent Profile in the Workspace.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(createAgentSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      const input = createAgentSchema.parse(invocation.input)
      const agent = await runtime.spawnAIAgent(input)
      return json({ result: { id: agent.id, name: agent.name, kind: agent.kind } }, 201)
    },
  },
  {
    descriptor: {
      id: 'agents.agent.read',
      moduleId: AGENTS_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'agents.agent' },
      title: 'Read Agent',
      description: 'Reads the selected AI Agent Profile.',
      risk: 'read',
      idempotent: true,
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      const agent = runtime.team.getAgent(requireResourceId(invocation, 'agents.agent'))
      const ai = agent ? asAIAgent(agent) : undefined
      return ai
        ? json({ result: { id: ai.id, kind: ai.kind, config: ai.getConfig() } })
        : apiError(404, 'agent_not_found', 'Agent not found')
    },
  },
])

// People Capabilities are dispatched outside the runtime lease (see
// people-capabilities.ts); the published catalog lists both registries.
const allCapabilityDescriptors = (() => {
  const runtimeIds = agentsCapabilities.descriptors.map(descriptor => descriptor.id)
  const misplaced = runtimeIds.filter(isPeopleCapabilityId)
  if (misplaced.length > 0) throw new Error(`People Capability ids belong to the People registry: ${misplaced.join(', ')}`)
  const strays = peopleCapabilityDescriptors.filter(descriptor => !isPeopleCapabilityId(descriptor.id))
  if (strays.length > 0) throw new Error(`People registry holds a non-People Capability: ${strays.map(descriptor => descriptor.id).join(', ')}`)
  return Object.freeze([...agentsCapabilities.descriptors, ...peopleCapabilityDescriptors])
})()

const invoke = async (
  capabilityId: string,
  workspaceId: WorkspaceId,
  raw: unknown,
  registry: WorkspaceRuntimeRegistry,
): Promise<Response> => {
  const invocation = moduleCapabilityInvocationSchema.parse(raw)
  if (invocation.workspaceId !== workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Invocation belongs to another Workspace')
  if (invocation.capabilityId !== capabilityId) return apiError(409, 'capability_scope_mismatch', 'Invocation Capability does not match the route')
  if (invocation.idempotencyKey !== undefined) return apiError(400, 'idempotency_not_supported', 'This Capability does not support keyed retries; inspect the Resource after an uncertain result.')
  const runtime = await registry.getOrLoad(workspaceId)
  const response = await agentsCapabilities.invoke(capabilityId, {
    runtime, library: registry.definitionsFor(workspaceId),
    flush: async () => {
      const saver = registry.autoSaverFor(workspaceId)
      if (!saver) throw new Error('Workspace persistence is unavailable')
      await saver.flush()
    },
  }, invocation)
  return response ?? apiError(404, 'capability_not_found', 'Capability not found')
}

export const handleAgentsModuleApi = async (
  request: Request,
  url: URL,
  config: { readonly state: AgentsModuleState; readonly registry: WorkspaceRuntimeRegistry },
): Promise<Response | null> => {
  try {
    if (url.pathname === '/.well-known/workspace-module' && request.method === 'GET') return json(agentsModuleManifest)
    if (url.pathname === agentsModuleManifest.endpoints.featuredDefinitions && request.method === 'GET') return json(agentsFeaturedDefinitions)

    const match = url.pathname.match(/^\/internal\/workspaces\/([^/]+)(?:\/(definitions|resources|capabilities)|\/capabilities\/([^/]+)\/invoke)?$/)
    if (!match) return null
    const workspaceId = workspaceIdSchema.parse(decodeURIComponent(match[1] ?? ''))
    const collection = match[2]
    const capabilityId = match[3] === undefined ? undefined : decodeURIComponent(match[3])

    if (collection === undefined && capabilityId === undefined) {
      if (request.method === 'PUT') {
        const input = lifecycleSchema.parse(await readJson(request))
        if (input.workspaceId !== workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Lifecycle body and route disagree')
        const provisioned = await config.state.provision(workspaceId)
        return json({ workspaceId, moduleId: 'agents' }, provisioned.created ? 201 : 200)
      }
      if (request.method === 'DELETE') {
        await config.registry.remove(workspaceId)
        return new Response(null, { status: 204 })
      }
    }

    // Before the Workspace lease: People never load the Agents runtime, and a
    // waiting sync must not hold an operation that removal or eviction awaits.
    if (capabilityId !== undefined && isPeopleCapabilityId(capabilityId) && request.method === 'POST') {
      return await invokePeopleCapability(capabilityId, workspaceId, await readJson(request), config.registry, request.signal)
    }

    return await config.registry.withWorkspace(workspaceId, async () => {
    await requireModule(config.state, workspaceId)
    if (collection === 'definitions' && request.method === 'GET') {
      return json(moduleDefinitionCollectionSchema.parse({ definitions: await definitionsFor(workspaceId, config.registry.definitionsFor(workspaceId)) }))
    }
    if (collection === 'resources' && request.method === 'GET') {
      return json(moduleResourceCollectionSchema.parse({ resources: await resourcesFor(workspaceId, config.registry) }))
    }
    if (collection === 'capabilities' && request.method === 'GET') {
      return json(moduleCapabilityCollectionSchema.parse({ capabilities: allCapabilityDescriptors }))
    }
    if (capabilityId !== undefined && request.method === 'POST') {
      return await invoke(capabilityId, workspaceId, await readJson(request), config.registry)
    }
    return null
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'workspace_closing') return apiError(409, 'workspace_closing', error.message, true)
    // Admission recovers when data is removed or the operator policy changes.
    if (error instanceof Error && 'code' in error && error.code === 'storage_budget_exceeded') return apiError(507, 'storage_budget_exceeded', error.message, true)
    if (error instanceof Error && 'code' in error && error.code === 'workspace_capacity_exceeded') return apiError(503, 'workspace_capacity_exceeded', error.message)
    if (error instanceof SyntaxError) return apiError(400, 'invalid_json', error.message)
    if (error instanceof z.ZodError) return apiError(400, 'invalid_request', error.message)
    if (error instanceof Error && error.message.includes('Workspace not found:')) return apiError(404, 'workspace_not_found', 'Module Workspace not found')
    if (error instanceof Error && (error.message.startsWith('Capability requires') || error.message.includes('not provisioned'))) {
      return apiError(409, 'capability_scope_invalid', error.message)
    }
    throw error
  }
}
