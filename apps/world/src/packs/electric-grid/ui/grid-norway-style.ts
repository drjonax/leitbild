import type {
  PackMapAppearance,
  PackReferenceDatasetStyle,
  PackReferenceLayerSpec,
} from '../../../core/packs/reference-style.ts'
import {
  gridMapPalette,
  gridVoltageStops,
  type GridMapPalette,
  type GridVoltageClassId,
} from './grid-map-palette.ts'

// Explicit, geometry-aware layers for the OSM-derived Norwegian grid. Classes
// are hidden by `filter` (zoom-stepped) and layer `minzoom`, never by opacity.
// No layer sets `maxzoom`: the source overzooms past its z14 tiles.
//
// Today's tiles carry substations and plants mostly as (Multi)Polygons at every
// zoom. MapLibre cannot draw one circle per polygon (a circle layer draws one
// per vertex), so below z12 the outline layers draw polygon sites with a thick
// round-joined stroke that reads as a single dot; from z12 the stroke thins to a
// footprint outline over a fill. Circle layers take Point features only, which
// covers generators and transformers today and site points once the tile build
// emits them below z12.

type VoltageValues<T> = Readonly<Record<GridVoltageClassId, T>>

const category = ['get', 'category'] as const
const voltage = ['get', 'maxVoltageKv'] as const
const output = ['get', 'outputMw'] as const
const isCategory = (value: string): ReadonlyArray<unknown> => ['==', category, value]
const isAnyCategory = (values: ReadonlyArray<string>): ReadonlyArray<unknown> => ['in', category, ['literal', values]]
const isPoint: ReadonlyArray<unknown> = ['==', ['geometry-type'], 'Point']
const isPolygon: ReadonlyArray<unknown> = ['==', ['geometry-type'], 'Polygon']
const isPolygonOrLine: ReadonlyArray<unknown> = ['in', ['geometry-type'], ['literal', ['Polygon', 'LineString']]]

/** One value per voltage class; features without `maxVoltageKv` take the explicit `unknown` value. */
const byVoltage = <T>(values: VoltageValues<T>): ReadonlyArray<unknown> => [
  'case',
  ['has', 'maxVoltageKv'],
  ['step', voltage,
    values.kv66,
    gridVoltageStops.kv110, values.kv110,
    gridVoltageStops.kv132, values.kv132,
    gridVoltageStops.kv220, values.kv220,
    gridVoltageStops.kv300, values.kv300,
    gridVoltageStops.kv420, values.kv420,
  ],
  values.unknown,
]

/** Plant size class by nameplate output; plants without `outputMw` take the smallest class. */
const byPlantOutput = <T>(values: { readonly small: T; readonly medium: T; readonly large: T }): ReadonlyArray<unknown> => [
  'case',
  ['has', 'outputMw'],
  ['step', output, values.small, 100, values.medium, 500, values.large],
  values.small,
]

const visibleFrom = (minZoom: ReadonlyArray<unknown> | number): ReadonlyArray<unknown> => ['>=', ['zoom'], minZoom]

// Tile zoom from which each class is drawn; matches the tile-build projection plan
// (≥300 kV national, 220 kV z5, 132 kV z6, distribution z8+).
const lineMinZoom: VoltageValues<number> = { kv420: 4, kv300: 4, kv220: 5, kv132: 6, kv110: 8, kv66: 8, unknown: 9 }
const siteMinZoom: VoltageValues<number> = { kv420: 5, kv300: 5, kv220: 7, kv132: 7, kv110: 9, kv66: 9, unknown: 9 }
const siteLabelMinZoom: VoltageValues<number> = { kv420: 7, kv300: 7, kv220: 9, kv132: 9, kv110: 11, kv66: 11, unknown: 11 }
const plantMinZoom = byPlantOutput({ small: 9, medium: 7, large: 5 })
const plantLabelMinZoom = byPlantOutput({ small: 11, medium: 9, large: 7 })
const transformerMinZoom = 10
const generatorMinZoom = 9
/** Only transmission lines (≥ 200 kV class) carry along-line labels. */
const lineLabelMinKv = gridVoltageStops.kv220

