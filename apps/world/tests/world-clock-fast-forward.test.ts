import { newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSimulationRunRealtimeManager } from '../src/core/api/realtime.ts'
import type { OperationalObject, ScenarioExecutionState, SimulationClockState } from '../src/core/model/index.ts'
import type { RunExecutionState } from '../src/core/simulation-runs/execution.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunStateSnapshot } from '../src/core/simulation-runs/state-store.ts'
import { applySimulationRunEventBatchMessage, parseSimulationRunWebSocketMessage } from '../src/ui/simulation-run-events.ts'
import { simulationTimeAt } from '../src/ui/simulation-clock.ts'
import { createWorldClockOrder, executionClockReading, type ClockReadTicket, worldClockView } from '../src/ui/world-clock.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

/**
 * The World view's Run stores, fed as its route feeds them: the joined
 * snapshot, every realtime message as wire JSON, and each execution read,
 * asked for and answered, in the clock order the route keeps.
 */
const createWorldView = (snapshot: SimulationRunStateSnapshot) => {
  const order = createWorldClockOrder()
  let objects: ReadonlyArray<OperationalObject> = snapshot.objects
  let scenarioState: ScenarioExecutionState | undefined = snapshot.scenario
  let clock: SimulationClockState | undefined = order.published(snapshot.clock)
  let execution: RunExecutionState | null = null
  const answer = (ticket: ClockReadTicket, next: RunExecutionState): void => {
    execution = next
    const reading = executionClockReading(next)
    if (reading && order.readApplies(ticket)) clock = reading
  }
  return {
    receive: (wire: unknown): void => {
      const message = parseSimulationRunWebSocketMessage(JSON.stringify(wire))
      if (message?.type === 'realtime.ready') {
        if (message.clock) clock = order.published(message.clock)
        return
      }
      if (message?.type !== 'events') return
      const applied = applySimulationRunEventBatchMessage({
        objects,
        selectedControllerId: null,
        ...(scenarioState === undefined ? {} : { scenarioState }),
      }, message)
      if (applied.objectUpdate) objects = applied.objectUpdate.objects
      if (applied.scenarioUpdate) scenarioState = applied.scenarioUpdate
      if (applied.clockUpdate) clock = order.published(applied.clockUpdate)
    },
    /** The route joins the Run again after it reset it, from the Run's fresh snapshot. */
    join: (next: SimulationRunStateSnapshot): void => {
      objects = next.objects
      scenarioState = next.scenario
      clock = order.published(next.clock)
    },
    /** A read asked for and answered at once. */
    read: (next: RunExecutionState): void => answer(order.readAsked(), next),
    /** A read asked for now, whose answer arrives later. */
    ask: (): ClockReadTicket => order.readAsked(),
    answer,
    clock: () => clock,
    shown: (wallTimeMs: number) => worldClockView({ clock, execution }, wallTimeMs),
  }
}

type WorldView = ReturnType<typeof createWorldView>

