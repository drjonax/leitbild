import { afterAll, describe, expect, test } from 'bun:test'
import { processPlantUnitPackDataSchema } from '../src/packs/process-plant/model.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { fleetFixture, fleetRun } from './fixtures/fleet-runs.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

describe('the fork-only N-unit Halden fixtures', () => {
  test('are no product Scenarios: N identical units in one cluster, the first four on the grid', async () => {
    for (const units of [8, 12] as const) {
      const fixture = await fleetFixture(units)
      expect(fixture.id).toBe(`halden-fleet-${units}`)
      expect(builtinScenarioDefinitions.some(definition => definition.id === fixture.id)).toBe(false)
      const plants = fixture.packs.find(pack => pack.id === 'process-plant')!.items
      expect(plants.map(item => String(item.id))).toEqual(Array.from({ length: units }, (_, at) => `plant:halden-${at + 1}`))
      expect(new Set(plants.map(item => item.clusterId))).toEqual(new Set(['halden-power-complex']))
      expect(new Set(plants.map(item => JSON.stringify(item.model))).size).toBe(1)
      expect(fixture.connections?.map(connection => String(connection.system.objectId))).toEqual(['plant:halden-1', 'plant:halden-2', 'plant:halden-3', 'plant:halden-4'])
    }
  })

  test('the 12-unit fixture compiles and its Run starts with every unit projected', async () => {
    const fleet = await fleetRun(12)
    cleanups.push(fleet.close)
    const plants = fleet.runtime.snapshot().objects.filter(object => object.packId === 'process-plant')
    expect(plants).toHaveLength(12)
    for (const plant of plants) {
      const projection = processPlantUnitPackDataSchema.parse(plant.packData).projection
      expect(projection?.statusTone).not.toBe('idle')
    }
  }, 120_000)
})
