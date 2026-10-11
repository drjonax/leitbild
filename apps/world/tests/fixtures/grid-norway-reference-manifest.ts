// Categories and artifact of the published grid-norway reference build
// 20260528-230419, as served in /map/capabilities.json.
export const gridNorwayReferenceTileset = {
  kind: 'reference',
  datasetId: 'grid-norway',
  schemaVersion: 1,
  builtAt: '2026-05-28T23:04:19.050Z',
  buildId: '20260528-230419',
  artifact: {
    pmtilesPath: 'grid-norway.pmtiles',
    sidecarGeoJsonPath: 'grid-norway.features.geojson',
    outputLayer: 'grid',
  },
  categories: [
    { category: 'line', minZoom: 4, maxZoom: 14, featureCount: 7562 },
    { category: 'cable', minZoom: 5, maxZoom: 14, featureCount: 1048 },
    { category: 'substation', minZoom: 6, maxZoom: 14, featureCount: 1347 },
    { category: 'transformer', minZoom: 9, maxZoom: 14, featureCount: 14 },
    { category: 'plant', minZoom: 6, maxZoom: 14, featureCount: 366 },
    { category: 'generator', minZoom: 8, maxZoom: 14, featureCount: 567 },
    { category: 'load', minZoom: 8, maxZoom: 14, featureCount: 0 },
    { category: 'unknown', minZoom: 10, maxZoom: 14, featureCount: 0 },
  ],
  sources: [{ id: 'osm:pbf-power:NO', kind: 'local' }],
  licences: [{ id: 'osm-odbl-1.0', attribution: '© OpenStreetMap contributors · ODbL 1.0' }],
  // From the archive header (bounds as the 2026-10-10 map audit read them).
  tiles: { minZoom: 4, maxZoom: 14, bounds: [-0.4, 53.45, 31.02, 78.23] },
} as const

// The slim tile build of the 2026-10-08 OSM sidecar: a Pack tile projection to z12 with site points.
export const gridNorwaySlimReferenceTileset = {
  kind: 'reference',
  datasetId: 'grid-norway',
  schemaVersion: 1,
  builtAt: '2026-10-10T19:27:38.058Z',
  buildId: '20261010-192738',
  artifact: {
    pmtilesPath: 'grid-norway.pmtiles',
    sidecarGeoJsonPath: 'grid-norway.features.geojson',
    outputLayer: 'grid',
  },
  categories: [
    { category: 'busbar', minZoom: 12, maxZoom: 12, featureCount: 4135 },
    { category: 'cable', minZoom: 4, maxZoom: 12, featureCount: 1492 },
    { category: 'generator', minZoom: 9, maxZoom: 12, featureCount: 389 },
    { category: 'line', minZoom: 4, maxZoom: 12, featureCount: 8336 },
    { category: 'plant', minZoom: 5, maxZoom: 12, featureCount: 420 },
    { category: 'substation', minZoom: 5, maxZoom: 12, featureCount: 1867 },
    { category: 'transformer', minZoom: 10, maxZoom: 12, featureCount: 14 },
  ],
  sources: [{ id: 'osm:pbf-power:NO', kind: 'local' }],
  licences: [{ id: 'osm-odbl-1.0', attribution: '© OpenStreetMap contributors · ODbL 1.0' }],
  tiles: { minZoom: 4, maxZoom: 12, bounds: [-0.401667, 53.446519, 31.015342, 78.923129] },
} as const
