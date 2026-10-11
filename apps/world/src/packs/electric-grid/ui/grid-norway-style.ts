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
import {
  gridFootprintMinZoom,
  gridGeneratorMinZoom,
  gridLineLabelMinKv,
  gridLineMinZoom,
  gridNonOperationalMinZoom,
  gridPlantMinZoom,
  gridPlantOutputStops,
  gridSiteMinZoom,
  gridTransformerMinZoom,
} from './grid-zoom-classes.ts'

// Explicit, geometry-aware layers for the OSM-derived Norwegian grid. Classes
// are hidden by `filter` (zoom-stepped) and layer `minzoom`, never by opacity.
// No layer sets `maxzoom`: the source overzooms past its last tile zoom.
//
// The tile build emits each site as one point below z12 and its footprint from
// z12, and every feature only from the zoom these filters first draw it at
// (`grid-zoom-classes.ts`). Circle layers take Point features only. Older builds
// carry substations and plants as (Multi)Polygons at every zoom: below z12 the
// outline layers draw those with a thick round-joined stroke that reads as a
// single dot; from z12 the stroke thins to a footprint outline over a fill.
// HVDC lines draw as a double line. Assets under construction, proposed or
// disused (`lifecycle`) draw grey, thin and dashed, never before z8.

type VoltageValues<T> = Readonly<Record<GridVoltageClassId, T>>

const category = ['get', 'category'] as const
const voltage = ['get', 'maxVoltageKv'] as const
const output = ['get', 'outputMw'] as const
const isCategory = (value: string): ReadonlyArray<unknown> => ['==', category, value]
const isAnyCategory = (values: ReadonlyArray<string>): ReadonlyArray<unknown> => ['in', category, ['literal', values]]
const isPoint: ReadonlyArray<unknown> = ['==', ['geometry-type'], 'Point']
const isPolygon: ReadonlyArray<unknown> = ['==', ['geometry-type'], 'Polygon']
const isPolygonOrLine: ReadonlyArray<unknown> = ['in', ['geometry-type'], ['literal', ['Polygon', 'LineString']]]
const isNotInService: ReadonlyArray<unknown> = ['has', 'lifecycle']
const isHvdcInService: ReadonlyArray<unknown> = ['all', ['==', ['get', 'systems'], 'hvdc'], ['!', isNotInService]]

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
  ['step', output, values.small, gridPlantOutputStops.medium, values.medium, gridPlantOutputStops.large, values.large],
  values.small,
]

/** Drawn from the class zoom; assets not in service from z8 at the earliest. */
const visibleFrom = (classMinZoom: ReadonlyArray<unknown> | number): ReadonlyArray<unknown> =>
  ['>=', ['zoom'], ['case', isNotInService, ['max', gridNonOperationalMinZoom, classMinZoom], classMinZoom]]

const lineMinZoom = byVoltage(gridLineMinZoom)
const siteMinZoom = byVoltage(gridSiteMinZoom)
const siteLabelMinZoom: VoltageValues<number> = { kv420: 7, kv300: 7, kv220: 9, kv132: 9, kv110: 11, kv66: 11, unknown: 11 }
const plantMinZoom = byPlantOutput(gridPlantMinZoom)
const plantLabelMinZoom = byPlantOutput({ small: 11, medium: 9, large: 7 })

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

// An HVDC link draws as two strokes of half the 420 kV width around a gap of 0.6 of it.
const hvdcStrokeShare = 0.5
const hvdcGapShare = 0.6
const notInServiceWidthAt: Readonly<Record<4 | 8 | 12 | 16, number>> = { 4: 0.8, 8: 1.0, 12: 1.4, 16: 2.0 }
// Dash and gap lengths are multiples of the line width.
const notInServiceDash = ['literal', [2, 3]]
const solid = ['literal', [1, 0]]

