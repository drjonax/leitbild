import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createComparisonStorage } from './comparison-storage.ts'
import { workspaceDefinitionCatalogSchema, workspaceResourceCatalogSchema, type WorkspaceId } from '@leitbild/contracts'
import type { AgentTurnStart } from './ai-agent.ts'
import { evaluate, callLLM, streamLLM, type LLMCallMetrics } from './evaluation.ts'
import { createToolExecutor, type ExecutionGrowth, type RunToolOperation } from './spawn.ts'
import { estimateTokens } from './context-builder.ts'
import { OUTPUT_RESERVE, SAFETY_MARGIN } from './budget.ts'
import type { RoomDirectory } from '../core/rooms/directory.ts'
import type { ExecutionStore } from '../core/executions/store.ts'
import type { ToolRegistry } from '../core/types/tool.ts'
import type { ToolContext, ToolResult } from '../core/types/tool.ts'
import type { GenerationQuery } from '../core/types/llm.ts'
import type { ToolTraceEntry } from '../core/types/messaging.ts'
import type { LLMService } from '../llm/llm-service.ts'
import { modelSupportsImages } from '../llm/multimodal.ts'
import { resolveScope } from '../tools/built-in/workspace-capability-tools.ts'
import { readProductRevision } from '@leitbild/knowledge/source'
import { resolve } from 'node:path'
import { conversationReadInputSchema } from '../tools/built-in/conversation-read.ts'

// These built-ins were reviewed for conversation isolation, not merely reads.
// Unrestricted web/recall/room tools are deliberately not comparison-safe.
const supportedTools = new Set(['workspace_explore', 'workspace_call', 'conversation_read', 'product_search', 'product_read', 'pass'])
const guidance = 'This is an independent read-only retry of an earlier task against CURRENT data, not a historical simulation replay. Make your own tool choices. You cannot change the simulation or Workspace. Conversation evidence ends before the original task. Do not claim actions were performed. Explain material missing evidence. Other models and their answers are not available.'
const safeId = (id: string) => { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid comparison identifier'); return id }

interface StartingInput extends Omit<AgentTurnStart, 'context'> {
  readonly context: Omit<AgentTurnStart['context'], 'flushInfo'>
  readonly capturedAt: number
  readonly sourceRevision: string
  readonly boundary: NonNullable<ToolContext['comparison']>
}
interface CallEvidence { id: string; tool: string; arguments: unknown; startedAt: number; result?: ToolResult; completedAt?: number }
export interface Comparison {
  id: string; model: string; status: 'running'|'completed'|'failed'|'interrupted'; startedAt: number
  finishedAt?: number; content?: string; error?: string; metrics?: LLMCallMetrics
  query?: GenerationQuery; toolTrace?: ReadonlyArray<ToolTraceEntry>; calls: CallEvidence[]
  withheldTools: string[]
  nestedQueries?: GenerationQuery[]
}
interface RecordData { source: StartingInput; messageId: string; alternatives: Comparison[] }
const strings = z.array(z.string())
const sourceSchema = z.object({
  executionTurnId: z.string(), roomId: z.string(), messageId:z.string(), agentId: z.string(), capturedAt: z.number().finite(), sourceRevision: z.string(),
  config: z.object({ name: z.string(), model: z.string() }).passthrough(),
  context: z.object({ messages: z.array(z.object({ role: z.string(), content: z.string() }).passthrough()) }).passthrough(),
  toolDefinitions: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string() }).passthrough() }).passthrough()),
  focusedSubjects: z.array(z.unknown()),
  boundary: z.object({ resourceKeys: strings, definitionKeys: strings, messageIds: strings, turnIds: strings }).strict(),
}).passthrough()
const alternativeSchema = z.object({
  id: z.string(), model: z.string(), status: z.enum(['running', 'completed', 'failed', 'interrupted']), startedAt: z.number().finite(),
  finishedAt: z.number().finite().optional(), content: z.string().optional(), error: z.string().optional(),
  calls: z.array(z.object({ id: z.string(), tool: z.string(), arguments: z.unknown(), startedAt: z.number().finite(), completedAt: z.number().finite().optional() }).passthrough()),
  withheldTools: strings,
}).passthrough()
interface Dependencies {
  rooms: RoomDirectory; executions: ExecutionStore; registry: ToolRegistry; llm: LLMService
  workspaceId?: WorkspaceId; hostUrl?: string; root?: string
  growth: ExecutionGrowth; runOperation?: RunToolOperation
}

