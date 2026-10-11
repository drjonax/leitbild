import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { PMTiles, TileType, type Source } from 'pmtiles'
import {
  createBaseTileset,
  overviewPmtilesPathForRoot,
  defaultSceneryRecipes,
  findReferenceTilesets,
  loadMapCapabilityManifest,
  referenceRootFromEnv,
  sceneryTilesetPathForRoot,
  terrainPmtilesPathForRoot,
} from './capabilities.ts'
import {
  sceneryAssetTilesetSchema,
  sceneryAssetTileEncoding,
  sceneryRoadTileSchema,
  sceneryRoadTileTemplate,
} from './scenery.ts'
import { createLeitbildMapStyle, type MapTheme } from './style.ts'
import { acceptsGzipEncoding, createCompressedTileCache, gzipTile } from './tile-compression.ts'

export interface MapArtifactConfig {
  readonly rootDir: string
}

export interface ReferenceDatasetArtifactConfig {
  readonly referenceRoot: string
}

export interface MapArtifactFileStatus {
  readonly available: boolean
  readonly path: string
  readonly sizeBytes?: number
  readonly modifiedAt?: string
  readonly error?: string
}

export interface MapArtifactStatus {
  readonly status: 'ready' | 'unavailable'
  readonly rootDir: string
  readonly activeBuildId: string | null
  readonly activeBuildError?: string
  readonly capabilities: {
    readonly schemaVersion: number
    readonly tilesetId: string
    readonly styleUrl: string
    readonly tileUrl: string
  }
  readonly currentPmtiles: MapArtifactFileStatus
  readonly glyphProbe: MapArtifactFileStatus & {
    readonly fontStack: string
    readonly range: string
  }
  readonly terrain: MapArtifactFileStatus & {
    readonly tileUrl: string
    readonly tileTemplate: string
    readonly tileJsonUrl: string
    readonly demEncoding: 'terrarium'
  }
  readonly scenery: MapArtifactFileStatus & {
    readonly tilesetUrl: string
    readonly tileTemplate: string
    readonly roadTileTemplate: string
  }
}

const pmtilesContentType = 'application/vnd.pmtiles'
const vectorTileContentType = 'application/vnd.mapbox-vector-tile'
const rasterDemContentType = 'image/png'
const glyphContentType = 'application/x-protobuf'
const sceneryTilesetContentType = 'application/json; charset=utf-8'
const sceneryTileContentType = sceneryAssetTileEncoding
const sceneryRoadTileContentType = 'application/json; charset=utf-8'
const glyphProbeFontStack = 'Noto Sans Regular'
const glyphProbeRange = '0-255'
const mapFontPathPrefix = '/map/fonts/'
const mapDatasetPathPrefix = '/map/datasets/'
const mapSceneryPathPrefix = '/map/scenery/current/'
const datasetIdPattern = /^[a-z0-9][a-z0-9-]*$/
const pmtilesFilePattern = /^[a-z0-9][a-z0-9-]*\.pmtiles$/
const pmtilesBaseNamePattern = /^[a-z0-9][a-z0-9-]*$/
const sceneryRecipeIdPattern = /^[a-z0-9][a-z0-9-]*$/

interface TileCoordinates {
  readonly z: number
  readonly x: number
  readonly y: number
}

interface CachedPmtilesArchive {
  readonly filePath: string
  readonly mtimeMs: number
  readonly sizeBytes: number
  readonly archive: PMTiles
}

interface CachedValidatedJsonText {
  readonly filePath: string
  readonly mtimeMs: number
  readonly sizeBytes: number
  readonly body: string
}

interface ReferenceDatasetArtifactResolution {
  readonly ok: true
  readonly filePath: string
  /** Build id of the release directory the file was resolved in. */
  readonly buildId: string
}

interface ReferenceDatasetArtifactFailure {
  readonly ok: false
  readonly response: Response
}

