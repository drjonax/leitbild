import { createBaseTileset, type BaseTileset } from './capabilities.ts'

export interface MapLibreStyle {
  readonly version: 8
  readonly name: string
  readonly glyphs: string
  readonly metadata: Record<string, unknown>
  readonly sources: Record<string, unknown>
  readonly layers: ReadonlyArray<Record<string, unknown>>
}

export type MapTheme = 'light' | 'dark'

const sourceId = 'leitbild-osm'

// Line alpha belongs in `line-color`. MapLibre draws a line layer whose `line-opacity` evaluates to
// a value strictly between 0 and 1 for the current zoom into a full-viewport framebuffer and
// composites it, on every frame.
const translucent = (hex: string, alpha: number): string => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!match) throw new Error(`expected a #rrggbb colour, got ${hex}`)
  const [, red = '', green = '', blue = ''] = match
  return `rgba(${parseInt(red, 16)}, ${parseInt(green, 16)}, ${parseInt(blue, 16)}, ${alpha})`
}

const mapThemePalette = (theme: MapTheme) => {
  if (theme === 'dark') {
    return {
      background: '#0e1521',
      landuseFallback: '#151e2b',
      landuseHospital: '#172844',
      landuseIndustrial: '#252331',
      landuseResidential: '#182232',
      landuseCommercial: '#222331',
      landusePark: '#173123',
      landcoverFallback: '#17251f',
      landcoverWood: '#173821',
      landcoverGrass: '#1d3c26',
      landcoverWetland: '#16363a',
      landcoverRock: '#2b2b30',
      landcoverSand: '#3b3424',
      water: '#12394d',
      waterway: '#1f5c72',
      building: '#263140',
      roadCasing: '#0b111b',
      motorway: '#a35f4c',
      trunk: '#a7744a',
      primary: '#a48a4e',
      secondary: '#857b52',
      tertiary: '#676c55',
      minor: '#394457',
      rail: '#637086',
      boundary: '#566579',
      emergencyText: '#8ab9ff',
      labelText: '#c2ccda',
      roadText: '#b0bbc9',
      textHalo: '#0e1521',
    }
  }
  return {
    background: '#eef2f3',
    landuseFallback: '#edf0e8',
    landuseHospital: '#e7eef9',
    landuseIndustrial: '#ece4dd',
    landuseResidential: '#f3f0eb',
    landuseCommercial: '#f1e9df',
    landusePark: '#dbead5',
    landcoverFallback: '#e2ead8',
    landcoverWood: '#c8dfbd',
    landcoverGrass: '#d6e9c8',
    landcoverWetland: '#c7dfd7',
    landcoverRock: '#dedbd3',
    landcoverSand: '#eadfbf',
    water: '#a9d8e8',
    waterway: '#9bcfdf',
    building: '#d7d2ca',
    roadCasing: '#ffffff',
    motorway: '#e89a74',
    trunk: '#e9ae74',
    primary: '#e8c579',
    secondary: '#e4d78e',
    tertiary: '#e6e0a9',
    minor: '#f5f2e9',
    rail: '#8b8f98',
    boundary: '#9aa6b2',
    emergencyText: '#245b9f',
    labelText: '#4c5564',
    roadText: '#596272',
    textHalo: '#ffffff',
  }
}

