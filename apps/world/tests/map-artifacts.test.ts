import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { TileType } from 'pmtiles'
import {
  __clearManifestCacheForTests,
  createMapCapabilityManifest,
  findBaseTileset,
  mapCapabilityManifestSchema,
} from '../src/map/capabilities.ts'
import {
  currentPmtilesResponse,
  currentSceneryTilesetResponse,
  currentSceneryTileResponse,
  currentTerrainPmtilesResponse,
  currentTerrainRasterTileResponse,
  currentTerrainTileJsonResponse,
  currentVectorTileResponse,
  mapGlyphResponse,
  referenceDatasetPmtilesResponse,
  referenceDatasetVectorTileResponse,
} from '../src/map/artifacts.ts'
import { writePmtilesArchive } from '../src/map/pmtiles-writer.ts'
import { buildSceneryTilesetDocument } from '../src/map/scenery-tileset.ts'
import type { SceneryAssetTileSummary } from '../src/map/scenery.ts'
import { createLeitbildMapStyle } from '../src/map/style.ts'

// Stand-in MVT payload: the server never decodes tiles, it only codes and caches their bytes.
const fixtureTileBytes = (seed: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(8_192)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * seed + (index >> 6)) % 97
  return bytes
}

const mvtArchive = (tileBytes: Uint8Array): Uint8Array => writePmtilesArchive({
  tiles: [{ z: 1, x: 1, y: 0, data: tileBytes }],
  tileType: TileType.Mvt,
  bounds: { minLon: 0, minLat: 0, maxLon: 180, maxLat: 85 },
  center: { lon: 90, lat: 40, zoom: 1 },
})

const writeReferenceDataset = async (root: string, datasetId: string, buildId: string, bytes: string | Uint8Array): Promise<void> => {
  const buildDir = join(root, 'builds', datasetId, buildId)
  await mkdir(buildDir, { recursive: true })
  await Bun.write(join(buildDir, `${datasetId}.pmtiles`), bytes)
  await writeFile(join(buildDir, `${datasetId}.manifest.json`), JSON.stringify({
    schemaVersion: 1,
    datasetId,
    builtAt: '2026-05-30T12:00:00Z',
    buildId,
    artifact: {
      pmtilesPath: `${datasetId}.pmtiles`,
      sidecarGeoJsonPath: `${datasetId}.features.geojson`,
      outputLayer: datasetId,
    },
    categories: [{ category: 'line', minZoom: 0, maxZoom: 14, featureCount: 1 }],
    sources: [{ id: 'test:source', kind: 'local' }],
    licences: [{
      id: 'test',
      name: 'Test Licence',
      url: 'https://example.test/licence',
      attribution: 'Test attribution',
      commercialUseAllowed: true,
      redistributionAllowed: true,
      shareAlike: false,
    }],
  }))
  const releaseDir = join(root, 'releases', datasetId)
  await mkdir(releaseDir, { recursive: true })
  const currentLink = join(releaseDir, 'current')
  await rm(currentLink, { force: true })
  await symlink(buildDir, currentLink)
}

