import { describe, expect, test } from 'bun:test'
import { capabilityIdSchema, newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createExecutionStore } from '../core/executions/store.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import { createAIAgent } from './ai-agent.ts'
import { createRunContextFetcher } from './run-context.ts'

// The Run context pre-fetch (plan v3.1 §2.4, architecture A4): exactly one context publisher in scope, else exactly one
// focused, else a note; a refusal or a 3 s timeout is a note. The turn's model reads it; nothing stores it (R44).

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
  test('reads the one Run in scope', async () => {
    expect(await fetchWith(['run-a'])).toBe(`Run run-a as of ${at} (simulation time):\nContext of run-a`)
  })

  test('with several Runs it reads the one focused subject, and otherwise says why it read none', async () => {
    expect(await fetchWith(['run-a', 'run-b'], ['run-b'])).toContain('Context of run-b')
    expect(await fetchWith(['run-a', 'run-b'])).toBe('Run context not loaded: 2 Runs in scope, none focused')
    expect(await fetchWith(['run-a', 'run-b'], ['run-a', 'run-b'])).toBe('Run context not loaded: 2 Runs in scope, 2 focused')
    expect(await fetchWith([])).toBeUndefined()
  })

  test('a refusal and a timeout become notes', async () => {
    const refused = await fetchWith(['run-a'], [], async () => ({ ok: false, refusal: { success: false, error: 'ai_role_run_unsupported: AI is not supported in Runs that declare roles' } }))
    expect(refused).toBe('Run context not loaded: ai_role_run_unsupported: AI is not supported in Runs that declare roles')
    const slow = await fetchWith(['run-a'], [], async () => await new Promise(() => {}), 30)
    expect(slow).toBe('Run context not loaded: World did not answer within 0.03 s')
  })

  test('a cancelled turn stops the read instead of noting it', async () => {
    const controller = new AbortController()
    const pending = createRunContextFetcher(sources(['run-a'], async () => await new Promise(() => {})))('room', [], caller, controller.signal)
    controller.abort(new Error('cancelled'))
    expect(pending).rejects.toThrow()
  })

  test('the turn shows the context as its last context section; no execution row and no comparison record keeps it', async () => {
    const store = createExecutionStore(':memory:')
    const systems: string[] = []
    const captured: string[] = []
    const provider: LLMProvider = { models: async () => ['fixture'], chat: async request => {
      systems.push([...(request.systemBlocks ?? []).map(block => block.text), ...request.messages.filter(message => message.role === 'system').map(message => message.content)].join('\n'))
      return { content: 'Done', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
    } }
    const finished = Promise.withResolvers<void>()
    const fetchRunContext = createRunContextFetcher(sources(['run-a']))
    const agent = createAIAgent({ name: 'Assistant', model: 'fixture', persona: 'Test', historyLimit: 10 }, provider, () => {}, {
      executionStore: store, fetchRunContext, onTurnFinished: () => finished.resolve(),
      onTurnStart: async input => { captured.push(JSON.stringify(input.context)) },
    })
    agent.receive({ id: crypto.randomUUID(), roomId: 'room', senderId: 'human', content: 'How is the Run?', timestamp: Date.now(), type: 'chat' })
    await finished.promise
    const system = systems[0]!
    expect(system).toContain('Context of run-a')
    expect(system.slice(system.indexOf('Context of run-a')).indexOf('</leitbild:context>')).toBeGreaterThan(-1)
    const [turn] = store.listTurns('room')
    expect(store.listCalls('room', turn!.id)).toEqual([])
    expect(captured).toHaveLength(1)
    expect(captured[0]).not.toContain('Context of run-a')
    store.close()
  })
})
