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
  operatingPoint: { ref: 'electric-grid.norway.winter-weekday-peak', overrides },
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
  id: 'grid:ids', model: { ref: 'electric-grid.norway.transmission' }, operatingPoint: { ref: 'electric-grid.norway.winter-weekday-peak' }, automation: { ref: 'electric-grid.frequency.nordic-2025' },
}).model

describe('Grid Scenario Operating Point overrides', () => {
  test('rejects an unknown asset id at scenario compile with its exact path', async () => {
    const issues = await issuesOf({ branchStates: [{ assetId: 'branch:osm-ffffffffffffffff', state: 'open' }] })
    expect(issues.map(issue => [issue.path, issue.message])).toEqual([[['operatingPoint', 'overrides', 'branchStates', 0, 'assetId'], 'unknown branch branch:osm-ffffffffffffffff']])
  })

  test('rejects addresses the selected model does not have, per field', async () => {
    const issues = await issuesOf({
      hvdcSchedules: [{ assetId: 'hvdc:no-such-link', timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', transferMw: 500 }] }],
      externalExchangeSchedules: [
        { assetId: 'external:SE1', timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', exportMw: 100 }] },
        { assetId: 'external:DE', timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', exportMw: 100 }] },
      ],
    })
    expect(issues.map(issue => [issue.path, issue.message])).toEqual([
      [['operatingPoint', 'overrides', 'hvdcSchedules', 0, 'assetId'], 'unknown HVDC link hvdc:no-such-link'],
      [['operatingPoint', 'overrides', 'externalExchangeSchedules', 0, 'assetId'], 'unknown external system external:SE1'],
      [['operatingPoint', 'overrides', 'externalExchangeSchedules', 1, 'assetId'], 'external:DE is reached only through HVDC; schedule its links instead'],
    ])
  })

  test('applies a constant HVDC schedule as the link\'s initial set-point', async () => {
    const definition = compileGridDefinition({
      id: 'grid:hvdc', model: { ref: 'electric-grid.norway.transmission' }, automation: { ref: 'electric-grid.frequency.nordic-2025' },
      operatingPoint: { ref: 'electric-grid.norway.winter-weekday-peak', overrides: { hvdcSchedules: [{ assetId: 'hvdc:nordlink', timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', transferMw: 500 }] }] } },
    })
    expect(definition.operatingPoint.hvdcSetpoints.find(entry => entry.linkId === 'hvdc:nordlink')?.setpointMw).toBe(500)
  })

  test('accepts only stable asset ids, so name-derived v1 ids cannot be addressed', async () => {
    // A Grid Model v1 generator id, derived from the plant name.
    const issues = await issuesOf({ generatorStates: [{ assetId: 'NO-KVILLDAL-HYDRO', state: 'offline' }] })
    expect(model.generators.every(generator => generator.id.startsWith('generator:'))).toBe(true)
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
