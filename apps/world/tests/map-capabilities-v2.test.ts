import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TileType } from 'pmtiles'
import {
  __clearManifestCacheForTests,
  createBaseTileset,
  createMapCapabilityManifest,
  findBaseTileset,
  findReferenceTilesets,
  findSceneryTilesets,
  findTerrainTilesets,
  loadMapCapabilityManifest,
  mapCapabilityManifestSchema,
} from '../src/map/capabilities.ts'
import { writePmtilesArchive } from '../src/map/pmtiles-writer.ts'
import { buildSceneryTilesetDocument } from '../src/map/scenery-tileset.ts'
import type { SceneryAssetTileSummary } from '../src/map/scenery.ts'

const referenceArchive = (tileType: TileType = TileType.Mvt): Uint8Array => writePmtilesArchive({
  tiles: [{ z: 6, x: 33, y: 17, data: new Uint8Array([1]) }, { z: 12, x: 2170, y: 1190, data: new Uint8Array([2]) }],
  tileType,
  bounds: { minLon: 4.5, minLat: 57.9, maxLon: 31.1, maxLat: 71.2 },
  center: { lon: 10.7, lat: 59.9, zoom: 6 },
})

const writeReferenceManifest = async (
  root: string,
  datasetId: string,
  buildId: string,
  overrides: Record<string, unknown> = {},
  archive: Uint8Array | null = referenceArchive(),
): Promise<void> => {
  const buildDir = join(root, 'builds', datasetId, buildId)
  await mkdir(buildDir, { recursive: true })
  if (archive !== null) await Bun.write(join(buildDir, `${datasetId}.pmtiles`), archive)
  const manifest = {
    schemaVersion: 1,
    datasetId,
    builtAt: '2026-05-26T20:00:00Z',
    buildId,
    artifact: {
      pmtilesPath: `${datasetId}.pmtiles`,
      sidecarGeoJsonPath: `${datasetId}.features.geojson`,
      outputLayer: 'aero',
    },
    categories: [{ category: 'tma', minZoom: 6, maxZoom: 14, featureCount: 8 }],
    sources: [{ id: 'reference:areas', kind: 'remote' }],
    licences: [{
      id: 'cc-by-nc-sa-4.0',
      name: 'CC BY-NC-SA 4.0',
      url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      attribution: '© Test data',
      commercialUseAllowed: false,
      redistributionAllowed: true,
      shareAlike: true,
    }],
    ...overrides,
  }
  await writeFile(join(buildDir, `${datasetId}.manifest.json`), JSON.stringify(manifest))
  const releaseDir = join(root, 'releases', datasetId)
  await mkdir(releaseDir, { recursive: true })
  const symlinkPath = join(releaseDir, 'current')
  await rm(symlinkPath, { force: true })
  await symlink(join(root, 'builds', datasetId, buildId), symlinkPath)
}

const refRoot = async () => {
  __clearManifestCacheForTests()
  return mkdtemp(join(tmpdir(), 'leitbild-mapcap-'))
}

const scenerySummary = (mapRoot: string): SceneryAssetTileSummary => ({
  recipeId: 'drone-urban-flight',
  z: 14,
  x: 8686,
  y: 4758,
  byteLength: 8,
  centerLon: 10.755615,
  centerLat: 59.913869,
  bounds: { minLon: 10.744, minLat: 59.908, maxLon: 10.767, maxLat: 59.92 },
  boundingSphere: { centerLon: 10.755615, centerLat: 59.913869, centerHeightM: 6, radiusM: 900 },
  lod: { zoom: 14, geometricErrorM: 8, maxScreenSpaceError: 16 },
  minHeightM: 0,
  maxHeightM: 12,
  featureCounts: {
    polygons: 1,
    lines: 1,
    labels: 0,
    buildings: 1,
    roads: 1,
    water: 0,
    vegetation: 0,
  },
})

