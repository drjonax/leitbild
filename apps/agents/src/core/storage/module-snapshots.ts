import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { workspaceRoomScopeSchema } from '@leitbild/contracts'
import type { Agent, AIAgentConfig } from '../types/agent.ts'
import type { DeliveryMode, Message, RoomProfile } from '../types/messaging.ts'
import type { GenerationQueryRecord, Room } from '../types/room.ts'
import type { Bookmark } from '../workspaces/bookmark-store.ts'
import type { SummaryConfig } from '../types/summary.ts'
import type { Trigger } from '../triggers/types.ts'
import type { WorkspaceModulePaths } from '../paths.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { DEFAULT_RESPONSE_FORMAT, DEFAULT_WORKSPACE_PROMPT } from '../workspaces/settings.ts'
import { redactBiometricMessages } from './snapshot-redact.ts'
import { REASONING_EFFORTS } from '../types/llm.ts'

export const ROOMS_SNAPSHOT_SCHEMA = 3
export const AGENTS_SNAPSHOT_SCHEMA = 3
export const INSPECTIONS_SNAPSHOT_SCHEMA = 1

export interface RoomSnapshot {
  readonly profile: RoomProfile
  readonly messages: ReadonlyArray<Message>
  readonly members: ReadonlyArray<string>
  readonly deliveryMode: DeliveryMode
  readonly paused: boolean
  readonly muted: ReadonlyArray<string>
  readonly compressedIds?: ReadonlyArray<string>
  readonly summaryConfig?: SummaryConfig
  readonly latestSummary?: string
  readonly activePacks: ReadonlyArray<string>
}

export interface HumanActorSnapshot {
  readonly id: string
  readonly name: string
  readonly triggers?: ReadonlyArray<Trigger>
}

export interface PendingScrub {
  readonly packId: string
  readonly scheduledAt: string
}

export interface RoomsSnapshot {
  readonly schemaVersion: 3
  readonly savedAt: string
  readonly rooms: ReadonlyArray<RoomSnapshot>
  readonly humanActors: ReadonlyArray<HumanActorSnapshot>
  readonly bookmarks: ReadonlyArray<Bookmark>
  readonly pendingScrubs?: ReadonlyArray<PendingScrub>
}

export interface AgentProfileSnapshot {
  readonly id: string
  readonly config: AIAgentConfig
}

export interface AgentsSnapshot {
  readonly schemaVersion: 3
  readonly savedAt: string
  readonly agents: ReadonlyArray<AgentProfileSnapshot>
  readonly workspacePrompt?: string
  readonly responseFormat?: string
  readonly ollamaUrls?: ReadonlyArray<string>
  readonly ollamaUrl?: string
}

export interface GenerationInspectionSnapshot {
  readonly schemaVersion: 1
  readonly savedAt: string
  readonly rooms: ReadonlyArray<{
    readonly roomId: string
    readonly records: ReadonlyArray<GenerationQueryRecord>
  }>
}

export interface WorkspaceModuleSnapshots {
  readonly rooms: RoomsSnapshot | null
  readonly agents: AgentsSnapshot | null
  readonly inspections: GenerationInspectionSnapshot | null
}

interface SerializableRuntime {
  readonly rooms: {
    readonly listAllRooms: () => ReadonlyArray<RoomProfile>
    readonly getRoom: (idOrName: string) => Room | undefined
  }
  readonly settings: {
    readonly getPrompt: () => string
    readonly getResponseFormat: () => string
  }
  readonly bookmarks: { readonly list: () => ReadonlyArray<Bookmark> }
  readonly team: { readonly listAgents: () => ReadonlyArray<Agent> }
  readonly ollamaUrls?: {
    readonly list: () => string[]
    readonly getCurrent: () => string
  }
}

const triggerSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  mode: z.enum(['execute', 'post', 'start-script']),
  intervalSec: z.number().finite(),
  enabled: z.boolean(),
  roomId: z.string(),
  lastFiredAt: z.number().finite().optional(),
  targetName: z.string().optional(),
}).strict()

