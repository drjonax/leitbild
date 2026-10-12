import { newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, test } from 'bun:test'
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
import { executionClockReading, worldClockView } from '../src/ui/world-clock.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

/**
 * The World view's Run stores, fed as its route feeds them: the joined
 * snapshot, every realtime message as wire JSON, and each execution read.
 */
const createWorldView = (snapshot: SimulationRunStateSnapshot) => {
  let objects: ReadonlyArray<OperationalObject> = snapshot.objects
  let scenarioState: ScenarioExecutionState | undefined = snapshot.scenario
  let clock: SimulationClockState | undefined = snapshot.clock
  let execution: RunExecutionState | null = null
  return {
    receive: (wire: unknown): void => {
      const message = parseSimulationRunWebSocketMessage(JSON.stringify(wire))
      if (message?.type === 'realtime.ready') {
        if (message.clock) clock = message.clock
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
      if (applied.clockUpdate) clock = applied.clockUpdate
    },
    read: (next: RunExecutionState): void => {
      execution = next
      const reading = executionClockReading(next)
      if (reading) clock = reading
    },
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
})
