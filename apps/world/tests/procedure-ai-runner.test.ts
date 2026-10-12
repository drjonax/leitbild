import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, moduleCapabilityCollectionSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { createKnowledge } from '@leitbild/knowledge'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { actorIdSchema, objectIdSchema } from '../src/core/model/ids.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createProcedureSourceService } from '../src/features/procedures/source.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

const registries: WorldWorkspaceRuntimeRegistry[] = []
const directories: string[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.shutdown()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const revision = 'd'.repeat(40)
const e0 = `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Reactor Trip or Safety Injection
csfs-monitored: [subcriticality, core-cooling, heat-sink, rcs-integrity, containment, rcs-inventory]
---
# E-0 — Reactor Trip or Safety Injection
## Step 1 [id: verify-reactor-trip]
Check: reactor trip breakers «TRIP-BKR-A» AND «TRIP-BKR-B» OPEN AND neutron flux «NIS-PR-AVG» decreasing
- Verified [outcome: normal] → #verify-turbine-trip
- Not verified [outcome: rno] → [[FR-S.1]]
## Step 2 [id: verify-turbine-trip]
Check: all turbine stop valves CLOSED
- Verified [outcome: normal] → END

## Tags

- id: TRIP-BKR-A
  description: reactor trip breaker A position
  sim-path: rps.trip_breaker.a.position
  units: enum[OPEN,CLOSED]
  equipment: reactor-protection-system
- id: TRIP-BKR-B
  description: reactor trip breaker B position
  sim-path: rps.trip_breaker.b.position
  units: enum[OPEN,CLOSED]
  equipment: reactor-protection-system
- id: NIS-PR-AVG
  description: nuclear instrumentation power-range average
  sim-path: nis.power_range.avg
  units: percent
  equipment: nuclear-instrumentation
`

const es01 = `---
type: procedure
procedure-md: 0.7
procedure-id: ES-0.1
title: Reactor Trip Response
---
# ES-0.1 — Reactor Trip Response
## Step 1 [id: monitor]
Check: plant stable
- Stable [outcome: normal] → END
`

const setup = async (sourceCount = 1) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-procedure-ai-runner-'))
  directories.push(dataDir)
  const knowledge = createKnowledge({ revision, documents: [{ path: 'procedures/E-0.md', content: e0 }, { path: 'procedures/ES-0.1.md', content: es01 }] })
  const registry = createWorldWorkspaceRuntimeRegistry({
    dataDir, moduleState: createWorldModuleState({ dataDir }), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
    procedureSourceService: createProcedureSourceService({
      sources: ['runner-test', 'runner-other'].slice(0, sourceCount).map(sourceId => ({ sourceId, label: 'Runner fixture', repository: 'test', ref: 'publication', procedurePath: 'procedures' })),
      retentionDirectory: join(dataDir, 'procedure-publications'), loadKnowledge: async () => knowledge,
    }),
  })
  registries.push(registry)
  const workspaceId = newWorkspaceId()
  const provision = new Request(`http://world.test/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })
  await handleWorldModuleApi(provision, new URL(provision.url), registry)
  const run = await registry.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'test-plant' })
  await run.setClock({ paused: true })
  const plant = run.snapshot().objects.find(object => object.packId === 'process-plant')!
  return { registry, workspaceId, run, plantId: plant.id }
}

const access = (workspaceId: WorkspaceId, actor: { kind: 'ai' | 'human'; id?: string; displayName?: string }) =>
  accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor })

const invoker = (registry: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId, runId: string) =>
  async (capabilityId: string, input: unknown, actor: ReturnType<typeof access>): Promise<{ status: number; body: any }> => {
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId }, input, access: actor }),
    })
    const response = await handleWorldModuleApi(request, new URL(request.url), registry)
    return { status: response!.status, body: await response!.json() }
  }

describe('the AI procedure runner through the World Module API', () => {
  test('an AI agent starts and drives E-0, reads its step with live readings, and its accepted transition answers with the next step', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant', displayName: 'Assistant' })
    const human = access(workspaceId, { kind: 'human' })

    const listed = moduleCapabilityCollectionSchema.parse(await (await handleWorldModuleApi(new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities`), new URL(`http://world.test/internal/workspaces/${workspaceId}/capabilities`), registry))!.json())
    const stepRead = listed.capabilities.find(capability => capability.id === 'world.procedure.run.step.read')!
    expect(stepRead).toMatchObject({ kind: 'query', risk: 'read', scope: { kind: 'resource', resourceType: 'world.simulation-run' } })
    const discoverable = [stepRead.id, stepRead.title, stepRead.description, ...(stepRead.searchTerms ?? [])].join(' ').toLowerCase()
    for (const term of ['run', 'continue', 'procedure', 'step']) expect(discoverable).toContain(term)
    expect(listed.capabilities.find(capability => capability.id === 'world.procedure.run.drive')).toMatchObject({ kind: 'command', risk: 'write' })

    // No catalog read: the start pins the only source's current publication and answers with the first step.
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId, label: 'Unit A1' } }, ai)
    expect(started.status).toBe(200)
    const runId = run.snapshot().procedures!.runs[0]!.runId
    expect(started.body.result).toMatchObject({ ok: true, pinned: { runId, sourceId: 'runner-test', sourceRevision: revision, sourcePath: 'procedures/E-0.md' },
      next: { run: { runId, currentStepId: 'verify-reactor-trip', stepNumber: 1 }, step: { id: 'verify-reactor-trip' } } })
    expect(run.snapshot().procedures!.runs[0]).toMatchObject({ sourceRevision: revision, driver: { kind: 'ai', actorId: 'actor:ai:assistant', label: 'Assistant' } })

    // "Continue": the one active run the caller drives, without a runId.
    const read = await invoke('world.procedure.run.step.read', {}, ai)
    expect(read.status).toBe(200)
    const view = read.body.result
    const readTags = structuredClone(view.tags) as Array<{ id: string; reading: { formatted: string; quality: string; note?: string } }>
    expect(view.sequence).toBe(run.snapshot().seq)
    expect(view.paused).toBe(true)
    expect(view.run).toMatchObject({ runId, procedureId: 'E-0', plantId, unit: 'Unit A1', currentStepId: 'verify-reactor-trip', stepNumber: 1, totalSteps: 2, driver: { kind: 'ai' } })
    expect(view.step.branches.map((branch: { aiMaySelect: boolean }) => branch.aiMaySelect)).toEqual([true, false])
    expect(view.tags.map((tag: { id: string }) => tag.id)).toEqual(['TRIP-BKR-A', 'TRIP-BKR-B', 'NIS-PR-AVG'])
    for (const tag of view.tags) expect(tag.reading).toMatchObject({ formatted: expect.any(String), quality: expect.any(String), at: view.simulationTime })
    expect(view.csfs.map((csf: { id: string }) => csf.id)).toEqual(['subcriticality', 'core-cooling', 'heat-sink', 'rcs-integrity', 'containment', 'rcs-inventory'])

    const basis = 'Test-only selection of the authored normal branch on the readings World takes; no plant judgement.'
    const transition = await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis, evidenceTagIds: ['TRIP-BKR-A', 'NIS-PR-AVG'] }, ai)
    expect(transition.status).toBe(200)
    expect(transition.body.result).toMatchObject({ ok: true, next: { run: { currentStepId: 'verify-turbine-trip', stepNumber: 2 }, step: { id: 'verify-turbine-trip' } } })
    expect(transition.body.result.next.step.branches[0]).toMatchObject({ aiMaySelect: false, personOnlyReason: expect.stringContaining('END branch') })
    expect(transition.body.result.next.sequence).toBe(run.snapshot().seq)
    const decision = run.snapshot().procedures!.runs[0]!.stepStates.find(step => step.stepId === 'verify-reactor-trip')!.decision!
    expect(decision).toMatchObject({ selectedBy: 'actor:ai:assistant', selectedByLabel: 'Assistant', basis })
    expect(decision.evidence!.map(item => item.tagId)).toEqual(['TRIP-BKR-A', 'NIS-PR-AVG'])
    // The decision records what World read, as the step read showed it (the plant is paused).
    expect(decision.evidence!.map(item => item.reading)).toEqual(readTags.filter(tag => tag.id !== 'TRIP-BKR-B').map(tag => {
      const text = [tag.reading.formatted, ...(tag.reading.quality === 'good' ? [] : [`quality ${tag.reading.quality}`]), ...(tag.reading.note === undefined ? [] : [tag.reading.note])].join('; ')
      return text.length <= 160 ? text : `${text.slice(0, 159)}…`
    }))

    // A person's tick takes the run over; from then on the AI agent only reads it.
    const personTick = await invoke('world.procedure.step.update', { runId, stepId: 'verify-turbine-trip', assessment: 'complete' }, human)
    expect(personTick.status).toBe(200)
    expect(personTick.body.result.next).toBeUndefined()
    expect(run.snapshot().procedures!.runs[0]!.driver).toMatchObject({ kind: 'person', actorId: 'actor:operator' })
    const refused = await invoke('world.procedure.step.update', { runId, stepId: 'verify-turbine-trip', comment: 'Stop valves?' }, ai)
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toContain('A person drives E-0 on Unit A1')
    expect((await invoke('world.procedure.run.reset', { sourceId: 'runner-test', procedureId: 'E-0', scope: { plantId } }, ai)).body.error.message).toContain('A person resets procedure runs')

    // The step read keeps the AI inspection boundary, and reports unknown steps and runs as such.
    expect((await invoke('world.procedure.run.step.read', { runId, stepId: 'no-such-step' }, ai)).body.error.code).toBe('procedure_step_not_found')
    expect((await invoke('world.procedure.run.step.read', { runId: 'procedure-run:missing' }, ai)).body.error.code).toBe('procedure_run_not_found')
    const operator = { id: actorIdSchema.parse('operator:runner'), label: 'Runner operator', role: 'operator' as const }
    await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse(plantId), deny: ['inspect'] }] }, 0)
    const denied = await invoke('world.procedure.run.step.read', { runId }, ai)
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('agent_access_restricted')
    expect((await invoke('world.procedure.run.step.read', { runId }, human)).status).toBe(200)
  })

  test('a step read without runId names the runs when the caller drives none or several; a start without sourceId needs a sole source', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant', displayName: 'Assistant' })
    const human = access(workspaceId, { kind: 'human' })
    expect((await invoke('world.procedure.run.step.read', {}, ai)).body.error).toMatchObject({ code: 'procedure_run_not_found', message: expect.stringContaining('none is active') })
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId, label: 'Unit A1' } }, human)
    expect(started.body.result.pinned).toMatchObject({ sourceRevision: revision })
    expect(started.body.result.next).toBeUndefined()
    const unclaimed = await invoke('world.procedure.run.step.read', {}, ai)
    expect(unclaimed.status).toBe(404)
    expect(unclaimed.body.error.message).toContain('You drive no active procedure run. Active: E-0 on Unit A1')
    expect(unclaimed.body.error.message).toContain('nobody drives')
    await invoke('world.procedure.run.drive', { runId: run.snapshot().procedures!.runs[0]!.runId, action: 'claim' }, ai)
    expect((await invoke('world.procedure.run.step.read', {}, ai)).body.result.run.procedureId).toBe('E-0')
    await invoke('world.procedure.run.start', { procedureId: 'ES-0.1', scope: { plantId, label: 'Unit A1' } }, ai)
    const ambiguous = await invoke('world.procedure.run.step.read', {}, ai)
    expect(ambiguous.status).toBe(409)
    expect(ambiguous.body.error).toMatchObject({ code: 'procedure_run_ambiguous', message: expect.stringContaining('You drive 2 active procedure runs: E-0 on Unit A1') })

    const several = await setup(2)
    const severalAi = access(several.workspaceId, { kind: 'ai', id: 'assistant' })
    const refused = await invoker(several.registry, several.workspaceId, several.run.id)('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId: several.plantId } }, severalAi)
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toContain('This Run has 2 procedure sources (runner-test, runner-other): name sourceId.')
    const named = await invoker(several.registry, several.workspaceId, several.run.id)('world.procedure.run.start', { sourceId: 'runner-other', procedureId: 'E-0', scope: { plantId: several.plantId } }, severalAi)
    expect(named.body.result.pinned).toMatchObject({ sourceId: 'runner-other', sourceRevision: revision })
  })
})