const roomProfileSchema = z.object({
  scope: workspaceRoomScopeSchema,
  scopeRevision: z.number().int().nonnegative(),
  id: z.string(),
  name: z.string(),
  roomPrompt: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.number().finite(),
  sourceDefinition: z.object({
    id: z.string().min(1).max(128),
    revisionId: z.string().min(1).max(128),
  }).strict().optional(),
}).strict()

const messageCauseSchema = z.object({
  kind: z.enum(['script', 'trigger', 'biometric', 'resource-event', 'display-request']),
  name: z.string(),
  step: z.number().int().optional(),
}).strict()

const messageAttachmentSchema = z.object({
  kind: z.literal('image'),
  dataUrl: z.string().max(11_200_000),
  mimeType: z.literal('image/png'),
  width: z.number().finite(),
  height: z.number().finite(),
  source: z.enum(['resource', 'user-upload']).optional(),
  capturedAt: z.number().finite(),
}).strict()

const messageSchema = z.object({
  id: z.string(),
  senderId: z.string(),
  senderName: z.string().optional(),
  content: z.string(),
  timestamp: z.number().finite(),
  type: z.enum(['chat', 'join', 'leave', 'system', 'room_summary', 'pass', 'mute', 'error']),
  roomId: z.string(),
  correlationId: z.string().optional(),
  inReplyTo: z.array(z.string()).optional(),
  cause: messageCauseSchema.optional(),
  generationMs: z.number().finite().optional(),
  generationTraceId: z.string().optional(),
  promptTokens: z.number().finite().optional(),
  lastPromptTokens: z.number().finite().optional(),
  completionTokens: z.number().finite().optional(),
  cacheCreation: z.number().finite().optional(),
  cacheRead: z.number().finite().optional(),
  cacheMiss: z.number().finite().optional(),
  modelCalls: z.number().int().nonnegative().optional(),
  contextMax: z.number().finite().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  errorCode: z.enum([
    'no_api_key', 'model_unavailable', 'rate_limited', 'network',
    'provider_down', 'tool_loop_exceeded', 'empty_response',
    'tools_unavailable', 'request_dropped', 'unknown',
  ]).optional(),
  errorProvider: z.string().optional(),
  agentName: z.string().optional(),
  agentKind: z.enum(['ai', 'human']).optional(),
  agentTags: z.array(z.string()).optional(),
  toolTrace: z.array(z.object({
    tool: z.string(),
    argumentKeys: z.array(z.string()).max(32),
    argumentBytes: z.number().int().nonnegative(),
    operationIds: z.array(z.string()).optional(),
    target: z.string().optional(),
    success: z.boolean(),
    resultBytes: z.number().int().nonnegative().optional(),
    operationOutcomes: z.array(z.object({
      key: z.string(),
      operationId: z.string(),
      success: z.boolean(),
    }).strict()).optional(),
    resultPreview: z.string(),
  }).strict()).optional(),
  attachments: z.array(messageAttachmentSchema).max(8).optional(),
}).strict()

const nativeToolCallSchema = z.object({
  id: z.string().optional(),
  function: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.json()),
  }).strict(),
}).strict()

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.string(), z.json()),
  }).strict(),
}).strict()

const generationQuerySchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    toolCalls: z.array(nativeToolCallSchema).optional(),
    toolCallId: z.string().optional(),
    name: z.string().optional(),
    continuation: z.object({
      provider: z.literal('openrouter'),
      model: z.string().min(1),
      endpointHash: z.string().regex(/^[a-f0-9]{64}$/),
      reasoningDetails: z.array(z.record(z.string(), z.json())).optional(),
      reasoning: z.string().optional(),
    }).strict().optional(),
    images: z.array(z.object({ dataUrl: z.string(), mimeType: z.literal('image/png') }).strict()).optional(),
  }).strict()),
  temperature: z.number().finite().optional(),
  seed: z.number().finite().optional(),
  maxTokens: z.number().finite().optional(),
  jsonMode: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  toolChoice: z.union([z.enum(['auto', 'required']), z.object({ name: z.string() }).strict()]).optional(),
  think: z.boolean().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  numCtx: z.number().finite().optional(),
  keepAlive: z.string().optional(),
  systemBlocks: z.array(z.object({ text: z.string(), cacheable: z.boolean().optional() }).strict()).optional(),
}).strict()

