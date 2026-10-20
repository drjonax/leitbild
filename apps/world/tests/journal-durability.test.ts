import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IsoTimestamp, OperationalObject, SimulationRunEvent } from '../src/core/model/index.ts'
import { keepsStateChange } from '../src/core/simulation-runs/persistence-policy.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createFixtureObject } from './fixtures/fixture-pack.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The journal rule (plan v3.1 §2.2, V7; architecture A3): an upsert that changes an object's lifecycle, status,
// priority or alerts is durable even where its Pack marks it snapshot-only; packData churn stays projected.

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const at = '2026-10-20T08:00:00.000Z' as IsoTimestamp
const base = createFixtureObject({ type: 'unit', id: 'unit:one' as never, label: 'Unit One', position: [10.7, 59.9], speedMps: 12 }, { at, objectById: () => undefined })
const alert = { id: 'a1', kind: 'overspeed', severity: 'warning', message: 'Overspeed', raisedAt: at, acknowledged: false } as const

describe('the journal rule', () => {
  test('a new object and every lifecycle, status, priority or alert change are state changes; churn is not', () => {
    const changed = (patch: Partial<OperationalObject>) => keepsStateChange(base, { ...base, ...patch, revision: base.revision + 1 })
    expect(keepsStateChange(undefined, base)).toBe(true)
    expect(changed({ lifecycle: 'resolved' })).toBe(true)
    expect(changed({ operational: { ...base.operational, status: 'en_route' } })).toBe(true)
    expect(changed({ operational: { ...base.operational, priority: 'high' } })).toBe(true)
    expect(changed({ alerts: [alert] })).toBe(true)
    expect(keepsStateChange({ ...base, alerts: [alert] }, { ...base, alerts: [{ ...alert, acknowledged: true }] })).toBe(true)
    expect(changed({ packData: { type: 'unit', speedMps: 13 } })).toBe(false)
    expect(changed({ spatial: { ...base.spatial, position: { ...base.spatial.position!, speedMps: 9 } } })).toBe(false)
    expect(changed({ operational: { ...base.operational, mode: 'live' } })).toBe(false)
    expect(keepsStateChange({ ...base, alerts: [alert] }, { ...base, revision: 7, alerts: [{ ...alert }] })).toBe(false)
  })

  test('a Plant trip at maximum pace is journalled as status upserts while its every-step projections are not', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-journal-rule-'))
    const registry = createSimulationRunRegistry({
      dataDir, workspaceId: newWorkspaceId(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    cleanups.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
    // test-plant trips by itself about 2 s in (SG A low-low level → reactor trip, turbine trip at 3 s).
    const run = await registry.create({ scenarioId: 'test-plant' })
    await run.setClock({ paused: true })
    const startMs = Date.parse(run.snapshot().clock!.currentTime)
    const steps: SimulationRunEvent[] = []
    run.subscribe(message => { if (message.type === 'event.notification') steps.push(...message.events) })
    await run.runMaximumPace(new Date(startMs + 8_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    const journalled = run.events().flatMap(event => event.type === 'object.upserted' && event.object.packId === 'process-plant' ? [event.object] : [])
    expect(journalled.map(object => object.operational.status)).toContain('critical')
    // Every journalled upsert carries a state change against the one journalled before it: nothing in between changed state.
    journalled.slice(1).forEach((object, index) => expect(keepsStateChange(journalled[index], object)).toBe(true))
    const projected = steps.filter(event => event.type === 'object.upserted' && event.object.packId === 'process-plant')
    expect(journalled.length).toBeLessThan(10)
    expect(Math.max(...[...journalled, ...projected.map(event => event.type === 'object.upserted' ? event.object : base)].map(object => object.revision)))
      .toBeGreaterThan(journalled.length * 2)
  })
})
