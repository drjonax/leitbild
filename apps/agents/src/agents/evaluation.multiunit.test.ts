// The answer checks with a display host that composes views of a set of units: World's fleet, compare and set-trend
// results, as the display Capability returned them for twelve units with one tripped. The fence guard, the required
// view and the citation check read them exactly as they read a single unit's vignette.

import { describe, expect, test } from 'bun:test'
import { displayCardSchema } from '@leitbild/contracts'
import { evaluate } from './evaluation.ts'
import type { ContextResult } from './context-builder.ts'
import type { ChatRequest, ChatResponse, LLMProvider } from '../core/types/llm.ts'
import type { AIAgentConfig } from '../core/types/agent.ts'
import composed from './__fixtures__/multiunit-compose-results.json'

type Composed = { readonly view: { readonly viewType: string; readonly title: string; readonly height: number; readonly state: string }; readonly card: { readonly items: ReadonlyArray<{ readonly key: string; readonly label: string; readonly reading: string; readonly subject?: unknown }> } }
const results = composed as unknown as Record<'fleet' | 'compare' | 'trend', Composed>
const subject = { workspaceId: 'ws', moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
const OPERATION = 'world.simulation-run.display.compose'

const context = (): ContextResult => ({
  messages: [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: 'How are the units doing?' }],
  flushInfo: { ids: new Set(), triggerRoomId: 'room-1' },
  warnings: [],
})
const config: AIAgentConfig = { name: 'TestAgent', model: 'stub-model', persona: 'test' }
const composeCall = { content: '', toolCalls: [{ id: 'w1', function: { name: 'workspace_call', arguments: { calls: [] } } }] }
const fenced = (text: string, ref = 'call_0_0/compose'): string => `${text}\n\n\`\`\`leitbild-view\nview ${ref}\n\`\`\``
const options = { toolDefinitions: [{ type: 'function' as const, function: { name: 'workspace_call', description: 'call', parameters: {} } }] }

// A display host: each compose returns the fixture's result for `kind`, under the call that asked for it.
const host = (kind: keyof typeof results) => async (calls: ReadonlyArray<{ callId?: string }>) => [{
  success: true,
  data: { results: [{
    key: 'compose', operationId: OPERATION, success: true, data: results[kind],
    embeddedView: { ...results[kind].view, moduleId: 'world', subject }, viewRef: `${calls[0]!.callId}/compose`,
  }] },
}]
const scripted = (answers: ReadonlyArray<{ content: string; toolCalls?: ChatResponse['toolCalls'] }>) => {
  let index = 0
  const calls: ChatRequest[] = []
  const provider: LLMProvider = { models: async () => [], chat: async request => { calls.push(structuredClone(request)); return { generationMs: 1, tokensUsed: { prompt: 1, completion: 1 }, ...answers[index++]! } } }
  return { provider, calls }
}
const item = (kind: keyof typeof results, label: string) => results[kind].card.items.find(entry => entry.label === label)!
const firstNumber = (reading: string): string => reading.match(/\d+(?:\.\d+)?/)![0]