const generationQueryRecordSchema = z.object({
  messageId: z.string(),
  traceId: z.string(),
  query: generationQuerySchema,
}).strict()

const summaryScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), everySeconds: z.number().finite() }).strict(),
  z.object({ kind: z.literal('messages'), everyMessages: z.number().finite() }).strict(),
])

const summaryConfigSchema = z.object({
  model: z.string().optional(),
  summary: z.object({ enabled: z.boolean(), schedule: summaryScheduleSchema }).strict(),
  compression: z.object({
    enabled: z.boolean(),
    schedule: summaryScheduleSchema,
    keepFresh: z.number().finite(),
    batchSize: z.number().finite(),
    aggressiveness: z.enum(['low', 'med', 'high']),
  }).strict(),
}).strict()

const roomSnapshotSchema = z.object({
  profile: roomProfileSchema,
  messages: z.array(messageSchema),
  members: z.array(z.string()),
  deliveryMode: z.enum(['broadcast', 'manual']),
  paused: z.boolean(),
  muted: z.array(z.string()),
  compressedIds: z.array(z.string()).optional(),
  summaryConfig: summaryConfigSchema.optional(),
  latestSummary: z.string().optional(),
  activePacks: z.array(z.string()),
}).strict()

const agentConfigSchema = z.object({
  name: z.string(),
  ownerRoomId: z.string().optional(),
  model: z.string(),
  persona: z.string(),
  temperature: z.number().finite().optional(),
  seed: z.number().finite().optional(),
  historyLimit: z.number().finite().optional(),
  historyTokenBudget: z.number().int().positive().optional(),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  maxToolIterations: z.number().finite().optional(),
  tags: z.array(z.string()).optional(),
  thinking: z.boolean().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  includePrompts: z.object({
    persona: z.boolean().optional(),
    room: z.boolean().optional(),
    workspace: z.boolean().optional(),
    responseFormat: z.boolean().optional(),
    skills: z.boolean().optional(),
    wikis: z.boolean().optional(),
  }).strict().optional(),
  includeContext: z.object({
    participants: z.boolean().optional(),
    activity: z.boolean().optional(),
    knownAgents: z.boolean().optional(),
  }).strict().optional(),
  includeTools: z.boolean().optional(),
  promptsEnabled: z.boolean().optional(),
  contextEnabled: z.boolean().optional(),
  triggers: z.array(triggerSchema).optional(),
}).strict()

const bookmarkSchema = z.object({ id: z.string(), content: z.string() }).strict()

const roomsSnapshotSchema = z.object({
  schemaVersion: z.literal(ROOMS_SNAPSHOT_SCHEMA),
  savedAt: z.iso.datetime({ offset: true }),
  rooms: z.array(roomSnapshotSchema),
  humanActors: z.array(z.object({
    id: z.string(),
    name: z.string(),
    triggers: z.array(triggerSchema).optional(),
  }).strict()),
  bookmarks: z.array(bookmarkSchema),
  pendingScrubs: z.array(z.object({
    packId: z.string(),
    scheduledAt: z.iso.datetime({ offset: true }),
  }).strict()).optional(),
}).strict()

const agentsSnapshotSchema = z.object({
  schemaVersion: z.literal(AGENTS_SNAPSHOT_SCHEMA),
  savedAt: z.iso.datetime({ offset: true }),
  agents: z.array(z.object({ id: z.string(), config: agentConfigSchema }).strict()),
  workspacePrompt: z.string().optional(),
  responseFormat: z.string().optional(),
  ollamaUrls: z.array(z.string()).optional(),
  ollamaUrl: z.string().optional(),
}).strict()