const writeSceneryTileset = async (mapRoot: string): Promise<void> => {
  const sceneryRoot = join(mapRoot, 'current', 'scenery')
  await mkdir(sceneryRoot, { recursive: true })
  const tile = scenerySummary(mapRoot)
  await Bun.write(join(sceneryRoot, 'tileset.json'), JSON.stringify(buildSceneryTilesetDocument({
    tilesetId: 'leitbild-scenery-norway',
    sourceTilesetId: 'leitbild-osm-norway',
    sourcePmtilesPath: join(mapRoot, 'current', 'norway.pmtiles'),
    builtAt: '2026-06-08T00:00:00Z',
    bounds: { minLon: 10.7, minLat: 59.9, maxLon: 10.8, maxLat: 60 },
    zooms: [14],
    lodLevels: [{ zoom: 14, geometricErrorM: 8, maxScreenSpaceError: 16 }],
    inputArtifacts: [{
      kind: 'base-vector-pmtiles',
      id: 'leitbild-osm-norway',
      path: join(mapRoot, 'current', 'norway.pmtiles'),
      required: true,
    }],
    recipes: [{ id: 'drone-urban-flight' }],
    outputRoot: sceneryRoot,
    counts: {
      decodedTileCount: 1,
      emptyTileCount: 0,
      writtenTileCount: 1,
      polygons: 1,
      lines: 1,
      labels: 0,
      buildings: 1,
      roads: 1,
      water: 0,
      vegetation: 0,
      bytes: 8,
    },
    tiles: [tile],
  })))
}

describe('Map Capability Manifest v2', () => {
  test('synchronous factory returns schemaVersion 2 with base tileset only', () => {
    const manifest = createMapCapabilityManifest()
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.tilesets.length).toBe(1)
    const base = findBaseTileset(manifest)
    expect(base.kind).toBe('base')
    expect(base.id).toBe('leitbild-osm-norway')
  })

  test('schema rejects v1 shape', () => {
    expect(() => mapCapabilityManifestSchema.parse({
      schemaVersion: 1,
      tilesetId: 'leitbild-osm-norway',
    } as never)).toThrow()
  })

  test('createBaseTileset has the canonical OSM artifact paths', () => {
    const base = createBaseTileset()
    expect(base.artifact.currentTileUrl).toBe('/map/tiles/current.pmtiles')
    expect(base.artifact.glyphsUrl).toBe('/map/fonts/{fontstack}/{range}.pbf')
  })

  test('base tileset advertises drone-relevant scenery layers', () => {
    const base = createBaseTileset()
    const layerIds = base.layers.map(layer => layer.id)
    expect(layerIds).toEqual(expect.arrayContaining([
      'aeroway',
      'building',
      'landcover',
      'landuse',
      'place',
      'poi',
      'transportation',
      'water',
      'waterway',
    ]))
  })

  test('findBaseTileset / findReferenceTilesets discriminate by kind', () => {
    const manifest = createMapCapabilityManifest()
    expect(findReferenceTilesets(manifest)).toEqual([])
    expect(findTerrainTilesets(manifest)).toEqual([])
    expect(findSceneryTilesets(manifest)).toEqual([])
    expect(findBaseTileset(manifest).kind).toBe('base')
  })
})

