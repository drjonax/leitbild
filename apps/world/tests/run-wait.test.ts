import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import type { ActorId, EventId, IsoTimestamp, SimulationRunEvent, SimulationRunId } from '../src/core/model/index.ts'
import { createServer } from '../src/core/api/server.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { drivenRunsOf, runWaitInputSchema, waitForRunChange, type RunWaitPorts } from '../src/core/simulation-runs/run-wait.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

const assistant = 'actor:ai:assistant' as ActorId
const operator = 'actor:operator' as ActorId
const runId = 'procedure-run:wait'
const startTime = Date.parse('2026-10-13T08:00:00.000Z')

// Test-only Run: a journal, a plant clock and wall time the test moves by hand.
const fakeRun = () => {
  const journal: SimulationRunEvent[] = []
  let seq = 10
  let wall = 0
  let plantMs = startTime
  let paused = false
  const wakes = new Set<() => void>()
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = []
  const event = (body: Record<string, unknown>): SimulationRunEvent => ({
    id: `event:${++seq}` as EventId, simulationRunId: 'run-wait' as SimulationRunId, seq, at: new Date(startTime).toISOString() as IsoTimestamp,
    provenance: { source: 'operator' }, ...body,
  }) as SimulationRunEvent
  const ports: RunWaitPorts = {
    events: after => journal.filter(item => item.seq > after),
    sequence: () => seq,
    clock: () => ({ currentTime: new Date(plantMs).toISOString() as IsoTimestamp, paused }),
    subscribe: wake => { wakes.add(wake); return () => wakes.delete(wake) },
    now: () => wall,
    schedule: (callback, delayMs) => {
      const timer = { at: wall + delayMs, callback, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  }
  return {
    ports,
    commit: (body: Record<string, unknown>, durable = true) => {
      const committed = event(body)
      if (durable) journal.push(committed)
      for (const wake of [...wakes]) wake()
      return committed
    },
    // Moves wall and plant time together, firing due timers in order.
    advance: (ms: number, plantRate = 1) => {
      const until = wall + ms
      while (true) {
        const due = timers.filter(timer => !timer.cancelled && timer.at <= until).sort((left, right) => left.at - right.at)[0]
        if (due === undefined) break
        plantMs += paused ? 0 : (due.at - wall) * plantRate
        wall = due.at
        due.cancelled = true
        due.callback()
      }
      plantMs += paused ? 0 : (until - wall) * plantRate
      wall = until
    },
    pause: () => { paused = true },
    wakes,
    pendingTimers: () => timers.filter(timer => !timer.cancelled).length,
  }
}

const driverChanged = (changedBy: ActorId, driver?: { kind: 'ai' | 'person'; actorId: ActorId }) => ({
  type: 'procedure.run.driver.changed', runId, ...(driver === undefined ? {} : { driver: { ...driver, since: new Date(startTime).toISOString() } }),
  reason: driver?.kind === 'person' ? 'claimed' : 'released', changedAt: new Date(startTime).toISOString(), changedBy,
})
const proposalApproved = (type = 'process-plant.proposal.approved') => ({
  type: 'interaction.signal.received',
  signal: { id: `signal:${type}`, simulationRunId: 'run-wait', at: new Date(startTime).toISOString(), source: { kind: 'simulation', id: 'process-plant.sim' },
    targets: [{ kind: 'broadcast' }], type, payload: { proposalId: 'proposal:1' } },
})
const driven = [{ runId, procedureId: 'E-0', sourceId: 'leitbild', plantId: 'plant:unit-2' }]

describe('waiting for a Run change', () => {
  test('returns at plant time, from now when no afterSequence is given, and cleans up its timers and subscription', async () => {
    const run = fakeRun()
    const waiting = waitForRunChange({ input: runWaitInputSchema.parse({ simulationSeconds: 5 }), caller: assistant, driven, ports: run.ports })
    run.advance(4_900)
    run.advance(200)
    const result = await waiting
    expect(result).toMatchObject({ reason: 'simulation-time', fromSequence: 10, sequence: 10, waitedMs: 5_000 })
    expect(Date.parse(result.simulationTime) - startTime).toBeGreaterThanOrEqual(5_000)
    expect(run.wakes.size).toBe(0)
    expect(run.pendingTimers()).toBe(0)
  })

  test('returns at the first matching durable event after afterSequence, and at once for one already committed', async () => {
    const run = fakeRun()
    const filter = { events: [{ type: 'interaction.signal.received', signalType: 'process-plant.proposal.approved' }] }
    const waiting = waitForRunChange({ input: runWaitInputSchema.parse(filter), caller: assistant, driven, ports: run.ports })
    run.commit(proposalApproved('process-plant.proposal.recorded'))
    run.commit(proposalApproved(), false) // a projected change never wakes a wait
    run.advance(1_000)
    const approved = run.commit(proposalApproved())
    const result = await waiting
    expect(result).toMatchObject({ reason: 'event', fromSequence: 10, events: [approved] })

    const again = await waitForRunChange({ input: runWaitInputSchema.parse({ ...filter, afterSequence: 10 }), caller: assistant, driven, ports: run.ports })
    expect(again).toMatchObject({ reason: 'event', waitedMs: 0, events: [approved] })
    const later = waitForRunChange({ input: runWaitInputSchema.parse({ ...filter, afterSequence: approved.seq, maxWaitMs: 2_000 }), caller: assistant, driven, ports: run.ports })
    run.advance(2_000)
    expect(await later).toMatchObject({ reason: 'timeout', fromSequence: approved.seq, waitedMs: 2_000 })
  })

  test('returns when someone else takes over, releases or closes a Run the caller drives, never for its own change', async () => {
    const run = fakeRun()
    const waiting = waitForRunChange({ input: runWaitInputSchema.parse({ simulationSeconds: 60 }), caller: assistant, driven, ports: run.ports })
    run.commit(driverChanged(assistant, { kind: 'ai', actorId: assistant }))
    run.advance(500)
    const takeover = run.commit(driverChanged(operator, { kind: 'person', actorId: operator }))
    expect(await waiting).toMatchObject({ reason: 'driver-changed', events: [takeover],
      driverChanged: { runId, procedureId: 'E-0', change: 'procedure.run.driver.changed', by: operator, driver: { kind: 'person' } } })

    const closing = fakeRun()
    const pending = waitForRunChange({ input: runWaitInputSchema.parse({ simulationSeconds: 60 }), caller: assistant, driven, ports: closing.ports })
    closing.commit({ type: 'procedure.run.closed', runId, status: 'abandoned', closedAt: new Date(startTime).toISOString(), closedBy: operator })
    expect(await pending).toMatchObject({ reason: 'driver-changed', driverChanged: { change: 'procedure.run.closed', status: 'abandoned', by: operator } })

    // Runs the caller does not drive do not end its wait.
    const other = fakeRun()
    const unrelated = waitForRunChange({ input: runWaitInputSchema.parse({ simulationSeconds: 1 }), caller: assistant, driven: [], ports: other.ports })
    other.commit(driverChanged(operator, { kind: 'person', actorId: operator }))
    other.advance(1_000)
    expect(await unrelated).toMatchObject({ reason: 'simulation-time' })
  })

  test('a paused clock ends a wait for plant time at once; an event wait keeps waiting on it', async () => {
    const run = fakeRun()
    run.pause()
    expect(await waitForRunChange({ input: runWaitInputSchema.parse({ simulationSeconds: 30 }), caller: assistant, driven, ports: run.ports }))
      .toMatchObject({ reason: 'clock-paused', paused: true, waitedMs: 0 })
    const events = waitForRunChange({ input: runWaitInputSchema.parse({ events: [{ type: 'procedure.branch.selected', procedureRunId: runId }], maxWaitMs: 3_000 }), caller: assistant, driven, ports: run.ports })
    run.advance(3_000)
    expect(await events).toMatchObject({ reason: 'timeout', paused: true })
    expect(runWaitInputSchema.safeParse({}).success).toBe(false)
    expect(runWaitInputSchema.safeParse({ simulationSeconds: 5, maxWaitMs: 25_000 }).success).toBe(false)
  })

  test('the Runs a caller drives include those it drove before someone else took them', () => {
    const runs = [{ runId, procedureId: 'E-0', sourceId: 'leitbild', scope: { plantId: 'plant:unit-2' }, driver: { kind: 'person', actorId: operator } },
      { runId: 'procedure-run:other', procedureId: 'ES-0.1', sourceId: 'leitbild', scope: { plantId: 'plant:unit-2' } }] as never
    const journal = [{ type: 'procedure.run.driver.changed', runId, driver: { kind: 'ai', actorId: assistant } }] as never
    expect(drivenRunsOf(assistant, runs, journal)).toEqual(driven)
  })
})

const directories: string[] = []
const registries: WorldWorkspaceRuntimeRegistry[] = []
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.shutdown()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('waiting through the World server', () => {
  test('a wait longer than Bun\'s 10 s idle limit answers through the capability invoke route', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'world-run-wait-server-'))
    directories.push(dataDir)
    const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters() })
    registries.push(workspaces)
    const server = createServer({ workspaces, featuredDefinitions: { definitions: [], listed: [] }, port: 0, bindHost: '127.0.0.1', mapArtifacts: { rootDir: dataDir } })
    try {
      const workspaceId = newWorkspaceId()
      const base = `http://127.0.0.1:${server.port}/internal/workspaces/${workspaceId}`
      expect((await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })).status).toBe(201)
      const run = await workspaces.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'test-response' })
      const capabilityId = 'world.simulation-run.wait'
      const started = performance.now()
      const response = await fetch(`${base}/capabilities/${capabilityId}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id },
        input: { events: [{ type: 'procedure.branch.selected' }], maxWaitMs: 12_000 },
        access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'waiter' } }),
      }) })
      expect(response.status).toBe(200)
      const body = await response.json() as { result: { reason: string; waitedMs: number } }
      expect(body.result.reason).toBe('timeout')
      expect(body.result.waitedMs).toBeGreaterThanOrEqual(12_000)
      expect(performance.now() - started).toBeGreaterThanOrEqual(12_000)
    } finally { await server.stop() }
  }, 60_000)
})
