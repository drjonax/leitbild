import { describe, expect, test } from 'bun:test'
import { objectIdSchema } from '../src/core/model/index.ts'
import type { PackCreateObjectType } from '../src/core/packs/protocol.ts'
import {
  categoryRowsFor,
  placementCursorFor,
  selectedControllerObjectFor,
} from '../src/ui/control-surface-selectors.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { createActivePackViews } from '../src/core/packs/active-views.ts'
import { fixturePack, fixturePackId } from './fixtures/fixture-pack.ts'
import { responseScenario } from './fixtures/scenarios.ts'

const fixtureViews = createActivePackViews([fixturePack])

const scenarioObjects = () => structuredClone(responseScenario.initialObjects)

const fixtureObjects = () => scenarioObjects().filter(object => object.packId === fixturePackId)

describe('control surface selectors', () => {
  test('builds category rows through the active pack vocabulary', () => {
    const rows = categoryRowsFor(fixtureObjects(), fixtureViews)

    expect(rows.map(row => [row.category.id, row.objects.length, row.createType?.id])).toEqual([
      ['units', 3, undefined],
      ['tasks', 3, undefined],
      ['sites', 3, undefined],
    ])
    expect(categoryRowsFor([], fixtureViews).map(row => [row.category.id, row.objects.length])).toEqual([
      ['units', 0],
      ['tasks', 0],
      ['sites', 0],
    ])
  })

  test('keeps category object order deterministic regardless of incoming object order', () => {
    const objects = fixtureObjects()
    const unit = objects.find(object => object.kind === 'mobile_entity')
    if (!unit) throw new Error('scenario fixture missing unit')
    const laterUnit = {
      ...unit,
      id: 'unit:b2' as typeof unit.id,
      label: 'Unit B-2',
    }
    const earlierUnit = {
      ...unit,
      id: 'unit:a1' as typeof unit.id,
      label: 'Unit A-1',
    }

    const rows = categoryRowsFor([laterUnit, ...objects, earlierUnit], fixtureViews)
    const unitRow = rows.find(row => row.category.id === 'units')

    expect(unitRow?.objects.map(object => object.label)).toEqual([
      'Unit A-1',
      'Unit A-12',
      'Unit A-21',
      'Unit A-34',
      'Unit B-2',
    ])
  })

  test('does not expose unvalidated point-and-click control on assets of a Pack without targeting', () => {
    const objects = scenarioObjects()
    const unit = objects.find(object => object.kind === 'mobile_entity')
    const site = objects.find(object => object.id === 'site:north')
    if (!unit || !site) throw new Error('scenario fixture missing expected objects')

    expect(fixturePack.targeting).toBeUndefined()
    expect(selectedControllerObjectFor(objects, unit.id, fixtureViews, { objects })).toBeNull()
    expect(selectedControllerObjectFor(objects, site.id, fixtureViews, { objects })).toBeNull()
    expect(selectedControllerObjectFor(objects, objectIdSchema.parse('object:missing'), fixtureViews, { objects })).toBeNull()
  })

  test('creates placement cursor data and rejects unknown pack icons visibly', () => {
    const weatherCreateType = weatherPack.creation?.createObjectTypes.find(type => type.id === 'weather_probe')
    if (!weatherCreateType) throw new Error('weather create type missing')

    expect(placementCursorFor(weatherCreateType, fixtureViews)).toEqual({
      icon: 'cloud-rain',
      color: '#4669ff',
    })
    expect(placementCursorFor(null, fixtureViews)).toBeNull()

    const invalidCreateType: PackCreateObjectType = {
      ...weatherCreateType,
      icon: 'not-a-real-icon',
    }
    expect(() => placementCursorFor(invalidCreateType, fixtureViews)).toThrow('unknown create cursor icon')
  })
})
