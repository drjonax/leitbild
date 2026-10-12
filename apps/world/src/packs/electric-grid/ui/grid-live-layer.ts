import type { OperationalObject } from '../../../core/model/index.ts'
import { geoPointFromLonLat } from '../../../core/model/index.ts'
import { packField } from '../../../core/packs/presentation.ts'
import type {
  PackLiveFeatureState,
  PackLiveMapFeature,
  PackLiveMapGeometry,
  PackLiveMapHoverCard,
  PackLiveMapLayer,
  PackLiveMapLayerSpec,
  PackLiveMapState,
  PackMapFeatureSelection,
} from '../../../core/packs/protocol.ts'
import type { PackMapAppearance, PackMapLegend, PackMapTheme, PackMapThemedColor } from '../../../core/packs/reference-style.ts'
import { parseElectricGridObjectData } from '../model.ts'
import {
  gridMapGeometryResultSchema,
  gridMapStateResultSchema,
  type GridMapGeometryResult,
  type GridMapStateResult,
} from '../queries/map-schemas.ts'
import { gridMapPalette } from './grid-map-palette.ts'
import { gridNorwayStyle } from './grid-norway-style.ts'

// The Grid's live map layer: branch loading, switching, trips, energisation and flow direction,
// HVDC link state and transfer, bus islands, generator dispatch and trips, and load shedding,
// drawn from world.electric-grid.map.geometry and map.state as feature-state over native layers.

export const gridOverviewPanelId = 'electric-grid.overview'
export const gridLiveLayerGroupId = 'electric-grid:live'
const liveLayerId = 'electric-grid'
const flowArrowImageId = `${liveLayerId}:flow-arrow`

// Loading bands (% of the derated rating): attention from 70 % (the summary's constrained
// threshold), high from 90 %, overloaded from 100 %.
const watchLoadingPercent = 70
const highLoadingPercent = 90
const overloadLoadingPercent = 100
// Feature-state carries a branch's loading band (0 normal, 1 watch, 2 high, 3 overloaded), the
// steps its paint draws, not the raw percent: a revision then re-sets, and MapLibre re-evaluates,
// only the branches that change band. The hover card and labels read the exact percent.
const watchBand = 1
const highBand = 2
const overloadBand = 3
export const gridLoadingBand = (loadingPercent: number): number =>
  loadingPercent >= overloadLoadingPercent ? overloadBand
    : loadingPercent >= highLoadingPercent ? highBand
      : loadingPercent >= watchLoadingPercent ? watchBand
        : 0
// Flow below 5 MW draws no direction arrow: it is within the DC model's rounding of small flows.
const flowArrowMinimumMw = 5
// Below z6 the national view keeps ≥ 300 kV branches and anything in alarm.
const detailZoom = 6
const majorBranchKv = 300
const constraintLabelLimit = 20

/** `<gridId>#<assetId>`: Grid object ids cannot contain '#', so the first one separates them. */
export const gridAssetItemId = (gridId: string, assetId: string): string => `${gridId}#${assetId}`

export const parseGridAssetItemId = (itemId: string): { readonly gridId: string; readonly assetId: string } => {
  const separator = itemId.indexOf('#')
  if (separator <= 0 || separator === itemId.length - 1) throw new Error(`not a Grid asset selection: ${itemId}`)
  return { gridId: itemId.slice(0, separator), assetId: itemId.slice(separator + 1) }
}

interface LivePalette {
  readonly normal: string
  readonly watch: string
  readonly high: string
  readonly overload: string
  readonly tripped: string
  readonly hvdc: string
  readonly open: string
  readonly deenergized: string
  readonly unknown: string
  readonly casing: string
  readonly selected: string
  readonly hover: string
  readonly bus: string
  readonly generation: string
  readonly generationStroke: string
  readonly offline: string
  readonly loadRing: string
  readonly arrow: string
  readonly text: string
  readonly halo: string
  readonly islands: ReadonlyArray<string>
}

// Live state colours sit outside the reference voltage hues: teal, amber, orange and red carry
// loading; greys carry open and de-energised; a tripped branch is red and dashed; HVDC links in
// service are indigo and dashed. Alpha lives in the colour, never in line-opacity.
const themed = {
  normal: { light: '#0f8b8d', dark: '#2dd4bf' },
  watch: { light: '#d99a00', dark: '#facc15' },
  high: { light: '#ea580c', dark: '#fb923c' },
  overload: { light: '#d62828', dark: '#f87171' },
  tripped: { light: '#d62828', dark: '#f87171' },
  hvdc: { light: '#4338ca', dark: '#a5b4fc' },
  open: { light: '#6b7280', dark: '#9ca3af' },
  deenergized: { light: '#c3c8cf', dark: '#4b5563' },
  shed: { light: '#d62828', dark: '#f87171' },
  generation: { light: '#2e8540', dark: '#6fd36f' },
} as const satisfies Record<string, PackMapThemedColor>