describe('World clock across a fixed-duration fast-forward', () => {
  test('ends on the Run time the fast-forward reached, paused, after every fast-forward of a Run', async () => {
    const registry = createSimulationRunRegistry({
      dataDir: await mkdtemp(join(tmpdir(), 'leitbild-world-clock-fast-forward-')),
      workspaceId: newWorkspaceId(),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    const realtime = createSimulationRunRealtimeManager<WorldView>({
      registry,
      perspectiveOf: () => null,
      send: (view, message) => view.receive(message),
      sendReady: (view, message) => view.receive(message),
    })
    try {
      const run = await registry.create({ scenarioId: 'test-response' })
      const view = createWorldView(run.snapshot())
      realtime.addClient(run.id, view)

      for (const minutes of [2, 3]) {
        const started = await registry.advanceExecution(run.id, { minutes, onComplete: 'pause' })
        view.read(started)
        const startedMs = Date.parse(started.acceleration!.startedSimulationTime)
        // The view's one-second execution poll lands once while this fast-forward
        // runs, at a time from its middle, and next after it has completed.
        let inFlight: RunExecutionState | null = null
        for (let attempt = 0; attempt < 2_000; attempt += 1) {
          const execution = await registry.executionStatus(run.id)
          if (execution.acceleration?.status !== 'running') break
          if (inFlight === null && Date.parse(execution.currentSimulationTime) > startedMs) {
            inFlight = execution
            view.read(execution)
          }
          await Bun.sleep(2)
        }
        const final = await registry.executionStatus(run.id)
        view.read(final)

        expect(inFlight).not.toBeNull()
        expect(Date.parse(inFlight!.currentSimulationTime)).toBeLessThan(Date.parse(final.currentSimulationTime))
        expect(final).toMatchObject({ playback: 'paused', pace: 'realtime', acceleration: { status: 'completed' } })
        expect(final.currentSimulationTime).toBe(final.acceleration!.targetSimulationTime!)
        expect(view.clock()).toMatchObject({ currentTime: final.currentSimulationTime, paused: true })
        // Pack panels age their objects from this time; it stands still while the Run is paused.
        expect(simulationTimeAt(view.clock(), Date.now() + 60_000)).toBe(final.currentSimulationTime)
        expect(view.shown(Date.now() + 60_000)).toEqual({
          time: `${final.currentSimulationTime.slice(11, 19)} UTC`,
          paused: true,
          dateTime: `${final.currentSimulationTime.slice(0, 10)} ${final.currentSimulationTime.slice(11, 19)} UTC`,
        })
      }
    } finally {
      realtime.stop()
      await registry.shutdown()
    }
  })

  test('a poll answer from the middle of a fast-forward that arrives after the clock it stopped at leaves the view on that clock', async () => {
    const registry = createSimulationRunRegistry({
      dataDir: await mkdtemp(join(tmpdir(), 'leitbild-world-clock-late-read-')),
      workspaceId: newWorkspaceId(),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    const realtime = createSimulationRunRealtimeManager<WorldView>({
      registry,
      perspectiveOf: () => null,
      send: (view, message) => view.receive(message),
      sendReady: (view, message) => view.receive(message),
    })
    try {
      const run = await registry.create({ scenarioId: 'test-response' })
      const view = createWorldView(run.snapshot())
      realtime.addClient(run.id, view)
      const started = await registry.advanceExecution(run.id, { minutes: 2, onComplete: 'pause' })
      view.read(started)
      const startedMs = Date.parse(started.acceleration!.startedSimulationTime)
      // The poll is asked for while the fast-forward runs; its answer is held back until the Run has stopped.
      let late: { readonly ticket: ClockReadTicket; readonly execution: RunExecutionState } | null = null
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        const ticket = view.ask()
        const execution = await registry.executionStatus(run.id)
        if (execution.acceleration?.status !== 'running') break
        if (late === null && Date.parse(execution.currentSimulationTime) > startedMs) late = { ticket, execution }
        await Bun.sleep(2)
      }
      const final = await registry.executionStatus(run.id)
      expect(late).not.toBeNull()
      expect(late!.execution.pace).toBe('maximum')
      expect(Date.parse(late!.execution.currentSimulationTime)).toBeLessThan(Date.parse(final.currentSimulationTime))
      expect(view.clock()).toMatchObject({ currentTime: final.currentSimulationTime, paused: true })
      view.answer(late!.ticket, late!.execution)
      expect(view.clock()).toMatchObject({ currentTime: final.currentSimulationTime, paused: true })
      // The legitimate rewind: after a reset the route joins again, and the Run's start clock applies after every read.
      const beforeReset = view.ask()
      // The fast-forward lets go of the Run a moment after it reports completion.
      const resetWhenFree = async (attempt = 0): Promise<Awaited<ReturnType<typeof registry.reset>>> => {
        try {
          return await registry.reset(run.id)
        } catch (error) {
          if ((error as { readonly code?: unknown }).code !== 'simulation_run_busy' || attempt >= 500) throw error
          await Bun.sleep(2)
          return await resetWhenFree(attempt + 1)
        }
      }
      const reset = await resetWhenFree()
      view.join(reset.snapshot())
      const restarted = reset.snapshot().clock!.currentTime
      expect(Date.parse(restarted)).toBeLessThan(Date.parse(final.currentSimulationTime))
      expect(view.clock()?.currentTime).toBe(restarted)
      view.answer(beforeReset, late!.execution)
      expect(view.clock()?.currentTime).toBe(restarted)
    } finally {
      realtime.stop()
      await registry.shutdown()
    }
  })
})

describe('World clock order in the World view', () => {
  const route = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'routes', 'ControlSurfaceRoute.svelte'), 'utf8')

  test('the route sets its clock only through the clock order, as the view above does', () => {
    const assignments = [...route.matchAll(/(?<![\w.$])clock\s*=(?![=>])\s*([^\n]*)/g)].map(match => match[0].trim())
    // The declaration, the guarded execution reading, and each published clock: joins, realtime, perspectives and resets.
    expect(assignments.length).toBeGreaterThan(4)
    for (const assignment of assignments) {
      expect([assignment]).toEqual([expect.stringMatching(/^clock = \$state<SimulationClockState \| undefined>\(undefined\)$|^clock = clockOrder\.published\(|^clock = reading$/)])
    }
    expect(assignments.filter(assignment => assignment === 'clock = reading')).toHaveLength(1)
    expect(route).toMatch(/if \(reading && clockOrder\.readApplies\(ticket\)\) clock = reading\n/)
  })

  test('an execution read takes its ticket before it fetches and applies only if the ticket still applies', () => {
    const start = route.indexOf('const refreshExecution = async')
    const body = route.slice(start, route.indexOf('\n  }\n', start))
    const order = ['clockOrder.readAsked()', 'await fetchRunExecution(', 'clockOrder.readApplies(ticket)', 'clock = reading'].map(part => body.indexOf(part))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((left, right) => left - right)).toEqual(order)
    expect(body.match(/fetchRunExecution\(/g)).toHaveLength(1)
  })
})
