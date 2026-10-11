import { expect, test } from 'bun:test'
import { createRoom } from '../../core/rooms/room.ts'
import type { RoomDirectory } from '../../core/rooms/directory.ts'
import { createConversationReadTool } from './conversation-read.ts'
import { formatMessage } from '../../agents/context-builder.ts'
import { createExecutionStore } from '../../core/executions/store.ts'

test('exact prior arguments survive prose summaries and room restore, without cross-room access', async () => {
  const room=createRoom({id:'room',name:'Room',createdBy:'human',createdAt:1,scope:{kind:'workspace'},scopeRevision:0})
  room.addMember('agent')
  const message=room.post({senderId:'agent',type:'chat',content:'Draft is valid.',toolTrace:[{tool:'workspace_call',success:true,argumentKeys:[],argumentBytes:0,resultPreview:'valid'}]})
  const source={id:'draft',timing:120,unchanged:{mobilizationSeconds:60,visibilityM:2500}}
  room.injectGenerationQueries([{messageId:message.id,traceId:'trace',query:{model:'test',messages:[
    {role:'assistant',content:'',toolCalls:[{id:'call',function:{name:'workspace_call',arguments:{calls:[{operationId:'world.scenario.preview',input:{source}}]}}}]},
    {role:'tool',toolCallId:'call',name:'workspace_call',content:'{"valid":true}'},
  ]}}])
  const tool=createConversationReadTool({getRoom:(id:string)=>id==='room'?room:undefined} as RoomDirectory)
  const context={callerId:'agent',callerName:'Agent',roomId:'room'}
  expect(formatMessage(message,'','agent',()=> 'Agent')!.content).toContain(message.id)
  expect(await tool.execute({messageId:message.id},context)).toMatchObject({success:true,data:{modelRequest:{calls:[{providerCallId:'call',read:{messageId:message.id,callIndex:0}}]}}})
  expect(await tool.execute({messageId:message.id,toolCallId:'call'},context)).toMatchObject({
    success:true,data:{arguments:{calls:[{input:{source}}]}},
  })
  expect(await tool.execute({messageId:message.id,toolCallId:'call',part:'result'},context))
    .toMatchObject({success:true,data:{result:'{"valid":true}'}})
  expect(await tool.execute({messageId:message.id},{...context,callerId:'stranger'})).toMatchObject({success:false})
  expect(await tool.execute({messageId:message.id},{...context,roomId:'other'})).toMatchObject({success:false})
  room.replaceCompression([message.id], 'A draft was validated.')
  expect(await tool.execute({messageId:message.id,toolCallId:'call'},context)).toMatchObject({
    success:true,data:{arguments:{calls:[{input:{source}}]}},
  })
})

test('comparison history excludes the original answer, later conversation and sibling executions', async () => {
  const room = createRoom({ id: 'room', name: 'Room', createdBy: 'human', createdAt: 1, scope: { kind: 'workspace' }, scopeRevision: 0 })
  room.addMember('agent')
  const prior = room.post({ senderId: 'human', type: 'chat', content: 'Earlier question' })
  const original = room.post({ senderId: 'agent', type: 'chat', content: 'Original model answer with privileged evidence' })
  const later = room.post({ senderId: 'human', type: 'chat', content: 'Later follow-up' })
  const store = createExecutionStore(':memory:')
  try {
    for (const id of ['prior', 'original', 'later', 'sibling', 'own']) {
      // Identical timestamps intentionally rule out timestamp-only isolation.
      store.beginTurn({ id, roomId: 'room', agentId: 'agent', startedAt: 10 })
      store.recordAttempt(id, { id: 'call', tool: 'read_state', arguments: { selectedBy: id }, startedAt: 10 })
      store.recordOutcome(id, 'call', { success: true, data: { evidenceFor: id } })
      if (id !== 'own') store.finishTurn(id, 'completed')
    }
    const tool = createConversationReadTool({ getRoom: (id: string) => id === 'room' ? room : undefined } as RoomDirectory, store)
    const context = {
      callerId: 'agent', callerName: 'Agent', roomId: 'room',
      comparison: { resourceKeys: [], definitionKeys: [], messageIds: [prior.id], turnIds: ['prior', 'own'] },
    }
    const list = await tool.execute({}, context)
    expect(list).toMatchObject({ success: true, data: { total: 1, messages: [{ messageId: prior.id }] } })
    const payload = list.data as { executionTurns: Array<{ id: string }> }
    expect(payload.executionTurns.map(turn => turn.id).sort()).toEqual(['own', 'prior'])
    expect(JSON.stringify(list)).not.toContain('privileged evidence')
    expect(JSON.stringify(list)).not.toContain('Later follow-up')
    for (const messageId of [original.id, later.id]) {
      expect(await tool.execute({ messageId }, context)).toMatchObject({ success: false, error: 'comparison_evidence_out_of_scope: only evidence available before this task may be retrieved' })
    }
    for (const turnId of ['original', 'later', 'sibling']) {
      expect(await tool.execute({ turnId, toolCallId: 'call', part: 'result' }, context)).toMatchObject({ success: false })
    }
    expect(await tool.execute({ turnId: 'own', toolCallId: 'call', part: 'result' }, context))
      .toMatchObject({ success: true, data: { result: { data: { evidenceFor: 'own' } } } })
    expect(await tool.execute({ turnId: 'prior', toolCallId: 'call', part: 'arguments' }, context))
      .toMatchObject({ success: true, data: { arguments: { selectedBy: 'prior' } } })
    expect(await tool.execute({ messageId: prior.id }, { ...context, callerId: 'stranger' })).toMatchObject({ success: false })
  } finally {
    store.close()
  }
})