const livePalette = (theme: PackMapTheme): LivePalette => {
  const reference = gridMapPalette(theme)
  const light = theme === 'light'
  return {
    normal: themed.normal[theme],
    watch: themed.watch[theme],
    high: themed.high[theme],
    overload: themed.overload[theme],
    tripped: themed.tripped[theme],
    hvdc: themed.hvdc[theme],
    open: themed.open[theme],
    deenergized: themed.deenergized[theme],
    unknown: themed.open[theme],
    casing: light ? 'rgba(255, 255, 255, 0.85)' : 'rgba(14, 21, 33, 0.85)',
    selected: light ? '#2563eb' : '#93c5fd',
    hover: light ? 'rgba(37, 99, 235, 0.55)' : 'rgba(147, 197, 253, 0.55)',
    bus: light ? '#334155' : '#e2e8f0',
    generation: themed.generation[theme],
    generationStroke: light ? '#1f5f2c' : '#bbf7d0',
    offline: themed.open[theme],
    loadRing: light ? '#334155' : '#cbd5e1',
    arrow: light ? '#1f2937' : '#f8fafc',
    text: reference.text,
    halo: reference.halo,
    // Island strokes: eight hues apart from the loading ramp.
    islands: light
      ? ['#2563eb', '#9333ea', '#db2777', '#0891b2', '#65a30d', '#a16207', '#7c3aed', '#be123c']
      : ['#60a5fa', '#c084fc', '#f472b6', '#22d3ee', '#a3e635', '#fcd34d', '#a78bfa', '#fb7185'],
  }
}

const state = (key: string): ReadonlyArray<unknown> => ['feature-state', key]
const flagState = (key: string, fallback: boolean): ReadonlyArray<unknown> => ['boolean', state(key), fallback]
const numberState = (key: string): ReadonlyArray<unknown> => ['number', state(key), 0]
const islandState: ReadonlyArray<unknown> = ['number', state('island'), -1]
const isKind = (kind: string): ReadonlyArray<unknown> => ['==', ['get', 'kind'], kind]
const emphasised: ReadonlyArray<unknown> = ['any', flagState('hover', false), flagState('selected', false)]

/** Full strength from z6; below it only what `major` or an alarm keeps. */
const detailOpacity = (major: ReadonlyArray<unknown> | boolean, value: ReadonlyArray<unknown> | number = 1): ReadonlyArray<unknown> =>
  ['step', ['zoom'], ['case', major, value, flagState('alarm', false), value, 0], detailZoom, value]

const byKv = (values: { readonly kv420: number; readonly kv300: number; readonly kv220: number; readonly kv132: number; readonly low: number }): ReadonlyArray<unknown> =>
  ['step', ['get', 'kv'], values.low, 132, values.kv132, 200, values.kv220, 300, values.kv300, 380, values.kv420]

const branchWidthStops = [
  [4, { kv420: 1.8, kv300: 1.5, kv220: 1.2, kv132: 1.0, low: 0.8 }, 1],
  [8, { kv420: 3.2, kv300: 2.8, kv220: 2.4, kv132: 2.0, low: 1.6 }, 1.5],
  [12, { kv420: 5.5, kv300: 4.8, kv220: 4.2, kv132: 3.6, low: 3.0 }, 2],
  [16, { kv420: 9.0, kv300: 8.0, kv220: 7.0, kv132: 6.0, low: 5.0 }, 3],
] as const

/** Width by kV and zoom, wider when overloaded, hovered or selected; casings add `extra`. */
const branchWidth = (extra: number): ReadonlyArray<unknown> => ['interpolate', ['exponential', 1.4], ['zoom'],
  ...branchWidthStops.flatMap(([zoom, values, emphasis]) => [zoom, ['+', byKv(values), extra,
    ['case', emphasised, emphasis * 2, ['==', numberState('loadingBand'), overloadBand], emphasis, 0]]]),
]

const branchColor = (palette: LivePalette): ReadonlyArray<unknown> => ['case',
  ['!', flagState('live', false)], palette.unknown,
  flagState('tripped', false), palette.tripped,
  ['!', flagState('closed', true)], palette.open,
  ['!', flagState('energized', true)], palette.deenergized,
  ['==', numberState('loadingBand'), overloadBand], palette.overload,
  ['==', numberState('loadingBand'), highBand], palette.high,
  ['==', numberState('loadingBand'), watchBand], palette.watch,
  palette.normal,
]

const hvdcColor = (palette: LivePalette): ReadonlyArray<unknown> => ['case',
  ['!', flagState('live', false)], palette.unknown,
  flagState('tripped', false), palette.tripped,
  flagState('blocked', false), palette.open,
  palette.hvdc,
]

