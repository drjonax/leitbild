import { describe, expect, test } from 'bun:test'
import { expression, featureFilter, latest, validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { createActivePackViews } from '../src/core/packs/active-views.ts'
import { layerIdsMatching } from '../src/core/packs/layer-id-glob.ts'
import type { PackMapTheme, PackReferenceLayerSpec } from '../src/core/packs/reference-style.ts'
import { electricGridPackView } from '../src/packs/electric-grid/ui-pack.ts'
import { gridMapPalette, gridVoltageClasses, gridVoltageLegend } from '../src/packs/electric-grid/ui/grid-map-palette.ts'
import { gridNorwayStyle } from '../src/packs/electric-grid/ui/grid-norway-style.ts'
import { buildReferenceDatasetLayers, type ReferenceLayerSpec } from '../src/ui/map/reference-layer-factory.ts'
import { gridNorwayReferenceTileset } from './fixtures/grid-norway-reference-manifest.ts'

const themes: ReadonlyArray<PackMapTheme> = ['light', 'dark']
const built = (theme: PackMapTheme) => buildReferenceDatasetLayers(gridNorwayReferenceTileset, gridNorwayStyle, { theme })
const layer = (id: string, theme: PackMapTheme = 'light'): ReferenceLayerSpec => {
  const found = built(theme).layers.find(candidate => candidate.id === `reference:grid-norway:${id}`)
  if (!found) throw new Error(`no grid layer ${id}`)
  return found
}

const mvtType = { Point: 1, LineString: 2, Polygon: 3 } as const
type GeometryName = keyof typeof mvtType
const feature = (geometry: GeometryName, properties: Record<string, unknown>) =>
  ({ type: mvtType[geometry], properties, geometry: [] }) as never

/** Whether the layer draws the feature at an integer tile zoom (filter and minzoom). */
const draws = (spec: ReferenceLayerSpec, zoom: number, geometry: GeometryName, properties: Record<string, unknown>): boolean =>
  zoom >= (spec.minzoom ?? 0) && featureFilter(spec.filter as never).filter({ zoom } as never, feature(geometry, properties))

const evaluate = (spec: ReferenceLayerSpec, property: string, zoom: number, geometry: GeometryName, properties: Record<string, unknown>): unknown => {
  const inLayout = property in spec.layout
  const propertySpecs = (latest as unknown as Record<string, Record<string, unknown>>)[`${inLayout ? 'layout' : 'paint'}_${spec.type}`]!
  const compiled = expression.createPropertyExpression((inLayout ? spec.layout : spec.paint)[property] as never, propertySpecs[property] as never)
  if (compiled.result !== 'success') throw new Error(`invalid ${property}: ${JSON.stringify(compiled.value)}`)
  return (compiled.value as { evaluate: (globals: unknown, feature: unknown) => unknown }).evaluate({ zoom }, feature(geometry, properties))
}

const containsToken = (value: unknown, token: string): boolean =>
  Array.isArray(value) ? value.some(item => containsToken(item, token)) : value === token

const hasClause = (filter: ReadonlyArray<unknown>, clause: ReadonlyArray<unknown>): boolean =>
  filter[0] === 'all' && filter.slice(1).some(entry => JSON.stringify(entry) === JSON.stringify(clause))

const rgb = (hex: string): readonly [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as unknown as readonly [number, number, number]

const hueSaturation = (hex: string): { readonly hue: number; readonly saturation: number } => {
  const [r, g, b] = rgb(hex)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  const hue = delta === 0 ? 0 : max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4)
  return { hue: (hue + 360) % 360, saturation }
}

/** CIE76 colour difference in CIELAB (D65). */
const deltaE = (a: string, b: string): number => {
  const lab = (hex: string) => {
    const [r, g, bl] = rgb(hex).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116
    const x = f((0.4124 * r! + 0.3576 * g! + 0.1805 * bl!) / 0.95047), y = f(0.2126 * r! + 0.7152 * g! + 0.0722 * bl!), z = f((0.0193 * r! + 0.1192 * g! + 0.9505 * bl!) / 1.08883)
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)] as const
  }
  const [la, aa, ba] = lab(a), [lb, ab, bb] = lab(b)
  return Math.hypot(la - lb, aa - ab, ba - bb)
}

