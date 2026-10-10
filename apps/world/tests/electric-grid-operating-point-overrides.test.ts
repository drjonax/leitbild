import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import type { PackScenarioExpansionContext, PackScenarioItemSpec } from '../src/core/packs/protocol.ts'
import { gridOperatingPointOverridesSchema } from '../src/packs/electric-grid/config.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { electricGridScenarioSupport } from '../src/packs/electric-grid/scenario.ts'

const gridItem = (overrides: unknown): PackScenarioItemSpec => ({
  pack: 'electric-grid',
  type: 'grid',
  id: 'grid:overrides',
  label: 'Override test grid',
  location: [10.75, 59.91],
  model: { ref: 'electric-grid.norway.transmission' },
  operatingPoint: { ref: 'electric-grid.norway.normal', overrides },
  automation: { ref: 'electric-grid.frequency.nordic-2025' },
}) as PackScenarioItemSpec
const context = { at: '2026-01-15T16:00:00.000Z' as IsoTimestamp } as PackScenarioExpansionContext

const issuesOf = async (overrides: unknown): Promise<ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>> => {
  try {
    await electricGridScenarioSupport.expandItem(gridItem(overrides), context)
  } catch (error) {
    if (error instanceof z.ZodError) return error.issues
    throw error
  }
  throw new Error('expected the Grid item to be rejected')
}

const model = compileGridDefinition({
  id: 'grid:ids', model: { ref: 'electric-grid.norway.transmission' }, operatingPoint: { ref: 'electric-grid.norway.normal' }, automation: { ref: 'electric-grid.frequency.nordic-2025' },
}).model

describe('Grid Scenario Operating Point overrides', () => {
  test('rejects an unknown asset id at scenario compile with its exact path', async () => {
    const issues = await issuesOf({ branchStates: [{ assetId: 'branch:osm-ffffffffffffffff', state: 'open' }] })
    expect(issues.map(issue => [issue.path, issue.message])).toEqual([[['operatingPoint', 'overrides', 'branchStates', 0, 'assetId'], 'unknown branch branch:osm-ffffffffffffffff']])
  })

  test('rejects addresses the selected model does not have, per field', async () => {
    const issues = await issuesOf({
      hvdcSchedules: [{ assetId: 'hvdc:nordlink', timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', transferMw: 500 }] }],
      externalExchangeSchedules: [{ assetId: 'external:nordic-remainder', timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', exportMw: 100 }] }],
      priceAreaDemandScale: { NO1: 1.1 },
    })
    expect(issues.map(issue => issue.path)).toEqual([
      ['operatingPoint', 'overrides', 'priceAreaDemandScale', 'NO1'],
      ['operatingPoint', 'overrides', 'hvdcSchedules', 0, 'assetId'],
      ['operatingPoint', 'overrides', 'externalExchangeSchedules', 0, 'assetId'],
    ])
  })

  test('accepts only stable asset ids, so name-derived v1 ids cannot be addressed', async () => {
    const generator = model.generators[0]!
    const issues = await issuesOf({ generatorStates: [{ assetId: generator.id, state: 'offline' }] })
    expect(issues.map(issue => [issue.path, issue.message])).toEqual([[['operatingPoint', 'overrides', 'generatorStates', 0, 'assetId'], 'must be a generator id']])
  })

  test('keeps applying the scalar overrides the runtime uses and publishes the full typed shape', async () => {
    const { objects } = await electricGridScenarioSupport.expandItem(gridItem({ loadScale: 0.9, generatorStates: [], storageStateOfCharge: 0.3 }), context)
    expect(objects).toHaveLength(1)
    const schema = z.toJSONSchema(gridOperatingPointOverridesSchema) as { readonly properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining([
      'loadScale', 'priceAreaDemandScale', 'generatorStates', 'branchStates', 'hvdcSchedules', 'externalExchangeSchedules', 'generationAvailabilityScale', 'storageStateOfCharge',
    ]))
    expect(() => gridOperatingPointOverridesSchema.parse({ automation: { ref: 'electric-grid.frequency.nordic-2025' } })).toThrow()
  })
})
