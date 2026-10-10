import { describe, expect, test } from 'bun:test'
import { gridNorwayTileFeatures } from '../src/packs/electric-grid/datasets/grid-norway-tiles.ts'
import { gridNorwayTilebuild } from '../src/packs/electric-grid/datasets/grid-norway.ts'
import { siteAnchor } from '../src/packs/electric-grid/datasets/site-anchor.ts'
import type { GridReferenceFeatureProperties } from '../src/packs/electric-grid/schemas/grid-reference.ts'
import { pointInPolygon } from '../src/reference-data/point-in-polygon.ts'
import type { GeoJsonGeometry, NormalizedFeature, TileFeature, TileProjection } from '../src/reference-data/types.ts'
import { gridFeature } from './helpers/grid-reference-feature.ts'

const line: GeoJsonGeometry = { type: 'LineString', coordinates: [[10, 60], [10.2, 60.1]] }
const square: GeoJsonGeometry = { type: 'Polygon', coordinates: [[[10, 60], [10.002, 60], [10.002, 60.001], [10, 60.001], [10, 60]]] }
const node: GeoJsonGeometry = { type: 'Point', coordinates: [10.001, 60.0005] }

const tiled = (projection: TileProjection): ReadonlyArray<TileFeature> => {
  if (projection.kind !== 'tiled') throw new Error(`expected a tiled projection, got ${projection.reason}`)
  return projection.features
}

const only = (feature: NormalizedFeature): TileFeature => {
  const features = tiled(gridNorwayTileFeatures(feature))
  expect(features).toHaveLength(1)
  return features[0]!
}

describe('grid-norway tile projection: attributes', () => {
  test('keeps only what the style reads, with a rounded voltage', () => {
    const feature = only(gridFeature(line, { category: 'line', maxVoltageKv: 420, name: 'Holen - Rød' }))
    expect(feature.properties).toEqual({ category: 'line', maxVoltageKv: 420, name: 'Holen - Rød' })
    expect(feature.geometry).toBe(line)
    expect(only(gridFeature(line, { category: 'line', maxVoltageKv: 131.6 })).properties).toEqual({ category: 'line', maxVoltageKv: 132 })
    expect(only(gridFeature(line, { category: 'line' })).properties).toEqual({ category: 'line' })
  })

  test('names only features whose label can show', () => {
    expect(only(gridFeature(line, { category: 'line', maxVoltageKv: 220, name: 'A - B' })).properties.name).toBe('A - B')
    expect(only(gridFeature(line, { category: 'line', maxVoltageKv: 132, name: 'A - B' })).properties).not.toHaveProperty('name')
    expect(only(gridFeature(line, { category: 'cable', maxVoltageKv: 420, name: 'Oslofjord' })).properties).not.toHaveProperty('name')
    expect(only(gridFeature(node, { category: 'substation', maxVoltageKv: 22, name: 'Lokal' })).properties.name).toBe('Lokal')
    expect(only(gridFeature(node, { category: 'plant', outputMw: 12.4, name: 'Kraftverk' })).properties).toEqual({ category: 'plant', outputMw: 12, name: 'Kraftverk' })
    expect(only(gridFeature(node, { category: 'generator', outputMw: 3.6, name: 'G1' })).properties).toEqual({ category: 'generator', outputMw: 4 })
  })

  test('flags HVDC only, and marks assets that are not in service', () => {
    expect(only(gridFeature(line, { category: 'cable', maxVoltageKv: 450, systems: ['hvdc'] })).properties.systems).toBe('hvdc')
    expect(only(gridFeature(node, { category: 'substation', maxVoltageKv: 500, systems: ['ac50', 'hvdc'] })).properties.systems).toBe('hvdc')
    expect(only(gridFeature(line, { category: 'line', maxVoltageKv: 132, systems: ['traction'] })).properties).not.toHaveProperty('systems')
    expect(only(gridFeature(line, { category: 'line', maxVoltageKv: 420, lifecycle: 'construction' })).properties.lifecycle).toBe('construction')
    expect(only(gridFeature(line, { category: 'line', maxVoltageKv: 420 })).properties).not.toHaveProperty('lifecycle')
  })
})

