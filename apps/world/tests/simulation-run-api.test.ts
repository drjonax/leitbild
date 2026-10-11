import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  accessContextSchema,
  newRequestId,
  newWorkspaceId,
} from '@leitbild/contracts'
import type {
  IsoTimestamp,
  OperationalObject,
  ProcedureCatalog,
  ProcedureDocument,
  SimulationClockState,
  SimulationRunEvent,
  SimulationRunId,
} from '../src/core/model/index.ts'
import { deleteObjectCommandKind, geoPointFromLonLat } from '../src/core/model/index.ts'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { ProcedureSourceService } from '../src/features/procedures/source.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { fixturePackId, fixtureRuntimeId } from './fixtures/fixture-pack.ts'
import { fixtureCommandIds, fixtureQueryIds } from './fixtures/fixture-runtime.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testPacks, testScenarioAuthoring, waitForCondition } from './helpers.ts'
import { responseScenario } from './fixtures/scenarios.ts'

interface ApiResponse<T> {
  readonly status: number
  readonly body: T
}

const procedureSource = {
  sourceId: 'pwr-ops',
  label: 'PWR operations procedures',
  repository: 'leitbild-wikis/pwr-ops',
  ref: 'main',
  path: 'wiki/procedures',
  revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  fetchedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/tree/main/wiki/procedures',
}

const procedureMarkdown = `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Reactor Trip or Safety Injection
profile: nuclear-erg
category: diagnostic-eop
csfs-monitored: [subcriticality]
entry-triggers: [reactor-trip-signal]
---

# E-0 — Reactor Trip or Safety Injection

## Step 1 [id: verify-reactor-trip]
Check: reactor trip breakers «TRIP-BKR-A» OPEN
- Verified → END

## Tags

- id: TRIP-BKR-A
  description: reactor trip breaker A position
  sim-path: rps.trip_breaker.a.position
  units: enum[OPEN,CLOSED]
`

const createProcedureDocument = (): ProcedureDocument =>
  parseProcedureMarkdown({
    source: procedureSource,
    sourcePath: 'wiki/procedures/E-0.md',
    sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/blob/main/wiki/procedures/E-0.md',
    rawMarkdown: procedureMarkdown,
  })

const createProcedureSourceService = (document = createProcedureDocument()): ProcedureSourceService => ({
  readEvidence: async () => { throw new Error('No retained evidence in this route fixture') },
  listSources: () => [{
    sourceId: document.source.sourceId,
    label: document.source.label,
    repository: document.source.repository,
    ref: document.source.ref,
    procedurePath: document.source.path,
  }],
  readCatalog: async (): Promise<ProcedureCatalog> => ({
    source: document.source,
    procedures: [{
      sourceId: document.source.sourceId,
      procedureId: document.procedureId,
      title: document.title,
      ...(document.profile === undefined ? {} : { profile: document.profile }),
      ...(document.category === undefined ? {} : { category: document.category }),
      csfsMonitored: document.csfsMonitored,
      entryTriggers: document.entryTriggers,
      stepCount: document.steps.length,
      tagCount: document.tags.length,
      sourcePath: document.sourcePath,
      sourceUrl: document.sourceUrl,
    }],
  }),
  readDocument: async (config): Promise<ProcedureDocument> => {
    if (config.procedureId !== document.procedureId) throw new Error(`unknown procedure ${config.procedureId}`)
    return document
  },
})

const createTestRegistry = async (config: {
  readonly procedureSourceService?: ProcedureSourceService
} = {}): Promise<SimulationRunRegistry> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-api-test-'))
  return createSimulationRunRegistry({
    dataDir,
    workspaceId: newWorkspaceId(),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
    ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
    ...(config.procedureSourceService === undefined
      ? {}
      : { procedureSourceService: config.procedureSourceService }),
  })
}

const callRoute = async <T>(
  registry: SimulationRunRegistry,
  path: string,
  init?: RequestInit,
): Promise<ApiResponse<T>> => {
  const apiPrefix = `/api/workspaces/${encodeURIComponent(registry.workspaceId)}/world`
  const request = new Request(`http://leitbild.test${apiPrefix}${path}`, init)
  const response = await handleSimulationRunApi(request, new URL(request.url), {
    registry,
    accessContext: accessContextSchema.parse({
      workspaceId: registry.workspaceId,
      requestId: newRequestId(),
      actor: { kind: 'anonymous' },
    }),
  })
  if (!response) throw new Error(`route did not handle ${init?.method ?? 'GET'} ${path}`)
  return { status: response.status, body: await response.json() as T }
}