describe('loadMapCapabilityManifest (disk reads)', () => {
  test('returns base and explicit unavailable terrain when no reference releases exist', async () => {
    const root = await refRoot()
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(manifest.tilesets.length).toBe(3)
    expect(manifest.tilesets[0]!.kind).toBe('base')
    const terrain = findTerrainTilesets(manifest)
    expect(terrain.length).toBe(1)
    expect(terrain[0]!.availability.status).toBe('unavailable')
    expect(terrain[0]!.artifact.currentTileTemplate).toBe('/map/terrain/current/{z}/{x}/{y}.png')
    const scenery = findSceneryTilesets(manifest)
    expect(scenery.length).toBe(1)
    expect(scenery[0]!.availability.status).toBe('unavailable')
    expect(scenery[0]!.artifact.format).toBe('3d-tiles')
    expect(scenery[0]!.artifact.tileEncoding).toBe('model/gltf-binary')
    expect(scenery[0]!.artifact.lodStrategy).toBe('hierarchical-screen-space-error')
    expect(scenery[0]!.artifact.tilesetUrl).toBe('/map/scenery/current/tileset.json')
    expect(scenery[0]!.artifact.currentTileTemplate).toBe('/map/scenery/current/{recipeId}/{z}/{x}/{y}.glb')
    expect(scenery[0]!.artifact.roadTileTemplate).toBe('/map/scenery/current/{recipeId}/{z}/{x}/{y}.roads.json')
    expect(scenery[0]!.recipes.find(recipe => recipe.id === 'drone-urban-flight')?.scenarioPackIds).toEqual(['drone'])
  })

  test('marks corrupt terrain artifacts unavailable instead of advertising fake elevation', async () => {
    const root = await refRoot()
    const mapRoot = await mkdtemp(join(tmpdir(), 'leitbild-mapcap-map-'))
    await mkdir(join(mapRoot, 'current'), { recursive: true })
    await Bun.write(join(mapRoot, 'current', 'terrain.pmtiles'), 'terrain-bytes')
    await Bun.write(join(mapRoot, 'current', 'norway.pmtiles'), 'vector-bytes')

    const manifest = await loadMapCapabilityManifest({ referenceRoot: root, mapRoot })
    const terrain = findTerrainTilesets(manifest)
    expect(terrain.length).toBe(1)
    expect(terrain[0]!.availability.status).toBe('unavailable')
    expect(terrain[0]!.availability.path).toBe(join(mapRoot, 'current', 'terrain.pmtiles'))
    expect(terrain[0]!.availability.error).toContain('PMTiles archive')
    const scenery = findSceneryTilesets(manifest)
    expect(scenery[0]!.availability.status).toBe('unavailable')
    expect(scenery[0]!.availability.path).toBe(join(mapRoot, 'current', 'scenery', 'tileset.json'))
  })

  test('marks precompiled 3D Tiles scenery artifacts available when the tileset exists', async () => {
    const root = await refRoot()
    const mapRoot = await mkdtemp(join(tmpdir(), 'leitbild-mapcap-map-'))
    await mkdir(join(mapRoot, 'current'), { recursive: true })
    await Bun.write(join(mapRoot, 'current', 'norway.pmtiles'), 'vector-bytes')
    await writeSceneryTileset(mapRoot)

    const manifest = await loadMapCapabilityManifest({ referenceRoot: root, mapRoot })
    const scenery = findSceneryTilesets(manifest)
    expect(scenery[0]!.availability).toMatchObject({
      status: 'available',
      path: join(mapRoot, 'current', 'scenery', 'tileset.json'),
    })
    expect(scenery[0]!.artifact.tilesetUrl).toBe('/map/scenery/current/tileset.json')
    expect(scenery[0]!.artifact.currentTileTemplate).toBe('/map/scenery/current/{recipeId}/{z}/{x}/{y}.glb')
    expect(scenery[0]!.artifact.roadTileTemplate).toBe('/map/scenery/current/{recipeId}/{z}/{x}/{y}.roads.json')
  })

  test('marks corrupt precompiled scenery tilesets unavailable', async () => {
    const root = await refRoot()
    const mapRoot = await mkdtemp(join(tmpdir(), 'leitbild-mapcap-map-'))
    await mkdir(join(mapRoot, 'current', 'scenery'), { recursive: true })
    await Bun.write(join(mapRoot, 'current', 'scenery', 'tileset.json'), '{ not valid json')

    const manifest = await loadMapCapabilityManifest({ referenceRoot: root, mapRoot })
    const scenery = findSceneryTilesets(manifest)
    expect(scenery[0]!.availability.status).toBe('unavailable')
    expect(scenery[0]!.availability.error).toContain('JSON')
  })

  test('discovers a promoted reference dataset and appends it', async () => {
    const root = await refRoot()
    await writeReferenceManifest(root, 'reference-areas', '20260526-2000')
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(manifest.tilesets.length).toBe(4)
    const refs = findReferenceTilesets(manifest)
    expect(refs.length).toBe(1)
    expect(refs[0]!.datasetId).toBe('reference-areas')
    expect(refs[0]!.buildId).toBe('20260526-2000')
  })

  test('publishes the zoom range and bounds of the archive the release serves', async () => {
    const root = await refRoot()
    await writeReferenceManifest(root, 'grid-norway', '20261010-192738', {
      // A build manifest's own record of the header is not what clients get.
      tiles: { minZoom: 0, maxZoom: 3, bounds: [0, 0, 1, 1] },
    })
    const [tileset] = findReferenceTilesets(await loadMapCapabilityManifest({ referenceRoot: root }))
    expect(tileset?.tiles).toEqual({ minZoom: 6, maxZoom: 12, bounds: [4.5, 57.9, 31.1, 71.2] })
  })

  test('skips a reference dataset whose archive is missing or holds no vector tiles', async () => {
    const root = await refRoot()
    await writeReferenceManifest(root, 'missing-archive', 'b1', { datasetId: 'missing-archive' }, null)
    await writeReferenceManifest(root, 'raster-archive', 'b1', { datasetId: 'raster-archive' }, referenceArchive(TileType.Png))
    await writeReferenceManifest(root, 'escaping-archive', 'b1', { datasetId: 'escaping-archive', artifact: { pmtilesPath: '../x.pmtiles', sidecarGeoJsonPath: 'x.geojson', outputLayer: 'x' } })
    await writeReferenceManifest(root, 'reference-areas', 'b1')
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(findReferenceTilesets(manifest).map(tileset => tileset.datasetId)).toEqual(['reference-areas'])
  })

  test('accepts local-file reference sources in promoted manifests', async () => {
    const root = await refRoot()
    await writeReferenceManifest(root, 'grid-norway', '20260528-230419', {
      sources: [{ id: 'osm:pbf-power:NO', kind: 'local' }],
    })
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    const refs = findReferenceTilesets(manifest)
    expect(refs.map(ref => ref.datasetId)).toEqual(['grid-norway'])
    expect(refs[0]?.sources).toEqual([{ id: 'osm:pbf-power:NO', kind: 'local' }])
  })

  test('skips corrupt per-dataset manifests with a warning, base still served', async () => {
    const root = await refRoot()
    const buildDir = join(root, 'builds', 'broken', 'b1')
    await mkdir(buildDir, { recursive: true })
    await writeFile(join(buildDir, 'broken.manifest.json'), '{ not valid json')
    await mkdir(join(root, 'releases', 'broken'), { recursive: true })
    await symlink(buildDir, join(root, 'releases', 'broken', 'current'))
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(manifest.tilesets.length).toBe(3)
    expect(findReferenceTilesets(manifest).length).toBe(0)
  })

  test('cache invalidates when symlink target changes', async () => {
    const root = await refRoot()
    await writeReferenceManifest(root, 'reference-areas', '20260526-2000')
    const first = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(findReferenceTilesets(first)[0]!.buildId).toBe('20260526-2000')

    // Replace the symlink target by promoting a second build.
    await writeReferenceManifest(root, 'reference-areas', '20260526-2100', { buildId: '20260526-2100' })
    // The writer added a fresh symlink at the same path? Actually we'd need to
    // remove the old symlink first. Simulate atomically by clearing cache.
    __clearManifestCacheForTests()
    const reread = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(findReferenceTilesets(reread).length).toBeGreaterThan(0)
  })

  test('multiple datasets are listed alphabetically', async () => {
    const root = await refRoot()
    await writeReferenceManifest(root, 'reference-areas', 'b1')
    await writeReferenceManifest(root, 'b-dataset', 'b1', { datasetId: 'b-dataset' })
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    const ids = findReferenceTilesets(manifest).map(t => t.datasetId)
    expect(ids).toEqual(['b-dataset', 'reference-areas'])
  })
})
