import { describe, expect, test } from 'bun:test'
import { objectIdSchema, packIdSchema } from '../src/core/model/index.ts'
import { processPlantIdForObject } from '../src/packs/process-plant/model.ts'
import { processPlantIdForObject as processPlantIdForUiObject } from '../src/ui/process-display/process-display-client.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

const unit = {
  id: objectIdSchema.parse('plant:halden-a1'),
  packId: packIdSchema.parse('process-plant'),
  packData: {
    type: 'process-plant',
    schemaVersion: 1,
    model: { ref: 'process-plant.pwr-reference', parameters: {} },
    operatingPoint: { ref: 'process-plant.pwr-full-power' },
    automation: { ref: 'process-plant.pwr-reference' },
    electricalPorts: [],
  },
} as const

describe('Process Plant object identity', () => {
  test('uses the canonical Operational Object id as the Plant id', () => {
    expect(processPlantIdForObject(unit)).toBe('plant:halden-a1')
    expect(processPlantIdForUiObject(unit)).toBe('plant:halden-a1')
  })

  test('rejects objects that are not valid Process Plant units', () => {
    expect(processPlantIdForObject({ ...unit, packId: packIdSchema.parse('weather') })).toBeNull()
    expect(processPlantIdForObject({ ...unit, packData: { type: 'process-plant' } })).toBeNull()
    expect(processPlantIdForUiObject({ ...unit, packId: packIdSchema.parse('weather') })).toBeNull()
  })
})
