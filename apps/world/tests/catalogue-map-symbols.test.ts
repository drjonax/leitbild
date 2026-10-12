import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import type { PackMapFeature, PackObjectPresentation } from '../src/core/packs/protocol.ts'
import { createCatalogueSymbolAtlas, emptyCatalogueSymbolAtlas, type CatalogueAtlasCell, type CatalogueSymbolAtlasPorts, type CatalogueSymbolAtlasState } from '../src/ui/map-runtime/catalogue-symbol-atlas.ts'
import { createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'
import { createOperationalDeckLayers } from '../src/ui/map-runtime/operational-deck-layers.ts'
import { catalogueSymbolIds } from '../src/ui/map-runtime/operational-render-controller.ts'
import { leitbildSymbolIds, symbolAtlasFor } from '../src/ui/map-runtime/symbol-kit.ts'
import type { OperationalRenderSnapshot } from '../src/ui/map-runtime/types.ts'

const at = '2026-10-12T08:00:00.000Z' as IsoTimestamp

const objectOf = (id: string, lon: number): OperationalObject => ({
  id: id as ObjectId,
  kind: 'mobile_entity',
  packId: 'fixture' as PackId,
  label: id,
  lifecycle: 'active',
  revision: 1,
  spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(lon, 59.12), observedAt: at } },
  operational: { status: 'normal', mode: 'simulated' },
  alerts: [],
  provenance: { source: 'simulator' },
  timestamps: { createdAt: at, updatedAt: at },
})

const presentationWith = (icons: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>> = {}) =>
  (object: OperationalObject): PackObjectPresentation => ({
    categoryId: 'fixture',
    icon: icons[object.id] ?? 'square',
    color: '#334155',
    summary: object.label,
    fields: [],
    ...(labels[object.id] ? { mapLabel: labels[object.id] } : {}),
  })

const snapshotOf = (
  objects: ReadonlyArray<OperationalObject>,
  presentationFor: (object: OperationalObject) => PackObjectPresentation,
  packFeatures: ReadonlyArray<PackMapFeature> = [],
): OperationalRenderSnapshot => createMapFeatureStore().update({
  objects,
  selectedControllerId: null,
  highlightedObjectIds: [],
  hiddenObjectCategoryIds: [],
  placementPoints: [],
  packFeatures,
  hasNewInfo: () => false,
  presentationFor,
})

const layersOf = (snapshot: OperationalRenderSnapshot, catalogueAtlas: CatalogueSymbolAtlasState) => createOperationalDeckLayers({
  snapshot,
  visibleFamilies: new Set(['objects', 'routes']),
  catalogueAtlas,
  onObjectSelected: () => undefined,
  onObjectSeen: () => undefined,
  onObjectHover: () => undefined,
})

const todaysLayerIds = [
  'leitbild-assignment-preview-line',
  'leitbild-assignment-crosshair',
  'leitbild-assignment-handles',
  'leitbild-operational-path-casing',
  'leitbild-operational-paths',
  'leitbild-object-halos',
  'leitbild-object-status-disks',
  'leitbild-object-symbols',
  'leitbild-object-new-info',
  'leitbild-area-symbols',
  'leitbild-placement-preview',
]

const flush = async (): Promise<void> => { for (let index = 0; index < 5; index += 1) await Promise.resolve() }

