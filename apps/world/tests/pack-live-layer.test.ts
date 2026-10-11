import { describe, expect, test } from 'bun:test'
import type { OperationalObject } from '../src/core/model/index.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import type { PackLiveFeatureState, PackLiveMapLayer, PackMapFeatureQuery } from '../src/core/packs/protocol.ts'
import type { PackReferenceDatasetStyle } from '../src/core/packs/reference-style.ts'
import {
  createPackLiveLayerController,
  featureStateChanges,
  recolorPaintValue,
  type LiveMapHover,
  type LiveMapPort,
  type PackLiveLayerSyncInput,
} from '../src/ui/map-runtime/pack-live-layer.ts'

// A fake MapLibre map for the generic live-layer renderer: it records sources, layer order,
// feature-state writes and paint changes, and answers rendered-feature queries on demand.

interface FakeLayer {
  readonly id: string
  readonly type: string
  readonly source?: string
  layout: Record<string, unknown>
  paint: Record<string, unknown>
}

const createFakeMap = (baseLayers: ReadonlyArray<FakeLayer>) => {
  const layers: FakeLayer[] = baseLayers.map(layer => ({ ...layer }))
  const sources = new Map<string, { data: GeoJSON.FeatureCollection; promoteId?: string; attribution?: string; setData: (data: GeoJSON.FeatureCollection) => void }>()
  const featureState = new Map<string, Record<string, unknown>>()
  const stateWrites: Array<{ readonly source: string; readonly id: number; readonly state: Readonly<Record<string, unknown>> }> = []
  const stateRemovals: Array<{ readonly source: string; readonly id?: number; readonly key?: string }> = []
  const images = new Set<string>()
  const listeners = new Map<string, Set<(event: never) => void>>()
  let rendered: ReadonlyArray<{ readonly id: number; readonly source: string; readonly layer: string }> = []
  const port: LiveMapPort = {
    getStyle: () => ({ layers }),
    getSource: id => sources.get(id),
    addSource: (id, source) => {
      if (sources.has(id)) throw new Error(`source ${id} exists`)
      const entry = { data: source.data, ...(source.promoteId === undefined ? {} : { promoteId: source.promoteId }), ...(source.attribution === undefined ? {} : { attribution: source.attribution }), setData: (data: GeoJSON.FeatureCollection) => { entry.data = data } }
      sources.set(id, entry)
    },
    removeSource: id => { sources.delete(id) },
    getLayer: id => layers.find(layer => layer.id === id),
    addLayer: (layer, beforeId) => {
      const entry = { ...(layer as unknown as FakeLayer), layout: { ...(layer.layout as Record<string, unknown>) }, paint: { ...(layer.paint as Record<string, unknown>) } }
      const index = beforeId === undefined ? -1 : layers.findIndex(candidate => candidate.id === beforeId)
      if (beforeId !== undefined && index < 0) throw new Error(`no layer ${beforeId}`)
      if (index < 0) layers.push(entry)
      else layers.splice(index, 0, entry)
    },
    removeLayer: id => { layers.splice(layers.findIndex(layer => layer.id === id), 1) },
    setLayoutProperty: (layerId, name, value) => { layers.find(layer => layer.id === layerId)!.layout[name] = value },
    setPaintProperty: (layerId, name, value) => { layers.find(layer => layer.id === layerId)!.paint[name] = value },
    setFeatureState: (target, state) => {
      stateWrites.push({ source: target.source, id: target.id, state })
      const key = `${target.source}|${target.id}`
      featureState.set(key, { ...featureState.get(key), ...state })
    },
    removeFeatureState: (target, key) => {
      stateRemovals.push({ source: target.source, ...(target.id === undefined ? {} : { id: target.id }), ...(key === undefined ? {} : { key }) })
      const stateKey = `${target.source}|${target.id}`
      if (key === undefined) featureState.delete(stateKey)
      else delete featureState.get(stateKey)?.[key]
    },
    hasImage: id => images.has(id),
    addImage: id => { images.add(id) },
    removeImage: id => { images.delete(id) },
    queryRenderedFeatures: (_point, options) => rendered.filter(feature => options.layers.includes(feature.layer)),
    on: (type: string, listener: (event: never) => void) => {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    off: (type: string, listener: (event: never) => void) => { listeners.get(type)?.delete(listener) },
  }
  return {
    port,
    layers,
    sources,
    featureState,
    stateWrites,
    stateRemovals,
    images,
    render: (features: typeof rendered) => { rendered = features },
    emit: (type: string, event: unknown) => { for (const listener of listeners.get(type) ?? []) listener(event as never) },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  }
}

const baseLayers: ReadonlyArray<FakeLayer> = [
  { id: 'background', type: 'background', layout: {}, paint: {} },
  { id: 'roads', type: 'line', source: 'base', layout: {}, paint: {} },
  { id: 'reference:grid:lines:line', type: 'line', source: 'reference:grid', layout: {}, paint: { 'line-color': ['case', true, '#1b1f6b', '#c2389e'], 'line-width': 2 } },
  { id: 'reference:grid:lines:label', type: 'symbol', source: 'reference:grid', layout: {}, paint: { 'text-color': '#1f2937' } },
  { id: 'place-labels', type: 'symbol', source: 'base', layout: {}, paint: {} },
]

const referenceStyle: PackReferenceDatasetStyle = {
  datasetId: 'grid',
  outputLayer: 'grid',
  categories: ['line'],
  layersFor: () => [
    { id: 'lines:line', type: 'line', filter: [], paint: { 'line-color': ['case', true, '#1b1f6b', '#c2389e'], 'line-width': 2 } },
    { id: 'lines:label', type: 'symbol', filter: [], paint: { 'text-color': '#1f2937' } },
  ],
}

interface TestGeometry { readonly key: string; readonly count: number }
interface TestState { readonly key: string; readonly revision: number; readonly values: ReadonlyArray<number>; readonly extra?: boolean }

const testLayer: PackLiveMapLayer = {
  id: 'test',
  layerGroupId: 'test:live',
  sourceObjects: objects => objects.filter(object => object.packId === 'test'),
  geometryQuery: object => ({ capabilityId: 'world.test.geometry', input: { id: object.id } }),
  stateQuery: object => ({ capabilityId: 'world.test.state', input: { id: object.id } }),
  loadGeometry: raw => {
    const geometry = raw as TestGeometry
    return {
      key: geometry.key,
      features: Array.from({ length: geometry.count }, (_, fid) => ({ fid, geometry: geoPointFromLonLat(10 + fid, 60), properties: { kind: 'point' } })),
      selectionFor: fid => ({ panelId: 'test.panel', itemId: `item-${fid}` }),
      fidForSelection: selection => selection.panelId === 'test.panel' ? Number(selection.itemId.slice('item-'.length)) : null,
      presentState: rawState => {
        const state = rawState as TestState
        if (state.key !== geometry.key) throw new Error('misaligned')
        return {
          revision: state.revision,
          featureStates: new Map(state.values.map((value, fid): [number, PackLiveFeatureState] => [fid, { value, ...(state.extra ? { extra: true } : {}) }])),
          labels: state.values.flatMap((value, fid) => value > 50 ? [{ fid, geometry: geoPointFromLonLat(10 + fid, 60), properties: { text: `${value}` } }] : []),
          hoverCard: fid => ({ title: `Point ${fid}`, fields: [{ key: 'value', label: 'Value', value: String(state.values[fid]) }] }),
        }
      },
    }
  },
  stateGeometryKey: raw => (raw as TestState).key,
  layersFor: appearance => [
    { id: 'points', source: 'features', type: 'circle', paint: { 'circle-color': appearance.theme === 'light' ? '#000000' : '#ffffff', 'circle-opacity': ['number', ['feature-state', 'value'], 0] }, interactive: true },
    { id: 'labels', source: 'labels', type: 'symbol', layout: { 'text-field': ['get', 'text'] }, paint: {} },
  ],
  imagesFor: () => [{ id: 'test:arrow', svg: '<svg/>' }],
  referenceContext: { datasetIds: ['grid'], color: () => '#999999' },
  attribution: 'Test data'
}

const objectAt = (revision: number): OperationalObject => ({ id: 'grid-a', packId: 'test', revision }) as unknown as OperationalObject

const settle = async (): Promise<void> => {
  for (let round = 0; round < 4; round += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

const harness = () => {
  const map = createFakeMap(baseLayers)
  const queries: PackMapFeatureQuery[] = []
  const answers: { geometry: TestGeometry; state: TestState } = { geometry: { key: 'g1', count: 3 }, state: { key: 'g1', revision: 1, values: [10, 20, 30] } }
  const errors: string[] = []
  const hovers: Array<LiveMapHover | null> = []
  const selections: Array<{ panelId: string; itemId: string }> = []
  let hidden = false
  let pending: Array<() => void> | null = null
  const controller = createPackLiveLayerController({
    query: async (request, signal) => {
      queries.push(request)
      if (pending) await new Promise<void>(resolve => pending!.push(resolve))
      if (signal.aborted) throw signal.reason
      return structuredClone(request.capabilityId.endsWith('geometry') ? answers.geometry : answers.state)
    },
    rasterize: async () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }) as unknown as ImageData,
    documentHidden: () => hidden,
    onSelect: selection => { selections.push(selection) },
    onHover: hover => { hovers.push(hover) },
    onError: message => { errors.push(message) },
  })
  let visible = true
  let theme: 'light' | 'dark' = 'light'
  let selected: Readonly<Record<string, string | null>> = {}
  const sync = (revision: number, objects: ReadonlyArray<OperationalObject> = [objectAt(revision)]): void => {
    const input: PackLiveLayerSyncInput = {
      map: map.port,
      bindings: [{ packId: 'test', layer: testLayer }],
      objects,
      appearance: { theme },
      groupVisible: groupId => { if (groupId !== 'test:live') throw new Error(groupId); return visible },
      referenceStyles: [referenceStyle],
      selections: selected,
    }
    controller.sync(input)
  }
  return {
    map, queries, answers, errors, hovers, selections, controller, sync,
    setVisible: (value: boolean) => { visible = value },
    setHidden: (value: boolean) => { hidden = value },
    setTheme: (value: 'light' | 'dark') => { theme = value },
    select: (value: Readonly<Record<string, string | null>>) => { selected = value },
    hold: () => { pending = [] },
    release: () => { const waiting = pending ?? []; pending = null; for (const resolve of waiting) resolve() },
  }
}

const sourceId = 'live:test:grid-a'
const stateIds = (queries: ReadonlyArray<PackMapFeatureQuery>) => queries.map(query => query.capabilityId)

describe('Pack live map layer renderer', () => {
  test('installs a promoted-id GeoJSON source and inserts its layers below the first base label', async () => {
    const h = harness()
    h.sync(1)
    await settle()
    expect(h.errors).toEqual([])
    expect(h.map.sources.get(sourceId)!.promoteId).toBe('fid')
    expect(h.map.sources.get(sourceId)!.attribution).toBe('Test data')
    expect(h.map.sources.get(sourceId)!.data.features.map(feature => feature.properties!.fid)).toEqual([0, 1, 2])
    expect(h.map.layers.map(layer => layer.id)).toEqual([
      'background', 'roads', 'reference:grid:lines:line', 'reference:grid:lines:label',
      'live:test:grid-a:points', 'live:test:grid-a:labels',
      'place-labels',
    ])
    expect(h.map.images.has('test:arrow')).toBe(true)
    expect(h.map.featureState.get(`${sourceId}|2`)).toEqual({ value: 30 })
  })

  test('writes only the feature-state values that changed', async () => {
    const h = harness()
    h.sync(1)
    await settle()
    const writes = h.map.stateWrites.length
    h.answers.state = { key: 'g1', revision: 2, values: [10, 25, 30] }
    h.sync(2)
    await settle()
    expect(h.map.stateWrites.slice(writes)).toEqual([{ source: sourceId, id: 1, state: { value: 25 } }])
    h.answers.state = { key: 'g1', revision: 3, values: [10, 25, 30], extra: true }
    h.sync(3)
    await settle()
    expect(h.map.stateWrites.slice(writes + 1).map(write => write.id)).toEqual([0, 1, 2])
    h.answers.state = { key: 'g1', revision: 4, values: [10, 25, 30] }
    h.sync(4)
    await settle()
    expect(h.map.stateRemovals).toEqual([0, 1, 2].map(id => ({ source: sourceId, id, key: 'extra' })))
    expect(h.map.stateWrites.length).toBe(writes + 4)
  })

  test('fetches state only on a new revision and geometry only on a new key', async () => {
    const h = harness()
    h.sync(1)
    await settle()
    expect(stateIds(h.queries).sort()).toEqual(['world.test.geometry', 'world.test.state'])
    h.sync(1)
    h.sync(1)
    await settle()
    expect(h.queries).toHaveLength(2)
    h.answers.state = { key: 'g1', revision: 2, values: [1, 2, 3] }
    h.sync(2)
    await settle()
    expect(stateIds(h.queries.slice(2))).toEqual(['world.test.state'])
    h.answers.geometry = { key: 'g2', count: 4 }
    h.answers.state = { key: 'g2', revision: 3, values: [1, 2, 3, 4] }
    h.sync(3)
    await settle()
    expect(stateIds(h.queries.slice(3))).toEqual(['world.test.state', 'world.test.geometry'])
    expect(h.map.sources.get(sourceId)!.data.features).toHaveLength(4)
    expect(h.map.featureState.get(`${sourceId}|3`)).toEqual({ value: 4 })
    expect(h.errors).toEqual([])
  })

  test('skips fetches while its layer group is hidden or the page is hidden', async () => {
    const h = harness()
    h.setVisible(false)
    h.sync(1)
    h.setVisible(true)
    h.setHidden(true)
    h.sync(1)
    await settle()
    expect(h.queries).toEqual([])
    h.setHidden(false)
    h.sync(1)
    await settle()
    expect(h.queries).toHaveLength(2)
    h.setVisible(false)
    h.sync(2)
    await settle()
    expect(h.queries).toHaveLength(2)
    expect(h.map.layers.filter(layer => layer.id.startsWith('live:')).map(layer => layer.layout.visibility)).toEqual(['none', 'none'])
  })

  test('aborts a superseded fetch and applies only the newest state', async () => {
    const h = harness()
    h.sync(1)
    await settle()
    h.hold()
    h.answers.state = { key: 'g1', revision: 2, values: [99, 99, 99] }
    h.sync(2)
    await settle()
    h.answers.state = { key: 'g1', revision: 3, values: [7, 8, 9] }
    h.sync(3)
    await settle()
    h.release()
    await settle()
    expect(h.errors).toEqual([])
    expect([0, 1, 2].map(fid => h.map.featureState.get(`${sourceId}|${fid}`)!.value)).toEqual([7, 8, 9])
    expect(h.map.stateWrites.some(write => write.state.value === 99)).toBe(false)
  })

  test('rejects a query outside its own Pack', async () => {
    const h = harness()
    const foreign: PackLiveMapLayer = { ...testLayer, stateQuery: () => ({ capabilityId: 'world.other.state', input: {} }) }
    h.controller.sync({ map: h.map.port, bindings: [{ packId: 'test', layer: foreign }], objects: [objectAt(1)], appearance: { theme: 'light' }, groupVisible: () => true, referenceStyles: [], selections: {} })
    await settle()
    expect(h.errors).toEqual(['Pack test live map layer test uses foreign Capability world.other.state'])
  })

  test('mutes reference colours while shown and restores them when hidden', async () => {
    const h = harness()
    h.sync(1)
    await settle()
    const reference = () => h.map.layers.find(layer => layer.id === 'reference:grid:lines:line')!.paint['line-color']
    expect(reference()).toEqual(['case', true, '#999999', '#999999'])
    expect(h.map.layers.find(layer => layer.id === 'reference:grid:lines:label')!.paint['text-color']).toBe('#999999')
    h.setVisible(false)
    h.sync(1)
    expect(reference()).toEqual(['case', true, '#1b1f6b', '#c2389e'])
  })

  test('hover shows the Pack card, click selects, and the selection carries feature-state', async () => {
    const h = harness()
    h.sync(1)
    await settle()
    h.map.render([{ id: 1, source: sourceId, layer: 'live:test:grid-a:points' }])
    h.map.emit('mousemove', { point: { x: 5, y: 5 }, lngLat: { lng: 11, lat: 60 } })
    h.map.emit('mousemove', { point: { x: 6, y: 5 }, lngLat: { lng: 11, lat: 60 } })
    expect(h.hovers).toEqual([{ title: 'Point 1', fields: [{ key: 'value', label: 'Value', value: '20' }], lngLat: [11, 60] }])
    expect(h.map.featureState.get(`${sourceId}|1`)!.hover).toBe(true)
    h.map.emit('click', { point: { x: 6, y: 5 }, lngLat: { lng: 11, lat: 60 } })
    expect(h.selections).toEqual([{ panelId: 'test.panel', itemId: 'item-1' }])
    h.map.render([])
    h.map.emit('mousemove', { point: { x: 50, y: 50 }, lngLat: { lng: 15, lat: 60 } })
    expect(h.hovers.at(-1)).toBeNull()
    expect(h.map.featureState.get(`${sourceId}|1`)!.hover).toBe(false)
    h.select({ 'test.panel': 'item-2' })
    h.sync(1)
    expect(h.map.featureState.get(`${sourceId}|2`)!.selected).toBe(true)
    h.select({ 'test.panel': null })
    h.sync(1)
    expect(h.map.featureState.get(`${sourceId}|2`)!.selected).toBe(false)
  })

  test('reinstalls after a style reload with the new theme, and removes everything on destroy', async () => {
    const h = harness()
    h.sync(1)
    await settle()
    for (const id of [...h.map.sources.keys()]) h.map.port.removeSource(id)
    for (const layer of h.map.layers.filter(candidate => candidate.id.startsWith('live:'))) h.map.port.removeLayer(layer.id)
    h.setTheme('dark')
    h.sync(1)
    await settle()
    expect(h.queries).toHaveLength(2)
    expect(h.map.layers.find(layer => layer.id === 'live:test:grid-a:points')!.paint['circle-color']).toBe('#ffffff')
    expect(h.map.featureState.get(`${sourceId}|0`)).toEqual({ value: 10 })
    h.controller.destroy()
    expect(h.map.layers.some(layer => layer.id.startsWith('live:'))).toBe(false)
    expect(h.map.sources.size).toBe(0)
    expect(h.map.listenerCount()).toBe(0)
  })
})

describe('live layer helpers', () => {
  test('feature-state changes list only changed and removed keys', () => {
    expect(featureStateChanges(undefined, { a: 1 })).toEqual({ set: { a: 1 }, removed: [] })
    expect(featureStateChanges({ a: 1, b: true }, { a: 1, b: true })).toBeNull()
    expect(featureStateChanges({ a: 1, b: true }, { a: 2 })).toEqual({ set: { a: 2 }, removed: ['b'] })
  })

  test('recolouring touches colour literals only', () => {
    expect(recolorPaintValue(['match', ['get', 'category'], 'line', '#112233', 'rgba(1, 2, 3, 0.5)'], () => '#000000'))
      .toEqual(['match', ['get', 'category'], 'line', '#000000', '#000000'])
  })
})