type ReferenceDatasetArtifactResult = ReferenceDatasetArtifactResolution | ReferenceDatasetArtifactFailure

const pmtilesArchiveCache = new Map<string, CachedPmtilesArchive>()
const validatedJsonTextCache = new Map<string, CachedValidatedJsonText>()
const defaultTileCacheControl = 'public, max-age=3600'
// A reference tile URL names its build, so its bytes never change.
const buildTileCacheControl = 'public, max-age=31536000, immutable'
// Gzipped vector tiles shared by the base map, the overview and reference datasets. The largest
// grid tile is about 160 KB gzipped and a base-map tile about 20 KB.
const compressedVectorTiles = createCompressedTileCache({ maxBytes: 64 * 1024 * 1024 })

export const createMapArtifactConfigFromEnv = (): MapArtifactConfig => ({
  rootDir: resolve(process.env.LEITBILD_MAP_ROOT ?? '/opt/leitbild/maps'),
})

export const currentPmtilesPath = (config: MapArtifactConfig): string =>
  resolve(config.rootDir, 'current', 'norway.pmtiles')

export const currentTerrainPmtilesPath = (config: MapArtifactConfig): string =>
  terrainPmtilesPathForRoot(config.rootDir)

export const currentSceneryTilesetPath = (config: MapArtifactConfig): string =>
  sceneryTilesetPathForRoot(config.rootDir)

const currentSceneryTilePath = (
  config: MapArtifactConfig,
  recipeId: string,
  coordinates: TileCoordinates,
  extension: 'glb' | 'roads.json',
): string =>
  resolve(config.rootDir, 'current', 'scenery', recipeId, String(coordinates.z), String(coordinates.x), `${coordinates.y}.${extension}`)

const cachedValidatedJsonText = async (config: {
  readonly filePath: string
  readonly validate: (value: unknown) => void
}): Promise<string> => {
  const info = await stat(config.filePath)
  const cached = validatedJsonTextCache.get(config.filePath)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.sizeBytes === info.size) return cached.body
  const body = await readFile(config.filePath, 'utf8')
  config.validate(JSON.parse(body) as unknown)
  validatedJsonTextCache.set(config.filePath, {
    filePath: config.filePath,
    mtimeMs: info.mtimeMs,
    sizeBytes: info.size,
    body,
  })
  return body
}

const glyphProbePath = (config: MapArtifactConfig): string =>
  resolve(config.rootDir, 'fonts', glyphProbeFontStack, `${glyphProbeRange}.pbf`)

const isWithin = (rootPath: string, candidatePath: string): boolean => {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

const parseTileCoordinate = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

const parseTileCoordinates = (
  zPart: string,
  xPart: string,
  yPart: string,
  extension: 'mvt' | 'png' | 'glb' | 'roads.json',
): TileCoordinates | null => {
  const z = parseTileCoordinate(zPart)
  const x = parseTileCoordinate(xPart)
  const escapedExtension = extension.replaceAll('.', '\\.')
  const yMatch = yPart.match(new RegExp(`^(\\d+)\\.${escapedExtension}$`))
  const y = yMatch ? parseTileCoordinate(yMatch[1] ?? '') : null
  if (z === null || x === null || y === null) return null
  if (z < 0 || z > 26) return null
  const maxTile = 2 ** z
  if (x < 0 || x >= maxTile || y < 0 || y >= maxTile) return null
  return { z, x, y }
}

const createBunFileSource = (filePath: string, key: string): Source => ({
  getKey: (): string => key,
  getBytes: async (
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<{ readonly data: ArrayBuffer }> => {
    signal?.throwIfAborted()
    const data = await Bun.file(filePath).slice(offset, offset + length).arrayBuffer()
    signal?.throwIfAborted()
    return { data }
  },
})

const pmtilesArchiveFor = async (filePath: string): Promise<PMTiles> => {
  const info = await stat(filePath)
  const cached = pmtilesArchiveCache.get(filePath)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.sizeBytes === info.size) {
    return cached.archive
  }

  const key = `${filePath}:${info.mtimeMs}:${info.size}`
  const archive = new PMTiles(createBunFileSource(filePath, key))
  pmtilesArchiveCache.set(filePath, {
    filePath,
    mtimeMs: info.mtimeMs,
    sizeBytes: info.size,
    archive,
  })
  return archive
}

const emptyVectorTileResponse = (cacheControl: string = defaultTileCacheControl): Response =>
  new Response(new Uint8Array(), {
    headers: {
      'Content-Type': vectorTileContentType,
      'Content-Length': '0',
      'Cache-Control': cacheControl,
    },
  })

const emptyRasterDemTileResponse = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'public, max-age=3600',
    },
  })

