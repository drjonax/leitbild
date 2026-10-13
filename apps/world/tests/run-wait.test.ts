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
  let closed = false
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
    closed: () => closed,
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
    close: () => { closed = true },
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

  test('a wait ends at its next tick when its Run closes, and cleans up its timers and subscription', async () => {
    const run = fakeRun()
    const waiting = waitForRunChange({ input: runWaitInputSchema.parse({ events: [{ type: 'procedure.branch.selected' }] }), caller: assistant, driven, ports: run.ports })
    run.close()
    run.advance(250)
    await expect(waiting).rejects.toMatchObject({ code: 'simulation_run_closed' })
    expect(run.wakes.size).toBe(0)
    expect(run.pendingTimers()).toBe(0)
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

  // The AI procedure runner waits on a Run most of the time; deleting the Run or
  // its Workspace must stop it, not answer busy or hold the delete for 20 s.
  const startWaiting = async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'world-run-wait-delete-'))
    directories.push(dataDir)
    const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters() })
    registries.push(workspaces)
    const server = createServer({ workspaces, featuredDefinitions: { definitions: [], listed: [] }, port: 0, bindHost: '127.0.0.1', mapArtifacts: { rootDir: join(dataDir, 'maps') } })
    const workspaceId = newWorkspaceId()
    const base = `http://127.0.0.1:${server.port}/internal/workspaces/${workspaceId}`
    expect((await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })).status).toBe(201)
    const run = await workspaces.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'test-response' })
    const resource = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }
    const invoke = (capabilityId: string, input: unknown, kind: 'ai' | 'human') => fetch(`${base}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        workspaceId, capabilityId, resource, input,
        access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: kind === 'ai' ? { kind, id: 'waiter' } : { kind } }),
      }),
    })
    const started = performance.now()
    const waiting = invoke('world.simulation-run.wait', { events: [{ type: 'procedure.branch.selected' }], maxWaitMs: 20_000 }, 'ai')
    // The wait holds its Run before anything is deleted.
    while (workspaces.getLoaded(workspaceId)!.simulationRuns.leaseSummary(run.id).leasesByKind.api === 0) await Bun.sleep(10)
    return { dataDir, server, workspaces, workspaceId, base, run, invoke, started, waiting }
  }

  test('deleting a Run an AI is waiting on stops it: the delete succeeds and the wait ends at once', async () => {
    const { server, invoke, run, started, waiting, workspaceId, dataDir } = await startWaiting()
    try {
      const deleted = await invoke('world.simulation-run.delete', {}, 'human')
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toEqual({ result: { deleted: true, simulationRunId: run.id } })
      const waited = await waiting
      expect(waited.status).toBe(409)
      expect((await waited.json() as { error: { code: string } }).error.code).toBe('simulation_run_closed')
      expect(performance.now() - started).toBeLessThan(5_000)
      expect(await Bun.file(join(dataDir, 'workspaces', workspaceId, 'world', 'simulation-runs', run.id, 'manifest.json')).exists()).toBe(false)
    } finally { await server.stop() }
  }, 30_000)

  test('removing a Workspace while an AI waits on its Run answers at once and leaves no World state', async () => {
    const { server, workspaces, workspaceId, base, started, waiting, dataDir } = await startWaiting()
    try {
      const removed = await fetch(base, { method: 'DELETE' })
      expect(removed.status).toBe(204)
      expect(performance.now() - started).toBeLessThan(5_000)
      expect((await waiting).status).toBe(409)
      expect(workspaces.getLoaded(workspaceId)).toBeUndefined()
      expect(await workspaces.list()).toEqual([])
      expect(await Bun.file(join(dataDir, 'workspaces', workspaceId, 'world', 'workspace.json')).exists()).toBe(false)
    } finally { await server.stop() }
  }, 30_000)
})
