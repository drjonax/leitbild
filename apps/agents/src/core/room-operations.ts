// System-level room/membership operations — extracted from workspace-runtime.ts to keep
// createAgentsWorkspaceRuntime focused on factory wiring. Pure dependency injection: the
// factory closes over team/rooms/routeMessage and the late-bound callbacks
// it needs, and returns four functions with the original signatures.
//
// Internal cross-reference: systemRemoveAgentFromRoom usually calls
// systemRemoveRoom when the last member leaves, so the four ops share a
// closure rather than being free functions. Orchestrated teardown paths can
// opt out when the room itself is the durable artifact.

import type { RouteMessage, Team } from './types/agent.ts'
import type { OnMembershipChanged, RemoveAgentFromRoomOptions } from './types/room.ts'
import type { RoomDirectory } from './rooms/directory.ts'
import type { TriggerScheduler } from './triggers/scheduler.ts'
import { addAgentToRoom, removeAgentFromRoom } from '../agents/actions.ts'
import { asAIAgent } from '../agents/shared.ts'

export interface RoomOperationsDeps {
  readonly team: Team
  readonly rooms: RoomDirectory
  readonly routeMessage: RouteMessage
  readonly onMembershipChanged: OnMembershipChanged
  readonly triggerScheduler: TriggerScheduler
}

export interface RoomOperations {
  readonly addAgentToRoom: (agentId: string, roomId: string, invitedBy?: string) => Promise<void>
  readonly removeAgentFromRoom: (agentId: string, roomId: string, removedBy?: string, options?: RemoveAgentFromRoomOptions) => void
  readonly removeRoom: (roomId: string) => boolean
  readonly cancelGenerationsInRoom: (roomId: string) => void
}

export const createRoomOperations = (deps: RoomOperationsDeps): RoomOperations => {
  const { team, rooms, routeMessage, onMembershipChanged, triggerScheduler } = deps

  const systemAddAgentToRoom = async (agentId: string, roomId: string, invitedBy?: string): Promise<void> => {
    const agent = team.getAgent(agentId)
    const room = rooms.getRoom(roomId)
    if (!agent || !room) return
    await addAgentToRoom(agentId, agent.name, roomId, invitedBy, team, routeMessage, rooms)
    onMembershipChanged(roomId, room.profile.name, agentId, agent.name, 'added')
  }

  const systemRemoveAgentFromRoom = (
    agentId: string,
    roomId: string,
    removedBy?: string,
    options?: RemoveAgentFromRoomOptions,
  ): void => {
    const agent = team.getAgent(agentId)
    const room = rooms.getRoom(roomId)
    if (!agent || !room) return
    removeAgentFromRoom(agentId, agent.name, roomId, removedBy, team, routeMessage, rooms)
    onMembershipChanged(roomId, room.profile.name, agentId, agent.name, 'removed')
    if ((options?.deleteRoomIfEmpty ?? true) && room.getParticipantIds().length === 0) {
      systemRemoveRoom(roomId)
    }
  }

  const systemRemoveRoom = (roomId: string): boolean => {
    const room = rooms.getRoom(roomId)
    if (!room) return false
    const ownedAgents = team.listByKind('ai').flatMap(agent => {
      const ai = asAIAgent(agent)
      return ai?.getConfig().ownerRoomId === roomId ? [ai] : []
    })
    cancelGenerationsInRoom(roomId)
    for (const agentId of room.getParticipantIds()) {
      team.getAgent(agentId)?.leave(roomId)
    }
    const removed = rooms.removeRoom(roomId)
    if (removed) {
      // Cascade-clean triggers pinned to the deleted room. Without this,
      // triggers become orphans — the scheduler skips them silently
      // (room.getRoom returns undefined) but they pile up in storage and
      // confuse the UI.
      for (const agent of team.listAgents()) {
        const triggers = agent.getTriggers?.() ?? []
        for (const t of triggers) {
          if (t.roomId === roomId) agent.deleteTrigger?.(t.id)
        }
      }
      for (const owned of ownedAgents) {
        // As in removeAgent: an Agent leaving the team stops its turns.
        owned.close()
        owned.cancelGeneration()
        team.removeAgent(owned.id)
        for (const survivor of team.listByKind('ai')) asAIAgent(survivor)?.forgetAgent?.(owned.id)
      }
      triggerScheduler.invalidate()
    }
    return removed
  }

  // Cancel in-flight AI generation only for agents whose current generation
  // context is this room. Called by the room's onManualModeEntered hook.
  const cancelGenerationsInRoom = (roomId: string): void => {
    const room = rooms.getRoom(roomId)
    if (!room) return
    for (const id of room.getParticipantIds()) {
      const agent = team.getAgent(id)
      if (!agent || agent.kind !== 'ai') continue
      if (agent.state.getContext() !== roomId) continue
      const ai = asAIAgent(agent)
      ai?.cancelGeneration()
    }
  }

  return {
    addAgentToRoom: systemAddAgentToRoom,
    removeAgentFromRoom: systemRemoveAgentFromRoom,
    removeRoom: systemRemoveRoom,
    cancelGenerationsInRoom,
  }
}