const encodedVectorTileResponse = (
  bytes: Uint8Array<ArrayBuffer>,
  cacheControl: string,
  contentEncoding: 'gzip' | 'identity',
): Response => {
  const headers = new Headers({
    'Content-Type': vectorTileContentType,
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': cacheControl,
    // The same URL is served gzip-coded or as identity bytes depending on Accept-Encoding.
    Vary: 'Accept-Encoding',
  })
  if (contentEncoding === 'gzip') headers.set('Content-Encoding', 'gzip')
  return new Response(bytes, { headers })
}

const vectorTileResponse = async (
  req: Request,
  filePath: string,
  coordinates: TileCoordinates,
  missing: { readonly error: string; readonly status: number },
  cacheControl?: string,
): Promise<Response> => {
  const file = Bun.file(filePath)
  if (!await file.exists()) {
    return Response.json({
      ok: false,
      error: missing.error,
      expectedPath: filePath,
    }, { status: missing.status })
  }

  const archive = await pmtilesArchiveFor(filePath)
  let header: Awaited<ReturnType<PMTiles['getHeader']>>
  try {
    header = await archive.getHeader()
  } catch (error) {
    return Response.json({
      ok: false,
      error: 'map artifact is not a readable PMTiles archive',
      expectedPath: filePath,
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 415 })
  }
  if (header.tileType !== TileType.Mvt) {
    return Response.json({
      ok: false,
      error: 'map artifact is not an MVT PMTiles archive',
      expectedPath: filePath,
    }, { status: 415 })
  }

  // PMTiles hands out decompressed tile bytes, and the reverse proxy does not compress the
  // vector-tile media type, so the module codes the tile itself.
  if (!acceptsGzipEncoding(req.headers.get('accept-encoding'))) {
    const tile = await archive.getZxy(coordinates.z, coordinates.x, coordinates.y)
    if (!tile) return emptyVectorTileResponse(cacheControl)
    return encodedVectorTileResponse(new Uint8Array(tile.data), cacheControl ?? tile.cacheControl ?? defaultTileCacheControl, 'identity')
  }

  // The source key carries the archive's path, modification time and size.
  const tileKey = `${archive.source.getKey()}#${coordinates.z}/${coordinates.x}/${coordinates.y}`
  const compressed = await compressedVectorTiles.get(tileKey, async () => {
    const tile = await archive.getZxy(coordinates.z, coordinates.x, coordinates.y)
    if (!tile) return null
    return {
      bytes: await gzipTile(new Uint8Array(tile.data)),
      cacheControl: tile.cacheControl ?? defaultTileCacheControl,
    }
  })
  if (!compressed) return emptyVectorTileResponse(cacheControl)
  return encodedVectorTileResponse(compressed.bytes, cacheControl ?? compressed.cacheControl, 'gzip')
}