test('message discovery gives distinct round-trip selectors for request evidence and actual executions', async () => {
  const room = createRoom({ id: 'room', name: 'Room', createdBy: 'human', createdAt: 1, scope: { kind: 'workspace' }, scopeRevision: 0 })
  room.addMember('agent')
  const message = room.post({ senderId: 'agent', type: 'chat', content: 'Read the retained evidence.', generationTraceId: 'turn' })
  room.injectGenerationQueries([{ messageId: message.id, traceId: 'turn', query: { model: 'test', messages: [
    { role: 'assistant', content: '', toolCalls: [{ id: 'provider-reused', function: { name: 'read_state', arguments: { revision: 1 } } }] },
    { role: 'tool', name: 'read_state', toolCallId: 'provider-reused', content: '{"requestValue":1}' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'provider-reused', function: { name: 'read_state', arguments: { revision: 2 } } }] },
    { role: 'tool', name: 'read_state', toolCallId: 'provider-reused', content: '{"requestValue":2}' },
  ] } }])
  const store = createExecutionStore(':memory:')
  try {
    store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 10 })
    for (const revision of [1, 2]) {
      store.recordAttempt('turn', { id: `call_${revision}_0`, providerCallId: 'provider-reused', tool: 'read_state', arguments: { revision }, startedAt: 10 + revision })
      store.recordOutcome('turn', `call_${revision}_0`, { success: true, data: { actualValue: revision } })
    }
    store.finishTurn('turn', 'completed')
    const tool = createConversationReadTool({ getRoom: (id: string) => id === 'room' ? room : undefined } as RoomDirectory, store)
    const context = { callerId: 'agent', callerName: 'Agent', roomId: 'room' }
    const listed = await tool.execute({ messageId: message.id }, context)
    const data = listed.data as { modelRequest: { calls: Array<{ read: { messageId: string; callIndex: number } }> }; execution: { turnId: string } }
    expect(data).not.toHaveProperty('calls')
    expect(data).not.toHaveProperty('executionTurnId')
    expect(data.execution).toEqual({ turnId: 'turn' })
    for (const [index, call] of data.modelRequest.calls.entries()) {
      expect(await tool.execute(call.read, context)).toMatchObject({ success: true, data: { evidenceKind: 'model_request', arguments: { revision: index + 1 } } })
      expect(await tool.execute({ ...call.read, part: 'result' }, context)).toMatchObject({ success: true, data: { result: JSON.stringify({ requestValue: index + 1 }) } })
    }
    const actual = await tool.execute(data.execution, context)
    const actualCalls = (actual.data as { calls: Array<{ read: { turnId: string; toolCallId: string } }> }).calls
    for (const [index, call] of actualCalls.entries()) {
      expect(await tool.execute(call.read, context)).toMatchObject({ success: true, data: { evidenceKind: 'execution', arguments: { revision: index + 1 } } })
      expect(await tool.execute({ ...call.read, part: 'result' }, context)).toMatchObject({ success: true, data: { result: { success: true, data: { actualValue: index + 1 } } } })
    }
    // Provider IDs may repeat and must not silently alias an actual execution.
    expect(await tool.execute({ turnId: 'turn', toolCallId: 'provider-reused' }, context)).toMatchObject({ success: false })
    expect(await tool.execute({ messageId: message.id, toolCallId: 'provider-reused' }, context)).toMatchObject({ success: false, error: expect.stringContaining('ambiguous') })
    const comparison = { ...context, comparison: { resourceKeys: [], definitionKeys: [], messageIds: [message.id], turnIds: [] } }
    const restricted = await tool.execute({ messageId: message.id }, comparison)
    expect(restricted.data).not.toHaveProperty('execution')
    expect(restricted.data).toMatchObject({ modelRequest: { calls: [] } })
    const list = await tool.execute({}, comparison)
    expect((list.data as { messages: unknown[] }).messages[0]).not.toHaveProperty('execution')
    store.deleteRoom('room')
    expect((await tool.execute({ messageId: message.id }, context)).data).not.toHaveProperty('execution')
  } finally { store.close() }
})