describe('answer checks on views of a set of units', () => {
  test('each set card holds to the card contract; its aggregate lines name no single subject', () => {
    for (const kind of ['fleet', 'compare', 'trend'] as const) {
      const card = displayCardSchema.parse(results[kind].card)
      expect(JSON.parse(results[kind].view.state).views[0].of).toMatchObject({ group: 'halden-power-complex' })
      expect(card.items[0]!.subject).toBeUndefined()
      expect(card.items.filter(entry => entry.subject !== undefined).length).toBeGreaterThan(0)
    }
  })

  test('a fleet answer presenting its view and citing the tripped unit as its line reads is posted as it is', async () => {
    const tripped = item('fleet', 'Halden Unit 3')
    expect(tripped.reading).toStartWith('alarm · ')
    const thermal = tripped.reading.match(/Thermal power (\d+) MW/)![1]!
    const answer = fenced(`12 units ⟦k1⟧; Halden Unit 3 tripped, thermal power ${thermal} MW ⟦k2⟧.`)
    const { provider, calls } = scripted([composeCall, { content: answer }])
    const result = await evaluate(context(), config, provider, host('fleet'), 5, 'room-1', options)
    expect(calls).toHaveLength(2)
    // The model reads the set by reference and its card as lines, never the members' refs in the view state.
    const evidence = calls[1]!.messages.find(message => message.role === 'tool')!.content
    expect(evidence).not.toContain('halden-power-complex","closed"')
    expect(evidence).toContain(`k2 · Halden Unit 3 · ${tripped.reading}`)
    expect(result.decision.response).toEqual({ action: 'respond', content: answer })
  })

  test('a compared unit\'s number its line contradicts is corrected once, naming what the line reads', async () => {
    const line = item('compare', 'Halden Unit 3')
    const wrong = fenced('Halden Unit 3 reads 42.0 % ⟦k2⟧.')
    const right = fenced(`Halden Unit 3 reads ${firstNumber(line.reading)} % ⟦k2⟧.`)
    const { provider, calls } = scripted([composeCall, { content: wrong }, { content: right }])
    const result = await evaluate(context(), config, provider, host('compare'), 5, 'room-1', options)
    expect(calls).toHaveLength(3)
    expect(calls[2]!.messages.at(-1)!.content).toContain(`42.0 is cited with ⟦k2⟧, but k2 reads "${line.reading}" (Halden Unit 3).`)
    expect(result.decision.response).toEqual({ action: 'respond', content: right })
  })

  test('a band line supports the spread it reads', async () => {
    const band = item('trend', 'Reactor power · 12 units')
    const [, min, median] = band.reading.match(/^min (\S+) .* median (\S+) /)!
    const answer = fenced(`Reactor power spans from ${min} % ⟦k1⟧ on Halden Unit 3 to a median of ${median} % ⟦k1⟧.`)
    const { provider, calls } = scripted([composeCall, { content: answer }])
    const result = await evaluate(context(), config, provider, host('trend'), 5, 'room-1', options)
    expect(calls).toHaveLength(2)
    expect(result.decision.response).toEqual({ action: 'respond', content: answer })
  })

  test('the fence guard refuses a set view this turn did not compose, and asks for the one it composed', async () => {
    const stale = scripted([{ content: fenced('The fleet holds.') }, { content: 'The fleet holds.' }])
    await evaluate(context(), config, stale.provider, host('fleet'), 5, 'room-1', options)
    expect(stale.calls[1]!.messages.at(-1)!.content).toContain('call_0_0/compose is not a display composed in this turn')
    const unshown = scripted([composeCall, { content: 'Unit 3 tripped; the table below ranks the rest.' }, { content: fenced('Unit 3 tripped.') }])
    const result = await evaluate(context(), config, unshown.provider, host('fleet'), 5, 'room-1', options)
    expect(unshown.calls[2]!.messages.at(-1)!.content).toContain('This turn composed a display (viewRef call_0_0/compose) but the response does not present it.')
    expect(result.decision.response).toEqual({ action: 'respond', content: fenced('Unit 3 tripped.') })
  })

  test('a display request is met by a fleet view like any other', async () => {
    const { provider, calls } = scripted([{ content: 'Unit 3 tripped; the others hold power.' }, composeCall, { content: fenced('Unit 3 tripped.', 'call_1_0/compose') }])
    const result = await evaluate(context(), config, provider, host('fleet'), 5, 'room-1', { ...options, requireView: true })
    expect(calls).toHaveLength(3)
    expect(calls[1]!.messages.at(-1)!.content).toContain('The reader asked for a live display, and this response presents none.')
    expect(result.decision.response).toEqual({ action: 'respond', content: fenced('Unit 3 tripped.', 'call_1_0/compose') })
  })
})