interface CreatedRunResponse {
  readonly id: SimulationRunId
  readonly scenario?: { readonly id: string; readonly packs: readonly string[] }
  readonly snapshot: {
    readonly seq: number
    readonly scenario?: { readonly scenarioId: string }
    readonly clock?: SimulationClockState
    readonly objects: readonly OperationalObject[]
  }
}

const createRun = async (
  registry: SimulationRunRegistry,
  scenarioId?: string,
): Promise<CreatedRunResponse> => {
  const runtime = await registry.create({ scenarioId: scenarioId ?? 'test-response' })
  const revision = await registry.scenarioRevisionForRun(runtime.id)
  return {
    id: runtime.id,
    snapshot: runtime.snapshot(),
    ...(revision === undefined ? {} : { scenario: await registry.compileScenarioRevision(revision) }),
  }
}

const runPath = (id: SimulationRunId, suffix = ''): string =>
  `/simulation-runs/${encodeURIComponent(id)}${suffix}`

test('procedure HTTP reads independently restore a cold Run and keep missing Runs missing', async () => {
  const registry = await createTestRegistry({ procedureSourceService: createProcedureSourceService() })
  try {
    const created = await createRun(registry)
    for (const suffix of ['/procedures', '/procedures/E-0', '/procedure-runs']) {
      await registry.close(created.id)
      expect(registry.get(created.id)).toBeUndefined()
      const result = await callRoute<Record<string, unknown>>(registry, runPath(created.id, suffix))
      expect(result.status).toBe(200)
      expect(registry.get(created.id)).toBeDefined()
    }
    await registry.delete(created.id)
    for (const suffix of ['/procedures', '/procedures/E-0', '/procedure-runs']) {
      expect((await callRoute(registry, runPath(created.id, suffix))).status).toBe(404)
      expect(registry.get(created.id)).toBeUndefined()
    }
  } finally { await registry.shutdown() }
})

test('presence reports a cold Run without loading it or holding a lease', async () => {
  const registry = await createTestRegistry()
  try {
    const created = await createRun(registry)
    const unleased: SimulationRunRegistry = { ...registry, acquireLease: () => { throw new Error('presence must not lease a Run') } }
    const warm = await callRoute<{ loaded: boolean; execution: { playback: string } }>(unleased, runPath(created.id, '/presence'))
    expect(warm.status).toBe(200)
    expect(warm.body.loaded).toBe(true)
    await registry.close(created.id)
    const cold = await callRoute<{ simulationRunId: string; loaded: boolean; execution: { playback: string; currentSimulationTime: string } }>(unleased, runPath(created.id, '/presence'))
    expect(cold.status).toBe(200)
    expect(cold.body).toMatchObject({ simulationRunId: created.id, loaded: false })
    expect(typeof (cold.body as { title?: unknown }).title).toBe('string')
    expect(typeof cold.body.execution.currentSimulationTime).toBe('string')
    expect(registry.get(created.id)).toBeUndefined()
    await registry.delete(created.id)
    expect((await callRoute(unleased, runPath(created.id, '/presence'))).status).toBe(404)
  } finally { await registry.shutdown() }
})

const capabilityPath = (id: SimulationRunId, capabilityId: string): string =>
  runPath(id, `/capabilities/${encodeURIComponent(capabilityId)}/invoke`)

const closeAll = async (registry: SimulationRunRegistry): Promise<void> => {
  for (const runtime of registry.list()) await registry.close(runtime.id)
}