const majorBranch: ReadonlyArray<unknown> = ['>=', ['get', 'kv'], majorBranchKv]
// A network equivalent stands for out-of-scope sub-transmission, not a mapped line: thin and dashed.
const isEquivalent: ReadonlyArray<unknown> = ['==', ['get', 'equivalent'], true]
const isMappedBranch: ReadonlyArray<unknown> = ['all', isKind('branch'), ['!', isEquivalent]]
const equivalentDash = [2, 2]
const equivalentWidth: ReadonlyArray<unknown> = ['interpolate', ['exponential', 1.4], ['zoom'], 4, 0.8, 8, 1.4, 12, 2.4, 16, 4]
// Dash pattern in line widths: a tripped branch reads as broken; an HVDC cable as a dashed DC link.
const trippedDash = [1.5, 1.5]
const hvdcDash = [3, 1.5]
const hvdcWidth = (extra: number): ReadonlyArray<unknown> => ['interpolate', ['exponential', 1.4], ['zoom'],
  4, ['+', 1.6 + extra, ['case', emphasised, 2, 0]], 8, ['+', 2.8 + extra, ['case', emphasised, 3, 0]], 12, ['+', 4.8 + extra, ['case', emphasised, 4, 0]], 16, ['+', 8 + extra, ['case', emphasised, 6, 0]]]

const flowArrows = (direction: 1 | -1): PackLiveMapLayerSpec => ({
  id: direction === 1 ? 'flow-forward' : 'flow-reverse',
  source: 'features',
  type: 'symbol',
  minzoom: detailZoom,
  filter: ['any', isKind('branch'), isKind('hvdc')],
  layout: {
    'symbol-placement': 'line',
    'symbol-spacing': 160,
    'icon-image': flowArrowImageId,
    'icon-size': ['interpolate', ['linear'], ['zoom'], detailZoom, 0.45, 12, 0.7],
    'icon-rotate': direction === 1 ? 0 : 180,
    'icon-rotation-alignment': 'map',
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  },
  paint: { 'icon-opacity': ['case', ['==', numberState('flowDir'), direction], 1, 0] },
})

const pointRadius = (stops: ReadonlyArray<readonly [number, ReadonlyArray<unknown> | number]>): ReadonlyArray<unknown> =>
  ['interpolate', ['linear'], ['zoom'], ...stops.flatMap(([zoom, radius]) => [zoom, ['+', radius, ['case', emphasised, 2, 0]]])]

const sqrtCapacity: ReadonlyArray<unknown> = ['sqrt', ['get', 'capacityMw']]

