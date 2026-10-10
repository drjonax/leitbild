import { describe, expect, test } from 'bun:test'
import { actorIdSchema, isoTimestampSchema, nowIso, type SimulationRunEvent, type SimulationRunId } from '../src/core/model/index.ts'
import { createSimulationClock } from '../src/core/model/time.ts'
import type { EventLog } from '../src/core/simulation-runs/event-log.ts'
import { createSimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { createSimulationRunStateStore, type SimulationRunStateSnapshot } from '../src/core/simulation-runs/state-store.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { worldCoreCapabilities } from '../src/simulation/core-capabilities.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { createTestScenarioRuntimeResolver, waitForCondition } from './helpers.ts'
import { deferred, procedureTestSource } from './procedure-fixtures.ts'

const operator = { id: actorIdSchema.parse('operator:observation-timeout'), label: 'Timeout test operator', role: 'operator' as const }
const conditionCapabilityId = 'world.process-plant.procedure-condition.evaluate'

// The wall-time transport budget a healthy read must finish within: at load
// 120 a healthy read overran 25 ms, so it is a second, and every bound below
// tells a read cut off by the budget from one blocking on a hung transport.
const acquisitionBudgetMs = 1_000

/** Run, Hub, Process Plant and dispatch are real; only read-side transport is gated. */
const setup = async (options: { readonly steps?: number; readonly restored?: SimulationRunStateSnapshot; readonly hangSource?: boolean; readonly timeoutMs?: number } = {}) => {
  const source = scenarios.find(scenario => scenario.id === 'test-plant')!
  const resolved = createTestScenarioRuntimeResolver().resolve(source)!
  const scenario = { scenarioId: resolved.scenarioId, runtimeIds: resolved.runtimes.map(runtime => runtime.runtimeId),
    connections: resolved.scenario.connections, world: resolved.scenario.world, initialObjects: resolved.initialObjects,
    runtimeConfigByRuntimeId: resolved.runtimeConfigByRuntimeId, runtimeConfig: {} }
  const id = `run-observation-timeout-${crypto.randomUUID()}` as SimulationRunId
  const stateStore = createSimulationRunStateStore()
  const clock = createSimulationClock({ currentTime: scenario.world.startsAt, updatedAt: nowIso(), paused: true })
  const initial = options.restored ?? { objects: scenario.initialObjects, seq: 0, clock: clock.read() }
  stateStore.hydrate(initial)
  const adapter = createLocalProcessPlantPackRuntimeAdapter()
  const actual = await createRuntimeHub([adapter]).connect({ simulationRunId: id, scenario,
    initialObjects: initial.objects, runClock: clock, objectById: stateStore.getObject })
  const plants = await actual.invokeQuery({ capabilityId: 'world.process-plant.plants.list', input: {} }) as { plants: Array<{ id: string; modelRef: string; modelDigest: string }> }
  const plant = plants.plants[0]!
  const document = parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'wiki/procedures/TIMEOUT.md',
    sourceUrl: 'https://example.test/TIMEOUT.md', rawMarkdown: `---
type: procedure
procedure-md: 0.7
procedure-id: TIMEOUT
title: Read transport test, not an operating criterion
---
# Read transport test
${Array.from({ length: options.steps ?? 1 }, (_, index) => `## Step ${index + 1} [id: read-${index}]
Check: Test-only runtime pump comparison; no CSF adequacy claim.
\`\`\`procedure-observation
${JSON.stringify({ capabilityId: conditionCapabilityId, continuous: true, input: {
  condition: { type: 'comparison', signal: { path: 'rcpA.running' }, operator: '==', value: true, unit: 'boolean' },
  basis: { modelRef: plant.modelRef, modelDigest: plant.modelDigest, source: 'test-only', description: `Transport fixture ${index}, not an operating criterion` },
} })}
\`\`\`
- Assessed [outcome: normal] → END`).join('\n')}
` })
  let mode: 'healthy' | 'hang' | 'reject' = 'healthy'
  let queryCalls = 0
  let sourceCalls = 0
  const queryGate = deferred<void>()
  const sourceGate = deferred<void>()
  const persisted: SimulationRunEvent[] = []
  const eventLog: EventLog = { appendMany: async events => { persisted.push(...events) }, readAll: async () => persisted,
    readAfter: async seq => persisted.filter(event => event.seq > seq), readLast: async () => persisted.at(-1) ?? null,
    readLastSeq: async () => persisted.at(-1)?.seq ?? 0, sizeBytes: async () => JSON.stringify(persisted).length }
  let saved: SimulationRunStateSnapshot | null = null
  const runtime = await createSimulationRunRuntime({ id, stateStore, runClock: clock, restoredSnapshot: initial,
    runtimeConnection: { ...actual, invokeQuery: async request => {
      if (request.capabilityId !== conditionCapabilityId) return await actual.invokeQuery(request)
      queryCalls++
      if (mode === 'reject') throw new Error('Read transport failed')
      const response = await actual.invokeQuery(request)
      if (mode === 'hang') await queryGate.promise
      return response
    } }, eventLog, snapshotStore: { load: async () => saved, save: async snapshot => { saved = snapshot } },
    observationAcquisitionTimeoutMs: options.timeoutMs ?? acquisitionBudgetMs,
    scenario: { id: scenario.scenarioId, startsAt: scenario.world.startsAt, agentRestrictions: { operationIds: [], objects: [] } },
    runtimeCapabilities: [...adapter.capabilities.map(capability => ({ packId: adapter.packId, runtimeId: adapter.id, capability })),
      ...worldCoreCapabilities.map(capability => ({ packId: 'world', runtimeId: 'world.core', capability }))],
    procedureSourceService: { listSources: () => [], readCatalog: async () => { throw new Error('Not needed') },
      readEvidence: async () => { throw new Error('Not needed') }, readDocument: async () => {
        sourceCalls++
        if (options.hangSource) await sourceGate.promise
        return document
      } },
  })
  const command = async (capabilityId: string, input: unknown) => {
    const response = await runtime.invokeCapability(operator, { capabilityId, input })
    expect(response.kind === 'command' && response.result.ok).toBe(true)
  }
  const current = () => runtime.snapshot().procedures!.runs[0]!
  return { runtime, plant, current, command, calls: () => ({ query: queryCalls, source: sourceCalls }),
    mode: (next: typeof mode) => { mode = next }, queryGate, sourceGate,
    start: async () => await command('world.procedure.run.start', { sourceId: procedureTestSource.sourceId,
      sourceRevision: procedureTestSource.revision, procedureId: 'TIMEOUT', scope: { plantId: plant.id } }),
    scan: async () => await command('world.procedure.step.update', { runId: current().runId, stepId: 'read-0', comment: crypto.randomUUID() }),
  }
}

/** A hung transport would block forever; a read the budget cut off returns within it. */
const within = async <T>(promise: Promise<T>, wallMs = 10 * acquisitionBudgetMs): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Observer blocked runtime progress')), wallMs) })]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

describe('bounded read-only procedure acquisition', () => {
  test('hung query withdraws green, suppresses duplicate pending reads, ignores late evidence and permits controls, retry and close', async () => {
    const fixture = await setup()
    try {
      await fixture.start()
      expect(fixture.current().observations?.[0]?.result.status).toBe('satisfied')
      fixture.mode('hang')
      await within(fixture.scan())
      expect(fixture.current().observations?.[0]?.result).toMatchObject({ status: 'unknown', reason: expect.stringContaining('wall-time transport budget') })
      const calls = fixture.calls().query
      await within(fixture.scan())
      expect(fixture.calls().query).toBe(calls)
      await within(fixture.command('world.process-plant.control.write', { plantId: fixture.plant.id, path: 'rcpA.running', value: false }))
      const target = isoTimestampSchema.parse(new Date(Date.parse(fixture.runtime.snapshot().clock!.currentTime) + 2_000).toISOString())
      await within(fixture.runtime.runMaximumPace(target, { shouldStop: () => false }))
      fixture.queryGate.resolve()
      await Bun.sleep(10)
      expect(fixture.current().observations?.[0]?.result.status).toBe('unknown')
      fixture.mode('healthy')
      await fixture.scan()
      expect(fixture.current().observations?.[0]?.result.status).toBe('challenged')
      fixture.mode('reject')
      await fixture.scan()
      expect(fixture.current().observations?.[0]?.result).toMatchObject({ status: 'unknown', reason: 'Read transport failed' })
      fixture.mode('healthy')
      await fixture.scan()
      expect(fixture.current().observations?.[0]?.result.status).toBe('challenged')
      await within(fixture.runtime.close())
    } finally { fixture.queryGate.resolve(); await fixture.runtime.close() }
  })

  test('one pass budget bounds many distinct stalled bindings and close does not await the unresolved read', async () => {
    const fixture = await setup({ steps: 12, timeoutMs: 250 })
    try {
      fixture.mode('hang')
      const startedAt = performance.now()
      await within(fixture.start())
      // One pass budget starts a pass's first stalled read and none after it:
      // the start's pass, and each pass the Run's one-second observation timer
      // coalesced meanwhile, start one read at most. A budget per binding would
      // start all twelve, leaving none "not started".
      const timerPasses = Math.floor((performance.now() - startedAt) / 1_000) + 1
      expect(fixture.calls().query).toBeLessThanOrEqual(1 + timerPasses)
      expect(fixture.current().observations).toHaveLength(12)
      expect(fixture.current().observations?.every(observation => observation.result.status === 'unknown')).toBe(true)
      expect(fixture.current().observations?.some(observation => observation.result.reason?.includes('this read was not started'))).toBe(true)
      await within(fixture.runtime.close())
    } finally { fixture.queryGate.resolve(); await fixture.runtime.close() }
  })

  test('hung source withdraws restored evidence without repeated reads or blocking controls and shutdown', async () => {
    const first = await setup()
    await first.start()
    const restored = structuredClone(first.runtime.snapshot())
    await first.runtime.close()
    const fixture = await setup({ restored, hangSource: true })
    try {
      await waitForCondition('source timeout withdraws restored success', () => fixture.current().observations?.[0]?.result.status === 'unknown')
      expect(fixture.current().observations?.[0]?.result.reason).toContain('source unavailable')
      await Bun.sleep(1_100)
      expect(fixture.calls().source).toBe(1)
      await within(fixture.runtime.setClock({ paused: true }))
      await within(fixture.runtime.close())
      fixture.sourceGate.resolve()
      await Bun.sleep(10)
      expect(fixture.current().observations?.[0]?.result.status).toBe('unknown')
    } finally { fixture.sourceGate.resolve(); await fixture.runtime.close() }
  })

  test('timer coalesces a slow scan instead of queuing another control-blocking acquisition pass', async () => {
    const fixture = await setup({ steps: 12, timeoutMs: 1_500 })
    try {
      await fixture.start()
      const baselineCalls = fixture.calls().query
      fixture.mode('hang')
      await waitForCondition('timer enters its one slow scan', () => fixture.calls().query > baselineCalls)
      // The nominal second timer tick occurs while this first scan is pending.
      await Bun.sleep(1_050)
      await within(fixture.runtime.setClock({ paused: true }), 800)
      expect(fixture.calls().query).toBe(baselineCalls + 1)
      expect(fixture.current().observations?.every(observation => observation.result.status === 'unknown')).toBe(true)
      await within(fixture.runtime.close())
    } finally { fixture.queryGate.resolve(); await fixture.runtime.close() }
  })
})