describe('Simulation Run API', () => {
  test('copies an ordinary Run without a second execution REST surface', async () => {
    const registry = await createTestRegistry()
    try {
      const source = await createRun(registry)
      const created = await callRoute<{ readonly id: SimulationRunId; readonly uiPath: string }>(
        registry,
        runPath(source.id, '/copies'),
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'API copy' }) },
      )
      expect(created.status).toBe(201)
      expect(created.body.uiPath).toContain(created.body.id)
      expect((await registry.summary(created.body.id)).title).toBe('API copy')
    } finally { await registry.shutdown() }
  })
  test('fetches the complete Scenario Definition needed by an active Run UI', async () => {
    const registry = await createTestRegistry()
    const fetched = await callRoute<{
      readonly scenario: {
        readonly id: string
        readonly packs: readonly string[]
        readonly initialObjects: ReadonlyArray<{ readonly packId: string }>
      }
      readonly source: { readonly packs: ReadonlyArray<{ readonly id: string; readonly config: unknown; readonly items: readonly unknown[] }> }
    }>(registry, '/scenarios/halden-power-complex')
    expect(fetched.body.scenario.packs).toEqual(['process-plant', 'electric-grid', 'weather'])
    expect(fetched.body.scenario.initialObjects.filter(object => object.packId === 'weather')).toHaveLength(3)
    expect(fetched.body.scenario.initialObjects.filter(object => object.packId === 'process-plant')).toHaveLength(4)
    const processPlant = fetched.body.source.packs.find(pack => pack.id === 'process-plant')
    expect(processPlant?.config).toEqual({})
    expect(processPlant?.items).toHaveLength(4)
  })

  test('joins only existing runs and exposes their objects and capabilities', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await createRun(registry)
      await registry.close(created.id)
      const joined = await callRoute<CreatedRunResponse>(registry, runPath(created.id))
      expect(joined.status).toBe(200)
      expect(joined.body.id).toBe(created.id)
      expect(joined.body.snapshot.objects).toHaveLength(responseScenario.initialObjects.length)

      const objects = await callRoute<{ readonly objects: readonly OperationalObject[] }>(
        registry,
        runPath(created.id, '/objects'),
      )
      expect(objects.body.objects).toHaveLength(responseScenario.initialObjects.length)

      const capabilities = await callRoute<{
        readonly simulationRunId: SimulationRunId
        readonly scenarioId: string
        readonly activePackIds: readonly string[]
        readonly runtimes: ReadonlyArray<{ readonly id: string; readonly packId: string; readonly clock: string }>
        readonly capabilities: ReadonlyArray<{ readonly id: string; readonly kind: string }>
      }>(registry, runPath(created.id, '/capabilities'))
      expect(capabilities.body).toMatchObject({
        simulationRunId: created.id,
        scenarioId: 'test-response',
        activePackIds: [fixturePackId, 'weather'],
      })
      expect(capabilities.body.runtimes).toContainEqual({ id: fixtureRuntimeId, packId: fixturePackId, clock: 'simulation' })
      expect(capabilities.body.capabilities.some(capability => capability.kind === 'command' && capability.id === fixtureCommandIds.assign)).toBe(true)

      const missing = await callRoute<{ readonly error: { readonly code: string } }>(
        registry,
        '/simulation-runs/run-missing',
      )
      expect(missing.status).toBe(404)
      expect(missing.body.error.code).toBe('simulation_run_not_found')
    } finally {
      await closeAll(registry)
    }
  })

  test('rejects invalid run ids with a structured error', async () => {
    const registry = await createTestRegistry()
    const invalidId = await callRoute<{ readonly error: { readonly code: string } }>(
      registry,
      '/simulation-runs/not-a-run/objects',
    )
    expect(invalidId.status).toBe(400)
    expect(invalidId.body.error.code).toBe('invalid_request')
  })

  test('invokes typed query Capabilities through the run-pinned Capability set', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await createRun(registry)
      const weather = await callRoute<{
        readonly kind: 'query'; readonly result: { readonly state?: unknown }
      }>(registry, capabilityPath(created.id, 'world.weather.sample-at-point'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { point: geoPointFromLonLat(10.7522, 59.9139) },
        }),
      })
      expect(weather.status).toBe(200)
      expect(weather.body.kind).toBe('query')
      expect(weather.body.result.state).toBeTruthy()

      const fixture = await callRoute<{
        readonly kind: 'query'; readonly result: { readonly units?: readonly unknown[] }
      }>(registry, capabilityPath(created.id, fixtureQueryIds.state), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      })
      expect(fixture.body.result.units?.length).toBeGreaterThan(0)
    } finally {
      await closeAll(registry)
    }
  })

  test('records selected Pack observations in the Run Historian and exposes bounded history', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await createRun(registry, 'test-plant')
      const runtime = registry.get(created.id)
      if (!runtime) throw new Error('expected loaded Run')
      await waitForCondition('historian samples', () => (runtime.recordingStatus()?.sampleCount ?? 0) > 0, {
        timeoutMs: 5_000,
        intervalMs: 100,
      })
      const history = await callRoute<{
        readonly status: { readonly seriesCount: number; readonly sampleCount: number }
        readonly series: ReadonlyArray<{ readonly id: string; readonly runtimeId: string; readonly subjectId: string; readonly signalId: string }>
      }>(registry, runPath(created.id, '/history'))
      expect(history.status).toBe(200)
      expect(history.body.status.seriesCount).toBeGreaterThan(0)
      expect(history.body.status.sampleCount).toBeGreaterThan(0)
      const powerSeries = history.body.series.find(series => series.signalId === 'core.totalThermalPowerMw')
      expect(powerSeries).toBeTruthy()
      if (!powerSeries) throw new Error('expected recorded thermal power series')

      const samples = await callRoute<{ readonly samples: ReadonlyArray<{ readonly seriesId: string; readonly value: unknown }> }>(
        registry,
        runPath(created.id, `/history/samples?mode=raw&seriesId=${encodeURIComponent(powerSeries.id)}&limit=2`),
      )
      expect(samples.status).toBe(200)
      expect(samples.body.samples.length).toBeGreaterThan(0)
      expect(samples.body.samples.every(sample => sample.seriesId === powerSeries.id)).toBe(true)
      const summaryPath = runPath(created.id, `/history/samples?runtimeId=${encodeURIComponent(powerSeries.runtimeId)}&seriesId=${encodeURIComponent(powerSeries.id)}`)
      const summary = await callRoute<{ mode: string; windowSummary: { sampleCount: number; qualityCounts: { good: number } } }>(registry, summaryPath)
      expect(summary.body.mode).toBe('summary')
      expect(summary.body.windowSummary.sampleCount).toBeGreaterThan(0)
      expect(summary.body).not.toHaveProperty('samples')
      expect(summary.body).not.toHaveProperty('hasMore')
      expect((await callRoute(registry, `${summaryPath}&beforeSequence=1`)).status).toBe(400)
      expect((await callRoute(registry, runPath(created.id, '/history/samples'))).status).toBe(400)
      expect((await callRoute(registry, `${summaryPath}&mode=unknown`)).status).toBe(400)
    } finally {
      await closeAll(registry)
    }
  })

  test('records dynamically discovered fixture assets through the same Historian boundary', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await createRun(registry, 'test-response')
      const runtime = registry.get(created.id)
      if (!runtime) throw new Error('expected loaded Run')
      await waitForCondition('fixture historian samples', () => (runtime.recordingStatus()?.sampleCount ?? 0) > 0, {
        timeoutMs: 5_000,
        intervalMs: 100,
      })
      const history = await callRoute<{
        readonly series: ReadonlyArray<{ readonly id: string; readonly runtimeId: string; readonly subjectId: string; readonly signalId: string }>
      }>(registry, runPath(created.id, '/history'))
      const statusSeries = history.body.series.find(series =>
        series.runtimeId === fixtureRuntimeId
        && series.subjectId === 'unit:a12'
        && series.signalId === 'operational.status'
      )
      expect(statusSeries).toBeTruthy()
      if (!statusSeries) throw new Error('expected unit status series')

      const samples = await callRoute<{ readonly samples: ReadonlyArray<{ readonly value: unknown }> }>(
        registry,
        runPath(created.id, `/history/samples?mode=raw&seriesId=${encodeURIComponent(statusSeries.id)}&limit=1`),
      )
      expect(samples.body.samples).toHaveLength(1)
      expect(typeof samples.body.samples[0]?.value).toBe('string')
    } finally {
      await closeAll(registry)
    }
  })

  test('reset restores the pinned Scenario without accepting replacement configuration', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await createRun(registry, 'test-response')
      const runtime = registry.get(created.id)
      if (!runtime) throw new Error('expected loaded run')
      const notifications: SimulationRunEvent[][] = []
      const unsubscribe = runtime.subscribe(notification => notifications.push([...notification.events]))
      const facility = created.snapshot.objects.find(object => object.kind === 'facility')
      if (!facility) throw new Error('expected facility')
      await callRoute(registry, capabilityPath(created.id, deleteObjectCommandKind), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { objectId: facility.id },
        }),
      })
      const previousSeq = runtime.snapshot().seq

      const reset = await callRoute<CreatedRunResponse>(registry, runPath(created.id, '/reset'), {
        method: 'POST',
      })
      unsubscribe()
      const resetEvent = notifications.flat().find(event => event.type === 'simulationRun.reset')
      expect(reset.status).toBe(200)
      expect(reset.body.snapshot.scenario?.scenarioId).toBe('test-response')
      expect(reset.body.snapshot.objects.some(object => object.id === facility.id)).toBe(true)
      expect(resetEvent).toMatchObject({
        previousSeq,
        previousScenarioId: 'test-response',
        scenarioId: 'test-response',
      })
    } finally {
      await closeAll(registry)
    }
  })

  test('hard-deletes a run and terminates connected viewer leases', async () => {
    const registry = await createTestRegistry()
    const created = await createRun(registry)
    const releaseViewer = registry.acquireLease(created.id, 'realtime')
    const deleted = await callRoute<{ readonly deleted: boolean }>(
      registry,
      runPath(created.id),
      { method: 'DELETE' },
    )
    expect(deleted.status).toBe(200)
    expect(deleted.body.deleted).toBe(true)
    releaseViewer()
    expect(await registry.listKnown()).toEqual([])
  })

  test('records access-context Capability commands and interaction effects in run-scoped events', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await createRun(registry)
      const unit = created.snapshot.objects.find(object => object.kind === 'mobile_entity')
      const task = created.snapshot.objects.find(object => object.kind === 'incident')
      if (!unit || !task) throw new Error('expected unit and task')
      const idempotencyKey = `api-attribution-${crypto.randomUUID()}`

      const command = await callRoute<{ readonly result: { readonly ok: boolean } }>(
        registry,
        capabilityPath(created.id, fixtureCommandIds.assign),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey,
            input: { unitId: unit.id, taskId: task.id },
          }),
        },
      )
      expect(command.body.result.ok).toBe(true)

      const conflict = await callRoute<{ readonly error: { readonly code: string } }>(
        registry,
        capabilityPath(created.id, fixtureCommandIds.assign),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey,
            input: { unitId: unit.id, taskId: unit.id },
          }),
        },
      )
      expect(conflict.status).toBe(409)
      expect(conflict.body.error.code).toBe('idempotency_conflict')

      const signal = await callRoute<{ readonly signal: { readonly type: string } }>(
        registry,
        runPath(created.id, '/signals'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actorId: 'actor:test-api-operator',
            source: { kind: 'object', id: unit.id },
            type: 'test.operator-note',
            targetObjectIds: [task.id],
            payload: { targetObjectId: task.id },
          }),
        },
      )
      expect(signal.status).toBe(202)

      const events = await callRoute<{
        readonly events: ReadonlyArray<{
          readonly simulationRunId: SimulationRunId
          readonly type: string
          readonly command?: { readonly actorId: string; readonly clientId?: string }
        }>
      }>(registry, runPath(created.id, '/events'))
      expect(events.body.events.every(event => event.simulationRunId === created.id)).toBe(true)
      expect(events.body.events.find(event => event.type === 'command.issued')?.command?.actorId)
        .toBe('actor:operator')
      expect(events.body.events.some(event => event.type === 'interaction.signal.received')).toBe(true)
      // Unhandled external signals are recorded, not allowed to fabricate arrival/transfer effects.
      expect(events.body.events.some(event => event.type === 'notification.emitted')).toBe(false)
    } finally {
      await closeAll(registry)
    }
  })

  test('exposes procedure sources and synchronizes procedure state through Capabilities', async () => {
    const registry = await createTestRegistry({ procedureSourceService: createProcedureSourceService() })
    try {
      const created = await createRun(registry)
      const catalog = await callRoute<{ readonly catalog: ProcedureCatalog }>(
        registry,
        runPath(created.id, '/procedures'),
      )
      expect(catalog.body.catalog.procedures.map(procedure => procedure.procedureId)).toEqual(['E-0'])

      const document = await callRoute<{ readonly procedure: ProcedureDocument }>(
        registry,
        runPath(created.id, '/procedures/E-0'),
      )
      expect(document.body.procedure.steps.map(step => step.id)).toEqual(['verify-reactor-trip'])

      const targetObject = registry.get(created.id)!.snapshot().objects[0]!
      const started = await callRoute<{ readonly kind: string; readonly result: { readonly ok: boolean } }>(registry, capabilityPath(created.id, 'world.procedure.run.start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: {
            sourceId: 'pwr-ops',
            sourceRevision: procedureSource.revision,
            procedureId: 'E-0',
            scope: {
              plantId: targetObject.id,
              targetObjectId: targetObject.id,
              label: 'Procedure API unit',
            },
          },
        }),
      })
      expect(started.body.result.ok).toBe(true)
      const runs = await callRoute<{
        readonly procedures: { readonly runs: ReadonlyArray<{ readonly procedureId: string; readonly status: string }> }
      }>(registry, runPath(created.id, '/procedure-runs'))
      expect(runs.body.procedures.runs).toEqual([
        expect.objectContaining({ procedureId: 'E-0', status: 'active' }),
      ])
    } finally {
      await closeAll(registry)
    }
  })

})