const layersFor = (appearance: PackMapAppearance): ReadonlyArray<PackLiveMapLayerSpec> => {
  const palette = livePalette(appearance.theme)
  const line = { 'line-join': 'round', 'line-cap': 'round' }
  return [{
    id: 'branch-casing',
    source: 'features',
    type: 'line',
    filter: isMappedBranch,
    layout: line,
    paint: {
      'line-color': ['case', flagState('selected', false), palette.selected, flagState('hover', false), palette.hover, palette.casing],
      'line-width': branchWidth(2),
      'line-opacity': detailOpacity(majorBranch),
    },
    interactive: true,
  }, {
    id: 'branch-line',
    source: 'features',
    type: 'line',
    filter: isMappedBranch,
    layout: line,
    paint: {
      'line-color': branchColor(palette),
      'line-width': branchWidth(0),
      'line-opacity': detailOpacity(majorBranch),
    },
    interactive: true,
  }, {
    // Casing-coloured gaps over a tripped branch's red line: it reads as broken, unlike a grey open one.
    id: 'branch-tripped',
    source: 'features',
    type: 'line',
    filter: isMappedBranch,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color': palette.casing,
      'line-width': branchWidth(0),
      'line-dasharray': trippedDash,
      'line-opacity': ['case', flagState('tripped', false), 1, 0],
    },
  }, {
    id: 'equivalent-line',
    source: 'features',
    type: 'line',
    filter: ['all', isKind('branch'), isEquivalent],
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color': ['case', flagState('selected', false), palette.selected, flagState('hover', false), palette.hover, branchColor(palette)],
      'line-width': equivalentWidth,
      'line-dasharray': equivalentDash,
      'line-opacity': 1,
    },
    interactive: true,
  }, {
    id: 'hvdc-casing',
    source: 'features',
    type: 'line',
    filter: isKind('hvdc'),
    layout: line,
    paint: {
      'line-color': ['case', flagState('selected', false), palette.selected, flagState('hover', false), palette.hover, palette.casing],
      'line-width': hvdcWidth(2),
      'line-opacity': 1,
    },
    interactive: true,
  }, {
    id: 'hvdc-line',
    source: 'features',
    type: 'line',
    filter: isKind('hvdc'),
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color': hvdcColor(palette),
      'line-width': hvdcWidth(0),
      'line-dasharray': hvdcDash,
      'line-opacity': 1,
    },
    interactive: true,
  },
  flowArrows(1),
  flowArrows(-1),
  {
    id: 'buses',
    source: 'features',
    type: 'circle',
    filter: isKind('bus'),
    paint: {
      'circle-radius': pointRadius([[4, 1.5], [8, 3], [12, 5]]),
      // An asynchronous system's boundary bus terminates HVDC links outside the modelled AC network.
      'circle-color': ['case', flagState('external', false), palette.hvdc, palette.bus],
      // De-energised buses are hollow.
      'circle-opacity': detailOpacity(false, ['case', ['any', flagState('external', false), flagState('energized', true)], 1, 0]),
      'circle-stroke-color': ['case',
        flagState('selected', false), palette.selected,
        flagState('external', false), palette.halo,
        ['!', flagState('energized', true)], palette.deenergized,
        ['>=', islandState, 0], ['match', islandState, ...palette.islands.flatMap((color, index) => [index, color]), palette.halo],
        palette.halo,
      ],
      'circle-stroke-width': ['case', ['any', flagState('selected', false), ['>=', islandState, 0]], 2, 1],
      'circle-stroke-opacity': detailOpacity(false),
    },
    interactive: true,
  }, {
    id: 'loads',
    source: 'features',
    type: 'circle',
    filter: isKind('load'),
    paint: {
      'circle-radius': pointRadius([[4, 2.5], [8, 4], [12, 6.5]]),
      // A ring that fills red in proportion to shed demand.
      'circle-color': palette.overload,
      'circle-opacity': detailOpacity(false, numberState('shed')),
      'circle-stroke-color': ['case',
        flagState('selected', false), palette.selected,
        ['!', flagState('energized', true)], palette.deenergized,
        ['>', numberState('shed'), 0], palette.overload,
        palette.loadRing,
      ],
      'circle-stroke-width': 1.5,
      'circle-stroke-opacity': detailOpacity(false),
    },
    interactive: true,
  }, {
    id: 'generators',
    source: 'features',
    type: 'circle',
    filter: isKind('generator'),
    paint: {
      // Area proportional to capacity.
      'circle-radius': pointRadius([
        [4, ['+', 1.5, ['*', 0.12, sqrtCapacity]]],
        [8, ['+', 2, ['*', 0.25, sqrtCapacity]]],
        [12, ['+', 3, ['*', 0.4, sqrtCapacity]]],
      ]),
      'circle-color': palette.generation,
      // Fill alpha follows dispatch over capacity; an idle unit stays faintly visible.
      'circle-opacity': detailOpacity(false, ['+', 0.15, ['*', 0.85, numberState('dispatch')]]),
      'circle-stroke-color': ['case',
        flagState('selected', false), palette.selected,
        flagState('tripped', false), palette.overload,
        flagState('online', false), palette.generationStroke,
        palette.offline,
      ],
      'circle-stroke-width': ['case', ['any', flagState('tripped', false), flagState('selected', false)], 2.5, 1.2],
      'circle-stroke-opacity': detailOpacity(false),
    },
    interactive: true,
  }, {
    id: 'constraint-labels',
    source: 'labels',
    type: 'symbol',
    minzoom: 5,
    layout: {
      'symbol-placement': 'line-center',
      'text-field': ['get', 'text'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 12, 12],
      'text-max-angle': 40,
      'text-offset': [0, -1],
      'symbol-sort-key': ['get', 'rank'],
    },
    paint: {
      'text-color': ['case', ['==', ['get', 'tone'], 'alarm'], palette.overload, palette.text],
      'text-halo-color': palette.halo,
      'text-halo-width': 1.6,
    },
  }]
}

const imagesFor = (appearance: PackMapAppearance) => {
  const palette = livePalette(appearance.theme)
  const chevron = 'M8 5l8 7-8 7'
  return [{
    id: flowArrowImageId,
    // Points along +x, the line's direction from its first to its last vertex.
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${chevron}" stroke="${palette.halo}" stroke-width="6"/><path d="${chevron}" stroke="${palette.arrow}" stroke-width="3"/></svg>`,
  }]
}

const hexChannels = (color: string): readonly [number, number, number] => {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  if (!match) throw new Error(`grid context colour must be #rgb or #rrggbb: ${color}`)
  const digits = match[1]!.length === 3 ? [...match[1]!].map(digit => digit + digit).join('') : match[1]!
  const channel = (offset: number): number => Number.parseInt(digits.slice(offset, offset + 2), 16)
  return [channel(0), channel(2), channel(4)]
}

/** Context weight of the neutral grey: the reference grid keeps 30 % of its own hue. */
const contextNeutralWeight = 0.7

/** The reference grid recoloured toward its own "voltage not tagged" grey; text and halo stay legible. */
export const gridReferenceContextColor = (color: string, appearance: PackMapAppearance): string => {
  const palette = gridMapPalette(appearance.theme)
  if (color === palette.text || color === palette.halo) return color
  const own = hexChannels(color)
  const neutral = hexChannels(palette.voltage.unknown)
  return `#${own.map((channel, index) => Math.round(channel + (neutral[index]! - channel) * contextNeutralWeight).toString(16).padStart(2, '0')).join('')}`
}

const percent = (value: number): string => `${value.toFixed(1)} %`

