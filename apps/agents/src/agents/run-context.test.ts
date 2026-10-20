import { describe, expect, test } from 'bun:test'
import { capabilityIdSchema, newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createExecutionStore } from '../core/executions/store.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import { createAIAgent } from './ai-agent.ts'
import { createRunContextFetcher, RUN_CONTEXT_TOOL } from './run-context.ts'

// The Run context pre-fetch (plan v3.1 §2.4, architecture A4): exactly one context publisher in scope, else exactly one
// focused, else a note; a refusal or a 3 s timeout is a note; the read is the turn's run_context execution call.

const workspaceId = newWorkspaceId()
const ref = (id: string) => workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id })
const operationId = capabilityIdSchema.parse('world.simulation-run.context')
const at = '2026-01-01T08:00:00.000Z'
const caller = { id: 'agent-1', name: 'Assistant' }
const sources = (runs: ReadonlyArray<string>, read?: (resourceId: string) => Promise<unknown>) => ({
  publishers: async () => runs.map(id => ({ operationId, resource: ref(id) })),
  read: async (publisher: { resource: { id: string } }) => (read
    ? await read(publisher.resource.id)
    : { ok: true, context: { text: `Context of ${publisher.resource.id}`, at, clock: 'simulation' } }) as never,
})
const fetchWith = (runs: ReadonlyArray<string>, focused: ReadonlyArray<string> = [], read?: (resourceId: string) => Promise<unknown>, timeoutMs?: number) =>
  createRunContextFetcher(sources(runs, read), timeoutMs)('room', focused.map(ref), caller, new AbortController().signal)

describe('Run context pre-fetch', () => {
  test('reads the one Run in scope, recording the read as the turn\'s call', async () => {
    const fetched = await fetchWith(['run-a'])
    expect(fetched?.text).toBe(`Run run-a as of ${at} (simulation time):\nContext of run-a`)
    expect(fetched?.call).toMatchObject({ arguments: { operationId, resource: ref('run-a') }, result: { success: true, data: { context: { text: 'Context of run-a' } } } })
  })

  test('with several Runs it reads the one focused subject, and otherwise says why it read none', async () => {
    expect((await fetchWith(['run-a', 'run-b'], ['run-b']))?.text).toContain('Context of run-b')
    expect((await fetchWith(['run-a', 'run-b']))?.text).toBe('Run context not loaded: 2 Runs in scope, none focused')
    expect((await fetchWith(['run-a', 'run-b'], ['run-a', 'run-b']))?.text).toBe('Run context not loaded: 2 Runs in scope, 2 focused')
    expect(await fetchWith([])).toBeUndefined()
  })

  test('a refusal and a timeout become notes, kept with the call', async () => {
    const refused = await fetchWith(['run-a'], [], async () => ({ ok: false, refusal: { success: false, error: 'ai_role_run_unsupported: AI is not supported in Runs that declare roles' } }))
    expect(refused?.text).toBe('Run context not loaded: ai_role_run_unsupported: AI is not supported in Runs that declare roles')
    expect(refused?.call.result).toEqual({ success: false, error: 'ai_role_run_unsupported: AI is not supported in Runs that declare roles' })
    const slow = await fetchWith(['run-a'], [], async () => await new Promise(() => {}), 30)
    expect(slow?.text).toBe('Run context not loaded: World did not answer within 0.03 s')
  })

  test('a cancelled turn stops the read instead of noting it', async () => {
    const controller = new AbortController()
    const pending = createRunContextFetcher(sources(['run-a'], async () => await new Promise(() => {})))('room', [], caller, controller.signal)
    controller.abort(new Error('cancelled'))
    expect(pending).rejects.toThrow()
  })

  test('the turn shows the context as its last context section and records the read before any tool call', async () => {
    const store = createExecutionStore(':memory:')
    const systems: string[] = []
    const provider: LLMProvider = { models: async () => ['fixture'], chat: async request => {
      systems.push([...(request.systemBlocks ?? []).map(block => block.text), ...request.messages.filter(message => message.role === 'system').map(message => message.content)].join('\n'))
      return { content: 'Done', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
    } }
    const finished = Promise.withResolvers<void>()
    const fetchRunContext = createRunContextFetcher(sources(['run-a']))
    const agent = createAIAgent({ name: 'Assistant', model: 'fixture', persona: 'Test', historyLimit: 10 }, provider, () => {}, {
      executionStore: store, fetchRunContext, onTurnFinished: () => finished.resolve(),
    })
    agent.receive({ id: crypto.randomUUID(), roomId: 'room', senderId: 'human', content: 'How is the Run?', timestamp: Date.now(), type: 'chat' })
    await finished.promise
    const system = systems[0]!
    expect(system).toContain('Context of run-a')
    expect(system.indexOf('Context of run-a')).toBeGreaterThan(system.indexOf('You are'))
    expect(system.slice(system.indexOf('Context of run-a')).indexOf('</leitbild:context>')).toBeGreaterThan(-1)
    const [turn] = store.listTurns('room')
    const calls = store.listCalls('room', turn!.id)
    expect(calls.map(call => call.tool)).toEqual([RUN_CONTEXT_TOOL])
    expect(store.getCall('room', turn!.id, calls[0]!.id)).toMatchObject({ arguments: { operationId, resource: ref('run-a') }, result: { success: true } })
    store.close()
  })
})