const rasterDemTileResponse = async (
  filePath: string,
  coordinates: TileCoordinates,
  missing: { readonly error: string; readonly status: number },
): Promise<Response> => {
  const file = Bun.file(filePath)
  if (!await file.exists()) {
    return Response.json({
      ok: false,
      error: missing.error,
      expectedPath: filePath,
    }, { status: missing.status })
  }

  const archive = await pmtilesArchiveFor(filePath)
  let header: Awaited<ReturnType<PMTiles['getHeader']>>
  try {
    header = await archive.getHeader()
  } catch (error) {
    return Response.json({
      ok: false,
      error: 'terrain map artifact is not a readable PMTiles archive',
      expectedPath: filePath,
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 415 })
  }
  if (header.tileType !== TileType.Png) {
    return Response.json({
      ok: false,
      error: 'terrain map artifact is not a PNG PMTiles archive',
      expectedPath: filePath,
    }, { status: 415 })
  }

  const tile = await archive.getZxy(coordinates.z, coordinates.x, coordinates.y)
  if (!tile) return emptyRasterDemTileResponse()

  const bytes = tile.data
  return new Response(bytes, {
    headers: {
      'Content-Type': rasterDemContentType,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': tile.cacheControl ?? 'public, max-age=3600',
    },
  })
}

const referenceDatasetArtifactPath = async (
  datasetId: string,
  fileName: string,
  config: ReferenceDatasetArtifactConfig,
): Promise<ReferenceDatasetArtifactResult> => {
  if (!datasetId || !fileName || !datasetIdPattern.test(datasetId) || !pmtilesFilePattern.test(fileName)) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'invalid reference dataset path' }, { status: 400 }),
    }
  }

  const manifest = await loadMapCapabilityManifest({ referenceRoot: config.referenceRoot })
  const tileset = findReferenceTilesets(manifest).find(candidate => candidate.datasetId === datasetId)
  if (!tileset || tileset.artifact.pmtilesPath !== fileName) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'reference dataset not found' }, { status: 404 }),
    }
  }

  const referenceRootRealPath = await realpath(config.referenceRoot)
  const currentDir = resolve(config.referenceRoot, 'releases', datasetId, 'current')
  const currentDirRealPath = await realpath(currentDir)
  if (!isWithin(referenceRootRealPath, currentDirRealPath)) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'invalid reference dataset release path' }, { status: 503 }),
    }
  }

  const filePath = resolve(currentDirRealPath, fileName)
  if (!isWithin(currentDirRealPath, filePath)) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'invalid reference dataset path' }, { status: 400 }),
    }
  }

  // Builds live in builds/<dataset>/<buildId>; a promotion between reading the manifest and
  // resolving the release would otherwise pair one build's id with another build's bytes.
  const releaseBuildId = basename(currentDirRealPath)
  if (releaseBuildId !== tileset.buildId) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'reference dataset release is changing', releaseBuildId, manifestBuildId: tileset.buildId }, { status: 503 }),
    }
  }

  return { ok: true, filePath, buildId: releaseBuildId }
}

export const mapCapabilitiesResponse = async (
  config: MapArtifactConfig = createMapArtifactConfigFromEnv(),
  referenceConfig: ReferenceDatasetArtifactConfig = { referenceRoot: referenceRootFromEnv() },
): Promise<Response> => {
  const manifest = await loadMapCapabilityManifest({
    referenceRoot: referenceConfig.referenceRoot,
    mapRoot: config.rootDir,
  })
  return Response.json(manifest)
}

export const mapStyleResponse = async (theme: string | null = null, config: MapArtifactConfig = createMapArtifactConfigFromEnv()): Promise<Response> => {
  if (theme !== null && theme !== 'light' && theme !== 'dark') {
    return Response.json({ ok: false, error: 'invalid map theme' }, { status: 400 })
  }
  const manifest = await loadMapCapabilityManifest({ mapRoot: config.rootDir, referenceRoot: referenceRootFromEnv() })
  const style = createLeitbildMapStyle((theme ?? 'light') as MapTheme, manifest.tilesets.filter(tileset => tileset.kind === 'base'))
  const glyphFile = Bun.file(glyphProbePath(config))
  // Installed fonts are replaceable artifacts; do not retain an old cached range after installation.
  return Response.json({ ...style, glyphs: style.glyphs + (await glyphFile.exists() ? '?build=' + glyphFile.lastModified : '') })
}

