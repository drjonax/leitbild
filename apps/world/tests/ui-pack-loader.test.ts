import { describe, expect, test } from 'bun:test'
import { worldPacks } from '../src/app-assembly.ts'
import { knownUiPackIds, loadActivePackViews, loadUiPack } from '../src/ui/pack-loader.ts'

describe('UI scenario pack loading', () => {
  test('loads only the packs declared by a scenario', async () => {
    const pack = await loadActivePackViews(['process-plant'])

    expect(pack.packIds).toEqual(['process-plant'])
    expect(pack.presentation.categories.map(category => category.id)).toEqual(['process-plants'])
    expect(pack.presentation.categories.map(category => category.id)).not.toContain('weather')
    expect(pack.presentation.categories.map(category => category.id)).not.toContain('drones')
    expect(pack.creation?.createObjectTypes ?? []).toEqual([])
    expect(pack.surfacePanels).toEqual([])
  })

  test('combines scenario packs in declared order', async () => {
    const pack = await loadActivePackViews(['process-plant', 'weather'])

    expect(pack.packIds).toEqual(['process-plant', 'weather'])
    expect(pack.presentation.categories.map(category => category.id)).toEqual(['process-plants', 'weather'])
    expect(pack.creation?.createObjectTypes.map(type => type.id).sort()).toEqual([
      'weather_area',
      'weather_probe',
    ].sort())
  })

  test('rejects unknown and duplicate scenario pack ids visibly', async () => {
    await expect(loadUiPack('missing')).rejects.toThrow('scenario references unknown UI pack: missing')
    await expect(loadActivePackViews(['weather', 'weather']))
      .rejects.toThrow('scenario declares duplicate packs: weather')
  })

  test('has one reviewed lazy loader for every assembled World Pack', () => {
    expect(knownUiPackIds).toEqual(worldPacks.map(pack => pack.descriptor.id).sort())
  })

  test('publishes the same Pack identity through server and browser assemblies', async () => {
    for (const pack of worldPacks) {
      expect((await loadUiPack(pack.descriptor.id)).descriptor).toEqual(pack.descriptor)
    }
  })

  test('heavy browser views do not masquerade as complete server Packs', async () => {
    // A Pack whose server definition is already browser-safe loads as itself.
    const heavyViews = (await Promise.all(worldPacks.map(async pack => ({ pack, view: await loadUiPack(pack.descriptor.id) }))))
      .filter(({ pack, view }) => view !== pack)
    expect(heavyViews.map(({ pack }) => pack.descriptor.id)).toEqual(expect.arrayContaining(['drone', 'process-plant', 'electric-grid']))
    for (const { view } of heavyViews) {
      expect(Object.hasOwn(view, 'scenarioConfigSchema')).toBe(false)
      expect(Object.hasOwn(view, 'scenario')).toBe(false)
    }
  })
})