const generationInspectionSnapshotSchema = z.object({
  schemaVersion: z.literal(INSPECTIONS_SNAPSHOT_SCHEMA),
  savedAt: z.iso.datetime({ offset: true }),
  rooms: z.array(z.object({
    roomId: z.string(),
    records: z.array(generationQueryRecordSchema),
  }).strict()),
}).strict()

export const serializeModuleSnapshots = (runtime: SerializableRuntime): {
  readonly rooms: RoomsSnapshot
  readonly agents: AgentsSnapshot
  readonly inspections: GenerationInspectionSnapshot
} => {
  const rooms: RoomSnapshot[] = []
  const inspectionRooms: Array<{ roomId: string; records: ReadonlyArray<GenerationQueryRecord> }> = []
  for (const profile of runtime.rooms.listAllRooms()) {
    const room = runtime.rooms.getRoom(profile.id)
    if (!room) throw new Error(`Room disappeared during snapshot: ${profile.id}`)
    const state = room.getRoomState()
    rooms.push({
      profile: room.profile,
      messages: redactBiometricMessages(room.getRetainedMessages()),
      members: [...room.getParticipantIds()],
      deliveryMode: state.mode,
      paused: state.paused,
      muted: [...state.muted],
      ...(room.getCompressedIds().size > 0 ? { compressedIds: [...room.getCompressedIds()] } : {}),
      ...(room.summaryConfig ? { summaryConfig: room.summaryConfig } : {}),
      ...(state.latestSummary ? { latestSummary: state.latestSummary } : {}),
      activePacks: [...room.getActivePacks()],
    })
    const records = room.getGenerationQueries()
    if (records.length > 0) inspectionRooms.push({ roomId: room.profile.id, records })
  }

  const agents: AgentProfileSnapshot[] = []
  const humanActors: HumanActorSnapshot[] = []
  for (const actor of runtime.team.listAgents()) {
    if (actor.kind === 'ai') {
      const agent = asAIAgent(actor)
      if (!agent) throw new Error(`AI Agent does not implement the AI runtime contract: ${actor.id}`)
      agents.push({ id: actor.id, config: agent.getConfig() })
    } else if (actor.kind === 'human') {
      const triggers = actor.getTriggers?.() ?? []
      humanActors.push({
        id: actor.id,
        name: actor.name,
        ...(triggers.length > 0 ? { triggers: [...triggers] } : {}),
      })
    }
  }

  const savedAt = new Date().toISOString()
  const workspacePrompt = runtime.settings.getPrompt()
  const responseFormat = runtime.settings.getResponseFormat()
  return {
    rooms: roomsSnapshotSchema.parse({
      schemaVersion: ROOMS_SNAPSHOT_SCHEMA,
      savedAt,
      rooms,
      humanActors,
      bookmarks: [...runtime.bookmarks.list()],
    }),
    agents: agentsSnapshotSchema.parse({
      schemaVersion: AGENTS_SNAPSHOT_SCHEMA,
      savedAt,
      agents,
      ...(workspacePrompt !== DEFAULT_WORKSPACE_PROMPT ? { workspacePrompt } : {}),
      ...(responseFormat !== DEFAULT_RESPONSE_FORMAT ? { responseFormat } : {}),
      ...(runtime.ollamaUrls ? {
        ollamaUrls: runtime.ollamaUrls.list(),
        ollamaUrl: runtime.ollamaUrls.getCurrent(),
      } : {}),
    }),
    inspections: generationInspectionSnapshotSchema.parse({
      schemaVersion: INSPECTIONS_SNAPSHOT_SCHEMA,
      savedAt,
      rooms: inspectionRooms,
    }),
  }
}