const lineWidthStops = ([4, 8, 12, 16] as const).flatMap(zoom => [zoom, ['case',
  isNotInService, notInServiceWidthAt[zoom],
  isHvdcInService, lineWidthAt[zoom].kv420 * hvdcStrokeShare,
  byVoltage(lineWidthAt[zoom]),
]])
const lineWidth: ReadonlyArray<unknown> = ['interpolate', ['exponential', 1.4], ['zoom'], ...lineWidthStops]
const lineGapWidth: ReadonlyArray<unknown> = ['interpolate', ['exponential', 1.4], ['zoom'],
  ...([4, 8, 12, 16] as const).flatMap(zoom => [zoom, ['case', isHvdcInService, lineWidthAt[zoom].kv420 * hvdcGapShare, 0]]),
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

/** Voltage colour, grey for assets not in service. */
const serviceColor = (palette: GridMapPalette, inService: ReadonlyArray<unknown> | string): ReadonlyArray<unknown> =>
  ['case', isNotInService, palette.voltage.unknown, inService]

const lineLayers = (palette: GridMapPalette): ReadonlyArray<PackReferenceLayerSpec> => {
  const line = (id: string, categoryId: string, inServiceDash: ReadonlyArray<unknown>): PackReferenceLayerSpec => ({
    id,
    type: 'line',
    minzoom: gridLineMinZoom.kv420,
    filter: ['all', isCategory(categoryId), visibleFrom(lineMinZoom)],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': serviceColor(palette, byVoltage(palette.voltage)),
      'line-width': lineWidth,
      'line-gap-width': lineGapWidth,
      'line-dasharray': ['case', isNotInService, notInServiceDash, inServiceDash],
    },
  })
  return [
    line('lines:line', 'line', solid),
    line('cables:line', 'cable', ['literal', [2.5, 1.5]]),
  ]
}

const siteLayers = (palette: GridMapPalette): ReadonlyArray<PackReferenceLayerSpec> => {
  const color = serviceColor(palette, byVoltage(palette.voltage))
  const sites = isAnyCategory(['substation', 'transformer'])
  return [{
    id: 'substations:fill',
    type: 'fill',
    minzoom: gridFootprintMinZoom,
    filter: ['all', isPolygon, sites],
    paint: { 'fill-color': color, 'fill-opacity': palette.siteFillOpacity },
  }, {
    // Site footprints and, inside them, busbars.
    id: 'substations:outline',
    type: 'line',
    minzoom: gridSiteMinZoom.kv420,
    filter: ['all', isPolygonOrLine, isAnyCategory(['substation', 'transformer', 'busbar']), visibleFrom(['match', category, 'busbar', gridFootprintMinZoom, siteMinZoom])],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': color, 'line-width': siteOutlineWidth, 'line-dasharray': ['case', isNotInService, notInServiceDash, solid] },
  }, {
    id: 'substations:point',
    type: 'circle',
    minzoom: gridSiteMinZoom.kv420,
    filter: ['all', isPoint, sites, visibleFrom(['match', category, 'transformer', gridTransformerMinZoom, siteMinZoom])],
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
  minzoom: gridPlantMinZoom.large,
  filter: ['all', isPolygonOrLine, isAnyCategory(['plant', 'generator']), visibleFrom(['match', category, 'generator', gridGeneratorMinZoom, plantMinZoom])],
  layout: { 'line-join': 'round', 'line-cap': 'round' },
  paint: { 'line-color': serviceColor(palette, palette.generation), 'line-width': plantOutlineWidth, 'line-dasharray': ['case', isNotInService, notInServiceDash, solid] },
}, {
  id: 'generation:point',
  type: 'circle',
  minzoom: gridPlantMinZoom.large,
  filter: ['all', isPoint, isAnyCategory(['plant', 'generator']), visibleFrom(['match', category, 'generator', gridGeneratorMinZoom, plantMinZoom])],
  paint: {
    'circle-color': serviceColor(palette, palette.generation),
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
  filter: ['all', isCategory('line'), ['has', 'maxVoltageKv'], ['>=', voltage, gridLineLabelMinKv]],
  layout: {
    'symbol-placement': 'line',
    'symbol-spacing': 360,
    'text-field': ['case', ['has', 'name'], ['concat', ['get', 'name'], ' (', voltageText, ')'], voltageText],
    'text-font': font,
    'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 12],
    'text-max-angle': 30,
    // Beside the line rather than on it, so light lines in the dark theme stay legible under the text.
    'text-offset': [0, -0.9],
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
  categories: ['line', 'cable', 'busbar', 'substation', 'transformer', 'plant', 'generator'],
  layersFor,
}