const lineWidthAt: Readonly<Record<4 | 8 | 12 | 16, VoltageValues<number>>> = {
  4: { kv420: 1.8, kv300: 1.5, kv220: 1.2, kv132: 1.0, kv110: 0.8, kv66: 0.7, unknown: 0.7 },
  8: { kv420: 3.0, kv300: 2.6, kv220: 2.2, kv132: 1.8, kv110: 1.4, kv66: 1.1, unknown: 1.1 },
  12: { kv420: 5.0, kv300: 4.2, kv220: 3.6, kv132: 3.0, kv110: 2.4, kv66: 1.8, unknown: 1.8 },
  16: { kv420: 8.0, kv300: 7.0, kv220: 6.0, kv132: 5.0, kv110: 4.0, kv66: 3.0, unknown: 3.0 },
}

const siteRadiusAt: Readonly<Record<5 | 9 | 13, VoltageValues<number>>> = {
  5: { kv420: 3.5, kv300: 3.0, kv220: 2.5, kv132: 2.2, kv110: 2.0, kv66: 1.8, unknown: 1.8 },
  9: { kv420: 5.0, kv300: 4.5, kv220: 4.0, kv132: 3.5, kv110: 3.0, kv66: 2.6, unknown: 2.6 },
  13: { kv420: 7.0, kv300: 6.5, kv220: 6.0, kv132: 5.5, kv110: 5.0, kv66: 4.5, unknown: 4.5 },
}

const doubled = (values: VoltageValues<number>): VoltageValues<number> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value * 2])) as unknown as VoltageValues<number>

const lineWidth: ReadonlyArray<unknown> = ['interpolate', ['exponential', 1.4], ['zoom'],
  4, byVoltage(lineWidthAt[4]),
  8, byVoltage(lineWidthAt[8]),
  12, byVoltage(lineWidthAt[12]),
  16, byVoltage(lineWidthAt[16]),
]

const siteRadius: ReadonlyArray<unknown> = ['interpolate', ['linear'], ['zoom'],
  5, byVoltage(siteRadiusAt[5]),
  9, byVoltage(siteRadiusAt[9]),
  13, byVoltage(siteRadiusAt[13]),
]

// Below z12 a polygon site is a few pixels across, so a stroke as wide as the
// matching circle's diameter draws it as one dot; at z12 it becomes an outline.
const siteOutlineWidth: ReadonlyArray<unknown> = ['interpolate', ['linear'], ['zoom'],
  5, byVoltage(doubled(siteRadiusAt[5])),
  10, byVoltage(doubled(siteRadiusAt[9])),
  12, 1.4,
  16, 2.4,
]

const plantOutlineWidth: ReadonlyArray<unknown> = ['interpolate', ['linear'], ['zoom'], 5, 5, 10, 6, 12, 1.4, 16, 2.4]

/** Circle area proportional to nameplate output: radius grows with √MW. */
const generationRadiusAt = (basePx: number, pxPerSqrtMw: number): ReadonlyArray<unknown> => [
  'case',
  ['has', 'outputMw'],
  ['+', basePx, ['*', pxPerSqrtMw, ['sqrt', output]]],
  basePx,
]

const generationRadius: ReadonlyArray<unknown> = ['interpolate', ['linear'], ['zoom'],
  5, generationRadiusAt(1.5, 0.18),
  9, generationRadiusAt(2.0, 0.28),
  13, generationRadiusAt(3.0, 0.4),
]

const voltageText: ReadonlyArray<unknown> = ['concat', ['to-string', ['round', voltage]], ' kV']
const font = ['Noto Sans Regular']

const lineLayers = (palette: GridMapPalette): ReadonlyArray<PackReferenceLayerSpec> => {
  const color = byVoltage(palette.voltage)
  const line = (id: string, categoryId: string, extraPaint: Readonly<Record<string, unknown>>): PackReferenceLayerSpec => ({
    id,
    type: 'line',
    minzoom: lineMinZoom.kv420,
    filter: ['all', isCategory(categoryId), visibleFrom(byVoltage(lineMinZoom))],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': color, 'line-width': lineWidth, ...extraPaint },
  })
  return [
    line('lines:line', 'line', {}),
    // Dash lengths are multiples of the line width.
    line('cables:line', 'cable', { 'line-dasharray': [2.5, 1.5] }),
  ]
}

