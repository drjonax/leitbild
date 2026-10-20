import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActorId, ObjectId } from '../src/core/model/index.ts'
import { recordingSeriesIdFor } from '../src/core/model/index.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createManualIdleTimer, createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

// N2 and N5 end to end: the Grid and weather Packs declare and read through World's as-caller
// observation port on real Scenarios (assembly checks their Capabilities; the port validates
// every answer against the core shapes), with series from each Run's recording selection.
const operator = { id: 'actor:observation-port-test' as ActorId, label: 'Observation port test', role: 'operator' as const }
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const registry = async (): Promise<SimulationRunRegistry> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-observation-port-'))
  const created = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), idleRuntimeCloseTimer: createManualIdleTimer().arm,
  })
  cleanups.push(async () => { await created.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  return created
}

describe('grid and weather observations through the Run\'s port', () => {
  test('the Grid of nordic-frequency-event declares and reads as the caller', async () => {
    const run = await (await registry()).create({ scenarioId: 'nordic-frequency-event' })
    const port = run.observations(operator)
    const [declaration] = await port.declarations(['grid:norway' as ObjectId])
    if (declaration === undefined || 'refused' in declaration) throw new Error('the Grid declares nothing')
    expect(declaration.observables.find(observable => observable.ref === 'grid:norway#grid.frequency')!.series).toEqual({ seriesId: recordingSeriesIdFor('grid:norway', 'grid.frequency'), intervalMs: 2_000 })
    expect(declaration.elements.length).toBeGreaterThan(3_000)
    const [scoped] = await port.declarations(['grid:norway' as ObjectId], declaration.elements.filter(element => element.class === 'branch').slice(0, 2).map(element => element.id))
    expect(scoped !== undefined && !('refused' in scoped) && scoped.observables.length).toBeGreaterThan(0)
    const lead = await port.read({ lead: { objectId: 'grid:norway' as ObjectId, count: 6 } })
    expect(lead.observations.length).toBe(6)
    expect(lead.observations[0]!.clock).toBe('simulation')
    const read = await port.read({ refs: ['grid:norway#grid.frequency', 'grid:norway#no.such'] })
    expect([read.observations.map(observation => observation.ref), read.unknown]).toEqual([['grid:norway#grid.frequency'], ['grid:norway#no.such']])
  }, 120_000)

  test('the weather areas of test-response declare and read as the caller', async () => {
    const run = await (await registry()).create({ scenarioId: 'test-response' })
    const port = run.observations(operator)
    const [area] = await port.declarations(['weather:oslo-moving-rain-band' as ObjectId])
    if (area === undefined || 'refused' in area) throw new Error('weather declares nothing')
    expect(area.observables.find(observable => observable.ref === 'weather:oslo-moving-rain-band#airTemperatureC')).toMatchObject({ quantity: 'temperature', unit: 'degC', series: null })
    const read = await port.read({ refs: ['weather:oslo-moving-rain-band#precipitationType', 'weather:oslo-damp-background#visibilityM'] })
    expect(read.observations.map(observation => [observation.ref, typeof observation.value])).toEqual([['weather:oslo-moving-rain-band#precipitationType', 'string'], ['weather:oslo-damp-background#visibilityM', 'number']])
    const lead = await port.read({ lead: { objectId: 'weather:oslo-moving-rain-band' as ObjectId, count: 3 } })
    expect(lead.observations.map(observation => observation.rank)).toEqual([1, 2, 3])
  }, 120_000)
})
