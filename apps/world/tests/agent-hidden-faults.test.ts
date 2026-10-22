import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// D-88 and D13 ("hide the script"), for the AI actor only: an injected fault's command and its result are withheld
// from journal reads (changes, wait), counted without content; a Scenario's timeline is withheld from the Run's
// inspection, refused with the Run's pinned source, and left out of a definition's source and inspection, and an
// update from an AI keeps it as people wrote it. People, the instructor among them, keep every view.

let workspaces: WorldWorkspaceRuntimeRegistry
let dataDir: string
const workspaceId = newWorkspaceId() as WorkspaceId
let run: SimulationRunId
const fault = 'steam-generator-tube-leak-a'

type Call = { readonly status: number; readonly body: any }
const invoke = async (capabilityId: string, config: { readonly actor: 'human' | 'ai'; readonly input?: unknown; readonly definition?: { readonly id: string; readonly revisionId: string } }): Promise<Call> => {
  const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${encodeURIComponent(capabilityId)}/invoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId, capabilityId, input: config.input ?? {},
      ...(config.definition === undefined ? { resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run } }
        : { definition: { workspaceId, moduleId: 'world', type: 'world.scenario', ...config.definition } }),
      access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: config.actor === 'ai' ? { kind: 'ai', id: 'fault-test-agent' } : { kind: 'human', id: 'instructor' } }),
    }),
  })
  const response = (await handleWorldModuleApi(request, new URL(request.url), workspaces))!
  return { status: response.status, body: await response.json() }
}
const definition = async () => {
  const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/definitions`)
  const listed = await (await handleWorldModuleApi(request, new URL(request.url), workspaces))!.json() as { definitions: Array<{ ref: { id: string }; currentRevisionId: string }> }
  return { id: 'test-plant', revisionId: listed.definitions.find(entry => entry.ref.id === 'test-plant')!.currentRevisionId }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'world-hidden-faults-'))
  workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }), idleRuntimeCloseDelayMs: 600_000,
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters() })
  await workspaces.provision(workspaceId)
  // A person scripts the same fault an hour in, so the Run's timeline holds a scripted fault.
  const target = await definition()
  const source = (await invoke('world.scenario.read', { actor: 'human', definition: target })).body.result.source
  const scripted = await invoke('world.scenario.update', { actor: 'human', definition: target, input: { source: { ...source, timeline: { cues: [{
    id: 'scripted-leak', at: { kind: 'after_scenario_start', seconds: 3_600 },
    actions: [{ type: 'invoke_capability', capabilityId: 'world.process-plant.action.invoke', input: { plantId: 'plant:halden-a1', actionId: fault, parameters: { leakPercent: 1 } } }],
  }] } } } })
  expect(scripted.status).toBe(200)
  run = await workspaces.withRuntime(workspaceId, async runtime => (await runtime.simulationRuns.create({ scenarioId: 'test-plant' })).id)
  // The instructor injects a tube leak and trips the turbine; only the leak is a fault the model marks.
  expect((await invoke('world.process-plant.action.invoke', { actor: 'human', input: { plantId: 'plant:halden-a1', actionId: fault, parameters: { leakPercent: 1 } } })).status).toBe(200)
  expect((await invoke('world.process-plant.action.invoke', { actor: 'human', input: { plantId: 'plant:halden-a1', actionId: 'turbine-trip', parameters: {} } })).status).toBe(200)
})
afterAll(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

const actions = (events: ReadonlyArray<any>) => events.filter(event => event.type === 'command.issued' && event.command.kind === 'world.process-plant.action.invoke').map(event => event.command.payload.actionId)

describe('an injected fault is withheld from an AI caller\'s journal reads (D-88)', () => {
  test('changes: the fault\'s command and result are left out and counted; other instructor events stay; a person reads all', async () => {
    const ai = await invoke('world.simulation-run.changes', { actor: 'ai', input: { afterSequence: 0, limit: 500 } })
    expect(ai.status).toBe(200)
    expect(actions(ai.body.result.events)).toEqual(['turbine-trip'])
    expect(ai.body.result.withheld).toBe(2)
    expect(JSON.stringify(ai.body)).not.toContain(fault)
    const person = await invoke('world.simulation-run.changes', { actor: 'human', input: { afterSequence: 0, limit: 500 } })
    expect(actions(person.body.result.events)).toEqual([fault, 'turbine-trip'])
    expect(person.body.result.withheld).toBeUndefined()
  })

  test('wait: a command the AI waits for is never the fault\'s', async () => {
    const ai = await invoke('world.simulation-run.wait', { actor: 'ai', input: { afterSequence: 0, maxWaitMs: 1_000, events: [{ type: 'command.issued' }] } })
    expect(ai.status).toBe(200)
    expect(actions(ai.body.result.events)).toEqual(['turbine-trip'])
    expect(JSON.stringify(ai.body)).not.toContain(fault)
    const person = await invoke('world.simulation-run.wait', { actor: 'human', input: { afterSequence: 0, maxWaitMs: 1_000, events: [{ type: 'command.issued' }] } })
    expect(actions(person.body.result.events)).toContain(fault)
  })
})

describe('a Scenario\'s script is hidden from AI callers (D13)', () => {
  test('the Run\'s inspection has no timeline section for an AI caller; a person\'s has it', async () => {
    const sections = (call: Call) => call.body.result.sections.map((section: { id: string }) => section.id)
    const ai = await invoke('world.simulation-run.inspect', { actor: 'ai' })
    expect(sections(ai)).not.toContain('timeline')
    expect(JSON.stringify(ai.body)).not.toContain(fault)
    expect(sections(await invoke('world.simulation-run.inspect', { actor: 'human' }))).toContain('timeline')
  })

  test('the Run\'s pinned source is refused to an AI caller; a person reads it with its timeline', async () => {
    const ai = await invoke('world.simulation-run.scenario-source', { actor: 'ai' })
    expect([ai.status, ai.body.error.code]).toEqual([403, 'scenario_script_hidden'])
    const person = await invoke('world.simulation-run.scenario-source', { actor: 'human' })
    expect(person.status).toBe(200)
    expect(person.body.result.source.timeline.cues.map((cue: { id: string }) => cue.id)).toEqual(['scripted-leak'])
  })

  test('a definition\'s source and inspection come without the timeline for an AI caller; a person\'s with it', async () => {
    const target = await definition()
    const read = await invoke('world.scenario.read', { actor: 'ai', definition: target })
    expect(read.status).toBe(200)
    expect(read.body.result.source.title).toBe('Plant persistence fixture')
    expect(read.body.result.source.timeline).toBeUndefined()
    expect(JSON.stringify(read.body)).not.toContain(fault)
    expect((await invoke('world.scenario.read', { actor: 'human', definition: target })).body.result.source.timeline.cues.map((cue: { id: string }) => cue.id)).toEqual(['scripted-leak'])
    const inspected = await invoke('world.scenario.inspect', { actor: 'ai', definition: target })
    expect(inspected.body.result.sections.map((section: { id: string }) => section.id)).not.toContain('timeline')
    expect(inspected.body.result.sections.find((section: { id: string }) => section.id === 'authored-definition').data.timeline).toBeUndefined()
    expect(JSON.stringify(inspected.body)).not.toContain(fault)
    expect((await invoke('world.scenario.inspect', { actor: 'human', definition: target })).body.result.sections.map((section: { id: string }) => section.id)).toContain('timeline')
  })

  test('an AI caller\'s update keeps the timeline people wrote, and may not replace it', async () => {
    const target = await definition()
    const before = (await invoke('world.scenario.read', { actor: 'human', definition: target })).body.result.source
    const seen = (await invoke('world.scenario.read', { actor: 'ai', definition: target })).body.result.source
    const updated = await invoke('world.scenario.update', { actor: 'ai', definition: target, input: { source: { ...seen, title: 'Plant persistence fixture, revised' } } })
    expect(updated.status).toBe(200)
    const after = (await invoke('world.scenario.read', { actor: 'human', definition: await definition() })).body.result.source
    expect([after.title, after.timeline]).toEqual(['Plant persistence fixture, revised', before.timeline])
    const replacing = await invoke('world.scenario.update', { actor: 'ai', definition: await definition(), input: { source: { ...seen, timeline: { cues: [] } } } })
    expect([replacing.status, replacing.body.error.code]).toEqual([403, 'scenario_script_hidden'])
  })
})