describe('operational map icons', () => {
  test('compiled atlas ids draw from the compiled atlas, any other catalogue id from loaded artwork', () => {
    for (const id of leitbildSymbolIds) expect(symbolAtlasFor(id)).toBe('compiled')
    expect(symbolAtlasFor('anchor')).toBe('catalogue')
    expect(() => symbolAtlasFor('')).toThrow('Operational map icon is empty')
  })

  test('atlas-only objects render exactly the layers and data they always did', () => {
    const snapshot = snapshotOf([objectOf('a', 11.3), objectOf('b', 11.4)], presentationWith({}))
    expect(catalogueSymbolIds(snapshot).size).toBe(0)
    const layers = layersOf(snapshot, emptyCatalogueSymbolAtlas)
    expect(layers.map(layer => layer.id)).toEqual(todaysLayerIds)
    expect(layers.find(layer => layer.id === 'leitbild-object-symbols')?.props.data).toBe(snapshot.points)
  })

  test('an object with a catalogue icon no longer fails the map, and draws no icon until its artwork arrives', () => {
    const snapshot = snapshotOf([objectOf('a', 11.3), objectOf('t', 11.4)], presentationWith({ t: 'anchor' }))
    expect(snapshot.points.find(point => point.id === 't')).toMatchObject({ symbolId: 'anchor', symbolAtlas: 'catalogue' })
    expect([...catalogueSymbolIds(snapshot)]).toEqual(['anchor'])
    const waiting = layersOf(snapshot, emptyCatalogueSymbolAtlas)
    expect(waiting.map(layer => layer.id)).toEqual(todaysLayerIds)
    expect((waiting.find(layer => layer.id === 'leitbild-object-symbols')?.props.data as ReadonlyArray<{ readonly id: string }>).map(point => point.id)).toEqual(['a'])
    const loaded = layersOf(snapshot, { revision: 1, url: 'data:image/png;base64,', mapping: { anchor: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true } } })
    const catalogue = loaded.find(layer => layer.id === 'leitbild-object-catalogue-symbols')
    expect((catalogue?.props.data as ReadonlyArray<{ readonly id: string }>).map(point => point.id)).toEqual(['t'])
    expect(catalogue?.props.pickable).toBe(true)
  })

  test('Pack area symbols with a catalogue icon draw from the catalogue atlas too', () => {
    const feature: PackMapFeature = { id: 'area', categoryId: 'fixture', geometry: geoPointFromLonLat(11.3, 59.1), anchorPoint: geoPointFromLonLat(11.3, 59.1), symbol: { icon: 'package' }, color: '#334155', summary: 'Depot' }
    const snapshot = snapshotOf([], presentationWith({}), [feature])
    expect([...catalogueSymbolIds(snapshot)]).toEqual(['package'])
    const layers = layersOf(snapshot, { revision: 1, url: 'data:image/png;base64,', mapping: { package: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true } } })
    expect(layers.find(layer => layer.id === 'leitbild-area-symbols')?.props.data).toEqual([])
    expect((layers.find(layer => layer.id === 'leitbild-area-catalogue-symbols')?.props.data as ReadonlyArray<{ readonly id: string }>).map(symbol => symbol.id)).toEqual(['area-symbol:area'])
  })

  test('an object the screen may not order is drawn muted, its presentation aside', () => {
    const store = createMapFeatureStore()
    const snapshot = store.update({
      objects: [objectOf('a', 11.3), objectOf('b', 11.4)],
      selectedControllerId: null,
      highlightedObjectIds: [],
      mutedObjectIds: ['b'],
      hiddenObjectCategoryIds: [],
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor: presentationWith({}),
    })
    expect(snapshot.points.map(point => [point.id, point.muted])).toEqual([['a', false], ['b', true]])
  })

  test('labels are drawn natively only for objects whose Pack presents one', () => {
    const snapshot = snapshotOf([objectOf('a', 11.3), objectOf('b', 11.4)], presentationWith({}, { b: 'B2 · ENR' }))
    expect(snapshot.points.find(point => point.id === 'a')?.label).toBeNull()
    const labels = layersOf(snapshot, emptyCatalogueSymbolAtlas).find(layer => layer.id === 'leitbild-object-labels')
    expect((labels?.props.data as ReadonlyArray<{ readonly label: string }>).map(point => point.label)).toEqual(['B2 · ENR'])
  })

  test('a click or hover on a label acts on its object, so it never counts as open ground', () => {
    const snapshot = snapshotOf([objectOf('a', 11.3), objectOf('b', 11.4)], presentationWith({}, { b: 'B2 · ENR' }))
    const selected: string[] = []
    const seen: string[] = []
    const hovered: Array<string | null> = []
    const labels = createOperationalDeckLayers({
      snapshot,
      visibleFamilies: new Set(['objects', 'routes']),
      catalogueAtlas: emptyCatalogueSymbolAtlas,
      onObjectSelected: point => { selected.push(point.id) },
      onObjectSeen: point => { seen.push(point.id) },
      onObjectHover: point => { hovered.push(point?.id ?? null) },
    }).find(layer => layer.id === 'leitbild-object-labels')
    expect(labels?.props.pickable).toBe(true)
    const labelled = snapshot.points.find(point => point.id === 'b')
    type Pick = (info: { readonly object: unknown }) => void
    ;(labels?.props.onClick as unknown as Pick)({ object: labelled })
    ;(labels?.props.onHover as unknown as Pick)({ object: labelled })
    ;(labels?.props.onHover as unknown as Pick)({ object: undefined })
    expect(selected).toEqual(['b'])
    expect(seen).toEqual(['b'])
    expect(hovered).toEqual(['b', null])
  })
})

