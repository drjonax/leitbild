import { expect, test } from 'bun:test'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorageBudget } from '@leitbild/module-runtime'

test('Halden recording preview uses Pack-owned series selection and sampling cadence', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'recording-preview-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: 'a0b0402e-d94c-4d70-92d5-258c2cf9d202' as never, ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver() })
  try {
    const definition = testScenarioDefinitions.find(source => source.id === 'halden-power-complex')!
    const preview = await registry.previewScenario(definition)
    const plants = preview.recording.selections.find(selection => selection.packId === 'process-plant')!
    expect(plants.initialSeriesCount).toBe(1956)
    expect(plants.samplesPerSimulationSecond).toBe(1956)
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
