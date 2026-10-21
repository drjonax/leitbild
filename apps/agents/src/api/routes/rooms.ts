import { json, errorResponse, parseBody } from './helpers.ts'
import { SYSTEM_SENDER_ID } from '../../core/types/constants.ts'
import { SETTABLE_DELIVERY_MODES } from '../../core/types/messaging.ts'
import type { SettableDeliveryMode } from '../../core/types/messaging.ts'
import { validateSummaryConfig } from '../../core/types/summary.ts'
import type { RouteEntry } from './types.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { exportRoomConversation } from '../../core/rooms/room-export.ts'
import { roomPacksInputSchema } from '../../packs/activation.ts'
import { storedTurnCards } from '../../agents/answer-cards.ts'

export const roomRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/executions$/,
    handler: (req, match, { system }) => {
      const room = system.rooms.getRoom(decodeURIComponent(match[1]!))
      if (!room) return errorResponse('Room not found', 404)
      const params = new URL(req.url).searchParams
      const limit = Number(params.get('limit') ?? 30)
      const beforeId = params.get('beforeId')
      const beforeAt = params.get('beforeStartedAt')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (beforeId === null) !== (beforeAt === null) || (beforeAt !== null && !Number.isSafeInteger(Number(beforeAt)))) return errorResponse('Invalid execution page')
      const turns = system.executionStore.listTurns(room.profile.id, { limit: limit + 1, ...(beforeId !== null && beforeAt !== null ? { before: { id: beforeId, startedAt: Number(beforeAt) } } : {}) })
      const page = turns.slice(0, limit)
      const last = page.at(-1)
      return json({ turns: page, ...(turns.length > limit && last ? { next: { startedAt: last.startedAt, id: last.id } } : {}) })
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/executions\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const room = system.rooms.getRoom(decodeURIComponent(match[1]!))
      if (!room) return errorResponse('Room not found', 404)
      const turn = system.executionStore.getTurn(room.profile.id, decodeURIComponent(match[2]!))
      if (!turn) return errorResponse('Execution turn not found', 404)
      return json({ turn, calls: system.executionStore.listCalls(room.profile.id, turn.id) })
    },
  },
  {
    // What the turn proposed and where World says each proposal stands (the answer's proposal card).
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/executions\/([^/]+)\/proposals$/,
    handler: async (_req, match, { system }) => {
      try {
        return json({ cards: await system.readProposalCards(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!)) })
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === 'room_not_found' || code === 'turn_not_found') return errorResponse((error as Error).message, 404)
        if (code === 'workspace_host_unavailable') return errorResponse((error as Error).message, 503)
        throw error
      }
    },
  },
  {
    // The cards the turn's answer cites, keyed as it cites them (the answer's frozen card and key chips).
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/executions\/([^/]+)\/cards$/,
    handler: (_req, match, { system }) => {
      const room = system.rooms.getRoom(decodeURIComponent(match[1]!))
      if (!room) return errorResponse('Room not found', 404)
      const turn = system.executionStore.getTurn(room.profile.id, decodeURIComponent(match[2]!))
      if (!turn) return errorResponse('Execution turn not found', 404)
      const calls = system.executionStore.listCalls(room.profile.id, turn.id).map(call => system.executionStore.getCall(room.profile.id, turn.id, call.id)!)
      return json({ cards: storedTurnCards(calls) })
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/executions\/([^/]+)\/calls\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const room = system.rooms.getRoom(decodeURIComponent(match[1]!))
      if (!room) return errorResponse('Room not found', 404)
      const call = system.executionStore.getCall(room.profile.id, decodeURIComponent(match[2]!), decodeURIComponent(match[3]!))
      return call ? json(call) : errorResponse('Execution call not found', 404)
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms$/,
    handler: (_req, _match, { system }) => json(system.rooms.listAllRooms()),
  },
  {
    method: 'POST',
    pattern: /^\/rooms$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (!body.name || typeof body.name !== 'string') return errorResponse('name is required')
      try {
        const result = await system.createRoom({
          name: body.name,
          roomPrompt: body.roomPrompt as string | undefined,
          createdBy: (body.createdBy as string) ?? SYSTEM_SENDER_ID,
        })
        return json(result, 201)
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'storage_budget_exceeded') return errorResponse(err.message, 507)
        return errorResponse(err instanceof Error ? err.message : 'Failed to create room')
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)$/,
    handler: (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const limit = parseInt(new URL(req.url).searchParams.get('limit') ?? '50', 10)
      return json({ profile: room.profile, messages: room.getRecent(limit) })
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/export$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      return json(exportRoomConversation(room))
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/messages\/([^/]+)\/generation-query$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const messageId = decodeURIComponent(match[2]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const message = room.getRetainedMessages().find(candidate => candidate.id === messageId)
      if (!message) return errorResponse(`Message "${messageId}" not found`, 404)
      const record = room.getGenerationQuery(messageId)
      if (!record) return errorResponse(`Generation query for message "${messageId}" is unavailable`, 404)
      return json({
        ...record,
        generation: {
          ...(message.provider ? { provider: message.provider } : {}),
          ...(message.model ? { model: message.model } : {}),
          ...(message.generationMs !== undefined ? { durationMs: message.generationMs } : {}),
          ...(message.modelCalls !== undefined ? { modelCalls: message.modelCalls } : {}),
          ...(message.promptTokens !== undefined ? { promptTokens: message.promptTokens } : {}),
          ...(message.lastPromptTokens !== undefined ? { lastPromptTokens: message.lastPromptTokens } : {}),
          ...(message.completionTokens !== undefined ? { completionTokens: message.completionTokens } : {}),
          ...(message.cacheCreation !== undefined ? { cacheCreation: message.cacheCreation } : {}),
          ...(message.cacheRead !== undefined ? { cacheRead: message.cacheRead } : {}),
          ...(message.cacheMiss !== undefined ? { cacheMiss: message.cacheMiss } : {}),
          ...(message.toolTrace ? { toolTrace: message.toolTrace } : {}),
        },
      })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/rooms\/([^/]+)\/messages\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const messageId = decodeURIComponent(match[2]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const deleted = room.deleteMessage(messageId)
      if (!deleted) return errorResponse(`Message "${messageId}" not found`, 404)
      return json({ deleted: true, messageId })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/rooms\/([^/]+)\/messages$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const count = room.getMessageCount()
      room.clearMessages()
      // Also wipe per-agent memory of this room so AI participants don't
      // retain phantom history of cleared messages.
      for (const agentId of room.getParticipantIds()) {
        const agent = system.team.getAgent(agentId)
        const ai = agent ? asAIAgent(agent) : undefined
        ai?.clearHistory?.(room.profile.id)
      }
      return json({ cleared: true, count })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/rooms\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      system.removeRoom(room.profile.id)
      return json({ removed: true })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/prompt$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      if (typeof body.roomPrompt !== 'string') return errorResponse('roomPrompt is required')
      room.setRoomPrompt(body.roomPrompt)
      return json({ roomPrompt: room.profile.roomPrompt })
    },
  },
  {
    // List the exact Packs activated in this Room.
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/packs$/,
    handler: async (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      return json({ activePacks: room.getActivePacks() })
    },
  },
  {
    // Replace activation list. Validates each entry against the known-pack
    // set (bundled + filesystem-installed). The request is atomic: any
    // unknown Pack id aborts the whole replacement.
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/packs$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const parsed = roomPacksInputSchema.safeParse(await parseBody(req))
      if (!parsed.success) return errorResponse(parsed.error.message, 400)
      const result = system.setRoomPacks(room.profile.id, parsed.data.activePacks)
      if (!result.ok) return errorResponse(result.message, result.code === 'room_not_found' ? 404 : 400)
      return json({ activePacks: result.activePacks })
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/members$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const members = room.getParticipantIds().map(id => {
        const agent = system.team.getAgent(id)
        return agent ? { id: agent.id, name: agent.name, kind: agent.kind } : { id }
      })
      return json(members)
    },
  },
  {
    method: 'POST',
    pattern: /^\/rooms\/([^/]+)\/members$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const agentName = body.agentName as string | undefined
      if (!agentName) return errorResponse('agentName is required')
      const agent = system.team.getAgent(agentName)
      if (!agent) return errorResponse(`Agent "${agentName}" not found`, 404)
      await system.addAgentToRoom(agent.id, room.profile.id)
      return json({ added: true, agentName: agent.name, roomName: room.profile.name })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/rooms\/([^/]+)\/members\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const rName = decodeURIComponent(match[1]!)
      const aName = decodeURIComponent(match[2]!)
      const room = system.rooms.getRoom(rName)
      if (!room) return errorResponse(`Room "${rName}" not found`, 404)
      const agent = system.team.getAgent(aName)
      if (!agent) return errorResponse(`Agent "${aName}" not found`, 404)
      system.removeAgentFromRoom(agent.id, room.profile.id)
      return json({ removed: true, agentName: agent.name, roomName: room.profile.name })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/delivery-mode$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const rawMode = body.mode as string
      if (!SETTABLE_DELIVERY_MODES.includes(rawMode as SettableDeliveryMode)) {
        return errorResponse(`Invalid mode "${rawMode}". Valid: ${SETTABLE_DELIVERY_MODES.join(', ')}`, 400)
      }
      room.setDeliveryMode(rawMode as SettableDeliveryMode)
      return json({ mode: room.deliveryMode })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/pause$/,
    handler: async (req, match, { system, workspaceId, broadcastToWorkspace }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      if (typeof body.paused !== 'boolean') return errorResponse('paused must be a boolean')
      room.setPaused(body.paused)
      if (!body.paused) {
        const script = system.scriptRunner.getRun(room.profile.id)
        if (script) void system.scriptRunner.resume(room.profile.id)
      }
      const evt = { type: 'delivery_mode_changed' as const, roomName: room.profile.name, mode: room.deliveryMode, paused: room.paused }
      broadcastToWorkspace(workspaceId, evt)
      return json({ paused: room.paused })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/mute$/,
    handler: async (req, match, { system, workspaceId, broadcastToWorkspace }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      if (typeof body.agentName !== 'string') return errorResponse('agentName is required')
      if (typeof body.muted !== 'boolean') return errorResponse('muted must be a boolean')
      const agent = system.team.getAgent(body.agentName)
      if (!agent) return errorResponse(`Agent "${body.agentName}" not found`, 404)
      room.setMuted(agent.id, body.muted)
      const evt = { type: 'mute_changed' as const, roomName: room.profile.name, agentName: agent.name, muted: body.muted }
      broadcastToWorkspace(workspaceId, evt)
      return json({ muted: room.isMuted(agent.id) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)\/activate$/,
    handler: (_req, match, { system }) => {
      const roomName = decodeURIComponent(match[1]!)
      const agentName = decodeURIComponent(match[2]!)
      const room = system.rooms.getRoom(roomName)
      if (!room) return errorResponse(`Room "${roomName}" not found`, 404)
      const agent = system.team.getAgent(agentName)
      if (!agent) return errorResponse(`Agent "${agentName}" not found`, 404)
      const result = system.activateAgentInRoom(agent.id, room.profile.id)
      return json(result, result.ok ? 200 : 400)
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/summary-config$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      return json(room.summaryConfig)
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/summary-config$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      // Validate at the trust boundary. The previous version did
      // `body as unknown as SummaryConfig` which TS-accepted any shape
      // and pushed failure to runtime in unpredictable places (an
      // invalid schedule.kind could silently break the scheduler).
      const result = validateSummaryConfig(body)
      if (result.ok === false) return errorResponse(result.error, 400)
      room.setSummaryConfig(result.value)
      return json(room.summaryConfig)
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/summary$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const compression = room.getCurrentCompressionMessage()
      return json({
        summary: room.getLatestSummary() ?? null,
        compression: compression ? { id: compression.id, content: compression.content, timestamp: compression.timestamp } : null,
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/rooms\/([^/]+)\/summary\/regenerate$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const target = body.target as 'summary' | 'compression' | 'both'
      if (target !== 'summary' && target !== 'compression' && target !== 'both') {
        return errorResponse('target must be "summary", "compression", or "both"', 400)
      }
      // Fire and forget — the WS events carry progress + completion.
      void system.summaryScheduler.triggerNow(room.profile.id, target)
      return json({ triggered: target })
    },
  },
]