describe('catalogue symbol atlas', () => {
  interface FakeImage { readonly svg: string }

  const harness = (
    artwork: (ids: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string>>,
    overrides: Partial<Pick<CatalogueSymbolAtlasPorts<FakeImage>, 'compose' | 'onChange'>> = {},
  ) => {
    const loads: Array<ReadonlyArray<string>> = []
    const composed: Array<{ readonly cells: ReadonlyArray<CatalogueAtlasCell<FakeImage>>; readonly size: { readonly width: number; readonly height: number } }> = []
    const changes: CatalogueSymbolAtlasState[] = []
    const errors: string[] = []
    const atlas = createCatalogueSymbolAtlas<FakeImage>({
      loadArtwork: async ids => { loads.push(ids); return await artwork(ids) },
      rasterize: async svg => ({ svg }),
      compose: (cells, size) => { composed.push({ cells, size }); return `atlas:${cells.map(cell => cell.id).join(',')}` },
      onChange: state => { changes.push(state) },
      onError: message => { errors.push(message) },
      ...overrides,
    })
    return { atlas, loads, composed, changes, errors }
  }

  const known = async (ids: ReadonlyArray<string>) => new Map(ids.filter(id => id !== 'nonsense').map(id => [id, `<svg>${id}</svg>`]))

  test('loads artwork once per icon and packs it into 64 px cells, eight to a row', async () => {
    const run = harness(known)
    run.atlas.request(['anchor', 'package', 'anchor'])
    run.atlas.request(['anchor'])
    await flush()
    expect(run.loads).toEqual([['anchor', 'package']])
    const state = run.atlas.current()
    expect(state.url).toBe('atlas:anchor,package')
    expect(state.mapping.package).toEqual({ x: 64, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true })
    expect(run.composed[0]?.size).toEqual({ width: 512, height: 64 })
    expect(run.composed[0]?.cells.map(cell => [cell.id, cell.x, cell.y, cell.image.svg])).toEqual([['anchor', 8, 8, '<svg>anchor</svg>'], ['package', 72, 8, '<svg>package</svg>']])
    expect(run.changes.map(change => change.revision)).toEqual([1])
    run.atlas.request(['package', 'ship'])
    await flush()
    expect(run.loads).toEqual([['anchor', 'package'], ['ship']])
    expect(run.atlas.current()).toMatchObject({ revision: 2, url: 'atlas:anchor,package,ship' })
  })

  test('reports an icon without artwork once and never asks for it again', async () => {
    const run = harness(known)
    run.atlas.request(['nonsense', 'anchor'])
    await flush()
    run.atlas.request(['nonsense'])
    await flush()
    expect(run.errors).toEqual(['No map artwork for icon: nonsense'])
    expect(run.loads).toEqual([['nonsense', 'anchor']])
    expect(Object.keys(run.atlas.current().mapping)).toEqual(['anchor'])
  })

  test('reports a failed load with the icons it was for', async () => {
    const run = harness(async () => { throw new Error('Unknown icon name; discover available names with world.map.symbols') })
    run.atlas.request(['anchor', 'package'])
    await flush()
    expect(run.errors).toEqual(['No map artwork for icon: anchor, package (Unknown icon name; discover available names with world.map.symbols)'])
    expect(run.atlas.current()).toBe(emptyCatalogueSymbolAtlas)
  })

  test('an atlas that fails to compose or publish is reported on the error path, never left unhandled', async () => {
    let composeFails = true
    const composing = harness(known, {
      compose: cells => {
        if (composeFails) throw new Error('canvas 2D context unavailable')
        return `atlas:${cells.map(cell => cell.id).join(',')}`
      },
    })
    composing.atlas.request(['anchor'])
    await flush()
    expect(composing.errors).toEqual(['Map icon atlas: canvas 2D context unavailable'])
    expect(composing.atlas.current()).toBe(emptyCatalogueSymbolAtlas)
    composeFails = false
    composing.atlas.request(['package'])
    await flush()
    expect(composing.atlas.current()).toMatchObject({ revision: 1, url: 'atlas:anchor,package' })

    const publishing = harness(known, { onChange: () => { throw new Error('deck layer update failed') } })
    publishing.atlas.request(['anchor'])
    await flush()
    expect(publishing.errors).toEqual(['Map icon atlas: deck layer update failed'])
  })

  test('a load from before a reset never lands', async () => {
    let release: (value: ReadonlyMap<string, string>) => void = () => undefined
    const run = harness(() => new Promise(resolve => { release = resolve }))
    run.atlas.request(['anchor'])
    run.atlas.reset()
    release(new Map([['anchor', '<svg/>']]))
    await flush()
    expect(run.changes).toEqual([])
    expect(run.atlas.current().url).toBeNull()
  })
})