const pendingWrites = new Map<string, Promise<unknown>>()
const withSnapshotLock = <T>(path: string, action: () => Promise<T>): Promise<T> => {
  const next = (pendingWrites.get(path) ?? Promise.resolve()).catch(() => undefined).then(action)
  pendingWrites.set(path, next)
  const release = () => { if (pendingWrites.get(path) === next) pendingWrites.delete(path) }
  void next.then(release, release)
  return next
}

const writeSnapshot = async (snapshot: unknown, path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`)
    await rename(temporaryPath, path)
  } finally { await rm(temporaryPath, { force: true }) }
}

const removeSnapshot = async (path: string): Promise<void> => {
  try {
    await rm(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

const roomsIsEmpty = (snapshot: RoomsSnapshot): boolean =>
  snapshot.rooms.length === 0
  && snapshot.humanActors.length === 0
  && snapshot.bookmarks.length === 0

const agentsIsEmpty = (snapshot: AgentsSnapshot): boolean =>
  snapshot.agents.length === 0
  && snapshot.workspacePrompt === undefined
  && snapshot.responseFormat === undefined
  && (snapshot.ollamaUrls === undefined || snapshot.ollamaUrls.length === 0)

const inspectionsIsEmpty = (snapshot: GenerationInspectionSnapshot): boolean => snapshot.rooms.length === 0

const committedSnapshotSchema = z.object({
  rooms: roomsSnapshotSchema.nullable(),
  agents: agentsSnapshotSchema.nullable(),
  inspections: generationInspectionSnapshotSchema.nullable(),
}).strict()
type SnapshotPaths = {
  readonly rooms: Pick<WorkspaceModulePaths['rooms'], 'snapshot'>
  readonly agents: Pick<WorkspaceModulePaths['agents'], 'root' | 'snapshot' | 'inspections'>
}
const commitPath = (paths: SnapshotPaths): string => join(paths.agents.root, 'snapshot-commit.json')

// One atomic commit record is authoritative until all strict documents have
// been materialized. A crash between document writes cannot expose mixed generations.
const publishSnapshots = async (snapshots: WorkspaceModuleSnapshots, paths: SnapshotPaths): Promise<void> => {
  await writeSnapshot(committedSnapshotSchema.parse(snapshots), commitPath(paths))
  if (snapshots.rooms === null) await removeSnapshot(paths.rooms.snapshot)
  else await writeSnapshot(snapshots.rooms, paths.rooms.snapshot)
  if (snapshots.agents === null) await removeSnapshot(paths.agents.snapshot)
  else await writeSnapshot(snapshots.agents, paths.agents.snapshot)
  if (snapshots.inspections === null) await removeSnapshot(paths.agents.inspections)
  else await writeSnapshot(snapshots.inspections, paths.agents.inspections)
  await removeSnapshot(commitPath(paths))
}

export const saveWorkspaceModuleSnapshots = (
  snapshots: { readonly rooms: RoomsSnapshot; readonly agents: AgentsSnapshot; readonly inspections: GenerationInspectionSnapshot },
  paths: WorkspaceModulePaths,
): Promise<void> => withSnapshotLock(commitPath(paths), () => publishSnapshots({
  rooms: roomsIsEmpty(snapshots.rooms) ? null : roomsSnapshotSchema.parse(snapshots.rooms),
  agents: agentsIsEmpty(snapshots.agents) ? null : agentsSnapshotSchema.parse(snapshots.agents),
  inspections: inspectionsIsEmpty(snapshots.inspections) ? null : generationInspectionSnapshotSchema.parse(snapshots.inspections),
}, paths))

const loadStrict = async <T>(path: string, schema: z.ZodType<T>): Promise<T | null> => {
  const file = Bun.file(path)
  if (!await file.exists()) return null
  return schema.parse(JSON.parse(await file.text()) as unknown)
}

const readSnapshots = async (paths: SnapshotPaths): Promise<WorkspaceModuleSnapshots> => {
  const committed = await loadStrict(commitPath(paths), committedSnapshotSchema)
  if (committed) return committed
  return {
    rooms: await loadStrict(paths.rooms.snapshot, roomsSnapshotSchema),
    agents: await loadStrict(paths.agents.snapshot, agentsSnapshotSchema),
    inspections: await loadStrict(paths.agents.inspections, generationInspectionSnapshotSchema),
  }
}

export const loadWorkspaceModuleSnapshots = (paths: WorkspaceModulePaths): Promise<WorkspaceModuleSnapshots> =>
  withSnapshotLock(commitPath(paths), () => readSnapshots(paths))

interface RestorableRuntime {
  readonly rooms: { readonly restoreRoom: (profile: RoomProfile) => Room }
  readonly settings: {
    readonly setPrompt: (prompt: string) => void
    readonly setResponseFormat: (format: string) => void
  }
  readonly bookmarks: { readonly restore: (entries: ReadonlyArray<Bookmark>) => void }
  readonly spawnAIAgent: (config: AIAgentConfig, options?: { overrideId?: string }) => Promise<unknown>
  readonly spawnHumanAgent?: (config: { name: string }, send: (message: unknown) => void, options?: { overrideId?: string }) => Promise<unknown>
  readonly team?: {
    readonly getAgent: (idOrName: string) => {
      readonly join: (room: Room) => Promise<void>
      readonly addTrigger?: (trigger: Trigger) => void
    } | undefined
  }
  readonly ollamaUrls?: {
    readonly add: (url: string) => void
    readonly setCurrent: (url: string) => void
  }
}

export const restoreWorkspaceModuleSnapshots = async (
  runtime: RestorableRuntime,
  snapshots: WorkspaceModuleSnapshots,
): Promise<void> => {
  const roomMap = new Map<string, Room>()
  const rooms = snapshots.rooms
  if (rooms) {
    const scrubbed = new Set((rooms.pendingScrubs ?? []).map(scrub => scrub.packId))
    for (const roomSnapshot of rooms.rooms) {
      const room = runtime.rooms.restoreRoom(roomSnapshot.profile)
      room.injectMessages(roomSnapshot.messages)
      room.injectGenerationQueries(snapshots.inspections?.rooms.find(item => item.roomId === room.profile.id)?.records ?? [])
      room.restoreState({
        members: roomSnapshot.members,
        muted: roomSnapshot.muted,
        mode: roomSnapshot.deliveryMode,
        paused: roomSnapshot.paused,
        compressedIds: roomSnapshot.compressedIds,
        ...(roomSnapshot.summaryConfig ? { summaryConfig: roomSnapshot.summaryConfig } : {}),
        ...(roomSnapshot.latestSummary ? { latestSummary: roomSnapshot.latestSummary } : {}),
        activePacks: roomSnapshot.activePacks.filter(packId => !scrubbed.has(packId)),
      })
      roomMap.set(room.profile.id, room)
    }
  }

  const joinRestoredMemberships = async (actorId: string): Promise<void> => {
    const actor = runtime.team?.getAgent(actorId)
    if (!actor || !rooms) return
    for (const roomSnapshot of rooms.rooms) {
      if (!roomSnapshot.members.includes(actorId)) continue
      const room = roomMap.get(roomSnapshot.profile.id)
      if (room) await actor.join(room)
    }
  }

  const agents = snapshots.agents
  if (agents) {
    for (const agentSnapshot of agents.agents) {
      await runtime.spawnAIAgent(agentSnapshot.config, { overrideId: agentSnapshot.id })
      await joinRestoredMemberships(agentSnapshot.id)
    }
    if (runtime.ollamaUrls && agents.ollamaUrls) {
      for (const url of agents.ollamaUrls) runtime.ollamaUrls.add(url)
      if (agents.ollamaUrl) runtime.ollamaUrls.setCurrent(agents.ollamaUrl)
    }
    if (agents.workspacePrompt !== undefined) runtime.settings.setPrompt(agents.workspacePrompt)
    if (agents.responseFormat !== undefined) runtime.settings.setResponseFormat(agents.responseFormat)
  }

  if (rooms) {
    if (runtime.spawnHumanAgent) {
      for (const human of rooms.humanActors) {
        await runtime.spawnHumanAgent({ name: human.name }, () => {}, { overrideId: human.id })
        await joinRestoredMemberships(human.id)
        const actor = runtime.team?.getAgent(human.id)
        for (const trigger of human.triggers ?? []) actor?.addTrigger?.(trigger)
      }
    }
    runtime.bookmarks.restore(rooms.bookmarks)
  }
}

export const appendRoomsPendingScrub = (
  path: string,
  scrub: PendingScrub,
): Promise<{ readonly applied: boolean; readonly reason?: string }> => {
  const root = dirname(dirname(path))
  const paths = { rooms: { snapshot: path }, agents: { root, snapshot: join(root, 'snapshot.json'), inspections: join(root, 'generation-inspections.json') } }
  return withSnapshotLock(commitPath(paths), async () => {
  const current = await readSnapshots(paths)
  const snapshot = current.rooms
  if (!snapshot) return { applied: false, reason: 'no Rooms snapshot' }
  if ((snapshot.pendingScrubs ?? []).some(item => item.packId === scrub.packId)) {
    return { applied: false, reason: 'already queued' }
  }
  const next = roomsSnapshotSchema.parse({
    ...snapshot,
    pendingScrubs: [...(snapshot.pendingScrubs ?? []), scrub],
  })
  await publishSnapshots({ ...current, rooms: next }, paths)
  return { applied: true }
})
}

export interface ModuleAutoSaver {
  readonly scheduleSave: () => void
  readonly flush: () => Promise<void>
  readonly dispose: () => Promise<void>
}

const MAX_DEFER_MS = 30_000
// One retry budget, also used by shutdown (comfortably below the 90s service stop budget).
const SAVE_RETRY_BACKOFF_MS: ReadonlyArray<number> = [250, 1_000, 3_000]

export const createModuleAutoSaver = (
  runtime: SerializableRuntime,
  paths: WorkspaceModulePaths,
  debounceMs = 5_000,
): ModuleAutoSaver => {
  let timer: Timer | undefined
  let pending: Promise<void> | null = null
  let dirty = false
  let disposed = false
  let firstDeferredAt: number | null = null

  const runScheduledSave = (): void => {
    void save().catch(error => {
      console.error('[workspace-snapshot] scheduled Module save failed', error)
    })
  }

  const save = (): Promise<void> => {
    if (pending) return pending
    pending = (async () => {
      try {
        let failures = 0
        while (dirty) {
          dirty = false
          firstDeferredAt = null
          try {
            await saveWorkspaceModuleSnapshots(serializeModuleSnapshots(runtime), paths)
          } catch (error) {
            dirty = true
            const delay = SAVE_RETRY_BACKOFF_MS[failures++]
            if (delay === undefined) throw error
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
      } finally {
        pending = null
      }
    })()
    return pending
  }

  const scheduleSave = (): void => {
    if (disposed) return // Detached producers cannot restart persistence after disposal.
    dirty = true
    if (pending) return
    const now = performance.now()
    if (firstDeferredAt === null) firstDeferredAt = now
    const delay = now - firstDeferredAt >= MAX_DEFER_MS ? 0 : debounceMs
    if (timer) clearTimeout(timer)
    timer = setTimeout(runScheduledSave, delay)
  }

  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (disposed) throw new Error('Workspace autosaver is disposed')
    dirty = true
    await save()
  }

  const dispose = async (): Promise<void> => {
    disposed = true
    if (timer) clearTimeout(timer)
    timer = undefined
    firstDeferredAt = null
    await pending
  }

  return { scheduleSave, flush, dispose }
}
