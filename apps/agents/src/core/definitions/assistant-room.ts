import type {
  WorkspaceRoomScope,
  WorkspaceSubjectReference,
} from '@leitbild/contracts'
import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import type { Room } from '../types/room.ts'
import type { RoomDefinitionLibrary } from './room-definition-library.ts'
import { startRoomDefinition } from './room-definition-service.ts'

export class AssistanceRoomError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) { super(message) }
}

export interface AssistanceRoomResult {
  readonly created: boolean
  readonly room: { readonly id: string; readonly name: string }
  readonly revisionId: string
}

const pending = new WeakMap<AgentsWorkspaceRuntime, Map<string, Promise<Room>>>()

const targetKey = (scope: WorkspaceRoomScope): string => scope.kind === 'workspace'
  ? 'workspace'
  : scope.kind === 'resource'
    ? JSON.stringify(['resource', scope.resource.workspaceId, scope.resource.moduleId, scope.resource.type, scope.resource.id])
    : JSON.stringify(['collection', scope.collection.workspaceId, scope.collection.moduleId, scope.collection.type, scope.collection.id])

const sameTarget = (
  left: WorkspaceRoomScope,
  right: WorkspaceRoomScope,
): boolean => targetKey(left) === targetKey(right)

const resolveAssistanceRevision = async (
  library: RoomDefinitionLibrary,
) => {
  const records = await library.list()
  const revisions = await Promise.all(records.map(record => library.getRevision(record.currentRevisionId)))
  const matches = revisions.filter(revision => revision?.document.assistance === true)
  if (matches.length === 0) throw new AssistanceRoomError(503, 'assistance_definition_unavailable', 'The Assistance Room Definition is unavailable')
  if (matches.length > 1) throw new AssistanceRoomError(409, 'assistance_definition_conflict', 'More than one Assistance Room Definition is active')
  return matches[0]!
}

// The shared and explicitly created Assistance Rooms are named after their
// subject (a Run's title, or plain "Assistance"); the Module suffix keeps the
// conversation apart from the Resource it discusses.
const subjectRoomName = (title: string): string => `${title.slice(0, 115)} · Agents`

const requireHuman = (runtime: AgentsWorkspaceRuntime, room: Room) => {
  const participants = room.getParticipantIds().map(id => runtime.team.getAgent(id)).filter(agent => agent !== undefined)
  const human = participants.find(agent => agent.kind === 'human')
  const assistant = participants.find(agent => agent.kind === 'ai')
  if (!human || !assistant) throw new AssistanceRoomError(409, 'assistance_room_incomplete', 'Assistance Room is missing its human or AI participant')
  return human
}

// The request is the human participant's own message, and it wakes the Room so
// the Assistant answers. Posting through the ordinary Room message Capability
// would post as the invoking actor and leave a paused Room asleep.
const postRequest = (
  runtime: AgentsWorkspaceRuntime,
  room: Room,
  prompt: string,
  focusedSubjects: ReadonlyArray<WorkspaceSubjectReference> | undefined,
): void => {
  const human = requireHuman(runtime, room)
  room.setPaused(false)
  room.post({
    senderId: human.id,
    senderName: human.name,
    content: prompt,
    type: 'chat',
    ...(focusedSubjects === undefined ? {} : { focusedSubjects }),
  })
}

export const createAssistanceRoom = async (
  runtime: AgentsWorkspaceRuntime,
  library: RoomDefinitionLibrary,
  flush: () => Promise<void>,
  scope: WorkspaceRoomScope,
  title: string,
): Promise<AssistanceRoomResult> => {
  const revision = await resolveAssistanceRevision(library)
  const started = await startRoomDefinition(runtime, library, revision.definitionId, revision.id, { scope, name: subjectRoomName(title) })
  await flush()
  return { created: true, room: started.room, revisionId: revision.id }
}

// A fresh conversation is named by its caller ("Getting started question"),
// never merged into an existing Assistance Room, and starts with the request.
export const openNewAssistanceRoom = async (
  runtime: AgentsWorkspaceRuntime,
  library: RoomDefinitionLibrary,
  flush: () => Promise<void>,
  options: {
    readonly scope: WorkspaceRoomScope
    readonly title: string
    readonly prompt: string
    readonly focusedSubjects?: ReadonlyArray<WorkspaceSubjectReference>
  },
): Promise<AssistanceRoomResult> => {
  const revision = await resolveAssistanceRevision(library)
  const started = await startRoomDefinition(runtime, library, revision.definitionId, revision.id, { scope: options.scope, name: options.title })
  const room = runtime.rooms.getRoom(started.room.id)
  if (!room) throw new AssistanceRoomError(500, 'assistance_room_disappeared', 'Assistance Room disappeared during creation')
  postRequest(runtime, room, options.prompt, options.focusedSubjects)
  await flush()
  return { created: true, room: { id: room.profile.id, name: room.profile.name }, revisionId: revision.id }
}

export const ensureAssistanceRoom = async (
  runtime: AgentsWorkspaceRuntime,
  library: RoomDefinitionLibrary,
  flush: () => Promise<void>,
  options: {
    readonly scope: WorkspaceRoomScope
    readonly title?: string
    readonly prompt?: string
    readonly focusedSubjects?: ReadonlyArray<WorkspaceSubjectReference>
  } = { scope: { kind: 'workspace' } },
): Promise<AssistanceRoomResult> => {
  const revision = await resolveAssistanceRevision(library)

  const key = targetKey(options.scope)
  let requests = pending.get(runtime)
  if (!requests) { requests = new Map(); pending.set(runtime, requests) }
  const inflight = requests.get(key)
  let created = inflight === undefined
  const creation = inflight ?? (async (): Promise<Room> => {
    const existing = runtime.rooms.listAllRooms()
      .filter(room => room.sourceDefinition?.id === revision.definitionId && sameTarget(room.scope, options.scope))
      .sort((left, right) => left.createdAt - right.createdAt)[0]
    if (existing) {
      created = false
      const room = runtime.rooms.getRoom(existing.id)
      if (!room) throw new AssistanceRoomError(500, 'assistance_room_disappeared', 'Assistance Room disappeared during lookup')
      return room
    }
    const started = await startRoomDefinition(
      runtime,
      library,
      revision.definitionId,
      revision.id,
      { scope: options.scope, name: subjectRoomName(options.title ?? 'Assistance') },
    )
    const room = runtime.rooms.getRoom(started.room.id)
    if (!room) throw new AssistanceRoomError(500, 'assistance_room_disappeared', 'Assistance Room disappeared during creation')
    return room
  })()
  if (!inflight) requests.set(key, creation)
  let room: Room
  try { room = await creation }
  finally { if (requests.get(key) === creation) requests.delete(key) }

  if (options.prompt === undefined) requireHuman(runtime, room)
  else postRequest(runtime, room, options.prompt, options.focusedSubjects)
  await flush()
  return { created, room: { id: room.profile.id, name: room.profile.name }, revisionId: revision.id }
}
