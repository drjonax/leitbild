import type {
  GeoJsonGeometry,
  NormalizedFeature,
  TileFeature,
  TileFeaturePropertyValue,
  TileProjection,
} from '../../../reference-data/types.ts'
import { gridReferenceFeatureSchema, type GridReferenceFeatureProperties } from '../schemas/grid-reference.ts'
import {
  gridFootprintMinZoom,
  gridGeneratorMinZoom,
  gridLineLabelMinKv,
  gridLineMinZoom,
  gridNonOperationalMinZoom,
  gridPlantMinZoom,
  gridPlantSizeClassOf,
  gridSiteMinZoom,
  gridTransformerMinZoom,
  gridVoltageClassOf,
} from '../ui/grid-zoom-classes.ts'
import { siteAnchor } from './site-anchor.ts'

// The grid-norway tile projection: only the attributes the reference style reads,
// each feature from the zoom at which the style first draws it, and sites as one
// point below the footprint zoom. Portals, terminals and circuit relations are
// topology helpers for the model build; they stay in the sidecar only.

type TileProperties = Record<string, TileFeaturePropertyValue>

const baseProperties = (properties: GridReferenceFeatureProperties, maxVoltageKv: number | null): TileProperties => ({
  category: properties.category,
  ...(maxVoltageKv === null ? {} : { maxVoltageKv }),
  // The style needs only the HVDC flag; traction and other systems draw like AC.
  ...(properties.systems.includes('hvdc') ? { systems: 'hvdc' } : {}),
  ...(properties.lifecycle === 'operational' ? {} : { lifecycle: properties.lifecycle }),
})

const named = (properties: GridReferenceFeatureProperties): TileProperties =>
  properties.name === null ? {} : { name: properties.name }

/** Sidecar geometry from the footprint zoom, and below it one anchor point. */
const siteTiles = (geometry: GeoJsonGeometry, properties: TileProperties, minZoom: number): ReadonlyArray<TileFeature> => {
  if (geometry.type === 'Point') return [{ geometry, properties, minZoom }]
  if (minZoom >= gridFootprintMinZoom) return [{ geometry, properties, minZoom }]
  return [
    { geometry: { type: 'Point', coordinates: siteAnchor(geometry) }, properties, minZoom, maxZoom: gridFootprintMinZoom - 1 },
    { geometry, properties, minZoom: gridFootprintMinZoom },
  ]
}

const roundedOutput = (properties: GridReferenceFeatureProperties): TileProperties =>
  // Whole megawatts: circle area follows √MW, so finer output is invisible.
  properties.outputMw === null ? {} : { outputMw: Math.round(properties.outputMw) }

export const gridNorwayTileFeatures = (feature: NormalizedFeature): TileProjection => {
  const properties = gridReferenceFeatureSchema.parse(feature.properties)
  const { category, externalId } = properties
  if (category === 'portal' || category === 'terminal' || category === 'circuit') return { kind: 'excluded', reason: `${category}:topology-helper` }
  if (properties.lifecycle === 'abandoned') return { kind: 'excluded', reason: `${category}:abandoned` }

  const maxVoltageKv = properties.maxVoltageKv === null ? null : Math.round(properties.maxVoltageKv)
  const voltageClass = gridVoltageClassOf(maxVoltageKv)
  const base = baseProperties(properties, maxVoltageKv)
  const fromZoom = (classMinZoom: number): number =>
    properties.lifecycle === 'operational' ? classMinZoom : Math.max(classMinZoom, gridNonOperationalMinZoom)
  const tiled = (features: ReadonlyArray<TileFeature>): TileProjection => ({ kind: 'tiled', externalId, features })

  switch (category) {
    case 'line':
    case 'cable': {
      const labelled = category === 'line' && maxVoltageKv !== null && maxVoltageKv >= gridLineLabelMinKv
      return tiled([{ geometry: feature.geometry, properties: { ...base, ...(labelled ? named(properties) : {}) }, minZoom: fromZoom(gridLineMinZoom[voltageClass]) }])
    }
    case 'busbar':
      return tiled([{ geometry: feature.geometry, properties: base, minZoom: gridFootprintMinZoom }])
    case 'substation':
      return tiled(siteTiles(feature.geometry, { ...base, ...named(properties) }, fromZoom(gridSiteMinZoom[voltageClass])))
    case 'transformer':
      return tiled(siteTiles(feature.geometry, base, fromZoom(gridTransformerMinZoom)))
    case 'plant':
      return tiled(siteTiles(
        feature.geometry,
        { ...base, ...roundedOutput(properties), ...named(properties) },
        fromZoom(gridPlantMinZoom[gridPlantSizeClassOf(properties.outputMw)]),
      ))
    case 'generator':
      return tiled(siteTiles(feature.geometry, { ...base, ...roundedOutput(properties) }, fromZoom(gridGeneratorMinZoom)))
  }
}