describe('grid-norway reference style: layer structure', () => {
  test('draws the grid with at most ten explicit layers in both themes', () => {
    for (const theme of themes) {
      expect(built(theme).layers.length).toBeLessThanOrEqual(10)
      expect(built(theme).layers.map(spec => spec.id)).toEqual(built('light').layers.map(spec => spec.id))
    }
  })

  test('is a valid MapLibre style in both themes', () => {
    for (const theme of themes) {
      const style = built(theme)
      const errors = validateStyleMin({
        version: 8,
        glyphs: '/map/fonts/{fontstack}/{range}.pbf',
        sources: { [style.sourceId]: { ...style.source, tiles: [...style.source.tiles] } },
        layers: style.layers as never,
      } as never)
      expect(errors.map(error => error.message)).toEqual([])
    }
  })

  test('fills draw only polygons and circles only points', () => {
    for (const spec of built('light').layers) {
      if (spec.type === 'fill') expect(hasClause(spec.filter, ['==', ['geometry-type'], 'Polygon'])).toBe(true)
      if (spec.type === 'circle') expect(hasClause(spec.filter, ['==', ['geometry-type'], 'Point'])).toBe(true)
    }
    expect(draws(layer('substations:fill'), 13, 'LineString', { category: 'substation', maxVoltageKv: 420 })).toBe(false)
    expect(draws(layer('substations:point'), 13, 'Polygon', { category: 'substation', maxVoltageKv: 420 })).toBe(false)
    expect(draws(layer('generation:point'), 13, 'Polygon', { category: 'plant', outputMw: 900 })).toBe(false)
  })

  test('no layer stops at a maxzoom, so the grid stays visible when zoomed past the z14 tiles', () => {
    for (const spec of built('light').layers) expect((spec as { maxzoom?: number }).maxzoom ?? 24).toBeGreaterThanOrEqual(24)
    expect(built('light').source.maxzoom).toBe(14)
    expect(draws(layer('lines:line'), 18, 'LineString', { category: 'line', maxVoltageKv: 66 })).toBe(true)
    expect(draws(layer('substations:fill'), 18, 'Polygon', { category: 'substation', maxVoltageKv: 66 })).toBe(true)
  })

  test('line layers set no line-opacity, which in MapLibre 6 adds an off-screen pass whenever it evaluates between 0 and 1', () => {
    for (const spec of built('light').layers.filter(candidate => candidate.type === 'line')) {
      expect(spec.paint['line-opacity']).toBeUndefined()
    }
  })

  test('opacity never depends on feature data and no paint reads feature-state', () => {
    for (const spec of built('dark').layers) {
      expect(containsToken(spec.paint, 'feature-state')).toBe(false)
      for (const [property, value] of Object.entries(spec.paint)) {
        if (property.endsWith('-opacity')) expect(typeof value).toBe('number')
      }
    }
  })
})