const siteLayers = (palette: GridMapPalette): ReadonlyArray<PackReferenceLayerSpec> => {
  const color = byVoltage(palette.voltage)
  const sites = isAnyCategory(['substation', 'transformer'])
  return [{
    id: 'substations:fill',
    type: 'fill',
    minzoom: 12,
    filter: ['all', isPolygon, sites],
    paint: { 'fill-color': color, 'fill-opacity': palette.siteFillOpacity },
  }, {
    id: 'substations:outline',
    type: 'line',
    minzoom: siteMinZoom.kv420,
    filter: ['all', isPolygonOrLine, sites, visibleFrom(byVoltage(siteMinZoom))],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': color, 'line-width': siteOutlineWidth },
  }, {
    id: 'substations:point',
    type: 'circle',
    minzoom: siteMinZoom.kv420,
    filter: ['all', isPoint, sites, visibleFrom(['match', category, 'transformer', transformerMinZoom, byVoltage(siteMinZoom)])],
    paint: {
      'circle-color': color,
      'circle-radius': siteRadius,
      'circle-stroke-color': palette.halo,
      'circle-stroke-width': 1,
    },
  }]
}

const generationLayers = (palette: GridMapPalette): ReadonlyArray<PackReferenceLayerSpec> => [{
  id: 'generation:outline',
  type: 'line',
  minzoom: 5,
  filter: ['all', isPolygonOrLine, isAnyCategory(['plant', 'generator']), visibleFrom(['match', category, 'generator', generatorMinZoom, plantMinZoom])],
  layout: { 'line-join': 'round', 'line-cap': 'round' },
  paint: { 'line-color': palette.generation, 'line-width': plantOutlineWidth },
}, {
  id: 'generation:point',
  type: 'circle',
  minzoom: 5,
  filter: ['all', isPoint, isAnyCategory(['plant', 'generator']), visibleFrom(['match', category, 'generator', generatorMinZoom, plantMinZoom])],
  paint: {
    'circle-color': palette.generation,
    'circle-opacity': 0.8,
    'circle-radius': generationRadius,
    'circle-stroke-color': palette.halo,
    'circle-stroke-width': 1,
  },
}]

const labelPaint = (palette: GridMapPalette): Readonly<Record<string, unknown>> => ({
  'text-color': palette.text,
  'text-halo-color': palette.halo,
  'text-halo-width': 1.5,
})

const siteLabelLayout = (sortKey: ReadonlyArray<unknown>): Readonly<Record<string, unknown>> => ({
  'text-field': ['get', 'name'],
  'text-font': font,
  'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 13, 12],
  'text-anchor': 'top',
  'text-offset': [0, 0.8],
  'text-max-width': 8,
  'symbol-sort-key': sortKey,
})

const labelLayers = (palette: GridMapPalette): ReadonlyArray<PackReferenceLayerSpec> => [{
  id: 'lines:label',
  type: 'symbol',
  minzoom: 8,
  filter: ['all', isCategory('line'), ['has', 'maxVoltageKv'], ['>=', voltage, lineLabelMinKv]],
  layout: {
    'symbol-placement': 'line',
    'symbol-spacing': 360,
    'text-field': ['case', ['has', 'name'], ['concat', ['get', 'name'], ' · ', voltageText], voltageText],
    'text-font': font,
    'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 12],
    'text-max-angle': 30,
  },
  paint: labelPaint(palette),
}, {
  id: 'substations:label',
  type: 'symbol',
  minzoom: siteLabelMinZoom.kv420,
  filter: ['all', isCategory('substation'), ['has', 'name'], visibleFrom(byVoltage(siteLabelMinZoom))],
  // Lower sort keys are placed first, so higher voltage wins label collisions.
  layout: siteLabelLayout(byVoltage({ kv420: 0, kv300: 1, kv220: 2, kv132: 3, kv110: 4, kv66: 5, unknown: 6 })),
  paint: labelPaint(palette),
}, {
  id: 'generation:label',
  type: 'symbol',
  minzoom: 7,
  filter: ['all', isCategory('plant'), ['has', 'name'], visibleFrom(plantLabelMinZoom)],
  layout: siteLabelLayout(byPlantOutput({ small: 2, medium: 1, large: 0 })),
  paint: labelPaint(palette),
}]

const layersFor = (appearance: PackMapAppearance): ReadonlyArray<PackReferenceLayerSpec> => {
  const palette = gridMapPalette(appearance.theme)
  const sites = siteLayers(palette)
  // Site footprints sit under the lines that terminate in them; markers and labels sit above.
  return [
    ...sites.filter(layer => layer.type === 'fill'),
    ...lineLayers(palette),
    ...sites.filter(layer => layer.type !== 'fill'),
    ...generationLayers(palette),
    ...labelLayers(palette),
  ]
}

export const gridNorwayStyle: PackReferenceDatasetStyle = {
  datasetId: 'grid-norway',
  outputLayer: 'grid',
  categories: ['line', 'cable', 'substation', 'transformer', 'plant', 'generator'],
  layersFor,
}
