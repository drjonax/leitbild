import { describe, expect, test } from 'bun:test'
import type { PackReferenceDatasetStyle } from '../src/core/packs/reference-style.ts'
import { gridNorwayStyle } from '../src/packs/electric-grid/ui/grid-norway-style.ts'
import { createReferenceDataController } from '../src/ui/map/reference-data-controller.ts'
import { gridNorwayReferenceTileset } from './fixtures/grid-norway-reference-manifest.ts'
import { createFakeMapStyle, layerOrder } from './helpers/fake-map-style.ts'

const capabilities = (...tilesets: ReadonlyArray<Record<string, unknown>>) => ({
  schemaVersion: 2,
  tilesets: [{ kind: 'base', id: 'leitbild-osm-norway' }, ...tilesets],
})

const fakeFetch = (status: number, body: unknown) => async (_input: string): Promise<Response> =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const otherStyle: PackReferenceDatasetStyle = {
  datasetId: 'other-dataset',
  outputLayer: 'grid',
  categories: ['line', 'cable', 'substation', 'transformer', 'plant', 'generator'],
  layersFor: () => [{ id: 'all:line', type: 'line', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#000000' } }],
}

describe('createReferenceDataController', () => {
  test('registers the grid-norway source and Pack layers below the first base label', async () => {
    const { map, layers, sources } = createFakeMapStyle()
    const controller = await createReferenceDataController({
      map,
      styles: [gridNorwayStyle],
      appearance: { theme: 'light' },
      beforeLayerId: () => 'poi-emergency',
      fetchFn: fakeFetch(200, capabilities(gridNorwayReferenceTileset)),
    })
    const registered = controller.registered[0]!
    expect(controller.registered).toHaveLength(1)
    expect(registered.sourceId).toBe('reference:grid-norway')
    expect(sources.get('reference:grid-norway')?.tiles).toEqual(['/map/datasets/grid-norway/current/grid-norway/{z}/{x}/{y}.mvt'])
    expect(registered.layerIds.length).toBeGreaterThan(0)
    const order = layerOrder(layers)
    const firstLabel = order.indexOf('poi-emergency')
    expect(order.slice(firstLabel - registered.layerIds.length, firstLabel)).toEqual([...registered.layerIds])
  })

  test('resolves the insertion point only after the manifest arrives', async () => {
    const { map } = createFakeMapStyle()
    const events: string[] = []
    await createReferenceDataController({
      map,
      styles: [gridNorwayStyle],
      appearance: { theme: 'dark' },
      beforeLayerId: () => { events.push('anchor'); return null },
      fetchFn: async input => { events.push('fetch'); return await fakeFetch(200, capabilities(gridNorwayReferenceTileset))(input) },
    })
    expect(events).toEqual(['fetch', 'anchor'])
  })

  test('fails visibly when the insertion point is missing or the style does not fit the build', async () => {
    const { map } = createFakeMapStyle()
    await expect(createReferenceDataController({
      map,
      styles: [gridNorwayStyle],
      appearance: { theme: 'light' },
      beforeLayerId: () => 'missing-layer',
      fetchFn: fakeFetch(200, capabilities(gridNorwayReferenceTileset)),
    })).rejects.toThrow('missing layer missing-layer')

    const renamed = { ...gridNorwayReferenceTileset, artifact: { ...gridNorwayReferenceTileset.artifact, outputLayer: 'power' } }
    await expect(createReferenceDataController({
      map: createFakeMapStyle().map,
      styles: [gridNorwayStyle],
      appearance: { theme: 'light' },
      beforeLayerId: () => null,
      fetchFn: fakeFetch(200, capabilities(renamed)),
    })).rejects.toThrow('build wrote "power"')
  })

  test('registers only datasets with an active style and reports unpublished ones', async () => {
    const { map, sources } = createFakeMapStyle()
    const captured: string[] = []
    const controller = await createReferenceDataController({
      map,
      styles: [gridNorwayStyle, otherStyle],
      appearance: { theme: 'light' },
      beforeLayerId: () => null,
      fetchFn: fakeFetch(200, capabilities(gridNorwayReferenceTileset, { ...gridNorwayReferenceTileset, datasetId: 'unstyled' })),
      logger: message => captured.push(message),
    })
    expect(controller.registered.map(entry => entry.datasetId)).toEqual(['grid-norway'])
    expect(sources.has('reference:unstyled')).toBe(false)
    expect(captured.join('\n')).toContain('dataset "other-dataset" is not published')
  })

  test('manifest 404 or unparsable manifest registers nothing and logs why', async () => {
    for (const [status, body, reason] of [[404, 'not found', /HTTP 404/], [200, 'not json', /manifest fetch failed/]] as const) {
      const captured: string[] = []
      const controller = await createReferenceDataController({
        map: createFakeMapStyle().map,
        styles: [gridNorwayStyle],
        appearance: { theme: 'light' },
        beforeLayerId: () => null,
        fetchFn: fakeFetch(status, body),
        logger: message => captured.push(message),
      })
      expect(controller.registered).toEqual([])
      expect(captured.join('\n')).toMatch(reason)
    }
  })

  test('no active styles registers nothing without fetching', async () => {
    let fetches = 0
    const controller = await createReferenceDataController({
      map: createFakeMapStyle().map,
      styles: [],
      appearance: { theme: 'light' },
      beforeLayerId: () => null,
      fetchFn: async input => { fetches += 1; return await fakeFetch(200, capabilities())(input) },
    })
    expect(controller.registered).toEqual([])
    expect(fetches).toBe(0)
  })
})
