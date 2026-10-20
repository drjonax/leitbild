import {
  accessContextSchema,
  capabilityIdSchema,
  inspectionViewSchema,
  moduleCapabilityCollectionSchema,
  moduleDefinitionCollectionSchema,
  moduleResourceCollectionSchema,
  newRequestId,
  newWorkspaceId,
  workspaceModuleManifestSchema,
  type WorkspaceId,
} from '@leitbild/contracts'
import { afterEach,describe,expect,spyOn,test } from 'bun:test'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import {
  createWorldWorkspaceRuntimeRegistry,
  type WorldWorkspaceRuntimeRegistry,
} from '../src/core/workspaces/runtime-registry.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'
import { createTestPackRuntimeAdapters,createTestScenarioRuntimeResolver,testScenarioAuthoring } from './helpers.ts'
import { actorIdSchema, objectIdSchema } from '../src/core/model/ids.ts'
import { procedureTestDocument } from './procedure-fixtures.ts'
import type { ProcedureDocument } from '../src/core/model/procedures.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { createProcedureSourceService, type ProcedureSourceService } from '../src/features/procedures/source.ts'
import { createKnowledge } from '@leitbild/knowledge'

const registries: WorldWorkspaceRuntimeRegistry[] = []
const temporaryDirectories: string[] = []

const createRegistry = async (procedureSourceService?: ProcedureSourceService): Promise<WorldWorkspaceRuntimeRegistry> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-module-api-'))
  temporaryDirectories.push(dataDir)
  const registry = createWorldWorkspaceRuntimeRegistry({
    dataDir,
    moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
    ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
    ...(procedureSourceService ? { procedureSourceService } : {}),
  })
  registries.push(registry)
  return registry
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.shutdown()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const call = async <T>(
  registry: WorldWorkspaceRuntimeRegistry,
  path: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: T | null }> => {
  const request = new Request(`http://world.test${path}`, init)
  const response = await handleWorldModuleApi(request, new URL(request.url), registry)
  if (!response) throw new Error(`Module route did not handle ${init?.method ?? 'GET'} ${path}`)
  return { status: response.status, body: response.status === 204 ? null : await response.json() as T }
}

