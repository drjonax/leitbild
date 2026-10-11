import { describe, expect, test } from 'bun:test'
import { answerProcessPlantCatalogQuery } from '../src/packs/process-plant/queries/catalog-query.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

describe('Process Plant action discovery', () => {
  test('finds canonical action ids from domain shorthand', () => {
    const result = answerProcessPlantCatalogQuery({
      request: {
        capabilityId: 'world.process-plant.actions.search',
        input: { query: 'trip unit 2 RCPs' },
      },
    }) as { actions: Array<{ id: string }> }
    expect(result.actions[0]?.id).toBe('trip-reactor-coolant-pumps')
  })

  test('returns the complete authoritative action catalog when no query is supplied', () => {
    const catalog = answerProcessPlantCatalogQuery({
      request: { capabilityId: 'world.process-plant.catalog.list', input: {} },
    }) as { actions: Array<{ id: string }> }
    const search = answerProcessPlantCatalogQuery({
      request: { capabilityId: 'world.process-plant.actions.search', input: {} },
    }) as { total: number, actions: Array<{ id: string }> }
    expect(search.total).toBe(catalog.actions.length)
    expect(search.actions.map(action => action.id).sort()).toEqual(catalog.actions.map(action => action.id).sort())
  })
})
