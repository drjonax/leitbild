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
} as const