const provision = async (registry: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId) =>
  await call(registry, `/internal/workspaces/${workspaceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  })

describe('World Module API', () => {
  test('preserves uncertain, committed-observer, recovery and busy outcomes at the capability boundary', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const run = await registry.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'test-response' })
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'human', id: 'operator' } })
    const capabilityId = 'world.object.delete'
    for (const [code, message] of [
      ['simulation_run_commit_uncertain', 'Commit outcome is uncertain: disk write failed'],
      ['simulation_run_observer_failed', 'Events committed, but runtime observation failed; recovery required'],
      ['simulation_run_recovery_required', 'Simulation Run requires recovery'],
      ['simulation_run_busy', 'Simulation Run has commands preparing changes; retry copy when they finish'],
    ]) {
      const failure = spyOn(run, 'invokeCapability').mockRejectedValue(Object.assign(new Error(message), { code }))
      try {
        const result = await call(registry, `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input: { objectId: run.snapshot().objects[0]!.id }, access }),
        })
        expect(result.status).toBe(409)
        expect(result.body).toMatchObject({ error: { code, message } })
      } finally { failure.mockRestore() }
    }
  })

  test('procedure evidence and historical decisions obey exact-subject AI restrictions without hiding human evidence', async () => {
    const retention = await mkdtemp(join(tmpdir(), 'world-procedure-access-'))
    temporaryDirectories.push(retention)
    const revision = 'a'.repeat(40)
    const sourcePath = 'procedures/ACCESS.md'
    let knowledge = createKnowledge({ revision, documents: [] })
    const sources = createProcedureSourceService({
      sources: [{ sourceId: 'access-test', label: 'Access integration fixture', repository: 'test', ref: 'publication', procedurePath: 'procedures' }],
      retentionDirectory: retention, loadKnowledge: async () => knowledge,
    })
    let nextPreparation: { readonly entered: () => void; readonly released: Promise<void> } | undefined
    const registry = await createRegistry({ ...sources, readDocument: async request => {
      const preparation = nextPreparation
      if (preparation) {
        nextPreparation = undefined
        preparation.entered()
        await preparation.released
      }
      return await sources.readDocument(request)
    } })
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const run = await registry.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'test-plant' })
    await run.setClock({ paused: true })
    const operator = { id: actorIdSchema.parse('operator:access'), label: 'Access operator', role: 'operator' as const }
    const plants = await run.invokeCapability(operator, { capabilityId: 'world.process-plant.plants.list', input: {} })
    if (plants.kind !== 'query') throw new Error('Expected real plant identity query')
    const plant = (plants.result as { plants: Array<{ id: string; modelRef: string; modelDigest: string }> }).plants[0]!
    const conditionInput = {
      condition: { type: 'comparison', signal: { path: 'rcpA.running' }, operator: '==', value: true, unit: 'boolean' },
      basis: { modelRef: plant.modelRef, modelDigest: plant.modelDigest, source: 'test:api-access', description: 'restricted-physical-evidence-canary' },
    }
    knowledge = createKnowledge({ revision, documents: [{ path: sourcePath, content: `---
type: procedure
procedure-md: 0.7
procedure-id: ACCESS
title: Access boundary test
---
# Access boundary test
## Step 1 [id: pump]
Check: Test-only represented pump read, not a functional sufficiency criterion.
\`\`\`procedure-observation
${JSON.stringify({ capabilityId: 'world.process-plant.procedure-condition.evaluate', continuous: true, input: conditionInput })}
\`\`\`
- Record handover [outcome: normal] → #handover
## Step 2 [id: handover]
Action: Test-only handover.
- End review [outcome: normal] → END
` }] })
    const human = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'human', id: 'access-operator' } })
    const ai = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'access-agent' } })
    const invoke = (capabilityId: string, input: unknown, access = ai) => call<{ result: any; error?: { code: string } }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input, access }),
      })
    const start = { sourceId: 'access-test', sourceRevision: revision, procedureId: 'ACCESS', scope: { plantId: plant.id } }
    expect((await invoke('world.process-plant.procedure-condition.evaluate', { ...conditionInput, targetObjectId: plant.id })).status).toBe(200)
    expect((await invoke('world.procedure.run.start', start, human)).status).toBe(200)
    const procedureRun = run.snapshot().procedures!.runs[0]!
    expect(procedureRun.observations?.[0]?.result.status).toBe('satisfied')
    expect((await invoke('world.procedure.step.update', { runId: procedureRun.runId, stepId: 'pump', comment: 'restricted-comment-canary' }, human)).status).toBe(200)
    expect((await invoke('world.procedure.run.transition', { runId: procedureRun.runId, stepId: 'pump', branchIndex: 0 }, human)).status).toBe(200)
    const open = await invoke('world.procedure.runs.list', {})
    expect(open.body!.result.runs).toHaveLength(1)
    expect(JSON.stringify(open.body)).toContain('restricted-physical-evidence-canary')
    const journalBeforeRestriction = run.snapshot().seq
    await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse(plant.id), deny: ['inspect', 'change'] }] }, 0)
    expect((await invoke('world.process-plant.procedure-condition.evaluate', { ...conditionInput, targetObjectId: plant.id })).status).toBe(403)
    const context = await invoke('world.simulation-run.context', {})
    expect(context.status).toBe(200)
    expect(context.body!.result.context.text).not.toContain(plant.id)
    expect(context.body!.result.context.text).toContain('1 objects hidden by this Run\'s AI restrictions')
    expect((await invoke('world.procedure.runs.list', {})).body!.result.runs).toEqual([])
    expect(JSON.stringify((await invoke('world.procedure.runs.list', {}, human)).body)).toContain('restricted-physical-evidence-canary')
    const historical = await invoke('world.simulation-run.changes', { afterSequence: 0, limit: 200 })
    expect(historical.status).toBe(200)
    expect(JSON.stringify(historical.body)).not.toContain('restricted-physical-evidence-canary')
    expect(JSON.stringify(historical.body)).not.toContain('restricted-comment-canary')
    expect(historical.body!.result.events.some((event: { type: string }) => event.type.startsWith('procedure.'))).toBe(false)
    expect(historical.body!.result.nextSequence).toBe(run.snapshot().seq)
    // A page containing only denied evidence still advances its journal cursor.
    const firstProcedureSequence = run.events().find(event => event.type === 'procedure.run.started')!.seq
    const hiddenPage = await invoke('world.simulation-run.changes', { afterSequence: firstProcedureSequence - 1, limit: 1 })
    expect(hiddenPage.body!.result.events).toEqual([])
    expect(hiddenPage.body!.result.nextSequence).toBe(firstProcedureSequence)
    expect(hiddenPage.body!.result.hasMore).toBe(true)
    for (const [capabilityId, input] of [
      ['world.procedure.run.transition', { runId: procedureRun.runId, stepId: 'handover', branchIndex: 0 }],
      ['world.procedure.step.update', { runId: procedureRun.runId, stepId: 'handover', comment: 'denied change' }],
      ['world.procedure.run.close', { runId: procedureRun.runId, status: 'abandoned' }],
      ['world.procedure.run.start', start],
      ['world.procedure.run.reset', start],
    ] as const) {
      const denied = await invoke(capabilityId, input)
      expect(denied.status).toBe(403)
      expect(denied.body?.error?.code).toBe('agent_access_restricted')
    }
    expect(run.snapshot().procedures!.runs[0]!.status).toBe('active')
    // Admission is not a permit to commit after the human changes the live
    // policy while the exact pinned source is still being prepared.
    await run.setAgentRestrictions(operator, { operationIds: [], objects: [] }, 1)
    let preparationEntered!: () => void
    let releasePreparation!: () => void
    const entered = new Promise<void>(resolve => { preparationEntered = resolve })
    const released = new Promise<void>(resolve => { releasePreparation = resolve })
    nextPreparation = { entered: preparationEntered, released }
    const inFlight = invoke('world.procedure.step.update', { runId: procedureRun.runId, stepId: 'handover', comment: 'revoked-in-flight-canary' })
    await entered
    try {
      await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse(plant.id), deny: ['inspect', 'change'] }] }, 2)
    } finally { releasePreparation() }
    const revoked = await inFlight
    expect([403, 409]).toContain(revoked.status)
    expect(revoked.body!.error).toBeDefined()
    expect(JSON.stringify(revoked.body)).toContain('restricted')
    expect(JSON.stringify(run.snapshot().procedures)).not.toContain('revoked-in-flight-canary')
    expect((await invoke('world.procedure.run.reset', start, human)).status).toBe(200)
    expect(run.snapshot().procedures!.runs).toEqual([])
    // Removing the live projection must not re-expose retained decision evidence.
    const afterReset = await invoke('world.simulation-run.changes', { afterSequence: 0, limit: 200 })
    expect(JSON.stringify(afterReset.body)).not.toContain('restricted-physical-evidence-canary')
    expect(JSON.stringify(afterReset.body)).not.toContain('restricted-comment-canary')
    expect(afterReset.body!.result.events.some((event: { type: string }) => event.type.startsWith('procedure.'))).toBe(false)
    const humanHistory = await invoke('world.simulation-run.changes', { afterSequence: 0, limit: 200 }, human)
    expect(JSON.stringify(humanHistory.body)).toContain('restricted-physical-evidence-canary')
    expect(humanHistory.body!.result.nextSequence).toBeGreaterThan(journalBeforeRestriction)
  })

  test('native procedure selectors return client-domain errors and recover through the same handler', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'world-procedure-publication-'))
    temporaryDirectories.push(directory)
    const revision = 'a'.repeat(40)
    const sourcePath = 'packs/process-plant/procedures/E-0.md'
    const knowledge = createKnowledge({ revision, documents: [{ path: sourcePath, content: procedureTestDocument().rawMarkdown }] })
    const registry = await createRegistry(createProcedureSourceService({
      sources: [{ sourceId: 'leitbild', label: 'Model-annotated reference', repository: 'Leitbild-wiki', ref: 'publication', procedurePath: 'packs/process-plant/procedures' }],
      retentionDirectory: directory, loadKnowledge: async () => knowledge,
    }))
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const run = await registry.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'test-response' })
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'procedure-reader' } })
    const invoke = (capabilityId: string, input: unknown) => call<{ error?: { code: string }; result?: { procedureId?: string } }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input, access }),
      })
    const missingSource = await invoke('world.procedure.catalog.list', { sourceId: 'pwr-ops' })
    expect(missingSource.status).toBe(404)
    expect(missingSource.body?.error?.code).toBe('capability_target_not_found')
    for (const input of [
      { sourceId: 'pwr-ops', procedureId: 'E-0' },
      { procedureId: 'MISSING' },
      { procedureId: 'E-0', sourceRevision: 'b'.repeat(40) },
    ]) {
      const result = await invoke('world.procedure.document.read', input)
      expect(result.status).toBe(404)
      expect(result.body?.error?.code).toBe('capability_target_not_found')
    }
    const wrongPath = await invoke('world.procedure.document.read', { procedureId: 'E-0', sourceRevision: revision, sourcePath: 'other.md' })
    expect(wrongPath.status).toBe(400)
    expect(wrongPath.body?.error?.code).toBe('capability_input_rejected')
    expect((await invoke('world.procedure.catalog.list', {})).status).toBe(200)
    const recovered = await invoke('world.procedure.document.read', { sourceId: 'leitbild', procedureId: 'E-0', sourceRevision: revision, sourcePath })
    expect(recovered.status).toBe(200)
    expect(recovered.body?.result?.procedureId).toBe('E-0')
  })

  test('validates every selective artifact mode through the real runtime and HTTP output boundary', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const run = await registry.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'test-plant' })
    const capabilityId = 'world.process-plant.artifact.read'
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'artifact-reader' } })
    const read = (input: unknown) => call<{ result: Record<string, unknown> }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input, access }),
      })
    const identity = { plantId: 'plant:halden-a1', artifact: 'authored-spec' }
    const index = await read(identity)
    expect(index.status).toBe(200)
    // The four-loop Plant has more components than a default index page of 100 holds.
    expect(index.body!.result).toMatchObject({ mode: 'index', returned: 100, hasMore: true })
    expect(index.body!.result).not.toHaveProperty('content')
    const files = index.body!.result.sourceFiles as Array<{ path: string; sha256: string }>
    const source = await read({ ...identity, mode: 'source', sourcePath: files[0]!.path, expectedSha256: files[0]!.sha256, lineCount: 2 })
    expect(source.status).toBe(200)
    expect(source.body!.result).toMatchObject({ mode: 'source', returnedLines: 2, sha256: files[0]!.sha256 })
    const component = await read({ ...identity, mode: 'component', componentId: 'core' })
    expect(component.status).toBe(200)
    expect(component.body!.result).toMatchObject({ mode: 'component', authoredComponent: { id: 'core' } })
    for (const artifact of ['authored-spec', 'compiled-graph-mermaid']) {
      const full = await read({ ...identity, artifact, mode: 'full' })
      expect(full.status).toBe(200)
      expect(full.body!.result).not.toHaveProperty('mode')
      expect(typeof full.body!.result.content).toBe('string')
    }
    expect((await read({ ...identity, mode: 'source', sourcePath: '../../etc/passwd' })).status).toBe(404)
    expect((await read({ ...identity, mode: 'source', sourcePath: files[0]!.path, expectedSha256: '0'.repeat(64) })).status).toBe(400)
    expect((await read({ ...identity, mode: 'full', componentId: 'core' })).status).toBe(400)
  })

  test('rejects unknown display selectors as domain errors and accepts discovered selectors after recovery', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const run = await registry.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'test-plant' })
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'display-reader' } })
    const read = (capabilityId: string, input: unknown) => call<{ result?: Record<string, unknown>; error?: { code: string; message: string } }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input, access }),
      })
    const plantId = 'plant:halden-a1'
    // The unit overview is generated from the Plant, so the only selector is the Plant itself.
    const guessedPlant = await read('world.process-plant.display.overview', { plantId: 'plant:guessed' })
    expect(guessedPlant.status).toBe(404)
    expect(guessedPlant.body!.error).toMatchObject({ code: 'capability_target_not_found', message: expect.stringContaining(`Live Plants: ${plantId}`) })
    expect(run.health().every(health => health.state === 'ready' && health.failureCount === 0 && health.lastFailure === undefined)).toBe(true)
    expect((await read('world.process-plant.display.overview', { plantId, unexpected: true })).status).toBe(400)
    const overview = await read('world.process-plant.display.overview', { plantId })
    expect(overview.status).toBe(200)
    expect(overview.body!.result).toHaveProperty('plantId', plantId)
    expect(overview.body!.result).toHaveProperty('view.viewType', 'process-plant.display')
  })

  test('procedure reads select canonical evidence without duplicating Markdown or changing the UI document', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const run = await registry.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'test-response' })
    const base = procedureTestDocument()
    const document = parseProcedureMarkdown({ ...base,
      rawMarkdown: `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Evidence-preserving selection
applies-to: fixture-only
reference-plant: Test reference
---
Document-level caution and applicability remain relevant to a selected step.
## Step 1 [id: first]
Check: Verify «CHECK».
Caution: Observe «CAUTION» before acting.
Decision: Choose the applicable path.
1. Review «DECISION».
2. Do not infer a measured value from this authored instruction.
- Not verified → [[TARGET]]
  Because: Evidence from «RATIONALE» supports this path.
  Against: Conflicting «AGAINST» is not to be discarded.
## Step 2 [id: second]
Action: Inspect «OTHER-STEP».
- Verified → END
## Tags
- id: CHECK
- id: CAUTION
- id: DECISION
- id: RATIONALE
- id: AGAINST
- id: OTHER-STEP
`,
    })
    const original = structuredClone(document)
    const reader = spyOn(run, 'procedureDocument').mockResolvedValue(document)
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'procedure-reader' } })
    const capabilityId = 'world.procedure.document.read'
    const read = (input: unknown) => call<{ result: Omit<ProcedureDocument, 'rawMarkdown'> & { rawMarkdown?: string; totalSteps: number; totalTags: number; selectedStepId?: string } }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input, access }),
      })
    try {
      const full = await read({ procedureId: 'E-0' })
      expect(full.status).toBe(200)
      expect(full.body!.result).toMatchObject({ totalSteps: 2, totalTags: 6, steps: document.steps, tags: document.tags })
      expect(full.body!.result).not.toHaveProperty('rawMarkdown')
      expect(full.body!.result).not.toHaveProperty('selectedStepId')
      const pinned = { procedureId: 'E-0', sourceId: document.source.sourceId, sourceRevision: document.source.revision, sourcePath: document.sourcePath }
      const selected = await read({ ...pinned, stepId: 'first' })
      expect(reader).toHaveBeenLastCalledWith(pinned)
      expect(selected.body!.result).toMatchObject({
        selectedStepId: 'first', totalSteps: 2, totalTags: 6,
        source: document.source, appliesTo: document.appliesTo, description: document.description,
        referencePlant: 'Test reference',
        sourceUrl: document.sourceUrl, sourcePath: document.sourcePath, steps: [document.steps[0]],
        tags: document.tags.slice(0, 5),
      })
      expect(selected.body!.result.steps[0]!.tagIds).toEqual(['CHECK', 'CAUTION', 'DECISION', 'RATIONALE', 'AGAINST'])
      expect(selected.body!.result.steps[0]!.blocks.find(block => block.kind === 'decision')?.paths).toEqual([
        'Review «DECISION».', 'Do not infer a measured value from this authored instruction.',
      ])
      expect(selected.body!.result.steps[0]!.branches).toEqual(document.steps[0]!.branches)
      const withSource = await read({ ...pinned, stepId: 'second', includeSource: true })
      expect(withSource.body!.result.rawMarkdown).toBe(original.rawMarkdown)
      expect(withSource.body!.result.tags).toEqual([document.tags[5]!])
      expect((await read({ procedureId: 'E-0', stepId: 'missing' })).status).toBe(404)
      expect((await read({ procedureId: 'E-0', sourcePath: document.sourcePath })).status).toBe(400)
      expect((await read({ procedureId: 'E-0', includeSource: 'true' })).status).toBe(400)
      expect(document).toEqual(original)
      expect(await run.procedureDocument(pinned)).toEqual(original)
      reader.mockResolvedValue({ ...document, steps: [document.steps[0]!, document.steps[0]!] })
      expect((await read({ ...pinned, stepId: 'first' })).status).toBe(409)
    } finally { reader.mockRestore() }
  })

  test('exposes independent playback and pace through one discoverable capability', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const runs = registry.getLoaded(workspaceId)!.simulationRuns
    const run = await runs.create({ scenarioId: 'test-response' })
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'human', id: 'operator' } })
    const resource = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }
    const invoke = async (capabilityId: string, input: unknown) => await call<{ result: {
      playback: 'playing' | 'paused'; pace: 'realtime' | 'maximum'; maximumPace: { available: boolean }
    } }>(registry, `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId, resource, input, access }),
    })

    expect((await invoke('world.simulation-run.execution.read', {})).body?.result)
      .toMatchObject({ playback: 'playing', pace: 'realtime', maximumPace: { available: true } })
    expect((await invoke('world.simulation-run.execution.set', { playback: 'paused' })).body?.result)
      .toMatchObject({ playback: 'paused', pace: 'realtime' })
    expect((await invoke('world.simulation-run.execution.set', { pace: 'maximum' })).body?.result)
      .toMatchObject({ playback: 'paused', pace: 'maximum' })
    expect((await invoke('world.simulation-run.execution.set', { playback: 'playing' })).body?.result)
      .toMatchObject({ playback: 'playing', pace: 'maximum' })
    expect((await invoke('world.simulation-run.execution.set', { playback: 'paused' })).body?.result)
      .toMatchObject({ playback: 'paused', pace: 'maximum' })
    expect((await invoke('world.simulation-run.execution.set', { pace: 'realtime' })).body?.result)
      .toMatchObject({ playback: 'paused', pace: 'realtime' })
  })

  test('lists execution summaries without loading idle Simulation Runs', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const runs = registry.getLoaded(workspaceId)!.simulationRuns
    const run = await runs.create({ scenarioId: 'test-response' })
    await runs.close(run.id)
    expect(runs.get(run.id)).toBeUndefined()

    const resources = moduleResourceCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/resources`)).body,
    )

    expect(resources.resources.find(resource => resource.ref.type === 'world.simulation-run' && String(resource.ref.id) === String(run.id))?.summary)
      .toContainEqual(expect.objectContaining({ label: 'Status', value: 'Running' }))
    expect(runs.get(run.id)).toBeUndefined()
  })

  test('Agent history queries preserve simulation time and pagination through the capability boundary', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const runs = registry.getLoaded(workspaceId)!.simulationRuns
    const source = structuredClone(testScenarioDefinitions.find(item => item.id === 'halden-power-complex')!)
    await runs.createScenario({ ...source, id: 'history-api', world: { ...source.world, startsAt: '2026-01-01T00:00:00.000Z' } })
    const run = await runs.create({ scenarioId: 'history-api' })
    for (let attempt = 0; attempt < 30 && (run.recordingStatus()?.sampleCount ?? 0) < 100; attempt++) await Bun.sleep(100)
    expect(run.recordingStatus()!.sampleCount).toBeGreaterThan(0)
    await run.setClock({ paused: true })
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'history-reader' } })
    const seriesCapabilityId = 'world.simulation-run.history-series.list'
    const seriesCatalog = await call<{ result: { series: Array<{ runtimeId: string; id: string; subjectId: string }> } }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${seriesCapabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: seriesCapabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input: {}, access }),
      })
    const selectedSeries = seriesCatalog.body!.result.series[0]!
    expect(selectedSeries).toBeDefined()
    const capabilityId = 'world.simulation-run.history-samples.read'
    const read = (input: unknown) => call<{ result: { samples: Array<{ sequence: number; runtimeId?: string; seriesId?: string }>; windowSummary: { sampleCount: number; firstSample: { sequence: number } | null }; nextBeforeSequence: number | null } }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input, access }),
      })
    const series = { runtimeId: selectedSeries.runtimeId, seriesId: selectedSeries.id, mode: 'raw' }
    const missing = await read({ runtimeId: selectedSeries.runtimeId, seriesId: 'series:not-real', limit: 1 })
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ error: {
      code: 'historian_series_not_found',
      details: { nextOperation: seriesCapabilityId },
    } })
    const wrongRuntime = await read({ runtimeId: 'plant:not-a-runtime', seriesId: selectedSeries.id, limit: 1 })
    expect(wrongRuntime.status).toBe(422)
    expect(wrongRuntime.body).toMatchObject({ error: {
      code: 'historian_runtime_mismatch',
      details: {
        suppliedRuntimeId: 'plant:not-a-runtime',
        matchingReferences: [{ runtimeId: selectedSeries.runtimeId, id: selectedSeries.id }],
      },
    } })
    const first = await read({ ...series, timeAxis: 'simulation', to: '2026-01-02T00:00:00Z', limit: 2 })
    expect(first.body!.result.samples.length).toBeGreaterThan(0)
    expect(first.body!.result.windowSummary.sampleCount).toBeGreaterThan(0)
    expect(first.body!.result.windowSummary.firstSample).not.toBeNull()
    expect(first.body!.result.samples.every(sample => sample.runtimeId === undefined && sample.seriesId === undefined)).toBe(true)
    const summary = await read({ runtimeId: selectedSeries.runtimeId, seriesId: selectedSeries.id, timeAxis: 'simulation', to: '2026-01-02T00:00:00Z' })
    expect(summary.status).toBe(200)
    expect(summary.body!.result).toMatchObject({ mode: 'summary', windowSummary: first.body!.result.windowSummary })
    expect(summary.body!.result).not.toHaveProperty('samples')
    expect(summary.body!.result).not.toHaveProperty('nextBeforeSequence')
    expect((await read({ ...series, mode: 'summary', beforeSequence: 1 })).status).toBe(400)
    expect((await read({ runtimeId: selectedSeries.runtimeId })).status).toBe(400)
    const cursor = first.body!.result.nextBeforeSequence
    if (cursor !== null) {
      const second = await read({ ...series, timeAxis: 'simulation', to: '2026-01-02T00:00:00Z', beforeSequence: cursor, limit: 2 })
      expect(second.body!.result.samples.every(sample => sample.sequence < cursor)).toBe(true)
      expect(second.body!.result.windowSummary).toEqual(first.body!.result.windowSummary)
    }
    const observed = await read({ ...series, timeAxis: 'observed', to: '2026-01-02T00:00:00Z', limit: 2 })
    expect(observed.body!.result.samples).toEqual([])
    // Exact historian subject reads obey the same live Run restriction.
    await run.setAgentRestrictions({id:actorIdSchema.parse('actor:operator'),label:'Operator',role:'operator'}, {
      operationIds:[],objects:[{objectId:objectIdSchema.parse(selectedSeries.subjectId),deny:['inspect']}],
    },0)
    expect((await read({...series,limit:1})).status).toBe(403)
    expect(runs.leaseSummary(run.id).leasesByKind.api).toBe(0)
  })
  test('container admission is bounded without evicting active definition owners', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'world-container-cap-'))
    temporaryDirectories.push(dataDir)
    const moduleState = createWorldModuleState({ dataDir })
    const registry = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState, maxLoadedWorkspaces: 1,
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters() })
    registries.push(registry)
    const a = newWorkspaceId(), b = newWorkspaceId()
    await moduleState.provision(a); await moduleState.provision(b)
    const first = await registry.getOrLoad(a)
    const run = await first.simulationRuns.create({ scenarioId: 'test-response' })
    await expect(registry.getOrLoad(b)).rejects.toThrow('capacity')
    expect(registry.getLoaded(a)).toBe(first)
    await first.simulationRuns.close(run.id)
    expect((await registry.getOrLoad(b)).workspaceId).toBe(b)
    expect(registry.getLoaded(a)).toBeUndefined()
  })
  test('publishes the strict Module manifest', async () => {
    const registry = await createRegistry()
    const response = await call(registry, '/.well-known/workspace-module')
    expect(response.status).toBe(200)
    expect(workspaceModuleManifestSchema.safeParse(response.body).success).toBe(true)
  })

  test('provisions and removes one Host-owned Workspace idempotently', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    expect((await provision(registry, workspaceId)).status).toBe(201)
    expect((await provision(registry, workspaceId)).status).toBe(200)
    expect((await registry.list()).map(workspace => workspace.workspaceId)).toEqual([workspaceId])

    expect((await call(registry, `/internal/workspaces/${workspaceId}`, { method: 'DELETE' })).status).toBe(204)
    expect(await registry.list()).toEqual([])
  })

  test('discovers Pack authoring and saves an editable Scenario Definition', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const access = accessContextSchema.parse({
      workspaceId,
      requestId: newRequestId(),
      actor: { kind: 'human', id: 'scenario-author' },
    })
    const describeId = capabilityIdSchema.parse('world.scenario-authoring.describe')
    const described = await call<{ result: { detail: string; packs: Array<{ id: string; itemTypes: unknown[]; runtimes: unknown[]; configSchema?: unknown }>; commands: Array<{ packId: string }> } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${describeId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: describeId, input: {}, access }),
      },
    )
    expect(described.body?.result.packs.find(pack => pack.id === 'fixture')?.itemTypes.length).toBeGreaterThan(0)
    expect(described.body?.result.packs.find(pack => pack.id === 'process-plant')?.itemTypes.length).toBeGreaterThan(0)
    expect(described.body?.result.packs.map(pack => pack.id).sort()).toEqual(['drone', 'electric-grid', 'fixture', 'process-plant', 'weather'])
    expect(described.body?.result.detail).toBe('catalog')
    expect(described.body?.result.packs.find(pack => pack.id === 'process-plant')?.configSchema).toBeUndefined()

    const focused = await call<{ result: { packs: Array<{ id: string }>; commands: Array<{ packId: string }> } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${describeId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: describeId, input: { packIds: ['fixture', 'weather'], detail: 'authoring' }, access }),
      },
    )
    expect(focused.status).toBe(200)
    expect(focused.body?.result.packs.map(pack => pack.id)).toEqual(['fixture', 'weather'])
    expect(focused.body?.result.commands.every(command => ['fixture', 'weather'].includes(command.packId))).toBe(true)
    expect((focused.body?.result.packs[0] as { configSchema?: unknown } | undefined)?.configSchema).toBeTruthy()

    const weatherAuthoring = focused.body?.result.packs.find(pack => pack.id === 'weather') as {
      id: string
      itemTypes: Array<{ id: string; itemSchema: { properties: { keyframes: { description: string; items: { properties: { atSeconds: { description: string }; atmosphere: { description: string } } } } } } }>
    }
    const keyframes = weatherAuthoring.itemTypes.find(type => type.id === 'weather_area')!.itemSchema.properties.keyframes
    expect(keyframes.description).toContain('not timed step changes')
    expect(keyframes.description).toContain('final state holds')
    expect(keyframes.items.properties.atSeconds.description).toContain('not when the change starts')
    expect(keyframes.items.properties.atSeconds.description).toContain('{atSeconds:120}')
    expect(keyframes.items.properties.atmosphere.description).toContain('Omitted quantities retain')

    const editor = await call<{ result: { packs: Array<{ itemTypes: Array<{ id: string; collections: Array<{ fields: Array<{ path: string[]; description?: string }> }> }> }> } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${describeId}/invoke`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: describeId, input: { packIds: ['weather'], detail: 'editor' }, access }),
      },
    )
    expect(editor.status).toBe(200)
    const endpointTime = editor.body?.result.packs[0]?.itemTypes.find(type => type.id === 'weather_area')?.collections[0]?.fields.find(field => field.path[0] === 'atSeconds')
    expect(endpointTime?.description).toBe(keyframes.items.properties.atSeconds.description)

    const unknownPack = await call<{ error: { code: string } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${describeId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: describeId, input: { packIds: ['missing-pack'] }, access }),
      },
    )
    expect(unknownPack.status).toBe(400)
    expect(unknownPack.body?.error.code).toBe('scenario_authoring_pack_not_found')

    const previewSource = testScenarioDefinitions.find(source => source.id === 'halden-power-complex')!
    const previewId = capabilityIdSchema.parse('world.scenario.preview')
    const previewed = await call<{ result: { objectives: string[]; view: { center: [number, number]; zoom: number; layers: string[] }; assets: Array<{ id: string; electricalPorts: Array<{ role: string }> }>; connections: unknown[]; timeline: { cueCount: number; lastCueAtSeconds: number | null; cues: unknown[] } } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${previewId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: previewId, input: { source: previewSource }, access }),
      },
    )
    expect(previewed.status).toBe(200)
    expect(previewed.body?.result.assets.filter(asset => asset.electricalPorts.length > 0)).toHaveLength(5)
    const electricalRoles = previewed.body?.result.assets.flatMap(asset => asset.electricalPorts.map(port => port.role)) ?? []
    expect(electricalRoles.filter(role => role === 'system')).toHaveLength(4)
    expect(electricalRoles.filter(role => role === 'network')).toHaveLength(4)
    expect(previewed.body?.result.connections).toHaveLength(4)
    expect(previewed.body?.result.view.center).toHaveLength(2)
    expect(previewed.body?.result.timeline).toEqual({ cueCount: 0, lastCueAtSeconds: null, cues: [] })

    const source = testScenarioDefinitions.find(source => source.id === 'test-response')!
    const definition = { ...source, id: 'custom-authoring-test', title: 'Custom authoring test' }
    const createId = capabilityIdSchema.parse('world.scenario.create')
    const created = await call<{ result: { definition: { id: string; revisionId: string }; uiPath: string } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${createId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: createId, input: { source: definition }, access }),
      },
    )
    expect(created.status).toBe(201)
    expect(created.body?.result.definition.id).toBe(definition.id)
    expect(created.body?.result.uiPath).toContain(`definition=${definition.id}`)
    const runs = registry.getLoaded(workspaceId)!.simulationRuns
    const revision = await runs.currentScenario(definition.id)
    expect(revision?.document.title).toBe(definition.title)
    expect((await runs.compileScenarioRevision(revision!)).initialObjects.length).toBeGreaterThan(0)

    const updateId = capabilityIdSchema.parse('world.scenario.update')
    const updatedTitle = 'Updated authoring test'
    const updated = await call<{ result: { definition: { id: string; revisionId: string }; title: string } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${updateId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: updateId,
          definition: {
            workspaceId,
            moduleId: 'world',
            type: 'world.scenario',
            id: definition.id,
            revisionId: revision!.id,
          },
          input: { source: { ...definition, title: updatedTitle } },
          access,
        }),
      },
    )
    expect(updated.status).toBe(200)
    expect(updated.body?.result.title).toBe(updatedTitle)
    expect(updated.body?.result.definition.revisionId).not.toBe(revision!.id)
    const readId = capabilityIdSchema.parse('world.scenario.read')
    const read = await call<{ result: { source: { title: string }; definition: { revisionId: string } } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${readId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: readId,
          definition: {
            workspaceId,
            moduleId: 'world',
            type: 'world.scenario',
            id: definition.id,
            revisionId: updated.body!.result.definition.revisionId,
          },
          input: {},
          access,
        }),
      },
    )
    expect(read.status).toBe(200)
    expect(read.body?.result.source.title).toBe(updatedTitle)
    expect(read.body?.result.definition.revisionId).toBe(updated.body?.result.definition.revisionId)
    const updatedDescriptor = moduleDefinitionCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/definitions`)).body,
    ).definitions.find(candidate => candidate.ref.id === definition.id)!
    expect(updatedDescriptor.title).toBe(updatedTitle)
    expect(updatedDescriptor.uiPath).toContain(`definition=${definition.id}`)
  })

  test('discovers Scenario Definitions, starts an exact revision, and exposes agent-safe Run context', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)

    const capabilities = await call(registry, `/internal/workspaces/${workspaceId}/capabilities`)
    expect(moduleCapabilityCollectionSchema.safeParse(capabilities.body).success).toBe(true)
    expect((capabilities.body as { capabilities: Array<{ id: string }> }).capabilities.map(item => item.id)).toContain(
      'world.scenario.start',
    )
    expect((capabilities.body as { capabilities: Array<{ id: string }> }).capabilities.map(item => item.id)).toContain(
      'world.simulation-run.delete',
    )
    expect((capabilities.body as { capabilities: Array<{ id: string }> }).capabilities.map(item => item.id)).toContain(
      'world.object.delete',
    )
    // The displays an agent presents with its answer declare it; Agents gate "Show display" on the marker, not on an id.
    expect(moduleCapabilityCollectionSchema.parse(capabilities.body).capabilities.filter(item => item.publishes?.includes('embedded-view')).map(item => String(item.id)).sort())
      .toEqual(['world.process-plant.display.compose', 'world.process-plant.display.overview'])
    const definitions = await call(registry, `/internal/workspaces/${workspaceId}/definitions`)
    const parsedDefinitions = moduleDefinitionCollectionSchema.parse(definitions.body)
    const scenario = parsedDefinitions.definitions.find(definition => definition.ref.id === 'test-response')!
    expect(String(scenario.inspectionCapabilityId)).toBe('world.scenario.inspect')

    const access = accessContextSchema.parse({
      workspaceId,
      requestId: newRequestId(),
      actor: { kind: 'ai', id: 'operator' },
    })
    const createCapabilityId = capabilityIdSchema.parse('world.scenario.start')
    const inspectScenarioCapabilityId = capabilityIdSchema.parse('world.scenario.inspect')
    const scenarioInspection = await call<{ result: unknown }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${inspectScenarioCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: inspectScenarioCapabilityId,
          definition: { ...scenario.ref, revisionId: scenario.currentRevisionId },
          input: {},
          access,
        }),
      },
    )
    const parsedScenarioInspection = inspectionViewSchema.parse(scenarioInspection.body?.result)
    expect(parsedScenarioInspection.sections.map(section => section.id)).toContain('authored-definition')
    expect(parsedScenarioInspection.sections.map(section => section.id)).toContain('assets')
    expect(parsedScenarioInspection.sections.map(section => section.id)).toContain('timeline')

    const created = await call<{ result: { id: string }; createdResources: Array<{ id: string }> }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${createCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: createCapabilityId,
          definition: { ...scenario.ref, revisionId: scenario.currentRevisionId },
          input: {},
          access,
        }),
      },
    )
    expect(created.status).toBe(201)

    const resources = moduleResourceCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/resources`)).body,
    )
    const run = resources.resources
      .find(resource => resource.ref.type === 'world.simulation-run')
    expect(String(run?.ref.id)).toBe(created.body!.result.id)
    expect(run?.title).toBe(scenario.title)
    expect(run?.summary.find(item => item.key === 'started-at')?.kind).toBe('timestamp')
    expect(run?.summary.find(item => item.key === 'viewer-count')).toMatchObject({ kind: 'count', value: 0 })
    expect(run?.summary.find(item => item.key === 'status')).toMatchObject({ kind: 'status', value: 'Running' })
    const family = resources.resources.find(resource => resource.ref.type === 'world.run-family' && resource.ref.id === run?.ref.id)
    expect(family?.links).toContainEqual(expect.objectContaining({ rel: 'contains', ref: run?.ref }))
    expect(run?.links).toContainEqual(expect.objectContaining({ rel: 'member-of', ref: family?.ref }))
    expect(String(run?.inspectionCapabilityId)).toBe('world.simulation-run.inspect')
    expect(String(run?.renameCapabilityId)).toBe('world.simulation-run.rename')
    const renameCapabilityId = capabilityIdSchema.parse('world.simulation-run.rename')
    const renameRequest = {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId: renameCapabilityId, resource: run!.ref,
        input: { name: 'Training shift', expectedTitle: run!.title }, access }),
    }
    const renamed = await call<{ result: { title: string } }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${renameCapabilityId}/invoke`, renameRequest)
    expect(renamed.status).toBe(200)
    expect(renamed.body?.result.title).toBe('Training shift')
    expect((await call(registry, `/internal/workspaces/${workspaceId}/capabilities/${renameCapabilityId}/invoke`, renameRequest)).status).toBe(409)

    const inspectRunCapabilityId = capabilityIdSchema.parse('world.simulation-run.inspect')
    const runInspection = await call<{ result: unknown }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${inspectRunCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: inspectRunCapabilityId,
          resource: run!.ref,
          input: {},
          access,
        }),
      },
    )
    const parsedRunInspection = inspectionViewSchema.parse(runInspection.body?.result)
    expect(parsedRunInspection.sections.map(section => section.id)).toContain('live-assets')
    expect(parsedRunInspection.sections.map(section => section.id)).not.toContain('available-capabilities')

    const contextCapabilityId = capabilityIdSchema.parse('world.simulation-run.context')
    const context = await call<{ result: { context: { text: string; at: string; clock: string } } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${contextCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: contextCapabilityId,
          resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run!.ref.id },
          input: {},
          access,
        }),
      },
    )
    expect(context.body?.result.context.text.split('\n')[0]).toStartWith('Training shift · simulation time ')
    expect(context.body?.result.context.clock).toBe('simulation')
    expect(JSON.stringify(context.body)).not.toContain('timeline')

    const searchObjectsCapabilityId = capabilityIdSchema.parse('world.simulation-run.objects.search')
    const searchedObjects = await call<{ result: { total: number; objects: Array<{ id: string; packId: string }> } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${searchObjectsCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: searchObjectsCapabilityId,
          resource: run!.ref,
          input: { packId: 'fixture', limit: 2 },
          access,
        }),
      },
    )
    expect(searchedObjects.status).toBe(200)
    expect(searchedObjects.body?.result.objects.length).toBeLessThanOrEqual(2)
    expect(searchedObjects.body?.result.objects.every(object => object.packId === 'fixture')).toBe(true)

    const packCapabilityId = capabilityIdSchema.parse('world.fixture.state')
    const publishedCapabilities = moduleCapabilityCollectionSchema.parse(capabilities.body)
    const contextDescriptor = publishedCapabilities.capabilities.find(capability => capability.id === contextCapabilityId)
    expect(contextDescriptor).toMatchObject({ publishes: ['context'], outputSchema: { type: 'object', required: ['context'], properties: { context: { type: 'object' } } } })
    const packCapability = publishedCapabilities.capabilities.find(capability => capability.id === packCapabilityId)
    expect(packCapability).toMatchObject({ kind: 'query', scope: { kind: 'resource', resourceType: 'world.simulation-run' } })
    expect(packCapability?.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        units: { type: 'array' },
        tasks: { type: 'array' },
        sites: { type: 'array' },
      },
    })
    const fixtureState = await call<{ result: { units: unknown[]; tasks: unknown[]; sites: unknown[] } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${packCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: packCapabilityId,
          resource: run!.ref,
          input: {},
          access,
        }),
      },
    )
    expect(fixtureState.status).toBe(200)
    expect(fixtureState.body?.result.units.length).toBeGreaterThan(0)

    const deleteObjectCapabilityId = capabilityIdSchema.parse('world.object.delete')
    const deletedObject = await call<{ result: { ok: boolean } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${deleteObjectCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: deleteObjectCapabilityId,
          resource: run!.ref,
          input: { objectId: searchedObjects.body!.result.objects[0]!.id },
          access,
        }),
      },
    )
    expect(deletedObject.status).toBe(200)
    expect(deletedObject.body?.result.ok).toBe(true)

    const changesCapabilityId = capabilityIdSchema.parse('world.simulation-run.changes')
    const changes = await call<{ result: { currentSequence: number; events: unknown[]; hasMore: boolean } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${changesCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: changesCapabilityId,
          resource: run!.ref,
          input: { afterSequence: 0, limit: 2 },
          access,
        }),
      },
    )
    expect(changes.status).toBe(200)
    expect(changes.body?.result.events.length).toBeLessThanOrEqual(2)
    expect(changes.body?.result.currentSequence).toBeGreaterThanOrEqual(changes.body?.result.events.length ?? 0)

    const readCapabilityId = capabilityIdSchema.parse('world.simulation-run.read')
    const read = await call<{ result: { id: string } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${readCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: readCapabilityId,
          resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run!.ref.id },
          input: {},
          access,
        }),
      },
    )
    expect(read.body?.result.id).toBe(created.body?.result.id)

    const deleteCapabilityId = capabilityIdSchema.parse('world.scenario.delete')
    expect((await call(registry, `/internal/workspaces/${workspaceId}/capabilities/${deleteCapabilityId}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        capabilityId: deleteCapabilityId,
        definition: { ...scenario.ref, revisionId: scenario.currentRevisionId },
        input: {},
        access,
      }),
    })).status).toBe(200)
    expect(moduleDefinitionCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/definitions`)).body,
    ).definitions.some(definition => definition.ref.id === scenario.ref.id)).toBe(false)
    expect(moduleResourceCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/resources`)).body,
    ).resources.some(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === run!.ref.id)).toBe(true)

    const deleteRunCapabilityId = capabilityIdSchema.parse('world.simulation-run.delete')
    const simulationRunId = registry.getLoaded(workspaceId)!.simulationRuns.list()[0]!.id
    const releaseViewer = registry.getLoaded(workspaceId)!.simulationRuns.acquireLease(simulationRunId, 'realtime')
    const deleted = await call<{ result: { deleted: boolean } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${deleteRunCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: deleteRunCapabilityId,
          resource: run!.ref,
          input: {},
          access,
        }),
      },
    )
    expect(deleted.status).toBe(200)
    expect(deleted.body?.result.deleted).toBe(true)
    releaseViewer()
    expect(moduleResourceCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/resources`)).body,
    ).resources.some(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === run!.ref.id)).toBe(false)
  })
})