const fileStatus = async (path: string): Promise<MapArtifactFileStatus> => {
  try {
    const info = await stat(path)
    return {
      available: info.isFile() && info.size > 0,
      path,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    }
  } catch (error) {
    return {
      available: false,
      path,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const activeBuild = async (config: MapArtifactConfig): Promise<{
  readonly id: string | null
  readonly error?: string
}> => {
  const currentPath = resolve(config.rootDir, 'current')
  try {
    const info = await lstat(currentPath)
    if (!info.isSymbolicLink()) return { id: null }
    const target = await readlink(currentPath)
    return { id: basename(resolve(config.rootDir, target)) }
  } catch (error) {
    return {
      id: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const createMapArtifactStatus = async (config: MapArtifactConfig): Promise<MapArtifactStatus> => {
  const base = createBaseTileset()
  const currentPmtiles = await fileStatus(currentPmtilesPath(config))
  const terrain = await fileStatus(currentTerrainPmtilesPath(config))
  const sceneryTileset = await fileStatus(currentSceneryTilesetPath(config))
  const glyphProbe = await fileStatus(glyphProbePath(config))
  const active = await activeBuild(config)
  return {
    status: currentPmtiles.available && glyphProbe.available ? 'ready' : 'unavailable',
    rootDir: config.rootDir,
    activeBuildId: active.id,
    ...(active.error ? { activeBuildError: active.error } : {}),
    capabilities: {
      schemaVersion: 2,
      tilesetId: base.id,
      styleUrl: base.artifact.styleUrl,
      tileUrl: base.artifact.currentTileUrl,
    },
    currentPmtiles,
    glyphProbe: {
      ...glyphProbe,
      fontStack: glyphProbeFontStack,
      range: glyphProbeRange,
    },
    terrain: {
      ...terrain,
      tileUrl: '/map/terrain/current.pmtiles',
      tileTemplate: '/map/terrain/current/{z}/{x}/{y}.png',
      tileJsonUrl: '/map/terrain/current/tiles.json',
      demEncoding: 'terrarium',
    },
    scenery: {
      ...sceneryTileset,
      tilesetUrl: '/map/scenery/current/tileset.json',
      tileTemplate: '/map/scenery/current/{recipeId}/{z}/{x}/{y}.glb',
      roadTileTemplate: sceneryRoadTileTemplate,
    },
  }
}

const parseRange = (rangeHeader: string | null, size: number): { readonly start: number; readonly end: number } | null => {
  if (!rangeHeader) return null
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null
  if (rawStart === '') {
    const suffixLength = Number(rawEnd)
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null
    const start = Math.max(0, size - suffixLength)
    return { start, end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

const pmtilesFileResponse = async (
  req: Request,
  filePath: string,
  missing: { readonly error: string; readonly status: number },
): Promise<Response> => {
  const file = Bun.file(filePath)
  if (!await file.exists()) {
    return Response.json({
      ok: false,
      error: missing.error,
      expectedPath: filePath,
    }, { status: missing.status })
  }

  const info = await stat(filePath)
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': pmtilesContentType,
    'Cache-Control': 'public, max-age=3600',
  })
  const range = parseRange(req.headers.get('range'), info.size)
  if (!range) {
    headers.set('Content-Length', String(info.size))
    return new Response(file, { headers })
  }

  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
  headers.set('Content-Length', String(range.end - range.start + 1))
  return new Response(file.slice(range.start, range.end + 1), { status: 206, headers })
}

export const currentPmtilesResponse = async (req: Request, config: MapArtifactConfig): Promise<Response> =>
  pmtilesFileResponse(req, currentPmtilesPath(config), {
    error: 'vector map artifact unavailable',
    status: 503,
  })

export const overviewPmtilesResponse = async (req: Request, config: MapArtifactConfig): Promise<Response> =>
  pmtilesFileResponse(req, overviewPmtilesPathForRoot(config.rootDir), { error: 'World overview artifact unavailable', status: 503 })

export const currentTerrainPmtilesResponse = async (req: Request, config: MapArtifactConfig): Promise<Response> =>
  pmtilesFileResponse(req, currentTerrainPmtilesPath(config), {
    error: 'terrain map artifact unavailable',
    status: 503,
  })

export const currentVectorTileResponse = async (
  req: Request,
  url: URL,
  config: MapArtifactConfig,
): Promise<Response | null> => {
  const overview = url.pathname.startsWith('/map/tiles/overview/')
  const prefix = overview ? '/map/tiles/overview/' : '/map/tiles/current/'
  if (!url.pathname.startsWith(prefix)) return null
  const parts = url.pathname.slice(prefix.length).split('/').map(part => decodeURIComponent(part))
  if (parts.length !== 3) {
    return Response.json({ ok: false, error: 'invalid map tile path' }, { status: 400 })
  }
  const coordinates = parseTileCoordinates(parts[0] ?? '', parts[1] ?? '', parts[2] ?? '', 'mvt')
  if (!coordinates) {
    return Response.json({ ok: false, error: 'invalid map tile coordinates' }, { status: 400 })
  }
  return vectorTileResponse(req, overview ? overviewPmtilesPathForRoot(config.rootDir) : currentPmtilesPath(config), coordinates, {
    error: 'vector map artifact unavailable',
    status: 503,
  })
}

export const currentTerrainTileJsonResponse = async (config: MapArtifactConfig): Promise<Response> => {
  const filePath = currentTerrainPmtilesPath(config)
  const file = Bun.file(filePath)
  if (!await file.exists()) {
    return Response.json({
      ok: false,
      error: 'terrain map artifact unavailable',
      expectedPath: filePath,
    }, { status: 503 })
  }

  const archive = await pmtilesArchiveFor(filePath)
  let header: Awaited<ReturnType<PMTiles['getHeader']>>
  try {
    header = await archive.getHeader()
  } catch (error) {
    return Response.json({
      ok: false,
      error: 'terrain map artifact is not a readable PMTiles archive',
      expectedPath: filePath,
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 415 })
  }
  if (header.tileType !== TileType.Png) {
    return Response.json({
      ok: false,
      error: 'terrain map artifact is not a PNG PMTiles archive',
      expectedPath: filePath,
    }, { status: 415 })
  }

  return Response.json({
    tilejson: '3.0.0',
    name: 'leitbild-terrain-norway',
    scheme: 'xyz',
    tiles: ['/map/terrain/current/{z}/{x}/{y}.png'],
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    center: [header.centerLon, header.centerLat, header.centerZoom],
    encoding: 'terrarium',
    attribution: 'Terrain artifact source: Kartverket DTM preferred, Copernicus DEM GLO-30 fallback.',
  })
}

export const currentTerrainRasterTileResponse = async (
  url: URL,
  config: MapArtifactConfig,
): Promise<Response | null> => {
  const prefix = '/map/terrain/current/'
  if (!url.pathname.startsWith(prefix)) return null
  const parts = url.pathname.slice(prefix.length).split('/').map(part => decodeURIComponent(part))
  if (parts.length !== 3) {
    return Response.json({ ok: false, error: 'invalid terrain tile path' }, { status: 400 })
  }
  const coordinates = parseTileCoordinates(parts[0] ?? '', parts[1] ?? '', parts[2] ?? '', 'png')
  if (!coordinates) {
    return Response.json({ ok: false, error: 'invalid terrain tile coordinates' }, { status: 400 })
  }
  return rasterDemTileResponse(currentTerrainPmtilesPath(config), coordinates, {
    error: 'terrain map artifact unavailable',
    status: 503,
  })
}

export const currentSceneryTilesetResponse = async (
  config: MapArtifactConfig,
): Promise<Response> => {
  const filePath = currentSceneryTilesetPath(config)
  const file = Bun.file(filePath)
  if (!await file.exists()) {
    return Response.json({
      ok: false,
      error: 'precompiled scenery tileset unavailable',
      expectedPath: filePath,
    }, { status: 503 })
  }
  let body: string
  try {
    body = await cachedValidatedJsonText({
      filePath,
      validate: value => { sceneryAssetTilesetSchema.parse(value) },
    })
  } catch (error) {
    return Response.json({
      ok: false,
      error: 'precompiled scenery tileset is invalid',
      expectedPath: filePath,
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 415 })
  }
  return new Response(body, {
    headers: {
      'Content-Type': sceneryTilesetContentType,
      'Cache-Control': 'no-cache',
    },
  })
}

export const currentSceneryTileResponse = async (
  url: URL,
  config: MapArtifactConfig,
): Promise<Response | null> => {
  if (!url.pathname.startsWith(mapSceneryPathPrefix)) return null
  const parts = url.pathname.slice(mapSceneryPathPrefix.length).split('/').map(part => decodeURIComponent(part))
  if (parts.length !== 4) {
    return Response.json({ ok: false, error: 'invalid scenery tile path' }, { status: 400 })
  }
  const [recipeId, zPart, xPart, yPart] = parts
  if (!recipeId || !sceneryRecipeIdPattern.test(recipeId)) {
    return Response.json({ ok: false, error: 'invalid scenery recipe id' }, { status: 400 })
  }
  const extension = yPart?.endsWith('.roads.json') ? 'roads.json' : yPart?.endsWith('.glb') ? 'glb' : null
  if (!extension) {
    return Response.json({ ok: false, error: 'invalid scenery tile extension' }, { status: 400 })
  }
  const coordinates = parseTileCoordinates(zPart ?? '', xPart ?? '', yPart ?? '', extension)
  if (!coordinates) {
    return Response.json({ ok: false, error: 'invalid scenery tile coordinates' }, { status: 400 })
  }
  if (!defaultSceneryRecipes.some(recipe => recipe.id === recipeId)) {
    return Response.json({ ok: false, error: 'unknown scenery recipe' }, { status: 404 })
  }

  const precompiledPath = currentSceneryTilePath(config, recipeId, coordinates, extension)
  const precompiledFile = Bun.file(precompiledPath)
  if (await precompiledFile.exists()) {
    if (extension === 'roads.json') {
      let body: string
      try {
        body = await cachedValidatedJsonText({
          filePath: precompiledPath,
          validate: value => { sceneryRoadTileSchema.parse(value) },
        })
      } catch (error) {
        return Response.json({
          ok: false,
          error: 'precompiled scenery road tile is invalid',
          expectedPath: precompiledPath,
          detail: error instanceof Error ? error.message : String(error),
        }, { status: 415 })
      }
      return new Response(body, {
        headers: {
          'Content-Type': sceneryRoadTileContentType,
          'Cache-Control': 'public, max-age=3600',
        },
      })
    }
    return new Response(precompiledFile, {
      headers: {
        'Content-Type': sceneryTileContentType,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  }

  return Response.json({
    ok: false,
    error: 'precompiled scenery tile unavailable',
    expectedPath: precompiledPath,
  }, { status: 404 })
}

export const referenceDatasetPmtilesResponse = async (
  req: Request,
  url: URL,
  config: ReferenceDatasetArtifactConfig = { referenceRoot: referenceRootFromEnv() },
): Promise<Response | null> => {
  if (!url.pathname.startsWith(mapDatasetPathPrefix)) return null

  const encodedPath = url.pathname.slice(mapDatasetPathPrefix.length)
  const parts = encodedPath.split('/').map(part => decodeURIComponent(part))
  if (parts.length !== 3 || parts[1] !== 'current') {
    return Response.json({ ok: false, error: 'invalid reference dataset path' }, { status: 400 })
  }

  const [datasetId, , fileName] = parts
  const resolved = await referenceDatasetArtifactPath(datasetId ?? '', fileName ?? '', config)
  if (!resolved.ok) return resolved.response

  return pmtilesFileResponse(req, resolved.filePath, {
    error: 'reference dataset artifact unavailable',
    status: 503,
  })
}

export const referenceDatasetVectorTileResponse = async (
  req: Request,
  url: URL,
  config: ReferenceDatasetArtifactConfig = { referenceRoot: referenceRootFromEnv() },
): Promise<Response | null> => {
  if (!url.pathname.startsWith(mapDatasetPathPrefix)) return null

  const encodedPath = url.pathname.slice(mapDatasetPathPrefix.length)
  const parts = encodedPath.split('/').map(part => decodeURIComponent(part))
  if (parts.length !== 6 || parts[1] !== 'current') return null

  const [datasetId, , pmtilesBaseName, zPart, xPart, yPart] = parts
  if (!datasetId || !pmtilesBaseName || !pmtilesBaseNamePattern.test(pmtilesBaseName)) {
    return Response.json({ ok: false, error: 'invalid reference dataset tile path' }, { status: 400 })
  }
  const coordinates = parseTileCoordinates(zPart ?? '', xPart ?? '', yPart ?? '', 'mvt')
  if (!coordinates) {
    return Response.json({ ok: false, error: 'invalid reference dataset tile coordinates' }, { status: 400 })
  }

  const requestedBuildId = url.searchParams.get('build')
  if (requestedBuildId === null || requestedBuildId === '') {
    return Response.json({ ok: false, error: 'reference dataset tile URL needs ?build=<buildId> from /map/capabilities.json' }, { status: 400 })
  }

  const resolved = await referenceDatasetArtifactPath(datasetId, `${pmtilesBaseName}.pmtiles`, config)
  if (!resolved.ok) return resolved.response
  // A client holding an older capabilities manifest must reload it rather than mix builds.
  if (requestedBuildId !== resolved.buildId) {
    return Response.json({
      ok: false,
      error: 'reference dataset build is not the current release',
      requestedBuildId,
      currentBuildId: resolved.buildId,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  return vectorTileResponse(req, resolved.filePath, coordinates, {
    error: 'reference dataset artifact unavailable',
    status: 503,
  }, buildTileCacheControl)
}

export const mapGlyphResponse = async (url: URL, config: MapArtifactConfig): Promise<Response | null> => {
  if (!url.pathname.startsWith(mapFontPathPrefix)) return null

  const encodedPath = url.pathname.slice(mapFontPathPrefix.length)
  const separatorIndex = encodedPath.lastIndexOf('/')
  if (separatorIndex <= 0 || separatorIndex === encodedPath.length - 1) {
    return Response.json({ ok: false, error: 'invalid map glyph path' }, { status: 400 })
  }

  const fontStack = decodeURIComponent(encodedPath.slice(0, separatorIndex))
  const rangeFile = decodeURIComponent(encodedPath.slice(separatorIndex + 1))
  if (!/^\d+-\d+\.pbf$/.test(rangeFile)) {
    return Response.json({ ok: false, error: 'invalid map glyph range' }, { status: 400 })
  }

  const fontsRoot = resolve(config.rootDir, 'fonts')
  const filePath = resolve(fontsRoot, fontStack, rangeFile)
  if (!isWithin(fontsRoot, filePath)) {
    return Response.json({ ok: false, error: 'invalid map glyph path' }, { status: 400 })
  }

  const file = Bun.file(filePath)
  if (!await file.exists()) {
    return Response.json({
      ok: false,
      error: 'map glyph unavailable',
      expectedPath: filePath,
    }, { status: 404 })
  }

  return new Response(file, {
    headers: {
      'Content-Type': glyphContentType,
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
