import { describe, expect, test } from 'bun:test'
import { electricGridPackView } from '../src/packs/electric-grid/ui-pack.ts'
import { gridNorwayStyle } from '../src/packs/electric-grid/ui/grid-norway-style.ts'
import { createReferenceDataController } from '../src/ui/map/reference-data-controller.ts'
import { createMapLayerRegistry } from '../src/ui/map-runtime/map-layer-registry.ts'
import { gridNorwayReferenceTileset, gridNorwaySlimReferenceTileset } from './fixtures/grid-norway-reference-manifest.ts'
import { createFakeMapStyle, layerOrder } from './helpers/fake-map-style.ts'

const oldBuild = gridNorwayReferenceTileset.buildId
const newBuild = gridNorwaySlimReferenceTileset.buildId
const laterTileset = { ...gridNorwaySlimReferenceTileset, buildId: '20261101-000000' }
const sourceId = 'reference:grid-norway'

const capabilities = (...tilesets: ReadonlyArray<Record<string, unknown>>) =>
  new Response(JSON.stringify({ schemaVersion: 2, tilesets: [{ kind: 'base', id: 'leitbild-osm-norway' }, ...tilesets] }), { status: 200 })

/** Answers each capabilities read with the next response and counts the reads. */
const scriptedFetch = (...responses: ReadonlyArray<() => Response>) => {
  const reads: string[] = []
  return {
    reads,
    fetchFn: async (input: string): Promise<Response> => {
      const next = responses[reads.length]
      reads.push(input)
      if (!next) throw new Error(`unexpected capabilities read ${reads.length}`)
      return next()
    },
  }
}

/** The map `error` event MapLibre 6 fires when a tile request fails with a non-404 status (shape seen in Chrome). */
const tileError = (status: number, buildId: string, forSource = sourceId) => {
  const url = `/map/datasets/grid-norway/current/grid-norway/9/270/148.mvt?build=${buildId}`
  return {
    type: 'error',
    sourceId: forSource,
    error: Object.assign(new Error(`AJAXError: Conflict (${status}): ${url}`), { status, url }),
  }
}

const settled = async (): Promise<void> => { await Bun.sleep(5) }

const registerGrid = async (...responses: ReadonlyArray<() => Response>) => {
  const fake = createFakeMapStyle()
  const scripted = scriptedFetch(() => capabilities(gridNorwayReferenceTileset), ...responses)
  const failures: string[] = []
  const logs: string[] = []
  const controller = await createReferenceDataController({
    map: fake.map,
    styles: [gridNorwayStyle],
    appearance: { theme: 'light' },
    beforeLayerId: () => 'poi-emergency',
    fetchFn: scripted.fetchFn,
    logger: message => logs.push(message),
    onBuildRecoveryFailed: message => failures.push(message),
  })
  const gridLayerIds = () => fake.layers.filter(layer => layer.source === sourceId).map(layer => layer.id)
  return { ...fake, ...scripted, controller, failures, logs, gridLayerIds }
}