/** Message-owned experiments. Never posts to Rooms or normal execution history. */
export const createComparisons = (deps: Dependencies) => {
  const pending = new Map<string, StartingInput>()
  const records = new Map<string, RecordData>()
  const loads = new Map<string, Promise<RecordData | undefined>>()
  const starts = new Map<string, number>()
  const saving = new Map<RecordData, number>()
  const storage = deps.root ? createComparisonStorage(deps.root, deps.growth) : undefined
  const jobs = new Map<string, { controller: AbortController; done: Promise<void> }>()
  let closed=false
  let writes = Promise.resolve()
  const recordKey = (roomId: string, messageId: string) => `${safeId(roomId)}/${safeId(messageId)}`
  const release = (key: string, record: RecordData): void => {
    if (storage && records.get(key) === record && !loads.has(key) && !starts.has(key) && !saving.has(record) && !record.alternatives.some(a => jobs.has(a.id))) records.delete(key)
  }
  const persist = (record: RecordData, alternative?: Comparison): Promise<void> => {
    if (!storage) return Promise.resolve() // Isolated runtime tests have no durable directory.
    const key = recordKey(record.source.roomId, record.messageId)
    const text = JSON.stringify(alternative ?? {...record.source,messageId:record.messageId})
    saving.set(record,(saving.get(record)??0)+1)
    const task = writes.then(async () => {
      if (records.get(key) !== record) return // Removal owns cancellation and tombstones this object.
      if (alternative) await storage.writeAlternative(record.source.roomId, record.messageId, alternative.id, text)
      else await storage.writeSource(record.source.roomId, record.messageId, text)
    }).finally(()=>{
      const count=saving.get(record)!-1
      if(count)saving.set(record,count);else saving.delete(record)
      release(key,record)
    })
    writes = task.catch(error => { console.error('[comparisons] Persistence failed', error) })
    return task
  }
  const load = async (roomId: string, messageId: string): Promise<RecordData | undefined> => {
    const room = deps.rooms.getRoom(roomId)
    if (!room?.getRetainedMessages().some(m => m.id === messageId)) throw new Error('Message not found')
    const key = recordKey(roomId, messageId)
    const cached = records.get(key)
    if (cached) return cached
    if (!storage) return undefined
    const existing = loads.get(key)
    if (existing) return existing
    const loading = (async () => {
      await writes
      const stored = await storage.read(roomId, messageId)
      if (!stored) return undefined
      if (!deps.rooms.getRoom(roomId)?.getRetainedMessages().some(message => message.id === messageId)) throw new Error('Message not found')
      const {messageId:storedMessageId,...parsedSource}=sourceSchema.parse(stored.source)
      const source = parsedSource as unknown as StartingInput
      if (source.roomId !== roomId || storedMessageId !== messageId) throw new Error('Invalid comparison source identity')
      const alternatives = stored.alternatives.map(value => alternativeSchema.parse(value) as unknown as Comparison).sort((a,b) => a.startedAt - b.startedAt)
      const record: RecordData = {source, messageId, alternatives}
      records.set(key, record)
      for (const alternative of alternatives) if (alternative.status === 'running') {
        alternative.status = 'interrupted'; alternative.error = 'Server restarted; execution was not automatically retried'; alternative.finishedAt = Date.now()
        await persist(record, alternative)
      }
      return record
    })().finally(() => { loads.delete(key);const record=records.get(key);if(record)release(key,record) })
    loads.set(key, loading)
    return loading
  }
  const capture = async (input: AgentTurnStart): Promise<void> => {
    if(closed)throw new Error('Workspace comparisons are closed')
    const room = deps.rooms.getRoom(input.roomId)
    if (!room) throw new Error('Comparison capture: Room no longer exists')
    const capturedScope=structuredClone(room.profile.scope)
    const capturedAt=Date.now()
    const messages = room.getRetainedMessages()
    const messageIds = messages.map(m => m.id)
    const turnIds = messages.flatMap(m => {
      const turn = m.generationTraceId ? deps.executions.getTurn(input.roomId, m.generationTraceId) : undefined
      return turn?.status === 'completed' && deps.executions.listCalls(input.roomId, turn.id).every(call => call.completedAt !== undefined) ? [turn.id] : []
    })
    let resourceKeys: string[] = [], definitionKeys: string[] = []
    if (deps.workspaceId && deps.hostUrl && input.toolDefinitions.some(t => t.function.name === 'workspace_explore')) {
      const base = `${deps.hostUrl}/api/workspaces/${deps.workspaceId}`
      const [r, d] = await Promise.all(['resources','definitions'].map(part => fetch(`${base}/${part}`, {signal:AbortSignal.timeout(10_000)})))
      if (!r!.ok || !d!.ok) throw new Error('Comparison capture: scope catalog unavailable')
      const scope = resolveScope(capturedScope, workspaceResourceCatalogSchema.parse(await r!.json()).resources, workspaceDefinitionCatalogSchema.parse(await d!.json()).definitions)
      resourceKeys = [...scope.resourceKeys]; definitionKeys = [...scope.definitionKeys]
    }
    const { flushInfo: _deliveryOnly, ...context } = input.context
    const sourceRevision=await readProductRevision(resolve(import.meta.dir, '../../../..'))
    if(closed)throw new Error('Workspace comparisons are closed')
    pending.set(input.executionTurnId, structuredClone({...input, context, capturedAt,sourceRevision, boundary:{resourceKeys,definitionKeys,messageIds,turnIds}}))
  }
  const link = ({executionTurnId, roomId, messageId}: {executionTurnId:string;roomId:string;messageId:string}): void => {
    const source = pending.get(executionTurnId)
    if (!source || source.roomId !== roomId) return // Failed capture/routed copies are not replayable.
    pending.delete(executionTurnId)
    const record: RecordData = {source,messageId,alternatives:[]}
    const key=recordKey(roomId,messageId)
    records.set(key,record)
    starts.set(key,(starts.get(key)??0)+1)
    void (deps.runOperation ? deps.runOperation(() => persist(record)) : persist(record))
      .catch(error => console.error('[comparisons] Starting input could not be saved',error))
      .finally(() => {
        const count=starts.get(key)!-1
        if(count)starts.set(key,count);else starts.delete(key)
        release(key,record)
      })
  }
  const publicAlternative = ({query: _query,calls,toolTrace:_trace,nestedQueries:_nested,...alternative}:Comparison) => ({...alternative,toolCount:calls.length})
  const list = async (roomId:string,messageId:string) => {
    const record = await load(roomId,messageId)
    try { return {available:!!record, ...(!record?{reason:'Original starting input was not retained'}:{}), alternatives:record?.alternatives.map(publicAlternative) ?? []} }
    finally { if(record)release(recordKey(roomId,messageId),record) }
  }
  const find = async (roomId:string,messageId:string,id:string) => {
    const record = await load(roomId,messageId)
    const alternative = record?.alternatives.find(a=>a.id===id)
    if (!record || !alternative) throw new Error('Comparison not found')
    return {record,alternative}
  }
  const start = async (roomId:string,messageId:string,model:string) => {
    const key=recordKey(roomId,messageId)
    starts.set(key,(starts.get(key)??0)+1)
    try {
    if (!model.includes(':') || model.trim()!==model) throw new Error('Choose an explicit provider:model')
    const record = await load(roomId,messageId)
    if (!record) throw new Error('Original starting input was not retained')
    const source = record.source
    const room = deps.rooms.getRoom(roomId)!
    const assertSource = () => {
      if(closed)throw new Error('Workspace comparisons are closed')
      const currentRoom=deps.rooms.getRoom(roomId)
      if(!currentRoom?.getRetainedMessages().some(message=>message.id===messageId) || records.get(key)!==record) throw new Error('Comparison source was removed before execution could start')
      if(!currentRoom.hasMember(source.agentId)) throw new Error('Original Agent is no longer a Room member')
    }
    if (!room.hasMember(source.agentId)) throw new Error('Original Agent is no longer a Room member')
    // Comparisons must not verify a pending model change on the original Agent.
    const provider = deps.llm.bound({source:'comparison',fallbackChain:[]})
    const info = await provider.modelInfo?.(model)
    if (!info || info.contextMax <= 0) throw new Error('Model context capacity is unavailable')
    if (source.context.messages.some(m=>m.images?.length) && !modelSupportsImages(model)) throw new Error('Selected model cannot consume the captured images')
    if (source.context.messages.some(m=>m.continuation)) throw new Error('Starting input contains model-specific continuation; cross-model task replay is unavailable')
    const tools = source.toolDefinitions.filter(t=>supportedTools.has(t.function.name))
    const systemBlocks = [...(source.context.systemBlocks ?? source.context.messages.filter(m=>m.role==='system').map(m=>({text:m.content,cacheable:true}))),{text:guidance,cacheable:false}]
    const messages=source.context.messages.filter(m=>m.role!=='system')
    const tokenBudget=info.contextMax-OUTPUT_RESERVE-SAFETY_MARGIN-estimateTokens(JSON.stringify(tools))
    if (estimateTokens(JSON.stringify({messages,systemBlocks})) >= tokenBudget) throw new Error('Captured input exceeds selected model context allowance; it was not truncated')
    if(source.config.reasoningEffort && info.reasoning?.supportedEfforts && !info.reasoning.supportedEfforts.includes(source.config.reasoningEffort)) throw new Error('Selected model does not support the captured reasoning effort; settings were not silently changed')
    assertSource()
    const alternative:Comparison = {id:randomUUID(),model,status:'running',startedAt:Date.now(),calls:[],withheldTools:source.toolDefinitions.filter(t=>!supportedTools.has(t.function.name)).map(t=>t.function.name)}
    record.alternatives.push(alternative)
    try { await persist(record, alternative) }
    catch(error) { record.alternatives=record.alternatives.filter(a=>a!==alternative); throw error }
    assertSource()
    const controller = new AbortController()
    const work = async () => {
      try {
        const config = {...source.config,model}
        const nestedProvider:typeof provider = {...provider,
          chat:async request=>{
            (alternative.nestedQueries ??= []).push(structuredClone(request))
            controller.signal.throwIfAborted()
            return provider.chat(request)
          },
          ...(provider.stream?{stream:(request:GenerationQuery)=>{
            (alternative.nestedQueries ??= []).push(structuredClone(request))
            return provider.stream!(request,controller.signal)
          }}:{}),
        }
        const nestedSettings={model,...(config.seed===undefined?{}:{seed:config.seed}),...(config.thinking===undefined?{}:{think:config.thinking}),...(config.reasoningEffort===undefined?{}:{reasoningEffort:config.reasoningEffort})}
        const context:ToolContext = {callerId:source.agentId,callerName:config.name,roomId,focusedSubjects:source.focusedSubjects,comparison:source.boundary,
          llm:request=>callLLM(nestedProvider,{...request,...nestedSettings}),
          llmStream:request=>streamLLM(nestedProvider,{...request,...nestedSettings}),
        }
        const executor = createToolExecutor(deps.registry,tools.map(t=>t.function.name),context,id=>deps.rooms.getRoom(id),()=>source.focusedSubjects,undefined,undefined,deps.runOperation)
        const tracked:typeof executor = async (calls,trigger,signal,turn) => {
          if (!deps.rooms.getRoom(roomId)?.hasMember(source.agentId)) throw new Error('Comparison access changed: Agent removed from Room')
          const results:ToolResult[]=[]
          for (const call of calls) {
            signal?.throwIfAborted()
            const evidence:CallEvidence = {id:call.callId ?? randomUUID(),tool:call.tool,arguments:call.arguments,startedAt:Date.now()}
            alternative.calls.push(evidence)
            await persist(record, alternative)
            let result:ToolResult
            const ownRead=call.tool==='conversation_read' && call.arguments.turnId===alternative.id
            const parsedOwn=ownRead?conversationReadInputSchema.safeParse(call.arguments):undefined
            if(ownRead && (!tools.some(t=>t.function.name==='conversation_read') || !parsedOwn?.success || call.arguments.messageId || call.arguments.callIndex!==undefined)) {
              result={success:false,error:'Invalid or unavailable conversation_read request'}
            } else if(ownRead) {
              const own=alternative.calls.find(c=>c.id===call.arguments.toolCallId)
              result=call.arguments.toolCallId
                ? own ? {success:true,data:{evidenceKind:'execution',turnId:alternative.id,toolCallId:own.id,...(call.arguments.part==='result'?{result:own.result ?? {success:false,error:'Outcome not yet available'}}:{arguments:own.arguments})}} : {success:false,error:'Comparison call not found'}
                : {success:true,data:{evidenceKind:'execution',turn:{id:alternative.id,status:alternative.status},calls:alternative.calls.map(c=>({toolCallId:c.id,tool:c.tool,startedAt:c.startedAt,completedAt:c.completedAt}))}}
            } else {
              result=(await executor([call],trigger,signal,turn))[0]!
              if(call.tool==='conversation_read' && result.success && result.data && typeof result.data==='object') result={...result,data:{...result.data,ownExecutionTurnId:alternative.id}}
            }
            evidence.result=result;evidence.completedAt=Date.now()
            await persist(record, alternative)
            results.push(result)
          }
          return results
        }
        const result=await evaluate({...source.context,messages,systemBlocks,tokenBudget,flushInfo:{ids:new Set(),triggerRoomId:roomId}},config,provider,tracked,undefined,roomId,{executionTurnId:alternative.id,toolDefinitions:tools,signal:controller.signal,...(source.requireView?{requireView:true}:{})})
        const response=result.decision.response
        if(response.action==='respond') alternative.content=response.content
        else if(response.action==='error') alternative.error=response.message
        else alternative.content=response.reason ?? 'The model chose not to respond.'
        alternative.status=controller.signal.aborted?'interrupted':response.action==='error'?'failed':'completed'
        alternative.metrics=result.decision.metrics
        alternative.query=result.decision.generationQuery
        alternative.toolTrace=result.decision.toolTrace
      } catch(error) {alternative.status=controller.signal.aborted?'interrupted':'failed';alternative.error=error instanceof Error?error.message:String(error)}
      finally {
        alternative.finishedAt=Date.now()
        try { await persist(record, alternative) }
        finally { jobs.delete(alternative.id); release(key,record) }
      }
    }
    const done = Promise.resolve().then(()=>deps.runOperation?deps.runOperation(work):work()).catch(error=>console.error('[comparisons] Job failed',error))
    jobs.set(alternative.id,{controller,done})
    return publicAlternative(alternative)
    } finally {
      const count=starts.get(key)!-1
      if(count)starts.set(key,count);else starts.delete(key)
      const record=records.get(key);if(record)release(key,record)
    }
  }
  const cancel = async (roomId:string,messageId:string,id:string) => {const {record}=await find(roomId,messageId,id);try {jobs.get(id)?.controller.abort(new Error('Comparison cancelled'));return {cancelled:true}}finally{release(recordKey(roomId,messageId),record)}}
  const remove = async (roomId:string,messageId:string,id:string) => {
    const {record}=await find(roomId,messageId,id)
    const job=jobs.get(id);job?.controller.abort(new Error('Comparison deleted'));await job?.done
    record.alternatives=record.alternatives.filter(a=>a.id!==id)
    try { if(storage) { const task=writes.then(()=>storage.removeAlternative(roomId,messageId,id));writes=task.catch(error=>console.error('[comparisons] Removal failed',error));await task };return {deleted:true} }
    finally {release(recordKey(roomId,messageId),record)}
  }
  const removeMessages = (roomId:string,messageId?:string) => {
    for (const [key,record] of records) if(record.source.roomId===roomId && (!messageId||record.messageId===messageId)) {
      for(const alternative of record.alternatives) jobs.get(alternative.id)?.controller.abort(new Error('Source message removed'))
      records.delete(key)
    }
    for(const [key,source]of pending)if(source.roomId===roomId)pending.delete(key)
    if(storage) writes=writes.then(()=>storage.remove(roomId,messageId)).catch(error=>console.error('[comparisons] Removal failed',error))
  }
  return {capture,link,list,start,cancel,remove,removeMessages,discard:(executionTurnId:string)=>{pending.delete(executionTurnId)},
    detail:async(roomId:string,messageId:string,id:string)=>{const {record,alternative}=await find(roomId,messageId,id);try{return {...alternative,startingInput:record.source,notice:guidance}}finally{release(recordKey(roomId,messageId),record)}},
    close:async()=>{closed=true;for(const job of jobs.values())job.controller.abort(new Error('Workspace closed'));await Promise.all([...jobs.values()].map(j=>j.done));await writes;pending.clear();records.clear()},
  }
}
export type Comparisons=ReturnType<typeof createComparisons>