describe('grid-norway reference style: zoom classes through filters', () => {
  const line = (kv: number | null) => kv === null ? { category: 'line' } : { category: 'line', maxVoltageKv: kv }

  test('transmission shows nationally, regional and distribution voltages join as you zoom in', () => {
    const spec = layer('lines:line')
    const firstZoom = (kv: number | null) => [4, 5, 6, 7, 8, 9, 10].find(zoom => draws(spec, zoom, 'LineString', line(kv)))
    expect(firstZoom(420)).toBe(4)
    expect(firstZoom(515)).toBe(4)
    expect(firstZoom(300)).toBe(4)
    expect(firstZoom(230)).toBe(5)
    expect(firstZoom(132)).toBe(6)
    expect(firstZoom(110)).toBe(8)
    expect(firstZoom(66)).toBe(8)
    expect(firstZoom(null)).toBe(9)
    expect(draws(layer('cables:line'), 4, 'LineString', { category: 'cable', maxVoltageKv: 515 })).toBe(true)
    expect(draws(spec, 12, 'LineString', { category: 'cable', maxVoltageKv: 420 })).toBe(false)
  })

  test('polygon sites draw as outline dots by voltage class, footprints fill from z12', () => {
    const outline = layer('substations:outline')
    expect(draws(outline, 5, 'Polygon', { category: 'substation', maxVoltageKv: 420 })).toBe(true)
    expect(draws(outline, 6, 'Polygon', { category: 'substation', maxVoltageKv: 132 })).toBe(false)
    expect(draws(outline, 7, 'Polygon', { category: 'substation', maxVoltageKv: 132 })).toBe(true)
    expect(draws(outline, 8, 'Polygon', { category: 'substation', maxVoltageKv: 22 })).toBe(false)
    expect(draws(outline, 9, 'Polygon', { category: 'substation', maxVoltageKv: 22 })).toBe(true)
    expect(draws(layer('substations:fill'), 11, 'Polygon', { category: 'substation', maxVoltageKv: 420 })).toBe(false)
    expect(draws(layer('substations:fill'), 12, 'Polygon', { category: 'substation', maxVoltageKv: 420 })).toBe(true)
    const dot = evaluate(outline, 'line-width', 7, 'Polygon', { category: 'substation', maxVoltageKv: 420 }) as number
    const footprint = evaluate(outline, 'line-width', 13, 'Polygon', { category: 'substation', maxVoltageKv: 420 }) as number
    expect(dot).toBeGreaterThan(footprint * 3)
  })

  test('site points, transformers and generation follow their own zoom classes', () => {
    const sites = layer('substations:point')
    expect(draws(sites, 5, 'Point', { category: 'substation', maxVoltageKv: 300 })).toBe(true)
    expect(draws(sites, 9, 'Point', { category: 'transformer', maxVoltageKv: 420 })).toBe(false)
    expect(draws(sites, 10, 'Point', { category: 'transformer', maxVoltageKv: 420 })).toBe(true)
    const generation = layer('generation:point')
    expect(draws(generation, 5, 'Point', { category: 'plant', outputMw: 1240 })).toBe(true)
    expect(draws(generation, 6, 'Point', { category: 'plant', outputMw: 140 })).toBe(false)
    expect(draws(generation, 7, 'Point', { category: 'plant', outputMw: 140 })).toBe(true)
    expect(draws(generation, 8, 'Point', { category: 'generator', outputMw: 900 })).toBe(false)
    expect(draws(generation, 9, 'Point', { category: 'generator', outputMw: 3 })).toBe(true)
    expect(draws(layer('generation:outline'), 5, 'Polygon', { category: 'plant', outputMw: 600 })).toBe(true)
    expect(draws(layer('generation:outline'), 8, 'Polygon', { category: 'plant', outputMw: 30 })).toBe(false)
  })

  test('generation circle area is proportional to nameplate output', () => {
    const spec = layer('generation:point')
    const radius = (outputMw: number) => evaluate(spec, 'circle-radius', 9, 'Point', { category: 'plant', outputMw }) as number
    const base = evaluate(spec, 'circle-radius', 9, 'Point', { category: 'plant' }) as number
    expect(radius(400) - base).toBeCloseTo(2 * (radius(100) - base), 6)
  })

  test('labels: named transmission lines from z8 with name then kV; sites by voltage class', () => {
    const labels = layer('lines:label')
    expect(labels.minzoom).toBe(8)
    expect(draws(labels, 8, 'LineString', { category: 'line', maxVoltageKv: 420, name: 'Holen - Rød' })).toBe(true)
    expect(draws(labels, 12, 'LineString', { category: 'line', maxVoltageKv: 132, name: 'Lokal' })).toBe(false)
    expect(String(evaluate(labels, 'text-field', 9, 'LineString', { category: 'line', maxVoltageKv: 420, name: 'Holen - Rød' }))).toBe('Holen - Rød (420 kV)')
    expect(String(evaluate(labels, 'text-field', 9, 'LineString', { category: 'line', maxVoltageKv: 300 }))).toBe('300 kV')
    const sites = layer('substations:label')
    expect(draws(sites, 7, 'Polygon', { category: 'substation', maxVoltageKv: 420, name: 'Sylling' })).toBe(true)
    expect(draws(sites, 8, 'Polygon', { category: 'substation', maxVoltageKv: 132, name: 'Lokal' })).toBe(false)
    expect(draws(sites, 9, 'Polygon', { category: 'substation', maxVoltageKv: 132, name: 'Lokal' })).toBe(true)
    expect(draws(sites, 13, 'Polygon', { category: 'substation', maxVoltageKv: 420 })).toBe(false)
  })
})