const drawnAs: Readonly<Record<GridMapGeometryResult['branches'][number]['pathSource'], string>> = {
  'mapped-route': 'Mapped route',
  transformer: 'Transformer, drawn between its buses',
  'network-equivalent': 'Network equivalent (not a mapped line)',
  'bus-to-bus': 'Straight line between its buses (no mapped route)',
}

const hvdcStateText: Readonly<Record<GridMapStateResult['hvdcLinks']['state'][number], string>> = {
  deblocked: 'In service',
  blocked: 'Blocked: deblock to return it to service',
  tripped: 'Tripped by its converter protection: reset it, then deblock',
}
const mw = (value: number): string => `${Math.round(value).toLocaleString()} MW`

interface FeatureRefs {
  readonly branchStart: number
  readonly busStart: number
  readonly generatorStart: number
  readonly loadStart: number
  readonly hvdcStart: number
  readonly end: number
}

const refsFor = (geometry: GridMapGeometryResult): FeatureRefs => {
  const branchStart = 0
  const busStart = branchStart + geometry.branches.length
  const generatorStart = busStart + geometry.buses.length
  const loadStart = generatorStart + geometry.generators.length
  const hvdcStart = loadStart + geometry.loads.length
  return { branchStart, busStart, generatorStart, loadStart, hvdcStart, end: hvdcStart + geometry.hvdcLinks.length }
}

const requireAligned = (geometry: GridMapGeometryResult, result: GridMapStateResult): void => {
  const mismatched = [
    ['branches', geometry.branches.length, Object.values(result.branches)],
    ['buses', geometry.buses.length, Object.values(result.buses)],
    ['generators', geometry.generators.length, Object.values(result.generators)],
    ['loads', geometry.loads.length, Object.values(result.loads)],
    ['hvdcLinks', geometry.hvdcLinks.length, Object.values(result.hvdcLinks)],
  ].filter(([, length, arrays]) => (arrays as ReadonlyArray<ReadonlyArray<unknown>>).some(values => values.length !== length))
  if (mismatched.length > 0) throw new Error(`Grid map state arrays do not match the geometry: ${mismatched.map(([name]) => name).join(', ')}`)
}

