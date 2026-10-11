import { z } from 'zod'
import type { RoomDirectory } from '../../core/rooms/directory.ts'
import type { Tool } from '../../core/types/tool.ts'
import { extractToolInteractions } from '../../core/tool-evidence.ts'
import type { ExecutionStore } from '../../core/executions/store.ts'

export const conversationReadInputSchema = z.object({
  messageId: z.string().optional(),
  turnId: z.string().optional().describe('Actual execution turn, including interrupted turns without a posted message.'),
  beforeTurn: z.object({ startedAt: z.number().int(), id: z.string() }).strict().optional(),
  toolCallId: z.string().optional(),
  callIndex: z.number().int().nonnegative().optional().describe('Choose the indexed occurrence when a retained provider call ID is repeated.'),
  part: z.enum(['arguments', 'result']).default('arguments'),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(10),
}).strict()

// Request snapshots and actual executions are distinct facts in the same
// conversation. Never accepts another Room or exposes private instructions.
export const createConversationReadTool = (rooms: RoomDirectory, executions?: ExecutionStore): Tool => ({
  name: 'conversation_read',
  description: 'Retrieve exact earlier work from this conversation. Follow returned read selectors: execution lists actual calls; modelRequest lists final model-request evidence. Their call IDs are not interchangeable. Add part arguments or result to a call selector. Missing execution outcomes are unknown: inspect current state before retrying. Old observations are historical, not current state.',
  parameters: z.toJSONSchema(conversationReadInputSchema, { io: 'input' }),
  execute: async (params, context) => {
    const parsed = conversationReadInputSchema.safeParse(params)
    if (!parsed.success) return { success: false, error: parsed.error.message }
    const room = context.roomId ? rooms.getRoom(context.roomId) : undefined
    if (!room || !room.getParticipantIds().includes(context.callerId)) {
      return { success: false, error: 'conversation_access_denied: caller must belong to the current Room' }
    }
    const { messageId, turnId, beforeTurn, toolCallId, callIndex, part, offset, limit } = parsed.data
    const executionLink = (id: string | undefined) => id && (!context.comparison || context.comparison.turnIds.includes(id)) && executions?.getTurn(room.profile.id, id)
      ? { execution: { turnId: id } } : {}
    if (context.comparison && ((messageId && !context.comparison.messageIds.includes(messageId)) || (turnId && !context.comparison.turnIds.includes(turnId)))) {
      return { success: false, error: 'comparison_evidence_out_of_scope: only evidence available before this task may be retrieved' }
    }
    if (toolCallId && callIndex !== undefined) return {success:false,error:'Choose either toolCallId or callIndex, not both'}
    if (messageId && turnId) return {success:false,error:'Choose messageId for model-request evidence or turnId for actual execution evidence, not both'}
    if (turnId) {
      const turn = executions?.getTurn(room.profile.id, turnId)
      if (!turn) return { success: false, error: 'conversation_execution_unavailable: turn was removed or is not in this Room' }
      if (callIndex !== undefined) return { success: false, error: 'Actual execution calls have unique toolCallId values; callIndex selects request evidence only' }
      if (!toolCallId) return { success: true, data: { evidenceKind: 'execution', turn, calls: executions!.listCalls(room.profile.id, turnId).map(call => ({
        ...call, toolCallId: call.id, read: { turnId, toolCallId: call.id }, outcome: call.completedAt === undefined ? 'unknown' : 'recorded',
      })) } }
      const call = executions!.getCall(room.profile.id, turnId, toolCallId)
      if (!call) return { success: false, error: 'conversation_tool_call_unavailable: choose a toolCallId from this turn' }
      if (part === 'result' && call.result === undefined) return { success: false, error: 'conversation_outcome_unknown: no durable outcome; inspect current state before retrying', data: { evidenceKind: 'execution', turn, toolCallId } }
      return { success: true, data: { evidenceKind: 'execution', turnId, toolCallId, tool: call.tool,
        startedAt: call.startedAt, ...(call.completedAt === undefined ? {} : { completedAt: call.completedAt }),
        [part]: part === 'arguments' ? call.arguments : call.result,
      } }
    }
    const messages = room.getRetainedMessages().filter(message => !context.comparison || context.comparison.messageIds.includes(message.id))
    if (!messageId) {
      if (toolCallId || callIndex !== undefined) return {success:false,error:'messageId or turnId is required with a tool-call selector'}
      const ordered = [...messages].reverse()
      // Tests/headless readers may have no execution store. This represents
      // absence of execution recording, not inferred execution from requests.
      const turns = context.comparison
        ? context.comparison.turnIds.map(id => executions?.getTurn(room.profile.id, id)).filter((turn): turn is NonNullable<typeof turn> => turn !== undefined)
          .sort((a,b) => b.startedAt-a.startedAt || b.id.localeCompare(a.id))
          .filter(turn => !beforeTurn || turn.startedAt < beforeTurn.startedAt || (turn.startedAt === beforeTurn.startedAt && turn.id < beforeTurn.id)).slice(0,limit+1)
        : executions?.listTurns(room.profile.id, { limit: limit + 1, ...(beforeTurn ? { before: beforeTurn } : {}) }) ?? []
      const page = turns.slice(0, limit)
      const last = page.at(-1)
      return {success:true,data:{
        total:ordered.length, offset, hasMore:offset+limit<ordered.length,
        executionTurns: page,
        ...(turns.length > limit && last ? { nextTurn: { startedAt: last.startedAt, id: last.id } } : {}),
        messages:ordered.slice(offset,offset+limit).map(m=>({
          messageId:m.id,sender:m.senderName??m.senderId,timestamp:m.timestamp,
          preview:m.content.slice(0,240),hasToolEvidence:!!m.toolTrace?.length || !!room.getGenerationQuery(m.id)?.query.messages.some(message => message.toolCalls?.length),
          ...executionLink(m.generationTraceId),
        })),
      }}
    }
    const message = messages.find(m=>m.id===messageId)
    if (!message) return {success:false,error:'conversation_message_unavailable: message was removed or is not in this Room'}
    const savedRecord = room.getGenerationQuery(messageId)
    const record = !context.comparison || (savedRecord && context.comparison.turnIds.includes(savedRecord.traceId)) ? savedRecord : undefined
    const calls = extractToolInteractions(record?.query.messages ?? [])
    if (!toolCallId && callIndex === undefined) return {success:true,data:{
      evidenceKind:'model_request',messageId,content:message.content,timestamp:message.timestamp,
      ...executionLink(message.generationTraceId),
      modelRequest:{messageId,calls:calls.map(call=>({providerCallId:call.id,read:{messageId,callIndex:call.callIndex},tool:call.name,
        operationIds: typeof call.arguments === 'object' && call.arguments !== null && 'calls' in call.arguments && Array.isArray(call.arguments.calls)
          ? (call.arguments.calls as Array<Record<string,unknown>>).map(c=>c.operationId) : undefined,
      }))},
    }}
    const matches = callIndex === undefined ? calls.filter(call => call.id === toolCallId) : calls.filter(call => call.callIndex === callIndex)
    if (matches.length > 1) return {success:false,error:'conversation_tool_call_ambiguous: choose callIndex from this message instead of the repeated toolCallId'}
    const call = matches[0]
    if (!call) return {success:false,error:'conversation_tool_call_unavailable: choose a toolCallId from this message'}
    const result = call.result
    if(part==='result'&&!result) return {success:false,error:'conversation_result_unavailable: no retained result for this call'}
    return {success:true,data:{evidenceKind:'model_request',messageId,toolCallId:call.id,callIndex:call.callIndex,tool:call.name,timestamp:message.timestamp,
      [part]:part==='arguments'?call.arguments:result!.content,
    }}
  },
})