describe('grid-norway reference palette', () => {
  const tagged = gridVoltageClasses.filter(entry => entry.id !== 'unknown')

  test('voltage classes are clearly distinguishable in both themes', () => {
    for (const theme of themes) {
      for (let i = 0; i < tagged.length; i += 1) {
        for (let j = i + 1; j < tagged.length; j += 1) {
          expect(deltaE(tagged[i]!.color[theme], tagged[j]!.color[theme])).toBeGreaterThan(25)
        }
      }
      // Untagged voltage is a lighter (light theme) or darker (dark theme) neutral than ≤ 66 kV.
      const color = (id: string) => gridVoltageClasses.find(entry => entry.id === id)!.color[theme]
      expect(deltaE(color('kv66'), color('unknown'))).toBeGreaterThan(15)
      const kv132 = gridVoltageClasses.find(entry => entry.id === 'kv132')!.color[theme]
      const kv110 = gridVoltageClasses.find(entry => entry.id === 'kv110')!.color[theme]
      expect(deltaE(kv132, kv110)).toBeGreaterThan(30)
    }
  })

  test('normal voltage classes leave red, orange and amber free for live alarm states', () => {
    for (const theme of themes) {
      for (const entry of [...gridVoltageClasses, { id: 'generation', color: { light: gridMapPalette('light').generation, dark: gridMapPalette('dark').generation } }]) {
        const { hue, saturation } = hueSaturation(entry.color[theme])
        if (saturation > 0.2) expect(hue > 60 && hue < 330).toBe(true)
      }
    }
  })

  test('paint colours come from the theme palette and labels use theme text and halo', () => {
    for (const theme of themes) {
      const palette = gridMapPalette(theme)
      for (const entry of tagged) {
        const kv = { kv420: 420, kv300: 300, kv220: 220, kv132: 132, kv110: 110, kv66: 66 }[entry.id as 'kv420']
        expect(evaluate(layer('lines:line', theme), 'line-color', 9, 'LineString', { category: 'line', maxVoltageKv: kv })).toMatchObject(colorObject(entry.color[theme]))
      }
      expect(evaluate(layer('lines:line', theme), 'line-color', 9, 'LineString', { category: 'line' })).toMatchObject(colorObject(palette.voltage.unknown))
      for (const id of ['lines:label', 'substations:label', 'generation:label']) {
        expect(layer(id, theme).paint['text-color']).toBe(palette.text)
        expect(layer(id, theme).paint['text-halo-color']).toBe(palette.halo)
      }
    }
    expect(gridMapPalette('light').text).not.toBe(gridMapPalette('dark').text)
  })

  test('the legend lists every voltage class in the palette colours', () => {
    expect(gridVoltageLegend.entries.map(entry => entry.id)).toEqual(gridVoltageClasses.map(entry => entry.id))
    for (const entry of gridVoltageLegend.entries) {
      expect(entry.color).toEqual(gridVoltageClasses.find(candidate => candidate.id === entry.id)!.color)
    }
  })
})

const colorObject = (hex: string) => {
  const [r, g, b] = rgb(hex)
  return { r: expect.closeTo(r, 3), g: expect.closeTo(g, 3), b: expect.closeTo(b, 3), a: 1 }
}

describe('grid-norway Pack presentation', () => {
  test('every grid layer belongs to exactly one layer-group toggle, and every drawn category has one', () => {
    const groups = electricGridPackView.presentation.mapLayerGroups ?? []
    const ids = built('light').layers.map(spec => spec.id)
    for (const id of ids) expect(groups.filter(group => layerIdsMatching([id], group.layerIdPattern).length === 1)).toHaveLength(1)
    for (const group of groups) expect(layerIdsMatching(ids, group.layerIdPattern).length).toBeGreaterThan(0)
    const drawnCategories = (spec: PackReferenceLayerSpec) => gridNorwayStyle.categories.filter(category => containsToken(spec.filter, category))
    const covered = new Set(gridNorwayStyle.layersFor({ theme: 'light' }).flatMap(drawnCategories))
    expect([...covered].sort()).toEqual([...gridNorwayStyle.categories].sort())
  })

  test('active Pack views carry the grid style and legend, and reject a dataset without exactly one style', () => {
    const views = createActivePackViews([electricGridPackView])
    expect(views.referenceStyles).toEqual([gridNorwayStyle])
    expect(views.referenceDatasetIds).toEqual(['grid-norway'])
    expect(views.presentation.mapLegends).toEqual([gridVoltageLegend])
    const unstyled = { ...electricGridPackView, presentation: { ...electricGridPackView.presentation, referenceStyles: [] } }
    expect(() => createActivePackViews([unstyled])).toThrow('reference dataset grid-norway with 0 styles')
    const foreign = { ...electricGridPackView, referenceData: { datasetIds: [] } }
    expect(() => createActivePackViews([foreign])).toThrow('styles undeclared reference dataset grid-norway')
  })
})