const scenerySummary = (): SceneryAssetTileSummary => ({
  recipeId: 'drone-urban-flight',
  z: 14,
  x: 8686,
  y: 4758,
  byteLength: 9,
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

const writeSceneryTileset = async (rootDir: string): Promise<void> => {
  const sceneryRoot = join(rootDir, 'current', 'scenery')
  await mkdir(join(sceneryRoot, 'drone-urban-flight', '14', '8686'), { recursive: true })
  await Bun.write(join(sceneryRoot, 'drone-urban-flight', '14', '8686', '4758.glb'), 'glb-bytes')
  await Bun.write(join(sceneryRoot, 'drone-urban-flight', '14', '8686', '4758.roads.json'), JSON.stringify({
    schemaVersion: 1,
    tileEncoding: 'leitbild-scenery-road-json-v1',
    recipeId: 'drone-urban-flight',
    sourceTilesetId: 'leitbild-osm-norway',
    tile: { z: 14, x: 8686, y: 4758, extent: 4096 },
    roads: [{
      id: 'road:fixture',
      className: 'primary',
      isBridge: false,
      isTunnel: false,
      path: [[1000, 1000], [3000, 3000]],
      widthM: 16,
      verticalOffsetM: 0,
    }],
  }))
  const tile = scenerySummary()
  await Bun.write(join(sceneryRoot, 'tileset.json'), JSON.stringify(buildSceneryTilesetDocument({
    tilesetId: 'leitbild-scenery-norway',
    sourceTilesetId: 'leitbild-osm-norway',
    sourcePmtilesPath: join(rootDir, 'current', 'norway.pmtiles'),
    builtAt: '2026-06-08T00:00:00Z',
    bounds: { minLon: 10.7, minLat: 59.9, maxLon: 10.8, maxLat: 60 },
    zooms: [14],
    lodLevels: [{ zoom: 14, geometricErrorM: 8, maxScreenSpaceError: 16 }],
    inputArtifacts: [{
      kind: 'base-vector-pmtiles',
      id: 'leitbild-osm-norway',
      path: join(rootDir, 'current', 'norway.pmtiles'),
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
      bytes: 9,
    },
    tiles: [tile],
  })))
}

const collectContentUris = (tile: {
  readonly content?: { readonly uri?: unknown }
  readonly children?: ReadonlyArray<unknown>
}): ReadonlyArray<string> => [
  ...(typeof tile.content?.uri === 'string' ? [tile.content.uri] : []),
  ...(Array.isArray(tile.children)
    ? tile.children.flatMap(child => typeof child === 'object' && child !== null ? collectContentUris(child as Parameters<typeof collectContentUris>[0]) : [])
    : []),
]

describe('vector map artifacts', () => {
  test('declares the canonical vector tile capabilities', () => {
    const manifest = mapCapabilityManifestSchema.parse(createMapCapabilityManifest())
    expect(manifest.schemaVersion).toBe(2)
    const base = findBaseTileset(manifest)
    expect(base.artifact.format).toBe('pmtiles')
    expect(base.artifact.currentTileUrl).toBe('/map/tiles/current.pmtiles')
    expect(base.layers.map(layer => layer.id)).toContain('transportation')
    expect(base.layers.map(layer => layer.id)).toContain('poi')
    expect(base.layers.map(layer => layer.id)).toContain('landuse')
  })

  test('style uses only self-hosted vector tile sources', () => {
    const style = createLeitbildMapStyle()

    expect(style.sources['leitbild-osm']).toEqual({
      type: 'vector',
      tiles: ['/map/tiles/current/{z}/{x}/{y}.mvt'],
      minzoom: 0,
      maxzoom: 14,
      bounds: [-12, 57, 36, 82],
      attribution: '© OpenStreetMap contributors © OpenMapTiles',
    })
    expect(JSON.stringify(style)).not.toContain('"raster"')
    expect(style.glyphs).toBe('/map/fonts/{fontstack}/{range}.pbf')
  })

  test('style supports light and dark vector themes without changing sources', () => {
    const lightStyle = createLeitbildMapStyle('light')
    const darkStyle = createLeitbildMapStyle('dark')

    expect(darkStyle.sources).toEqual(lightStyle.sources)
    expect(darkStyle.name).toContain('dark')
    expect(JSON.stringify(darkStyle.layers)).toContain('#0e1521')
  })

  test('PMTiles serving supports byte ranges and fails visibly when missing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'leitbild-map-test-'))
    const currentDir = join(rootDir, 'current')
    await mkdir(currentDir)
    await Bun.write(join(currentDir, 'norway.pmtiles'), '0123456789')

    const rangeResponse = await currentPmtilesResponse(new Request('http://localhost/map/tiles/current.pmtiles', {
      headers: { range: 'bytes=2-5' },
    }), { rootDir })
    expect(rangeResponse.status).toBe(206)
    expect(rangeResponse.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await rangeResponse.text()).toBe('2345')

    const missingResponse = await currentPmtilesResponse(new Request('http://localhost/map/tiles/current.pmtiles'), {
      rootDir: join(rootDir, 'missing'),
    })
    expect(missingResponse.status).toBe(503)
    expect(await missingResponse.json()).toMatchObject({ ok: false, error: 'vector map artifact unavailable' })
  })

  test('terrain artifact routes expose byte serving and explicit unavailable states', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'leitbild-map-test-'))
    const currentDir = join(rootDir, 'current')
    await mkdir(currentDir)
    await Bun.write(join(currentDir, 'terrain.pmtiles'), 'terrain-bytes')

    const rangeResponse = await currentTerrainPmtilesResponse(new Request('http://localhost/map/terrain/current.pmtiles', {
      headers: { range: 'bytes=0-6' },
    }), { rootDir })
    expect(rangeResponse.status).toBe(206)
    expect(rangeResponse.headers.get('content-range')).toBe('bytes 0-6/13')
    expect(await rangeResponse.text()).toBe('terrain')

    const missingPmtiles = await currentTerrainPmtilesResponse(new Request('http://localhost/map/terrain/current.pmtiles'), {
      rootDir: join(rootDir, 'missing'),
    })
    expect(missingPmtiles.status).toBe(503)
    expect(await missingPmtiles.json()).toMatchObject({ ok: false, error: 'terrain map artifact unavailable' })

    const missingTileJson = await currentTerrainTileJsonResponse({ rootDir: join(rootDir, 'missing') })
    expect(missingTileJson.status).toBe(503)
    expect(await missingTileJson.json()).toMatchObject({ ok: false, error: 'terrain map artifact unavailable' })

    const corruptTileJson = await currentTerrainTileJsonResponse({ rootDir })
    expect(corruptTileJson.status).toBe(415)
    expect(await corruptTileJson.json()).toMatchObject({ ok: false, error: 'terrain map artifact is not a readable PMTiles archive' })

    const invalidTile = await currentTerrainRasterTileResponse(new URL('http://localhost/map/terrain/current/27/0/0.png'), { rootDir })
    expect(invalidTile?.status).toBe(400)

    const missingTile = await currentTerrainRasterTileResponse(new URL('http://localhost/map/terrain/current/0/0/0.png'), {
      rootDir: join(rootDir, 'missing'),
    })
    expect(missingTile?.status).toBe(503)
  })

  test('scenery artifact routes expose one 3D Tiles tileset and explicit GLB content paths', async () => {
    __clearManifestCacheForTests()
    const rootDir = await mkdtemp(join(tmpdir(), 'leitbild-map-test-'))
    const currentDir = join(rootDir, 'current')
    await mkdir(currentDir)
    await Bun.write(join(currentDir, 'norway.pmtiles'), 'not-a-real-pmtiles')
    await writeSceneryTileset(rootDir)

    const tileset = await currentSceneryTilesetResponse({ rootDir })
    expect(tileset.status).toBe(200)
    const body = await tileset.json()
    expect(body).toMatchObject({
      asset: { version: '1.1', gltfUpAxis: 'z' },
      extras: {
        leitbild: {
          artifactFormat: '3d-tiles',
          tileEncoding: 'model/gltf-binary',
          roadTileTemplate: '/map/scenery/current/{recipeId}/{z}/{x}/{y}.roads.json',
          counts: { writtenTileCount: 1 },
        },
      },
    })
    expect(collectContentUris(body.root)).toEqual(['drone-urban-flight/14/8686/4758.glb'])

    const missingTileset = await currentSceneryTilesetResponse({ rootDir: join(rootDir, 'missing') })
    expect(missingTileset.status).toBe(503)
    expect(await missingTileset.json()).toMatchObject({ ok: false, error: 'precompiled scenery tileset unavailable' })

    const corruptRoot = await mkdtemp(join(tmpdir(), 'leitbild-map-test-corrupt-scenery-'))
    await mkdir(join(corruptRoot, 'current', 'scenery'), { recursive: true })
    await Bun.write(join(corruptRoot, 'current', 'scenery', 'tileset.json'), '{ not valid json')
    const corruptTileset = await currentSceneryTilesetResponse({ rootDir: corruptRoot })
    expect(corruptTileset.status).toBe(415)
    expect(await corruptTileset.json()).toMatchObject({ ok: false, error: 'precompiled scenery tileset is invalid' })

    const invalidTile = await currentSceneryTileResponse(new URL('http://localhost/map/scenery/current/drone-urban-flight/27/0/0.glb'), { rootDir })
    expect(invalidTile?.status).toBe(400)

    const invalidExtension = await currentSceneryTileResponse(new URL('http://localhost/map/scenery/current/drone-urban-flight/14/8686/4758.json'), { rootDir })
    expect(invalidExtension?.status).toBe(400)

    const invalidRecipe = await currentSceneryTileResponse(new URL('http://localhost/map/scenery/current/bad_recipe/14/0/0.glb'), { rootDir })
    expect(invalidRecipe?.status).toBe(400)

    const missingTile = await currentSceneryTileResponse(new URL('http://localhost/map/scenery/current/drone-urban-flight/14/8686/4759.glb'), { rootDir })
    expect(missingTile?.status).toBe(404)
    expect(await missingTile?.json()).toMatchObject({ ok: false, error: 'precompiled scenery tile unavailable' })

    const tile = await currentSceneryTileResponse(new URL('http://localhost/map/scenery/current/drone-urban-flight/14/8686/4758.glb'), { rootDir })
    expect(tile?.status).toBe(200)
    expect(tile?.headers.get('content-type')).toBe('model/gltf-binary')
    expect(await tile?.text()).toBe('glb-bytes')

    const roadTile = await currentSceneryTileResponse(new URL('http://localhost/map/scenery/current/drone-urban-flight/14/8686/4758.roads.json'), { rootDir })
    expect(roadTile?.status).toBe(200)
    expect(roadTile?.headers.get('content-type')).toContain('application/json')
    expect(await roadTile?.json()).toMatchObject({
      tileEncoding: 'leitbild-scenery-road-json-v1',
      roads: [{ id: 'road:fixture', className: 'primary' }],
    })

    await Bun.write(join(currentDir, 'scenery', 'drone-urban-flight', '14', '8686', '4758.roads.json'), '{ not valid json')
    const invalidRoadTile = await currentSceneryTileResponse(new URL('http://localhost/map/scenery/current/drone-urban-flight/14/8686/4758.roads.json'), { rootDir })
    expect(invalidRoadTile?.status).toBe(415)
  })

  test('reference dataset PMTiles route serves promoted datasets from the manifest', async () => {
    __clearManifestCacheForTests()
    const referenceRoot = await mkdtemp(join(tmpdir(), 'leitbild-reference-test-'))
    await writeReferenceDataset(referenceRoot, 'grid-norway', '20260530-120000', 'reference-bytes')

    const served = await referenceDatasetPmtilesResponse(new Request(
      'http://localhost/map/datasets/grid-norway/current/grid-norway.pmtiles',
      { headers: { range: 'bytes=0-8' } },
    ), new URL('http://localhost/map/datasets/grid-norway/current/grid-norway.pmtiles'), { referenceRoot })
    expect(served?.status).toBe(206)
    expect(served?.headers.get('content-range')).toBe('bytes 0-8/15')
    expect(await served?.text()).toBe('reference')

    const unknown = await referenceDatasetPmtilesResponse(new Request(
      'http://localhost/map/datasets/missing/current/missing.pmtiles',
    ), new URL('http://localhost/map/datasets/missing/current/missing.pmtiles'), { referenceRoot })
    expect(unknown?.status).toBe(404)
  })

  test('vector tile routes validate coordinates and dataset paths', async () => {
    __clearManifestCacheForTests()
    const rootDir = await mkdtemp(join(tmpdir(), 'leitbild-map-test-'))
    const currentDir = join(rootDir, 'current')
    await mkdir(currentDir)
    await Bun.write(join(currentDir, 'norway.pmtiles'), 'not-a-real-pmtiles')

    const invalidBaseUrl = new URL('http://localhost/map/tiles/current/27/0/0.mvt')
    const invalidBase = await currentVectorTileResponse(new Request(invalidBaseUrl), invalidBaseUrl, { rootDir })
    expect(invalidBase?.status).toBe(400)

    const referenceRoot = await mkdtemp(join(tmpdir(), 'leitbild-reference-test-'))
    await writeReferenceDataset(referenceRoot, 'grid-norway', '20260530-120000', 'not-a-real-pmtiles')
    const invalidReferenceUrl = new URL('http://localhost/map/datasets/grid-norway/current/grid-norway/0/0/1.mvt')
    const invalidReference = await referenceDatasetVectorTileResponse(new Request(invalidReferenceUrl), invalidReferenceUrl, { referenceRoot })
    expect(invalidReference?.status).toBe(400)

    const unknownReferenceUrl = new URL('http://localhost/map/datasets/missing/current/missing/0/0/0.mvt')
    const unknownReference = await referenceDatasetVectorTileResponse(new Request(unknownReferenceUrl), unknownReferenceUrl, { referenceRoot })
    expect(unknownReference?.status).toBe(404)
  })

  test('vector tiles are served gzip-coded to clients that accept gzip and as identity bytes otherwise', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'leitbild-map-test-'))
    await mkdir(join(rootDir, 'current'))
    const archivePath = join(rootDir, 'current', 'norway.pmtiles')
    const tileBytes = fixtureTileBytes(1)
    await Bun.write(archivePath, mvtArchive(tileBytes))
    const fixedMtime = new Date('2026-10-01T00:00:00Z')
    await utimes(archivePath, fixedMtime, fixedMtime)

    const url = new URL('http://localhost/map/tiles/current/1/1/0.mvt')
    const request = (acceptEncoding?: string): Request =>
      new Request(url, acceptEncoding === undefined ? {} : { headers: { 'Accept-Encoding': acceptEncoding } })

    const gzipped = await currentVectorTileResponse(request('gzip, deflate, br, zstd'), url, { rootDir })
    expect(gzipped?.status).toBe(200)
    expect(gzipped?.headers.get('content-type')).toBe('application/vnd.mapbox-vector-tile')
    expect(gzipped?.headers.get('content-encoding')).toBe('gzip')
    expect(gzipped?.headers.get('vary')).toBe('Accept-Encoding')
    expect(gzipped?.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(gzipped?.headers.get('etag')).toBeNull()
    const gzippedBody = new Uint8Array(await gzipped!.arrayBuffer())
    expect(gzipped?.headers.get('content-length')).toBe(String(gzippedBody.byteLength))
    expect(gzippedBody.byteLength).toBeLessThan(tileBytes.byteLength)
    expect(new Uint8Array(gunzipSync(gzippedBody))).toEqual(tileBytes)

    for (const acceptEncoding of [undefined, 'br, deflate', 'gzip;q=0']) {
      const identity = await currentVectorTileResponse(request(acceptEncoding), url, { rootDir })
      expect(identity?.status).toBe(200)
      expect(identity?.headers.get('content-encoding')).toBeNull()
      expect(identity?.headers.get('vary')).toBe('Accept-Encoding')
      expect(identity?.headers.get('content-length')).toBe(String(tileBytes.byteLength))
      expect(new Uint8Array(await identity!.arrayBuffer())).toEqual(tileBytes)
    }

    const absentUrl = new URL('http://localhost/map/tiles/current/1/0/0.mvt')
    const absent = await currentVectorTileResponse(new Request(absentUrl, { headers: { 'Accept-Encoding': 'gzip' } }), absentUrl, { rootDir })
    expect(absent?.status).toBe(200)
    expect(absent?.headers.get('content-encoding')).toBeNull()
    expect(absent?.headers.get('content-length')).toBe('0')
  })

  test('gzip-coded vector tiles are cached per archive identity', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'leitbild-map-test-'))
    await mkdir(join(rootDir, 'current'))
    const archivePath = join(rootDir, 'current', 'norway.pmtiles')
    const firstBytes = fixtureTileBytes(1)
    const replacementBytes = fixtureTileBytes(2)
    expect(replacementBytes.byteLength).toBe(firstBytes.byteLength)
    const fixedMtime = new Date('2026-10-01T00:00:00Z')
    await Bun.write(archivePath, mvtArchive(firstBytes))
    await utimes(archivePath, fixedMtime, fixedMtime)

    const url = new URL('http://localhost/map/tiles/current/1/1/0.mvt')
    const gzipTileBytes = async (): Promise<Uint8Array> => {
      const response = await currentVectorTileResponse(new Request(url, { headers: { 'Accept-Encoding': 'gzip' } }), url, { rootDir })
      expect(response?.headers.get('content-encoding')).toBe('gzip')
      return new Uint8Array(gunzipSync(new Uint8Array(await response!.arrayBuffer())))
    }
    const identityTileBytes = async (): Promise<Uint8Array> => {
      const response = await currentVectorTileResponse(new Request(url), url, { rootDir })
      return new Uint8Array(await response!.arrayBuffer())
    }

    expect(await gzipTileBytes()).toEqual(firstBytes)

    // Same size and modification time: the archive identity is unchanged, so the compressed
    // tile comes from memory while the uncoded path reads the file again.
    await Bun.write(archivePath, mvtArchive(replacementBytes))
    await utimes(archivePath, fixedMtime, fixedMtime)
    expect(await gzipTileBytes()).toEqual(firstBytes)
    expect(await identityTileBytes()).toEqual(replacementBytes)

    // A replaced archive (new modification time) is never served from the old entries.
    const laterMtime = new Date('2026-10-02T00:00:00Z')
    await utimes(archivePath, laterMtime, laterMtime)
    expect(await gzipTileBytes()).toEqual(replacementBytes)
  })

  test('reference dataset vector tiles share the gzip tile path', async () => {
    __clearManifestCacheForTests()
    const referenceRoot = await mkdtemp(join(tmpdir(), 'leitbild-reference-test-'))
    const tileBytes = fixtureTileBytes(3)
    await writeReferenceDataset(referenceRoot, 'grid-norway', '20260530-120000', mvtArchive(tileBytes))

    const url = new URL('http://localhost/map/datasets/grid-norway/current/grid-norway/1/1/0.mvt')
    const response = await referenceDatasetVectorTileResponse(new Request(url, { headers: { 'Accept-Encoding': 'gzip, br' } }), url, { referenceRoot })
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-encoding')).toBe('gzip')
    expect(response?.headers.get('vary')).toBe('Accept-Encoding')
    expect(new Uint8Array(gunzipSync(new Uint8Array(await response!.arrayBuffer())))).toEqual(tileBytes)
  })

  test('reference dataset PMTiles route rejects unsafe paths', async () => {
    __clearManifestCacheForTests()
    const referenceRoot = await mkdtemp(join(tmpdir(), 'leitbild-reference-test-'))
    await writeReferenceDataset(referenceRoot, 'grid-norway', '20260530-120000', 'reference-bytes')

    const invalidDataset = await referenceDatasetPmtilesResponse(new Request(
      'http://localhost/map/datasets/grid%2Fnorway/current/grid-norway.pmtiles',
    ), new URL('http://localhost/map/datasets/grid%2Fnorway/current/grid-norway.pmtiles'), { referenceRoot })
    expect(invalidDataset?.status).toBe(400)

    const invalidFile = await referenceDatasetPmtilesResponse(new Request(
      'http://localhost/map/datasets/grid-norway/current/grid-norway.txt',
    ), new URL('http://localhost/map/datasets/grid-norway/current/grid-norway.txt'), { referenceRoot })
    expect(invalidFile?.status).toBe(400)
  })

  test('glyph serving honors the self-hosted map font contract', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'leitbild-map-test-'))
    const glyphDir = join(rootDir, 'fonts', 'Noto Sans Regular')
    await mkdir(glyphDir, { recursive: true })
    await Bun.write(join(glyphDir, '0-255.pbf'), 'glyph-bytes')

    const served = await mapGlyphResponse(new URL('http://localhost/map/fonts/Noto%20Sans%20Regular/0-255.pbf'), { rootDir })
    expect(served?.status).toBe(200)
    expect(served?.headers.get('content-type')).toBe('application/x-protobuf')
    expect(await served?.text()).toBe('glyph-bytes')

    const missing = await mapGlyphResponse(new URL('http://localhost/map/fonts/Noto%20Sans%20Regular/256-511.pbf'), { rootDir })
    expect(missing?.status).toBe(404)

    const invalidRange = await mapGlyphResponse(new URL('http://localhost/map/fonts/Noto%20Sans%20Regular/0-255.txt'), { rootDir })
    expect(invalidRange?.status).toBe(400)
  })
})