describe('reference build recovery after a promotion', () => {
  test('swaps the source to the published build in place, keeping the Pack layers, their order and visibility', async () => {
    const grid = await registerGrid(() => capabilities(gridNorwaySlimReferenceTileset))
    expect(grid.controller.registered[0]?.buildId).toBe(oldBuild)
    grid.map.setLayoutProperty('reference:grid-norway:substations:point', 'visibility', 'none')
    const orderBefore = layerOrder(grid.layers)

    for (let index = 0; index < 5; index++) grid.emit('error', tileError(409, oldBuild))
    await settled()

    expect(grid.reads).toHaveLength(2)
    expect(grid.sources.get(sourceId)).toMatchObject({
      tiles: [`/map/datasets/grid-norway/current/grid-norway/{z}/{x}/{y}.mvt?build=${newBuild}`],
      minzoom: 4,
      maxzoom: 12,
      bounds: [...gridNorwaySlimReferenceTileset.tiles.bounds],
    })
    expect(layerOrder(grid.layers)).toEqual(orderBefore)
    expect(grid.layers.filter(layer => layer.visibility === 'none').map(layer => layer.id)).toEqual(['reference:grid-norway:substations:point'])
    expect(grid.failures).toEqual([])
    expect(grid.logs).toContain(`reference-data: grid-norway moved from build ${oldBuild} to ${newBuild}`)
  })

  test('reads the capabilities once per superseded build and ignores late, unrelated or other errors', async () => {
    const grid = await registerGrid(() => capabilities(gridNorwaySlimReferenceTileset), () => capabilities(laterTileset))
    grid.emit('error', tileError(409, oldBuild))
    await settled()
    expect(grid.reads).toHaveLength(2)

    grid.emit('error', tileError(409, oldBuild))
    grid.emit('error', tileError(500, newBuild))
    grid.emit('error', tileError(409, newBuild, 'reference:other-dataset'))
    grid.emit('error', { type: 'error', sourceId, error: new Error('network down') })
    await settled()
    expect(grid.reads).toHaveLength(2)

    grid.emit('error', tileError(409, newBuild))
    await settled()
    expect(grid.reads).toHaveLength(3)
    expect(String((grid.sources.get(sourceId)?.tiles as ReadonlyArray<string>)[0])).toEndWith('?build=20261101-000000')
    expect(grid.failures).toEqual([])
  })

  test('removes the dataset and reports when the capabilities cannot be read', async () => {
    const grid = await registerGrid(() => new Response('upstream down', { status: 503 }))
    grid.emit('error', tileError(409, oldBuild))
    await settled()
    expect(grid.failures).toHaveLength(1)
    expect(grid.failures[0]).toContain(`grid-norway left build ${oldBuild}`)
    expect(grid.failures[0]).toContain('returned HTTP 503')
    expect(grid.gridLayerIds()).toEqual([])
    expect(grid.sources.has(sourceId)).toBe(false)

    grid.emit('error', tileError(409, oldBuild))
    await settled()
    expect(grid.reads).toHaveLength(2)
    expect(grid.failures).toHaveLength(1)
  })

  test('removes the dataset and reports when it is no longer published, or the refused build still is', async () => {
    const vanished = await registerGrid(() => capabilities())
    vanished.emit('error', tileError(409, oldBuild))
    await settled()
    expect(vanished.failures[0]).toContain('no longer publish it')
    expect(vanished.gridLayerIds()).toEqual([])
    expect(vanished.sources.has(sourceId)).toBe(false)

    const unchanged = await registerGrid(() => capabilities(gridNorwayReferenceTileset))
    unchanged.emit('error', tileError(409, oldBuild))
    await settled()
    expect(unchanged.failures[0]).toContain('still publish the build the server refuses')
    expect(unchanged.gridLayerIds()).toEqual([])
  })

  test('a disposed controller stops following promotions', async () => {
    const grid = await registerGrid()
    expect(grid.listenerCount('error')).toBe(1)
    grid.controller.dispose()
    expect(grid.listenerCount('error')).toBe(0)
    grid.emit('error', tileError(409, oldBuild))
    await settled()
    expect(grid.reads).toHaveLength(1)
  })
})

describe('map layer registry and build recovery', () => {
  test('reports a failed recovery through onError and stops following on reset', async () => {
    const fake = createFakeMapStyle()
    const responses = [() => capabilities(gridNorwayReferenceTileset), () => new Response('gone', { status: 500 })]
    const originalFetch = globalThis.fetch
    let reads = 0
    globalThis.fetch = (async () => responses[reads++]!()) as unknown as typeof fetch
    const errors: string[] = []
    try {
      const registry = createMapLayerRegistry()
      await registry.registerReferenceLayers({
        map: fake.map,
        styles: [gridNorwayStyle],
        appearance: { theme: 'light' },
        layerGroups: electricGridPackView.presentation.mapLayerGroups ?? [],
        visibility: {},
        onError: message => errors.push(message),
      })
      fake.emit('error', tileError(409, oldBuild))
      await settled()
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('returned HTTP 500')
      expect(fake.listenerCount('error')).toBe(1)
      registry.reset()
      expect(fake.listenerCount('error')).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
