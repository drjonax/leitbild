import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import { emptyCatalogueSymbolAtlas } from '../src/ui/map-runtime/catalogue-symbol-atlas.ts'
import { mercatorPixels } from '../src/ui/map-runtime/label-placement.ts'
import { createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'
import { createOperationalDeckLayerFactory } from '../src/ui/map-runtime/operational-deck-layers.ts'
import { declutterPoints, fanGapPx, fanOut, fanSlots, fanZoomOf, lonLatOfPixels, type FanItem, type FanPlace } from '../src/ui/map-runtime/point-declutter.ts'
import { operationalIconPx, statusDiskRadiusPx } from '../src/ui/map-runtime/symbol-kit.ts'
import type { OperationalPointFeature, OperationalRenderSnapshot, Position3 } from '../src/ui/map-runtime/types.ts'

const disk = statusDiskRadiusPx(operationalIconPx)
const apart = 2 * disk + fanGapPx
/** Icons this little short of their air count as apart (`point-declutter.ts`): a fraction of the 4 px gap. */
const settled = 0.5
const item = (id: string, x: number, y: number): FanItem => ({ id, x, y, radiusPx: disk })
const placed = (items: ReadonlyArray<FanItem>, places: ReadonlyMap<string, FanPlace>): ReadonlyArray<FanItem> =>
  items.map(entry => ({ ...entry, ...(places.get(entry.id) ?? {}) }))
const closest = (items: ReadonlyArray<FanItem>): number => {
  let result = Infinity
  for (let a = 0; a < items.length; a += 1) for (let b = a + 1; b < items.length; b += 1) result = Math.min(result, Math.hypot(items[a]!.x - items[b]!.x, items[a]!.y - items[b]!.y))
  return result
}

describe('fanning out map icons that would overlap', () => {
  test('icons whose disks stand apart keep their true positions', () => {
    expect(fanOut([item('a', 0, 0), item('b', apart, 0), item('c', 0, apart + 1)]).size).toBe(0)
  })

  test('four plants a few px apart in a row spread along their row, every disk clear of the others, each moved as little as it can', () => {
    // As the Halden units lie at a regional zoom: west to east, each a little south of the last.
    const plants = [item('unit-1', 0, 0), item('unit-2', 4, 1), item('unit-3', 8, 2), item('unit-4', 12, 3)]
    const places = fanOut(plants)
    expect(places.size).toBe(4)
    const drawn = placed(plants, places)
    expect(closest(drawn)).toBeGreaterThanOrEqual(apart - settled)
    // Still a row from west to east, a little south each, around the same middle.
    for (let index = 1; index < drawn.length; index += 1) {
      expect(drawn[index]!.x).toBeGreaterThan(drawn[index - 1]!.x)
      expect(drawn[index]!.y).toBeGreaterThan(drawn[index - 1]!.y)
    }
    expect(drawn.reduce((sum, entry) => sum + entry.x, 0) / 4).toBeCloseTo(6, 6)
    for (const plant of plants) expect(Math.hypot(places.get(plant.id)!.x - plant.x, places.get(plant.id)!.y - plant.y)).toBeLessThan(1.6 * apart)
  })

  test('units parked on one spot fan out clockwise from the top in their draw order', () => {
    const units = [item('depot', 100, 100), item('truck-1', 100, 100), item('truck-2', 100, 100)]
    const places = fanOut(units)
    expect(closest(placed(units, places))).toBeGreaterThanOrEqual(apart - settled)
    expect(places.get('depot')!.x).toBeCloseTo(100, 6)
    expect(places.get('depot')!.y).toBeLessThan(100)
    expect(places.get('truck-1')!.x).toBeGreaterThan(100)
    expect(places.get('truck-2')!.x).toBeLessThan(100)
  })

  test('a ring on a spot that would cover a neighbour pushes it aside, so nothing overlaps after fanning', () => {
    // Two icons on one spot, and a third just beyond their disks but inside their ring.
    const items = [item('a', 0, 0), item('b', 0, 0), item('c', apart * 0.75, 0)]
    expect(closest(placed(items, fanOut(items)))).toBeGreaterThanOrEqual(apart - settled)
  })

  test('a dense cluster of a dozen icons a few px apart opens up with no two disks overlapping and keeps its shape', () => {
    const items = Array.from({ length: 12 }, (_, index) => item(`c${index}`, (index % 4) * 9, Math.floor(index / 4) * 9))
    const drawn = placed(items, fanOut(items))
    expect(closest(drawn)).toBeGreaterThanOrEqual(apart - settled)
    // The western column stays west of the eastern one, the top row above the bottom one.
    for (const row of [0, 1, 2]) expect(drawn[row * 4]!.x).toBeLessThan(drawn[row * 4 + 3]!.x)
    for (const column of [0, 1, 2, 3]) expect(drawn[column]!.y).toBeLessThan(drawn[8 + column]!.y)
  })

  test('a large group on one spot stands on a spiral with no two disks overlapping, its outer reach growing as the root of its size', () => {
    for (const count of [9, 25, 60]) {
      const items = Array.from({ length: count }, (_, index) => item(`u${index}`, 0, 0))
      const drawn = placed(items, fanOut(items))
      expect(closest(drawn)).toBeGreaterThanOrEqual(apart - settled)
      const reach = Math.max(...drawn.map(entry => Math.hypot(entry.x, entry.y)))
      expect(reach).toBeLessThan(apart * Math.sqrt(count))
    }
  })

  test('separate clusters fan out each around its own middle', () => {
    const items = [item('a', 0, 0), item('b', 2, 0), item('c', 500, 0), item('d', 502, 0), item('e', 250, 0)]
    const places = fanOut(items)
    expect(places.has('e')).toBe(false)
    expect((places.get('a')!.x + places.get('b')!.x) / 2).toBeCloseTo(1, 6)
    expect((places.get('c')!.x + places.get('d')!.x) / 2).toBeCloseTo(501, 6)
  })

  test('the layout is the same whatever order the same icons arrive in', () => {
    const items = [item('a', 0, 0), item('b', 5, 3), item('c', 9, -2), item('d', 300, 0)]
    const forward = fanOut(items)
    const backward = fanOut([...items].reverse())
    for (const id of ['a', 'b', 'c']) {
      expect(backward.get(id)!.x).toBeCloseTo(forward.get(id)!.x, 6)
      expect(backward.get(id)!.y).toBeCloseTo(forward.get(id)!.y, 6)
    }
  })

  test('the slots of any fan stand at least the spacing apart', () => {
    for (let count = 2; count <= 40; count += 1) {
      const slots = fanSlots(count, apart).map((slot, index) => ({ ...slot, id: String(index), radiusPx: disk }))
      expect(closest(slots)).toBeGreaterThanOrEqual(apart - settled)
    }
  })

  test('hundreds of icons spread over the map, a few of them clustered, lay out quickly and clear of each other', () => {
    const spread = Array.from({ length: 600 }, (_, index) => item(`p${index}`, (index % 30) * 50, Math.floor(index / 30) * 50))
    const depot = Array.from({ length: 12 }, (_, index) => item(`d${index}`, 1010, 510))
    const row = Array.from({ length: 8 }, (_, index) => item(`r${index}`, 220 + index * 6, 740 + index * 2))
    const items = [...spread, ...depot, ...row]
    const started = performance.now()
    const places = fanOut(items)
    expect(performance.now() - started).toBeLessThan(100)
    const drawn = placed(items, places)
    const near = (entry: FanItem) => Math.abs(entry.x - 1010) < 200 && Math.abs(entry.y - 510) < 200 || Math.abs(entry.x - 240) < 200 && Math.abs(entry.y - 747) < 200
    expect(closest(drawn.filter(near))).toBeGreaterThanOrEqual(apart - settled)
    // Icons far from the clusters stay where they are.
    expect(places.has('p0')).toBe(false)
    expect(places.has('p599')).toBe(false)
  })
})

describe('operational points as the map draws them', () => {
  const at = '2026-10-12T08:00:00.000Z' as IsoTimestamp
  const objectOf = (id: string, lon: number, lat: number): OperationalObject => ({
    id: id as ObjectId,
    kind: 'facility',
    packId: 'fixture' as PackId,
    label: id,
    lifecycle: 'active',
    revision: 1,
    spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(lon, lat), observedAt: at } },
    operational: { status: 'normal', mode: 'simulated' },
    alerts: [],
    provenance: { source: 'simulator' },
    timestamps: { createdAt: at, updatedAt: at },
  })
  // The four Halden units as the power complex places them, about 430 m apart, and the grid's alarm at the switchyard beside them.
  const units = [objectOf('plant:halden-1', 11.47, 59.087), objectOf('plant:halden-2', 11.477, 59.085), objectOf('plant:halden-3', 11.484, 59.083), objectOf('plant:halden-4', 11.491, 59.081)]
  const snapshotOf = (objects: ReadonlyArray<OperationalObject>, selected: string | null = null): OperationalRenderSnapshot => createMapFeatureStore().update({
    objects,
    selectedControllerId: selected,
    highlightedObjectIds: [],
    hiddenObjectCategoryIds: [],
    placementPoints: [],
    packFeatures: [],
    hasNewInfo: object => object.id === 'grid',
    presentationFor: object => ({ categoryId: 'fixture', icon: 'square', color: '#334155', summary: object.label, fields: [], mapLabel: object.label, noteworthyUpdates: true }),
  })
  const halden = snapshotOf(units).points

  test('pixels at a zoom come back to the degrees they were made from', () => {
    const pixels = mercatorPixels(11.47, 59.087, 9.5)
    const [lon, lat] = lonLatOfPixels(pixels.x, pixels.y, 9.5)
    expect(lon).toBeCloseTo(11.47, 9)
    expect(lat).toBeCloseTo(59.087, 9)
    expect(fanZoomOf(9.5)).toBe(9.5)
    expect(fanZoomOf(12.99)).toBe(12.875)
  })

  test('at the regional zoom the units fan out with a leader from each to its true position; zoomed in they stand where they are', () => {
    const regional = declutterPoints(halden, 9.5)
    expect(regional.leaders.map(leader => leader.id)).toEqual(halden.map(point => point.id))
    for (const leader of regional.leaders) expect(leader.trueAt).toEqual(halden.find(point => point.id === leader.id)!.position)
    const screen = regional.points.map(point => ({ id: point.id, ...mercatorPixels(point.position[0], point.position[1], 9.5), radiusPx: disk }))
    expect(closest(screen)).toBeGreaterThanOrEqual(apart - settled)
    expect(regional.points.map(point => point.object.id)).toEqual(halden.map(point => point.object.id))
    expect(regional.drawnAt.get('plant:halden-1')).toEqual(regional.points[0]!.position)

    const close = declutterPoints(halden, 15)
    expect(close.points).toBe(halden)
    expect(close.leaders).toEqual([])
  })

  test('every icon layer draws a fanned object where its icon stands, beside a leader to its true position; a handle stands on its controller\'s icon', () => {
    const snapshot = snapshotOf([...units, objectOf('grid', 11.478, 59.084)], 'plant:halden-2')
    const factory = createOperationalDeckLayerFactory()
    const selected: string[] = []
    const layers = factory.createLayers({
      snapshot,
      visibleFamilies: new Set(['objects']),
      catalogueAtlas: emptyCatalogueSymbolAtlas,
      disksPick: false,
      diskClicks: null,
      zoom: 9.5,
      onObjectSelected: point => { selected.push(point.object.id) },
      onObjectSeen: () => undefined,
      onObjectHover: () => undefined,
      assignmentInteraction: { revision: 1, active: false, anchor: null, pointer: null, handles: [{ id: 'handle', controllerId: 'plant:halden-2', position: [11.477, 59.085, 0] }] },
    })
    const drawn = factory.drawnPoints()
    expect(drawn.map(point => point.id)).toEqual(snapshot.points.map(point => point.id))
    const at = new Map(drawn.map(point => [point.id, point.position]))
    for (const point of snapshot.points) expect(at.get(point.id)).not.toEqual(point.position)
    const dataOf = (id: string) => layers.find(layer => layer.id === id)?.props.data as ReadonlyArray<OperationalPointFeature>
    for (const id of ['leitbild-object-halos', 'leitbild-object-status-disks', 'leitbild-object-symbols', 'leitbild-object-labels', 'leitbild-object-new-info']) {
      for (const point of dataOf(id)) expect(point.position).toEqual(at.get(point.id)!)
    }
    expect(dataOf('leitbild-object-new-info').map(point => point.id)).toEqual(['grid'])
    const leaders = dataOf('leitbild-object-leaders') as unknown as ReadonlyArray<{ readonly id: string; readonly drawnAt: Position3; readonly trueAt: Position3 }>
    expect(leaders.map(leader => leader.id).sort()).toEqual(snapshot.points.map(point => point.id).sort())
    for (const leader of leaders) {
      expect(leader.drawnAt).toEqual(at.get(leader.id)!)
      expect(leader.trueAt).toEqual(snapshot.points.find(point => point.id === leader.id)!.position)
    }
    // The leaders lie beneath the icons, and a click on a fanned icon still picks its object.
    const order = layers.map(layer => layer.id)
    expect(order.indexOf('leitbild-object-leaders')).toBeLessThan(order.indexOf('leitbild-object-halos'))
    const symbols = layers.find(layer => layer.id === 'leitbild-object-symbols')!.props as unknown as { readonly onClick: (info: { readonly object: unknown }) => void }
    symbols.onClick({ object: drawn.find(point => point.id === 'plant:halden-2') })
    expect(selected).toEqual(['plant:halden-2'])
    const handles = layers.find(layer => layer.id === 'leitbild-assignment-handles')!.props as unknown as { readonly getPosition: (handle: { readonly controllerId: string; readonly position: Position3 }) => Position3 }
    expect(handles.getPosition({ controllerId: 'plant:halden-2', position: [11.477, 59.085, 0] })).toEqual(at.get('plant:halden-2')!)

    // Zoomed in until the disks stand apart, every layer draws the true positions and no leader.
    const close = factory.createLayers({
      snapshot,
      visibleFamilies: new Set(['objects']),
      catalogueAtlas: emptyCatalogueSymbolAtlas,
      disksPick: false,
      diskClicks: null,
      zoom: 15,
      onObjectSelected: () => undefined,
      onObjectSeen: () => undefined,
      onObjectHover: () => undefined,
    })
    expect(factory.drawnPoints()).toBe(snapshot.points)
    expect(close.some(layer => layer.id === 'leitbild-object-leaders')).toBe(false)
    expect(close.find(layer => layer.id === 'leitbild-object-status-disks')?.props.data).toBe(snapshot.points)
  })
})
