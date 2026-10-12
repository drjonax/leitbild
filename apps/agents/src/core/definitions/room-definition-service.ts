import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import { SYSTEM_SENDER_ID } from '../types/constants.ts'
import { owningPackFor } from '../types/tool-pack.ts'
import { resolveWorkspaceDefaultModel } from '../workspaces/seed-workspace.ts'
import { DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from '../../llm/models/catalog.ts'
import type { RoomDefinition, PromptDeckEntry } from './room-definition-catalog.ts'
import type { RoomDefinitionLibrary } from './room-definition-library.ts'
import type { WorkspaceRoomScope } from '@leitbild/contracts'

export interface StartedRoomDefinition {
  readonly definition: RoomDefinition
  readonly revisionId: string
  readonly room: { readonly id: string; readonly name: string }
  readonly human: { readonly id: string; readonly name: string }
  readonly agents: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

const requireKnownPacks = (
  system: AgentsWorkspaceRuntime,
  requested: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const known = new Set(system.packCatalog.list().map(pack => pack.id))
  const missing = requested.filter(id => !known.has(id))
  if (missing.length > 0) throw new Error(`Required Packs are unavailable: ${missing.join(', ')}`)
  return [...new Set(requested)]
}

const uniqueAgentName = (system: AgentsWorkspaceRuntime, requested: string): string => {
  let candidate = requested
  let suffix = 2
  while (system.team.getAgent(candidate)) candidate = `${requested} ${suffix++}`
  return candidate
}

const validateAgentTools = (
  system: AgentsWorkspaceRuntime,
  definition: RoomDefinition,
  activePacks: ReadonlySet<string>,
): void => {
  for (const agent of definition.room.agents) {
    for (const toolName of agent.tools) {
      const entry = system.toolRegistry.getEntry(toolName)
      if (entry === undefined) throw new Error(`Agent "${agent.name}" selects unavailable tool "${toolName}"`)
      const owningPack = owningPackFor(entry)
      if (owningPack !== undefined && !activePacks.has(owningPack)) {
        throw new Error(`Agent "${agent.name}" selects tool "${toolName}" from inactive Pack "${owningPack}"`)
      }
    }
  }
}

const validateAgentSkills = (
  system: AgentsWorkspaceRuntime,
  definition: RoomDefinition,
  activePacks: ReadonlySet<string>,
): void => {
  for (const agent of definition.room.agents) {
    for (const skillName of agent.skills) {
      const skill = system.skillStore.get(skillName)
      if (skill === undefined) throw new Error(`Agent "${agent.name}" selects unavailable Skill "${skillName}"`)
      if (skill.pack !== undefined && !activePacks.has(skill.pack)) {
        throw new Error(`Agent "${agent.name}" selects Skill "${skillName}" from inactive Pack "${skill.pack}"`)
      }
    }
  }
}

export const startRoomDefinition = async (
  system: AgentsWorkspaceRuntime,
  library: RoomDefinitionLibrary,
  definitionId: string,
  revisionId: string,
  scoped?: { readonly scope: WorkspaceRoomScope; readonly name: string },
): Promise<StartedRoomDefinition> => {
  const revision = await library.getRevision(revisionId)
  if (!revision || revision.definitionId !== definitionId) throw new Error(`Unknown Room Definition Revision "${revisionId}"`)
  const definition = revision.document
  validateRoomDefinition(system, definition)
  const activePacks = definition.room.packs
  const human = system.team.listByKind('human').find(agent => agent.name === 'You')
    ?? system.team.listByKind('human')[0]
  if (!human) throw new Error('This Workspace has no human agent')

  const room = (await system.createRoom({
    name: scoped?.name ?? definition.title,
    scope: scoped?.scope ?? { kind: 'workspace' },
    roomPrompt: definition.room.prompt,
    createdBy: SYSTEM_SENDER_ID,
    sourceDefinition: { id: definition.id, revisionId: revision.id },
  })).value
  const createdAgents: Array<{ id: string; name: string }> = []
  try {
    room.setActivePacks(activePacks)
    room.setDeliveryMode(definition.room.deliveryMode)
    await system.addAgentToRoom(human.id, room.profile.id, 'demo')
    const defaultModel = resolveWorkspaceDefaultModel(system)
    for (const agentDefinition of definition.room.agents) {
      // The default effort belongs to the default model, so it applies only
      // when this Agent runs that model and declares no effort of its own.
      const reasoningEffort = agentDefinition.reasoningEffort
        ?? (agentDefinition.model === undefined && defaultModel === DEFAULT_MODEL_ID ? DEFAULT_REASONING_EFFORT : undefined)
      const agent = await system.spawnAIAgent({
        name: uniqueAgentName(system, agentDefinition.name),
        ownerRoomId: room.profile.id,
        model: agentDefinition.model ?? defaultModel,
        persona: agentDefinition.persona,
        tools: agentDefinition.tools,
        skills: agentDefinition.skills,
        ...(agentDefinition.temperature !== undefined ? { temperature: agentDefinition.temperature } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(agentDefinition.historyTokenBudget !== undefined ? { historyTokenBudget: agentDefinition.historyTokenBudget } : {}),
        ...(agentDefinition.maxToolIterations !== undefined ? { maxToolIterations: agentDefinition.maxToolIterations } : {}),
        ...(agentDefinition.includeContext ? { includeContext: agentDefinition.includeContext } : {}),
      })
      createdAgents.push({ id: agent.id, name: agent.name })
      await system.addAgentToRoom(agent.id, room.profile.id, 'demo')
    }
    // Joining a second AI intentionally auto-switches ordinary rooms to
    // manual. A Room Definition is authoritative, so restore its declared mode.
    room.setDeliveryMode(definition.room.deliveryMode)
    return {
      definition,
      revisionId: revision.id,
      room: { id: room.profile.id, name: room.profile.name },
      human: { id: human.id, name: human.name },
      agents: createdAgents,
    }
  } catch (error) {
    for (const agent of createdAgents) system.removeAgent(agent.id)
    system.removeRoom(room.profile.id)
    throw error
  }
}

export const validateRoomDefinition = (system: AgentsWorkspaceRuntime, definition: RoomDefinition): void => {
  const activePacks = requireKnownPacks(system, definition.room.packs)
  validateAgentTools(system, definition, new Set(activePacks))
  validateAgentSkills(system, definition, new Set(activePacks))
  for (const entry of definition.deck.entries) {
    if (entry.action.kind === 'start-script' && !system.scriptStore.get(entry.action.scriptName)) {
      throw new Error(`Prompt Deck entry ${entry.id} selects unavailable script ${entry.action.scriptName}`)
    }
  }
}

export const runPromptDeckEntry = async (
  system: AgentsWorkspaceRuntime,
  library: RoomDefinitionLibrary,
  roomId: string,
  entryId: string,
): Promise<PromptDeckEntry> => {
  const room = system.rooms.getRoom(roomId)
  if (!room) throw new Error(`Room "${roomId}" not found`)
  const sourceDefinition = room.profile.sourceDefinition
  if (!sourceDefinition) throw new Error('Room was not created from a Room Definition')
  const revision = await library.getRevision(sourceDefinition.revisionId)
  if (!revision || revision.definitionId !== sourceDefinition.id) {
    throw new Error(`Room Definition Revision "${sourceDefinition.revisionId}" not found`)
  }
  const entry = revision.document.deck.entries.find(candidate => candidate.id === entryId)
  if (!entry) throw new Error(`Unknown Prompt Deck entry "${entryId}"`)

  if (entry.action.kind === 'start-script') {
    const result = await system.scriptRunner.start(room.profile.id, entry.action.scriptName)
    if (!result.ok) throw new Error(result.reason ?? 'Failed to start script')
    return entry
  }

  const human = room.getParticipantIds()
    .map(id => system.team.getAgent(id))
    .find(agent => agent?.kind === 'human')
  if (!human) throw new Error('This room has no human agent')
  room.setPaused(false)
  room.post({
    senderId: human.id,
    senderName: human.name,
    content: entry.action.content,
    type: 'chat',
  })
  if (entry.action.pauseAfterMs !== undefined) {
    setTimeout(() => system.rooms.getRoom(room.profile.id)?.setPaused(true), entry.action.pauseAfterMs)
  }
  return entry
}
