import { expect,test } from 'bun:test'
import { worldPacks } from '../src/app-assembly.ts'
import { compiledScenarioSchema } from '../src/core/model/index.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { responseScenario,testScenarioDefinitions } from './fixtures/scenarios.ts'
import { testPacks } from './fixtures/test-packs.ts'

test('compiled Starting View contains no persisted screen composition', () => {
  const parsed = compiledScenarioSchema.parse(responseScenario)
  expect(Number(parsed.view.map.center.coordinates[0])).toBe(10.7522)
  expect(parsed.view.map.zoom).toBe(12)
  expect(parsed.view.map.layers).toContain('weather')
  expect('surface' in parsed).toBe(false)
  expect('width' in parsed.view.rail).toBe(false)
  expect(() => compiledScenarioSchema.parse({ ...parsed, view: { map: {}, rail: { sections: [] } } })).toThrow()
})

test('adding Weather discovers layers and categories while preserving intentional preferences', async () => {
  const source = testScenarioDefinitions.find(source => source.id === 'halden-power-complex')!
  const compiled = await compileScenarioDefinition({ ...source, view: {
    ...source.view,
    map: { ...source.view.map, hiddenLayers: ['routes'] },
    rail: { sections: [{ categoryId: 'weather', visible: false, collapsed: true, visibleFields: [] }] },
  } }, worldPacks, { routing: createDirectRoutingAdapter() })
  expect(compiled.view.map.layers).toContain('weather')
  expect(compiled.view.map.layers).not.toContain('routes')
  expect(compiled.view.rail.sections.find(section => section.categoryId === 'weather')?.visible).toBe(false)
  expect(compiled.view.rail.sections.length).toBeGreaterThan(1)
})

test('rejects unknown starting-view categories instead of hiding them silently', async () => {
  const source = testScenarioDefinitions[0]!
  await expect(compileScenarioDefinition({ ...source, view: {
    ...source.view, rail: { sections: [{ categoryId: 'missing' }] },
  } }, testPacks, { routing: createDirectRoutingAdapter() })).rejects.toThrow('inactive category')
})
