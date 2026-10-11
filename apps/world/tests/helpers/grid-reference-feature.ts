import type { GridReferenceFeatureProperties } from '../../src/packs/electric-grid/schemas/grid-reference.ts'
import type { GeoJsonGeometry, NormalizedFeature } from '../../src/reference-data/types.ts'

/** A schema-valid grid-norway sidecar feature with the given properties. */
export const gridFeature = (
  geometry: GeoJsonGeometry,
  overrides: Partial<GridReferenceFeatureProperties> & Pick<GridReferenceFeatureProperties, 'category'>,
): NormalizedFeature => {
  const maxVoltageKv = overrides.maxVoltageKv ?? null
  const properties: GridReferenceFeatureProperties = {
    source: 'osm:pbf-power:test',
    externalId: 'way/1',
    osmNodeIds: null,
    members: [],
    name: null,
    ref: null,
    operator: 'Statnett',
    voltageKv: maxVoltageKv === null ? [] : [maxVoltageKv],
    maxVoltageKv,
    voltageBelowThresholdV: [],
    frequencyHz: [],
    systems: ['ac50'],
    systemProvenance: 'inferred',
    lifecycle: 'operational',
    circuits: null,
    cables: null,
    power: null,
    plantSource: null,
    outputMw: null,
    geometrySource: 'osm-way',
    propertyProvenance: 'observed',
    confidence: 'high',
    tags: { power: overrides.category },
    ...overrides,
  }
  return { type: 'Feature', id: `test:${properties.externalId}`, geometry, properties }
}
