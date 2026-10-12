import { expect, test } from 'bun:test'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorageBudget } from '@leitbild/module-runtime'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

test('Halden recording preview uses Pack-owned series selection and sampling cadence', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'recording-preview-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: 'a0b0402e-d94c-4d70-92d5-258c2cf9d202' as never, ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver() })
  try {
    const definition = testScenarioDefinitions.find(source => source.id === 'halden-power-complex')!
    const preview = await registry.previewScenario(definition)
    const plants = preview.recording.selections.find(selection => selection.packId === 'process-plant')!
    // Every published signal of the reference Plant, the electrical, protection, secondary and thermal work's among
    // them, the pressurizer's backup heater group, every pump's loop reverse flow, every valve's isolation signal,
    // the pressurizer's level deviation from its program, each core's delayed-neutron and decay-heat groups, its
    // power range, startup rate, P-6 and P-10, Tref and Tavg's deviation from it, each steam generator's
    // auxiliary feedwater flow and wide-range level, and the feedwater tank's level control valve and the hotwell
    // reject valve and its flow; and, 55 more a Plant, its rod position and rod bottom, its diesels' meters, load
    // sequencers and sequenced loads, its buses' kilovolts, and its relief tank and tailpipes; and, 41 more a Plant
    // (C1), its rod steps and bank positions, source-range startup rate, trip breakers, each loop's ΔT power, flow and
    // forced flow, the turbine's load, speed and breaker, the grid's frequency, availability and supply voltage, and
    // the natural-circulation checks' rates; and, 18 more a Plant (C2b), each steam generator relief valve's flow to
    // the atmosphere, and the turbine-driven AFW pump's two steam supply valves and their lines' flows.
    expect(plants.initialSeriesCount).toBe(3116)
    expect(plants.samplesPerSimulationSecond).toBe(3116)
    expect(preview.recording.selections.every(selection => selection.initialSeriesCount !== null)).toBe(true)
    expect(preview.recording.sampleWindowSimulationSeconds).toBeLessThan(138)
    const slower = await registry.previewScenario({ ...definition, packs: definition.packs.map(pack => pack.id === 'process-plant' ? { ...pack, recording: { profileId: 'operations', intervalMs: 5000 } } : pack) })
    expect(slower.recording.sampleWindowSimulationSeconds!).toBeGreaterThan(preview.recording.sampleWindowSimulationSeconds! * 4)
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})

test('Run admission refuses low capacity without creating a partial Run', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'run-admission-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: 'a0b0402e-d94c-4d70-92d5-258c2cf9d202' as never, ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), storageBudget: createStorageBudget({ root: dataDir, maxBytes: 1024, minFreeBytes: 0 }) })
  try {
    await expect(registry.create({ scenarioId: 'test-response' })).rejects.toThrow('budget reached')
    expect(await registry.listKnown()).toEqual([])
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})