describe('grid-norway tile projection: zoom classes', () => {
  test('lines and cables start at their voltage class zoom; assets not in service from z8', () => {
    const minZoom = (overrides: Partial<GridReferenceFeatureProperties>) => only(gridFeature(line, { category: 'line', ...overrides })).minZoom
    expect([515, 420, 300, 230, 132, 110, 66].map(maxVoltageKv => minZoom({ maxVoltageKv }))).toEqual([4, 4, 4, 5, 6, 8, 8])
    expect(minZoom({})).toBe(9)
    expect(only(gridFeature(line, { category: 'cable', maxVoltageKv: 420 })).minZoom).toBe(4)
    expect(minZoom({ maxVoltageKv: 420, lifecycle: 'proposed' })).toBe(8)
    expect(minZoom({ maxVoltageKv: 132, lifecycle: 'disused' })).toBe(8)
    expect(minZoom({ lifecycle: 'construction' })).toBe(9)
    expect(only(gridFeature(line, { category: 'busbar', maxVoltageKv: 420 })).minZoom).toBe(12)
  })

  test('sites are points below z12 by class, and their footprint from z12', () => {
    const [anchor, footprint] = tiled(gridNorwayTileFeatures(gridFeature(square, { category: 'substation', maxVoltageKv: 420, name: 'Sylling' })))
    expect(anchor).toMatchObject({ minZoom: 5, maxZoom: 11, properties: { category: 'substation', maxVoltageKv: 420, name: 'Sylling' } })
    expect(anchor!.geometry.type).toBe('Point')
    expect(footprint).toEqual({ geometry: square, properties: anchor!.properties, minZoom: 12 })
    const pointAt = (geometry: GeoJsonGeometry, overrides: Parameters<typeof gridFeature>[1]) => tiled(gridNorwayTileFeatures(gridFeature(geometry, overrides)))[0]!.minZoom
    expect([420, 300, 220, 132, 110, 66].map(maxVoltageKv => pointAt(square, { category: 'substation', maxVoltageKv }))).toEqual([5, 5, 7, 7, 9, 9])
    expect(pointAt(square, { category: 'substation' })).toBe(9)
    expect(pointAt(square, { category: 'substation', maxVoltageKv: 420, lifecycle: 'construction' })).toBe(8)
    expect([1240, 500, 499, 100, 99].map(outputMw => pointAt(square, { category: 'plant', outputMw }))).toEqual([5, 5, 7, 7, 9])
    expect(pointAt(square, { category: 'plant' })).toBe(9)
    expect(pointAt(node, { category: 'generator', outputMw: 900 })).toBe(9)
    expect(pointAt(node, { category: 'transformer', maxVoltageKv: 420 })).toBe(10)
  })

  test('a site mapped as a node stays one point at every zoom', () => {
    expect(tiled(gridNorwayTileFeatures(gridFeature(node, { category: 'substation', maxVoltageKv: 132 })))).toEqual([
      { geometry: node, properties: { category: 'substation', maxVoltageKv: 132 }, minZoom: 7 },
    ])
  })

  test('topology helpers and abandoned assets stay out of the tiles with a reason', () => {
    expect(gridNorwayTileFeatures(gridFeature(node, { category: 'portal', maxVoltageKv: 420 }))).toEqual({ kind: 'excluded', reason: 'portal:topology-helper' })
    expect(gridNorwayTileFeatures(gridFeature(node, { category: 'terminal' }))).toEqual({ kind: 'excluded', reason: 'terminal:topology-helper' })
    expect(gridNorwayTileFeatures(gridFeature(node, { category: 'circuit', maxVoltageKv: 420 }))).toEqual({ kind: 'excluded', reason: 'circuit:topology-helper' })
    expect(gridNorwayTileFeatures(gridFeature(square, { category: 'substation', lifecycle: 'abandoned' }))).toEqual({ kind: 'excluded', reason: 'substation:abandoned' })
  })

  test('every tile feature fits the tile set zoom range', () => {
    expect(gridNorwayTilebuild.globalMaxZoom).toBe(12)
    expect(gridNorwayTilebuild.tileFeatures).toBe(gridNorwayTileFeatures)
  })
})

describe('site anchor', () => {
  const inside = (geometry: GeoJsonGeometry, point: readonly [number, number]) => pointInPolygon(point, geometry)

  test('an L-shaped footprint anchors inside, well away from its outline', () => {
    const lShape: GeoJsonGeometry = { type: 'Polygon', coordinates: [[[0, 60], [0.004, 60], [0.004, 60.0005], [0.001, 60.0005], [0.001, 60.002], [0, 60.002], [0, 60]]] }
    const anchor = siteAnchor(lShape)
    expect(inside(lShape, anchor)).toBe(true)
    // The vertex mean lies outside the L, in its notch.
    expect(inside(lShape, [0.0015, 60.0009])).toBe(false)
    expect(anchor[0]).toBeGreaterThan(0.0002)
    expect(anchor[0]).toBeLessThan(0.0008)
  })

  test('avoids holes, picks the largest part of a multipolygon and halves unclosed outlines', () => {
    const ring: GeoJsonGeometry = {
      type: 'Polygon',
      coordinates: [
        [[0, 60], [0.004, 60], [0.004, 60.002], [0, 60.002], [0, 60]],
        [[0.001, 60.0005], [0.003, 60.0005], [0.003, 60.0015], [0.001, 60.0015], [0.001, 60.0005]],
      ],
    }
    expect(inside(ring, siteAnchor(ring))).toBe(true)
    const parts: GeoJsonGeometry = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 60], [0.0002, 60], [0.0002, 60.0001], [0, 60.0001], [0, 60]]],
        [[[1, 61], [1.004, 61], [1.004, 61.002], [1, 61.002], [1, 61]]],
      ],
    }
    const [lon, lat] = siteAnchor(parts)
    expect(lon).toBeCloseTo(1.002, 4)
    expect(lat).toBeCloseTo(61.001, 4)
    const open: GeoJsonGeometry = { type: 'LineString', coordinates: [[0, 60], [0.002, 60], [0.002, 60.002]] }
    const [midLon, midLat] = siteAnchor(open)
    expect(midLon).toBeCloseTo(0.002, 6)
    // Half of the length measured in the local plane: 1 of 3 parts runs east at cos(60°) scale.
    expect(midLat).toBeCloseTo(60.0005, 6)
    expect(siteAnchor(node)).toEqual([10.001, 60.0005])
  })
})
