import { afterAll, describe, expect, test } from 'bun:test'
import type { ActorId, IsoTimestamp, SimulationRunEvent } from '../src/core/model/index.ts'
import { simulationRunEventSchema } from '../src/core/model/events.ts'
import { maximumPaceStepMs } from '../src/core/simulation-runs/execution.ts'
import type { SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { fixtureCommandIds } from './fixtures/fixture-runtime.ts'
import { createRoleRunRegistry } from './fixtures/role-runs.ts'

// Clocks (plan v3.1 §2.2, architecture A3): the runtime stamps the Run's simulation time on every event it commits,
// once per committed batch, so the journal and notifications carry the same value. At maximum pace a stamp is the
// slice boundary the Run stood at, so a Pack's change in that slice is stamped at most one slice early.

const operator = { id: 'actor:human:stamps' as ActorId, label: 'Stamps', role: 'operator' as const }
const registries: SimulationRunRegistry[] = []
afterAll(async () => { for (const registry of registries.splice(0)) await registry.shutdown() })

describe('simulation time stamps', () => {
  test('every committed event carries the Run clock it was committed at, in the journal and in notifications alike', async () => {
    const registry = await createRoleRunRegistry()
    registries.push(registry)
    const run = await registry.create({ scenarioId: 'open-run' })
    await run.setClock({ paused: true })
    const notified: SimulationRunEvent[] = []
    run.subscribe(message => { if (message.type === 'event.notification') notified.push(...message.events) })
    const before = run.events().length
    const pausedAt = run.snapshot().clock!.currentTime
    const outcome = await run.invokeCapability(operator, { capabilityId: fixtureCommandIds.assign, input: { unitId: 'unit:one', taskId: 'task:one' } })
    expect(outcome).toMatchObject({ kind: 'command', result: { ok: true } })
    const assigned = run.events().slice(before)
    expect(assigned.map(event => event.type)).toEqual(expect.arrayContaining(['command.issued', 'command.result', 'object.upserted']))
    expect(new Set(assigned.map(event => event.simulationTime))).toEqual(new Set([pausedAt]))
    const issued = assigned.find(event => event.type === 'command.issued')
    expect(issued?.type === 'command.issued' && issued.command.issuedAt).toBe(pausedAt)

    const boundaries = new Set<string>([pausedAt])
    const startMs = Date.parse(pausedAt)
    await run.runMaximumPace(new Date(startMs + 6 * maximumPaceStepMs).toISOString() as IsoTimestamp, {
      shouldStop: () => false, onProgress: time => { boundaries.add(time) },
    })
    const paced = run.events().slice(before + assigned.length)
    expect(paced.length).toBeGreaterThan(0)
    for (const event of [...paced, ...notified]) expect(boundaries.has(event.simulationTime!)).toBe(true)
    expect(paced.at(-1)).toMatchObject({ type: 'clock.updated', simulationTime: run.snapshot().clock!.currentTime })
    expect(maximumPaceStepMs).toBeLessThanOrEqual(1_000)
    // Every event the Run notified is one it committed with the same stamp.
    const committed = new Map(run.events().map(event => [event.id, event.simulationTime]))
    for (const event of notified) if (committed.has(event.id)) expect(event.simulationTime).toBe(committed.get(event.id))
  })

  test('the stamp survives the journal and an event saved without one still parses, as time unknown', () => {
    const event = { id: 'event:1', simulationRunId: 'run-stamps', seq: 1, at: '2026-10-20T08:00:00.000Z', provenance: { source: 'system' }, type: 'scenario.cue.started', cueId: 'opening' }
    expect(simulationRunEventSchema.parse(event)).not.toHaveProperty('simulationTime')
    expect(simulationRunEventSchema.parse({ ...event, simulationTime: '2026-01-01T08:00:05.000Z' }).simulationTime as string | undefined).toBe('2026-01-01T08:00:05.000Z')
    expect(simulationRunEventSchema.safeParse({ ...event, simulationTime: 'soon' }).success).toBe(false)
  })
})