const presentState = (gridId: string, geometry: GridMapGeometryResult, rawState: unknown): PackLiveMapState => {
  const result = gridMapStateResultSchema.parse(rawState)
  if (result.gridId !== gridId) throw new Error(`Grid map state is for ${result.gridId}, not ${gridId}`)
  if (result.geometryDigest !== geometry.geometryDigest) throw new Error(`Grid map state ${result.geometryDigest} does not align with geometry ${geometry.geometryDigest}`)
  requireAligned(geometry, result)
  const refs = refsFor(geometry)
  const featureStates = new Map<number, PackLiveFeatureState>()
  // The largest energised island is the main grid and keeps the plain stroke; every other
  // island takes a categorical stroke colour, repeating after eight.
  const busesPerIsland = result.islands.map(() => 0)
  for (const island of result.buses.island) if (island !== null) busesPerIsland[island]! += 1
  const mainIsland = result.islands.reduce((main, island, position) =>
    island.energized && (main < 0 || busesPerIsland[position]! > busesPerIsland[main]!) ? position : main, -1)
  const islandColor = (island: number): number => island === mainIsland ? -1 : (mainIsland >= 0 && island > mainIsland ? island - 1 : island) % 8
  const busEnergized = (bus: number): boolean => result.buses.energized[bus] === 1
  geometry.branches.forEach((branch, position) => {
    const closed = result.branches.closed[position] === 1
    const energized = busEnergized(branch.fromBus) && busEnergized(branch.toBus)
    const loadingBand = gridLoadingBand(result.branches.loadingPercent[position]!)
    const flow = result.branches.flowMw[position]!
    featureStates.set(refs.branchStart + position, {
      live: true,
      closed,
      tripped: result.branches.tripped[position] === 1,
      energized,
      loadingBand,
      flowDir: closed && energized && Math.abs(flow) > flowArrowMinimumMw ? Math.sign(flow) : 0,
      alarm: !closed || !energized || loadingBand >= highBand,
    })
  })
  geometry.buses.forEach((bus, position) => {
    const energized = busEnergized(position)
    // An HVDC terminal (an asynchronous system's boundary bus) lies outside the modelled AC network and every island: never a dead island.
    // A separated synchronous boundary bus also lies in no island, but its external system holds it energised: a live bus without island colour.
    const island = result.buses.island[position]!
    const external = bus.external?.synchronous === false
    featureStates.set(refs.busStart + position, {
      live: true,
      energized,
      external,
      island: island === null ? -1 : islandColor(island),
      alarm: !external && !energized,
    })
  })
  geometry.generators.forEach((generator, position) => {
    const lifecycle = result.generators.state[position]!
    featureStates.set(refs.generatorStart + position, {
      live: true,
      // Dispatch is whole MW, so it can round a hair past capacity.
      dispatch: Math.min(1, Math.max(0, result.generators.dispatchMw[position]! / generator.capacityMw)),
      online: lifecycle === 'online',
      tripped: lifecycle === 'tripped',
      alarm: lifecycle === 'tripped',
    })
  })
  geometry.loads.forEach((load, position) => {
    const demand = result.loads.demandMw[position]!
    const shed = result.loads.shedMw[position]!
    const energized = busEnergized(load.bus)
    featureStates.set(refs.loadStart + position, {
      live: true,
      energized,
      shed: demand > 0 ? Math.min(1, shed / demand) : 0,
      alarm: shed > 0 || !energized,
    })
  })
  geometry.hvdcLinks.forEach((_link, position) => {
    const linkState = result.hvdcLinks.state[position]!
    const transfer = result.hvdcLinks.transferMw[position]!
    featureStates.set(refs.hvdcStart + position, {
      live: true,
      blocked: linkState === 'blocked',
      tripped: linkState === 'tripped',
      flowDir: linkState === 'deblocked' && Math.abs(transfer) > flowArrowMinimumMw ? Math.sign(transfer) : 0,
      alarm: linkState === 'tripped',
    })
  })

  // Tripped branches first ("Tripped" is short enough to fit along a short line), then the most loaded
  // closed ones, within the label limit; every HVDC link carries its transfer or state.
  const branchLabel = (position: number, text: string, tone: 'alarm' | 'normal') => ({ path: geometry.branches[position]!.path, text, tone })
  const tripped = geometry.branches.flatMap((_branch, position) => result.branches.tripped[position] === 1 ? [branchLabel(position, 'Tripped', 'alarm')] : [])
  const loaded = geometry.branches
    .map((branch, position) => ({ branch, position, loading: result.branches.loadingPercent[position]! }))
    .filter(item => result.branches.closed[item.position] === 1 && item.loading >= watchLoadingPercent)
    .sort((left, right) => right.loading - left.loading)
    .map(item => branchLabel(item.position, `${item.branch.label} ${Math.round(item.loading)} %`, item.loading >= overloadLoadingPercent ? 'alarm' : 'normal'))
  const links = geometry.hvdcLinks.map((link, position) => {
    const linkState = result.hvdcLinks.state[position]!
    const transfer = result.hvdcLinks.transferMw[position]!
    const text = linkState !== 'deblocked' ? `${link.label} ${linkState}` : `${link.label} ${mw(Math.abs(transfer))} ${transfer >= 0 ? 'export' : 'import'}`
    return { path: link.path, text, tone: linkState === 'tripped' ? 'alarm' as const : 'normal' as const }
  })
  const labels: PackLiveMapFeature[] = [...[...tripped, ...loaded].slice(0, constraintLabelLimit), ...links].map((label, rank) => ({
    fid: rank,
    geometry: { type: 'LineString', coordinates: label.path },
    properties: { text: label.text, tone: label.tone, rank },
  }))

  const hoverCard = (fid: number): PackLiveMapHoverCard | null => {
    if (fid < refs.branchStart || fid >= refs.end) return null
    if (fid < refs.busStart) {
      const position = fid - refs.branchStart
      const branch = geometry.branches[position]!
      const from = geometry.buses[branch.fromBus]!
      const to = geometry.buses[branch.toBus]!
      const flow = result.branches.flowMw[position]!
      const closed = result.branches.closed[position] === 1
      const branchTripped = result.branches.tripped[position] === 1
      const availability = result.branches.availability[position]!
      return {
        title: branch.label,
        fields: [
          packField('loading', 'Loading', `${percent(result.branches.loadingPercent[position]!)} of ${mw(branch.ratingMw * availability)}`),
          packField('flow', 'Flow', flow === 0 ? '0 MW' : `${mw(Math.abs(flow))}, ${flow > 0 ? from.label : to.label} → ${flow > 0 ? to.label : from.label}`),
          packField('flow-model', 'Flow model', result.branches.flowModel[position] === 'ac' ? 'AC load flow' : result.branches.flowModel[position] === 'dc' ? 'DC estimate (AC load flow not converged)' : 'No flow'),
          packField('switching', 'Switching', closed
            ? (availability < 1 ? `Closed, derated to ${Math.round(availability * 100)} %` : 'Closed')
            : branchTripped ? 'Tripped by its protection: reset it, then close' : 'Open'),
          packField('energized', 'Energised', busEnergized(branch.fromBus) && busEnergized(branch.toBus) ? 'Yes' : 'No'),
          packField('voltage', 'Voltage', branch.pathSource === 'network-equivalent'
            ? `${from.kv} kV – ${to.kv} kV, equivalent of the sub-transmission between them`
            : `${branch.kv} kV ${branch.kind.replaceAll('_', ' ')}`),
          packField('path', 'Drawn as', drawnAs[branch.pathSource]),
        ],
      }
    }
    if (fid < refs.generatorStart) {
      const position = fid - refs.busStart
      const bus = geometry.buses[position]!
      const islandPosition = result.buses.island[position]!
      if (islandPosition === null && bus.external?.synchronous === true) {
        return {
          title: bus.label,
          fields: [
            packField('external', 'External system', `${bus.external.label}, behind AC ties`),
            packField('voltage', 'Voltage level', `${bus.kv} kV`),
            packField('role', 'Connection', 'Separated from Norway: every tie to this boundary bus is open. The external system holds it energised; closing a tie is checked on frequency difference.'),
          ],
        }
      }
      if (islandPosition === null) {
        const links = geometry.hvdcLinks.flatMap((link, linkPosition) => link.toBus === position ? [{ link, linkPosition }] : [])
        return {
          title: bus.label,
          fields: [
            ...(bus.external === undefined ? [] : [packField('external', 'External system', bus.external.label)]),
            packField('role', 'Connection', 'HVDC terminal outside the modelled AC network and every island; the external system supplies or absorbs its links\' transfer'),
            ...links.map(({ link, linkPosition }) => {
              const linkState = result.hvdcLinks.state[linkPosition]!
              const transfer = result.hvdcLinks.transferMw[linkPosition]!
              return packField(`link-${linkPosition}`, link.label, linkState !== 'deblocked'
                ? hvdcStateText[linkState]
                : transfer === 0 ? '0 MW' : `${mw(Math.abs(transfer))} ${transfer > 0 ? 'export' : 'import'}`)
            }),
          ],
        }
      }
      const island = result.islands[islandPosition]!
      return {
        title: bus.label,
        fields: [
          ...(bus.external === undefined ? [] : [packField('external', 'External system', `${bus.external.label}, behind AC ties`)]),
          packField('voltage', 'Voltage level', `${bus.kv} kV`),
          packField('island', 'Island', `${island.id} (${result.islands.length} in the Grid)`),
          packField('energized', 'Energised', island.energized
            ? `Yes${island.frequencyHz === null ? '' : `, ${island.frequencyHz.toFixed(3)} Hz`}`
            : 'No'),
        ],
      }
    }
    if (fid < refs.loadStart) {
      const position = fid - refs.generatorStart
      const generator = geometry.generators[position]!
      return {
        title: generator.label,
        fields: [
          packField('kind', 'Kind', generator.kind),
          packField('state', 'State', result.generators.state[position]!),
          packField('dispatch', 'Dispatch', `${mw(result.generators.dispatchMw[position]!)} of ${mw(generator.capacityMw)}`),
        ],
      }
    }
    if (fid < refs.hvdcStart) {
      const position = fid - refs.loadStart
      const load = geometry.loads[position]!
      return {
        title: load.label,
        fields: [
          packField('kind', 'Kind', load.kinds.map(kind => kind.replaceAll('_', ' ')).join(', ')),
          packField('served', 'Served', `${mw(result.loads.servedMw[position]!)} of ${mw(result.loads.demandMw[position]!)}`),
          packField('shed', 'Shed', mw(result.loads.shedMw[position]!)),
        ],
      }
    }
    const position = fid - refs.hvdcStart
    const link = geometry.hvdcLinks[position]!
    const linkState = result.hvdcLinks.state[position]!
    const transfer = result.hvdcLinks.transferMw[position]!
    const from = geometry.buses[link.fromBus]!
    const to = geometry.buses[link.toBus]!
    const end = (bus: typeof from): string => bus.external?.label ?? bus.label
    return {
      title: link.label,
      fields: [
        packField('state', 'State', hvdcStateText[linkState]),
        packField('transfer', 'Transfer', transfer === 0 ? '0 MW' : `${mw(Math.abs(transfer))}, ${transfer > 0 ? `${end(from)} → ${end(to)} (export)` : `${end(to)} → ${end(from)} (import)`}`),
        packField('setpoint', 'Set-point', `${mw(result.hvdcLinks.setpointMw[position]!)} (positive exports from Norway)`),
        packField('rating', 'Rating', `±${mw(link.ratingMw)}`),
        packField('path', 'Drawn as', link.pathSource === 'mapped-route' ? 'Mapped cable route' : 'Straight line between its converters (no mapped route)'),
      ],
    }
  }

  return { revision: result.revision, featureStates, labels, hoverCard }
}

