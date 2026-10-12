import { newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electricalPortFromObject, type ActorId, type ElectricalConnectionDefinition, type IsoTimestamp, type ObjectId } from '../src/core/model/index.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'
import { coupledBoundaryEffect, coupledBoundaryRampRefusal } from '../src/packs/process-plant/sim/offsite-isolation.ts'
import { processPlantRuntimeStateSchema, restoredOffsiteIsolationsFor, type ProcessPlantRuntimeState } from '../src/packs/process-plant/sim/runtime-state.ts'
import { createManualIdleTimer, createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

// A plant-side loss of offsite power on a Plant connected to a Grid holds against the Grid port:
// the coupling would otherwise rewrite the offsite source from the live port on every update.

const operator = { id: 'actor:offsite-isolation-test' as ActorId, label: 'Offsite isolation test operator', role: 'operator' as const }
// Hang guard, not a cost budget: four PWR Plants run single-threaded, about load/8-fold slower in wall time.
const watchdogMs = 1_200_000

const connection = { id: 'unit-1', system: { objectId: 'plant:halden-1', portId: 'grid-420kv' }, network: { objectId: 'grid:halden-four-unit', portId: 'unit-1-420kv' } } as unknown as ElectricalConnectionDefinition
const variables = new Map([
  ['offsiteGrid.available' as VariablePath, { connection, variable: 'available' as const }],
  ['offsiteGrid.voltageFraction' as VariablePath, { connection, variable: 'voltageFraction' as const }],
  ['offsiteGrid.frequencyHz' as VariablePath, { connection, variable: 'frequencyHz' as const }],
])

describe('plant-side writes to a Grid-coupled offsite boundary', () => {
  test('available=false isolates, available=true clears, voltage and frequency are the Grid\'s', () => {
    expect(coupledBoundaryEffect(variables, [{ path: 'offsiteGrid.available' as VariablePath, value: false }, { path: 'breaker.closed' as VariablePath, value: false }]))
      .toEqual({ ok: true, effect: { isolate: [connection], clear: [] } })
    expect(coupledBoundaryEffect(variables, [{ path: 'offsiteGrid.available' as VariablePath, value: true }])).toEqual({ ok: true, effect: { isolate: [], clear: [connection] } })
    const voltage = coupledBoundaryEffect(variables, [{ path: 'offsiteGrid.voltageFraction' as VariablePath, value: 0.85 }])
    expect(voltage.ok).toBe(false)
    if (!voltage.ok) expect(voltage.reason).toContain('is set by the Grid this Plant is connected to (grid:halden-four-unit:unit-1-420kv)')
    expect(coupledBoundaryEffect(variables, [{ path: 'offsiteGrid.frequencyHz' as VariablePath, value: 49.5 }]).ok).toBe(false)
    expect(coupledBoundaryRampRefusal(variables, 'offsiteGrid.voltageFraction' as VariablePath)).toContain('cannot be ramped')
    // A Plant with no Grid connection has no coupled boundary: its writes are its own.
    expect(coupledBoundaryEffect(undefined, [{ path: 'offsiteGrid.available' as VariablePath, value: false }])).toEqual({ ok: true, effect: { isolate: [], clear: [] } })
    expect(coupledBoundaryRampRefusal(undefined, 'offsiteGrid.voltageFraction' as VariablePath)).toBeNull()
  })

  test('persists its isolations as an optional field: a state without one restores with none', () => {
    expect(processPlantRuntimeStateSchema.parse({ schemaVersion: 1, plants: [] })).toEqual({ schemaVersion: 1, plants: [] })
    const withIsolation = processPlantRuntimeStateSchema.shape.plants.element.shape.offsiteIsolations.parse([{ portId: 'grid-420kv', cause: 'action loss-offsite-power' }])!
    expect(withIsolation).toEqual([{ portId: 'grid-420kv', cause: 'action loss-offsite-power' }])
    const state = { schemaVersion: 1, plants: [{ plantId: 'plant:halden-1', offsiteIsolations: withIsolation }] } as unknown as ProcessPlantRuntimeState
    expect(restoredOffsiteIsolationsFor(state, 'plant:halden-1')).toEqual(withIsolation)
    expect(restoredOffsiteIsolationsFor(state, 'plant:halden-2')).toEqual([])
    expect(restoredOffsiteIsolationsFor(null, 'plant:halden-1')).toEqual([])
  })
})

describe('a Grid-connected Plant\'s loss of offsite power', () => {
  test('holds against the Grid port until available=true clears it, and the Grid sees the Plant disconnected meanwhile', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-offsite-isolation-'))
    const registry = createSimulationRunRegistry({
      dataDir,
      workspaceId: newWorkspaceId(),
      ...testScenarioAuthoring(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      idleRuntimeCloseTimer: createManualIdleTimer().arm,
    })
    try {
      const run: SimulationRunRuntime = await registry.create({ scenarioId: 'halden-power-complex' })
      await run.setClock({ paused: true })
      const startedAtMs = Date.parse(run.snapshot().clock!.currentTime)
      const advanceTo = async (seconds: number): Promise<void> => {
        await run.runMaximumPace(new Date(startedAtMs + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
      }
      const plantPort = () => {
        const plant = run.snapshot().objects.find(object => object.id === 'plant:halden-1' as ObjectId)!
        return electricalPortFromObject(plant, 'grid-420kv')!.state!
      }
      const invoke = async (capabilityId: string, input: Record<string, unknown>) => run.invokeCapability(operator, { capabilityId, input })
      const unitOnePoint = async () => {
        const outcome = await invoke('world.electric-grid.connection-points.list', { gridId: 'grid:halden-four-unit' })
        if (outcome.kind !== 'query') throw new Error('connection-points.list is not a query')
        const points = (outcome.result as { connectionPoints: ReadonlyArray<{ id: string; connected: boolean; systemActivePowerMw: number; energized: boolean }> }).connectionPoints
        return points.find(point => point.id.includes('unit-1'))!
      }
      const signalTypes = (): ReadonlyArray<string> => run.events().flatMap(event => event.type === 'interaction.signal.received' && event.signal.type.startsWith('process-plant.offsite.') ? [event.signal.type] : [])

      await advanceTo(10)
      expect(plantPort()).toMatchObject({ energized: true, connected: true })
      expect((await unitOnePoint()).connected).toBe(true)

      const loss = await invoke('world.process-plant.action.invoke', { plantId: 'plant:halden-1', actionId: 'loss-offsite-power', parameters: {} })
      expect(loss).toMatchObject({ kind: 'command' })
      // Many Grid updates later the source still holds unavailable: the port reports disconnected
      // with no voltage and no frequency, and the Grid's bay sees no connected Plant.
      await advanceTo(40)
      expect(plantPort()).toMatchObject({ energized: false, connected: false, voltagePu: 0, frequencyHz: null })
      const isolatedPoint = await unitOnePoint()
      expect(isolatedPoint.connected).toBe(false)
      expect(isolatedPoint.systemActivePowerMw).toBe(0)
      expect(isolatedPoint.energized).toBe(true)
      expect(signalTypes()).toEqual(['process-plant.offsite.isolated'])

      // The Grid's voltage and frequency stay the Grid's: a plant-side write of them is refused.
      const voltageWrite = await invoke('world.process-plant.control.write', { plantId: 'plant:halden-1', path: 'offsiteGrid.voltageFraction', value: 0.85 })
      expect(voltageWrite).toMatchObject({ kind: 'command', result: { ok: false } })

      // An operator's or Scenario's write of available=true clears the isolation; the Grid port applies again.
      const restore = await invoke('world.process-plant.control.write', { plantId: 'plant:halden-1', path: 'offsiteGrid.available', value: true })
      expect(restore).toMatchObject({ kind: 'command', result: { ok: true } })
      await advanceTo(50)
      expect(plantPort()).toMatchObject({ energized: true, connected: true })
      expect(plantPort().voltagePu).toBeGreaterThan(0.9)
      expect((await unitOnePoint()).connected).toBe(true)
      expect(signalTypes()).toEqual(['process-plant.offsite.isolated', 'process-plant.offsite.restored'])
    } finally {
      await registry.shutdown()
      await rm(dataDir, { recursive: true, force: true })
    }
  }, watchdogMs)
})