export const createLeitbildMapStyle = (theme: MapTheme = 'light', bases: ReadonlyArray<BaseTileset> = [createBaseTileset()]): MapLibreStyle => {
  const base = bases.find(base => base.schema.name === 'openmaptiles-compatible-leitbild-v1')
  if (!base) throw new Error('Regional base style metadata is missing')
  const overview = bases.find(base => base.schema.name === 'natural-earth-overview')
  const palette = mapThemePalette(theme)
  return {
    version: 8,
    name: `Leitbild Vector Base ${theme}`,
    glyphs: base.artifact.glyphsUrl,
    metadata: { 'leitbild:baseSources': [sourceId, ...(overview ? [overview.id] : [])] },
    sources: {
      [sourceId]: {
        type: 'vector',
        tiles: [base.artifact.tileTemplate],
        minzoom: base.artifact.minZoom,
        maxzoom: base.artifact.maxZoom,
        bounds: base.artifact.bounds,
        attribution: base.artifact.attribution,
      },
      ...(overview ? { [overview.id]: { type: 'vector', tiles: [overview.artifact.tileTemplate], minzoom: overview.artifact.minZoom, maxzoom: overview.artifact.maxZoom, bounds: overview.artifact.bounds, attribution: overview.artifact.attribution } } : {}),
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': overview ? palette.water : palette.background },
      },
      ...(overview ? [
        { id: 'overview-land', type: 'fill', source: overview.id, 'source-layer': 'countries', paint: { 'fill-color': palette.background } },
        { id: 'overview-boundaries', type: 'line', source: overview.id, 'source-layer': 'countries', paint: { 'line-color': translucent(palette.boundary, 0.6), 'line-width': .7 } },
      ] : []),
      {
        id: 'landuse',
        type: 'fill',
        source: sourceId,
        'source-layer': 'landuse',
        paint: {
          'fill-color': [
            'match',
            ['get', 'class'],
            'hospital', palette.landuseHospital,
            'industrial', palette.landuseIndustrial,
            'residential', palette.landuseResidential,
            'commercial', palette.landuseCommercial,
            'park', palette.landusePark,
            palette.landuseFallback,
          ],
          'fill-opacity': 0.68,
        },
      },
      {
        id: 'landcover',
        type: 'fill',
        source: sourceId,
        'source-layer': 'landcover',
        paint: {
          'fill-color': [
            'match',
            ['get', 'class'],
            'wood', palette.landcoverWood,
            'grass', palette.landcoverGrass,
            'wetland', palette.landcoverWetland,
            'rock', palette.landcoverRock,
            'sand', palette.landcoverSand,
            palette.landcoverFallback,
          ],
          'fill-opacity': 0.74,
        },
      },
      {
        id: 'water',
        type: 'fill',
        source: sourceId,
        'source-layer': 'water',
        paint: { 'fill-color': palette.water },
      },
      {
        id: 'waterway',
        type: 'line',
        source: sourceId,
        'source-layer': 'waterway',
        paint: {
          'line-color': palette.waterway,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 1.6],
        },
      },
      {
        id: 'building',
        type: 'fill',
        source: sourceId,
        'source-layer': 'building',
        minzoom: 13,
        paint: {
          'fill-color': palette.building,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.45, 16, 0.72],
        },
      },
      {
        id: 'road-casing',
        type: 'line',
        source: sourceId,
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']]],
        paint: {
          'line-color': translucent(palette.roadCasing, 0.92),
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            ['match', ['get', 'class'], 'motorway', 2.8, 'trunk', 2.6, 'primary', 2.4, 'secondary', 1.8, 0.8],
            15,
            ['match', ['get', 'class'], 'motorway', 10, 'trunk', 9, 'primary', 8, 'secondary', 6, 'tertiary', 5, 'minor', 3.4, 2.4],
          ],
        },
      },
      {
        id: 'road',
        type: 'line',
        source: sourceId,
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']]],
        paint: {
          'line-color': [
            'match',
            ['get', 'class'],
            'motorway', palette.motorway,
            'trunk', palette.trunk,
            'primary', palette.primary,
            'secondary', palette.secondary,
            'tertiary', palette.tertiary,
            palette.minor,
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            ['match', ['get', 'class'], 'motorway', 2, 'trunk', 1.9, 'primary', 1.7, 'secondary', 1.2, 0.5],
            15,
            ['match', ['get', 'class'], 'motorway', 7, 'trunk', 6.4, 'primary', 5.8, 'secondary', 4.4, 'tertiary', 3.6, 'minor', 2.4, 1.6],
          ],
        },
      },
      {
        id: 'rail',
        type: 'line',
        source: sourceId,
        'source-layer': 'transportation',
        filter: ['==', ['get', 'class'], 'rail'],
        paint: {
          'line-color': palette.rail,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 15, 1.6],
          'line-dasharray': [1, 1.6],
        },
      },
      {
        id: 'boundary',
        type: 'line',
        source: sourceId,
        'source-layer': 'boundary',
        paint: {
          'line-color': translucent(palette.boundary, 0.52),
          'line-width': 0.8,
          'line-dasharray': [2, 2],
        },
      },
      {
        id: 'poi-emergency',
        type: 'symbol',
        source: sourceId,
        'source-layer': 'poi',
        minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['hospital', 'fire_station', 'police', 'doctors', 'pharmacy', 'helipad']]],
        layout: {
          'text-field': ['coalesce', ['get', 'name'], ['get', 'class']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 12],
          'text-anchor': 'top',
          'text-offset': [0, 0.7],
        },
        paint: {
          'text-color': palette.emergencyText,
          'text-halo-color': palette.textHalo,
          'text-halo-width': 1.4,
        },
      },
      {
        id: 'road-label',
        type: 'symbol',
        source: sourceId,
        'source-layer': 'transportation_name',
        minzoom: 13,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 12],
        },
        paint: {
          'text-color': palette.roadText,
          'text-halo-color': palette.textHalo,
          'text-halo-width': 1.3,
        },
      },
      {
        id: 'place-label',
        type: 'symbol',
        source: sourceId,
        'source-layer': 'place',
        minzoom: 8,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 13, 15],
        },
        paint: {
          'text-color': palette.labelText,
          'text-halo-color': palette.textHalo,
          'text-halo-width': 1.5,
        },
      },
      // Labels stay above all base fills, including regional coastal water.
      ...(overview ? [{ id: 'overview-labels', type: 'symbol', source: overview.id, 'source-layer': 'places', layout: { 'text-field': ['get','name'], 'text-font': ['Noto Sans Regular'], 'symbol-sort-key': ['case', ['==',['get','kind'],'country'],0,1], 'text-size': ['case', ['==',['get','kind'],'country'],13,11], 'text-max-width': 9 }, paint: { 'text-color': palette.labelText, 'text-halo-color': palette.textHalo, 'text-halo-width': 1 } }] : []),
    ],
  }
}