const loadGeometry = (rawGeometry: unknown): PackLiveMapGeometry => {
  const geometry = gridMapGeometryResultSchema.parse(rawGeometry)
  const refs = refsFor(geometry)
  // A bus's load marker selects its first load; any of its loads selected elsewhere highlights it.
  const assetIds = [
    ...geometry.branches.map(branch => branch.id),
    ...geometry.buses.map(bus => bus.id),
    ...geometry.generators.map(generator => generator.id),
    ...geometry.loads.map(load => load.loadIds[0]!),
    ...geometry.hvdcLinks.map(link => link.id),
  ]
  const fidByAssetId = new Map([
    ...assetIds.slice(0, refs.loadStart).map((assetId, fid) => [assetId, fid] as const),
    ...geometry.loads.flatMap((load, position) => load.loadIds.map(loadId => [loadId, refs.loadStart + position] as const)),
    ...geometry.hvdcLinks.map((link, position) => [link.id, refs.hvdcStart + position] as const),
  ])
  const features: PackLiveMapFeature[] = [
    ...geometry.branches.map((branch, position) => ({
      fid: refs.branchStart + position,
      geometry: { type: 'LineString' as const, coordinates: branch.path },
      properties: { kind: 'branch', kv: branch.kv, ...(branch.pathSource === 'network-equivalent' ? { equivalent: true } : {}) },
    })),
    ...geometry.buses.map((bus, position) => ({
      fid: refs.busStart + position,
      geometry: geoPointFromLonLat(bus.location[0], bus.location[1]),
      properties: { kind: 'bus', kv: bus.kv },
    })),
    ...geometry.generators.map((generator, position) => ({
      fid: refs.generatorStart + position,
      geometry: geoPointFromLonLat(generator.location[0], generator.location[1]),
      properties: { kind: 'generator', capacityMw: generator.capacityMw },
    })),
    ...geometry.loads.map((load, position) => ({
      fid: refs.loadStart + position,
      geometry: geoPointFromLonLat(load.location[0], load.location[1]),
      properties: { kind: 'load' },
    })),
    ...geometry.hvdcLinks.map((link, position) => ({
      fid: refs.hvdcStart + position,
      geometry: { type: 'LineString' as const, coordinates: link.path },
      properties: { kind: 'hvdc' },
    })),
  ]
  return {
    key: geometry.geometryDigest,
    features,
    selectionFor: (fid: number): PackMapFeatureSelection | null => {
      const assetId = assetIds[fid]
      return assetId === undefined ? null : { panelId: gridOverviewPanelId, itemId: gridAssetItemId(geometry.gridId, assetId) }
    },
    fidForSelection: (selection: PackMapFeatureSelection): number | null => {
      if (selection.panelId !== gridOverviewPanelId) return null
      const item = parseGridAssetItemId(selection.itemId)
      return item.gridId === geometry.gridId ? fidByAssetId.get(item.assetId) ?? null : null
    },
    presentState: rawState => presentState(geometry.gridId, geometry, rawState),
  }
}

const stateGeometryKey = (rawState: unknown): string => {
  const digest = typeof rawState === 'object' && rawState !== null ? (rawState as { readonly geometryDigest?: unknown }).geometryDigest : undefined
  if (typeof digest !== 'string') throw new Error('Grid map state has no geometryDigest')
  return digest
}

export const gridLiveMapLayer: PackLiveMapLayer = {
  id: liveLayerId,
  layerGroupId: gridLiveLayerGroupId,
  sourceObjects: (objects: ReadonlyArray<OperationalObject>) => objects.filter(object => parseElectricGridObjectData(object) !== null),
  geometryQuery: object => ({ capabilityId: 'world.electric-grid.map.geometry', input: { gridId: object.id } }),
  stateQuery: object => ({ capabilityId: 'world.electric-grid.map.state', input: { gridId: object.id } }),
  loadGeometry,
  stateGeometryKey,
  layersFor,
  imagesFor,
  referenceContext: { datasetIds: [gridNorwayStyle.datasetId], color: gridReferenceContextColor },
  // The Grid Model's sources and licences; NOTICE.md and each asset's provenance give the detail.
  attribution: 'Grid model: © OpenStreetMap contributors (ODbL) · NVE (NLOD 2.0) · Elhub, Kartverket, SSB, Svenska kraftnät, ENTSO-E via Energy-Charts (CC BY 4.0)',
}

export const gridLiveStateLegend: PackMapLegend = {
  id: 'electric-grid:live-state',
  title: 'Live grid state',
  entries: [
    { id: 'normal', label: `Loaded below ${watchLoadingPercent} %`, symbol: 'line', color: themed.normal, sizePx: 3 },
    { id: 'watch', label: `${watchLoadingPercent}–${highLoadingPercent} %`, symbol: 'line', color: themed.watch, sizePx: 3 },
    { id: 'high', label: `${highLoadingPercent}–${overloadLoadingPercent} %`, symbol: 'line', color: themed.high, sizePx: 3 },
    { id: 'overload', label: `Overloaded (≥ ${overloadLoadingPercent} %)`, symbol: 'line', color: themed.overload, sizePx: 4 },
    { id: 'tripped', label: 'Tripped by protection', symbol: 'dashed-line', color: themed.tripped, sizePx: 3 },
    { id: 'open', label: 'Open', symbol: 'line', color: themed.open, sizePx: 3 },
    { id: 'hvdc', label: 'HVDC link in service (grey: blocked, red: tripped)', symbol: 'dashed-line', color: themed.hvdc, sizePx: 3 },
    { id: 'deenergized', label: 'De-energised', symbol: 'line', color: themed.deenergized, sizePx: 3 },
    { id: 'generator', label: 'Generator (fill: dispatch)', symbol: 'circle', color: themed.generation, sizePx: 11 },
    { id: 'shed', label: 'Load (fills as demand is shed)', symbol: 'ring', color: themed.shed, sizePx: 11 },
  ],
}
