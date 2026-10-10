#!/usr/bin/env bun
// Per-zoom report of a reference dataset's PMTiles archive, checked against the Pack style that draws it:
// tiles, stored and decoded bytes, the largest tile, features and vertices, features no style layer draws
// at the tile's zoom, non-point features in circle-drawn categories below a given zoom, and the
// geometry/attribute byte split. Exits non-zero when either check finds a feature.
// Usage: bun run scripts/reference/tile-stats.ts <archive.pmtiles> --dataset <id> [--points-below <zoom>] [--json <out.json>]
import { featureFilter } from '@maplibre/maplibre-gl-style-spec'
import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { Compression, bytesToHeader, tileIdToZxy, type Header } from 'pmtiles'
import { worldPacks } from '../../src/app-assembly.ts'
import type { PackReferenceDatasetStyle } from '../../src/core/packs/reference-style.ts'

interface Args {
  readonly archive: string
  readonly dataset: string
  readonly pointsBelow: number | null
  readonly json: string | null
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
  const [archive, ...rest] = argv
  const options = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!
    const value = rest[index + 1]
    if (!['--dataset', '--points-below', '--json'].includes(flag) || value === undefined) {
      throw new Error(`usage: tile-stats.ts <archive.pmtiles> --dataset <id> [--points-below <zoom>] [--json <out.json>] (unexpected "${flag}")`)
    }
    options.set(flag, value)
  }
  const dataset = options.get('--dataset')
  if (archive === undefined || dataset === undefined) throw new Error('tile-stats.ts needs an archive path and --dataset <id>')
  const pointsBelow = options.get('--points-below')
  if (pointsBelow !== undefined && !/^\d+$/.test(pointsBelow)) throw new Error(`--points-below must be a zoom, got "${pointsBelow}"`)
  return { archive, dataset, pointsBelow: pointsBelow === undefined ? null : Number(pointsBelow), json: options.get('--json') ?? null }
}

const styleFor = (datasetId: string): PackReferenceDatasetStyle => {
  const styles = worldPacks.flatMap(pack => pack.presentation.referenceStyles ?? []).filter(style => style.datasetId === datasetId)
  if (styles.length !== 1) throw new Error(`expected one Pack style for dataset ${datasetId}, found ${styles.length}`)
  return styles[0]!
}

// --- PMTiles v3 directory walk ---------------------------------------------

interface StoredTile {
  readonly z: number
  readonly offset: number
  readonly length: number
}

const decompress = (bytes: Uint8Array<ArrayBuffer>, compression: Compression): Uint8Array<ArrayBuffer> => {
  if (compression === Compression.None) return bytes
  if (compression === Compression.Gzip) return Bun.gunzipSync(bytes)
  throw new Error(`unsupported PMTiles compression ${compression}`)
}

const readVarint = (bytes: Uint8Array, position: { index: number }): number => {
  let value = 0
  for (let shift = 0; ; shift += 7) {
    const byte = bytes[position.index++]!
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return value
  }
}

interface DirectoryEntry { tileId: number; runLength: number; length: number; offset: number }

const parseDirectory = (bytes: Uint8Array): ReadonlyArray<DirectoryEntry> => {
  const position = { index: 0 }
  const count = readVarint(bytes, position)
  const entries: DirectoryEntry[] = []
  let tileId = 0
  for (let k = 0; k < count; k++) {
    tileId += readVarint(bytes, position)
    entries.push({ tileId, runLength: 0, length: 0, offset: 0 })
  }
  for (const entry of entries) entry.runLength = readVarint(bytes, position)
  for (const entry of entries) entry.length = readVarint(bytes, position)
  entries.forEach((entry, k) => {
    const value = readVarint(bytes, position)
    entry.offset = value === 0 && k > 0 ? entries[k - 1]!.offset + entries[k - 1]!.length : value - 1
  })
  return entries
}

const listTiles = async (read: (offset: number, length: number) => Promise<Uint8Array<ArrayBuffer>>, header: Header): Promise<ReadonlyArray<StoredTile>> => {
  const tiles: StoredTile[] = []
  const walk = async (offset: number, length: number): Promise<void> => {
    for (const entry of parseDirectory(decompress(await read(offset, length), header.internalCompression))) {
      if (entry.runLength === 0) {
        await walk(header.leafDirectoryOffset + entry.offset, entry.length)
        continue
      }
      for (let run = 0; run < entry.runLength; run++) {
        tiles.push({ z: tileIdToZxy(entry.tileId + run)[0], offset: header.tileDataOffset + entry.offset, length: entry.length })
      }
    }
  }
  await walk(header.rootDirectoryOffset, header.rootDirectoryLength)
  return tiles
}

// --- Per-tile accounting -----------------------------------------------------

interface ByteSplit { geometry: number; attributes: number; other: number }

/** Protobuf bytes of MVT feature geometries versus feature tags plus the layers' key and value tables. */
const byteSplit = (tile: Uint8Array): ByteSplit => {
  const split: ByteSplit = { geometry: 0, attributes: 0, other: 0 }
  const reader = new PbfReader(tile)
  const count = (kind: keyof ByteSplit, from: number): void => { split[kind] += reader.pos - from }
  while (reader.pos < tile.length) {
    const tileTag = reader.readVarint()
    if (tileTag >> 3 !== 3) {
      reader.skip(tileTag)
      continue
    }
    const layerEnd = reader.readVarint() + reader.pos
    while (reader.pos < layerEnd) {
      const start = reader.pos
      const layerTag = reader.readVarint()
      if (layerTag >> 3 !== 2) {
        reader.skip(layerTag)
        count(layerTag >> 3 === 3 || layerTag >> 3 === 4 ? 'attributes' : 'other', start)
        continue
      }
      const featureEnd = reader.readVarint() + reader.pos
      while (reader.pos < featureEnd) {
        const fieldStart = reader.pos
        const featureTag = reader.readVarint()
        reader.skip(featureTag)
        count(featureTag >> 3 === 4 ? 'geometry' : featureTag >> 3 === 2 ? 'attributes' : 'other', fieldStart)
      }
    }
  }
  return split
}

// @mapbox/vector-tile 2 reads integer attribute values through pbf 4's readVarint64, which pbf 5 folds into readVarint(true).
const vectorTileReader = (bytes: Uint8Array): ConstructorParameters<typeof VectorTile>[0] => {
  const reader = new PbfReader(bytes)
  return Object.assign(reader, { readVarint64: () => reader.readVarint(true) }) as unknown as ConstructorParameters<typeof VectorTile>[0]
}

const geometryNames = ['Unknown', 'Point', 'LineString', 'Polygon'] as const

interface ZoomStats {
  tiles: number
  storedBytes: number
  rawBytes: number
  maxStoredBytes: number
  maxRawBytes: number
  maxRawTile: string
  features: number
  maxFeatures: number
  vertices: number
  undrawnFeatures: number
  undrawnVertices: number
  nonPointCircleFeatures: number
  bytes: ByteSplit
  byCategoryGeometry: Record<string, number>
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const style = styleFor(args.dataset)
  const file = Bun.file(args.archive)
  const read = async (offset: number, length: number) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
  const header = bytesToHeader((await read(0, 127)).buffer as ArrayBuffer)
  const layers = style.layersFor({ theme: 'light' }).map(layer => ({ ...layer, test: featureFilter(layer.filter as never) }))
  const circleCategories = style.categories.filter(category =>
    layers.some(layer => layer.type === 'circle' && JSON.stringify(layer.filter).includes(JSON.stringify(category))))
  const drawn = (zoom: number, feature: VectorTileFeature): boolean =>
    layers.some(layer => zoom >= (layer.minzoom ?? 0) && layer.test.filter({ zoom } as never, feature as never))

  const zooms = new Map<number, ZoomStats>()
  for (const stored of await listTiles(read, header)) {
    const storedBytes = await read(stored.offset, stored.length)
    const raw = decompress(storedBytes, header.tileCompression)
    const stats = zooms.get(stored.z) ?? {
      tiles: 0, storedBytes: 0, rawBytes: 0, maxStoredBytes: 0, maxRawBytes: 0, maxRawTile: '', features: 0, maxFeatures: 0, vertices: 0,
      undrawnFeatures: 0, undrawnVertices: 0, nonPointCircleFeatures: 0, bytes: { geometry: 0, attributes: 0, other: 0 }, byCategoryGeometry: {},
    }
    zooms.set(stored.z, stats)
    stats.tiles += 1
    stats.storedBytes += storedBytes.byteLength
    stats.rawBytes += raw.byteLength
    stats.maxStoredBytes = Math.max(stats.maxStoredBytes, storedBytes.byteLength)
    if (raw.byteLength > stats.maxRawBytes) {
      stats.maxRawBytes = raw.byteLength
      stats.maxRawTile = `${stored.z}@${stored.offset}`
    }
    const split = byteSplit(raw)
    stats.bytes.geometry += split.geometry
    stats.bytes.attributes += split.attributes
    stats.bytes.other += split.other
    const layer = new VectorTile(vectorTileReader(raw)).layers[style.outputLayer]
    if (!layer) continue
    stats.features += layer.length
    stats.maxFeatures = Math.max(stats.maxFeatures, layer.length)
    for (let index = 0; index < layer.length; index++) {
      const feature = layer.feature(index)
      const vertices = feature.loadGeometry().reduce((sum, ring) => sum + ring.length, 0)
      const category = String(feature.properties.category)
      const key = `${category}:${geometryNames[feature.type]}`
      stats.byCategoryGeometry[key] = (stats.byCategoryGeometry[key] ?? 0) + 1
      stats.vertices += vertices
      if (!drawn(stored.z, feature)) {
        stats.undrawnFeatures += 1
        stats.undrawnVertices += vertices
      }
      if (args.pointsBelow !== null && stored.z < args.pointsBelow && feature.type !== 1 && circleCategories.includes(category)) {
        stats.nonPointCircleFeatures += 1
      }
    }
  }

  const kb = (bytes: number): string => (bytes / 1024).toFixed(1)
  const percent = (part: number, whole: number): string => whole === 0 ? '0.0' : (100 * part / whole).toFixed(1)
  const rows = [...zooms].sort(([a], [b]) => a - b)
  console.log(`${args.archive}: ${kb(file.size)} KB, z${header.minZoom}–${header.maxZoom}, bounds ${[header.minLon, header.minLat, header.maxLon, header.maxLat].join(',')}`)
  console.log(`circle categories: ${circleCategories.join(', ')}${args.pointsBelow === null ? '' : `; checked for non-points below z${args.pointsBelow}`}`)
  console.log(' z   tiles  storedKB    rawKB  maxStoredKB  maxRawKB  features  maxF  vertices  undrawnF  undrawnV%  nonPointCircle  geom%  attr%')
  for (const [z, stats] of rows) {
    const split = stats.bytes.geometry + stats.bytes.attributes + stats.bytes.other
    console.log([
      String(z).padStart(2), String(stats.tiles).padStart(7), kb(stats.storedBytes).padStart(9), kb(stats.rawBytes).padStart(8),
      kb(stats.maxStoredBytes).padStart(12), kb(stats.maxRawBytes).padStart(9), String(stats.features).padStart(9), String(stats.maxFeatures).padStart(5),
      String(stats.vertices).padStart(9), String(stats.undrawnFeatures).padStart(9), percent(stats.undrawnVertices, stats.vertices).padStart(10),
      String(stats.nonPointCircleFeatures).padStart(15), percent(stats.bytes.geometry, split).padStart(6), percent(stats.bytes.attributes, split).padStart(6),
    ].join(' '))
  }
  for (const [z, stats] of rows.filter(([z]) => z <= header.minZoom + 3)) {
    console.log(`z${z} features by category and geometry: ${JSON.stringify(stats.byCategoryGeometry)}`)
  }
  if (args.json !== null) await Bun.write(args.json, JSON.stringify({ archive: args.archive, archiveBytes: file.size, header, zooms: Object.fromEntries(rows) }, null, 1))

  const undrawn = rows.reduce((sum, [, stats]) => sum + stats.undrawnFeatures, 0)
  const nonPoint = rows.reduce((sum, [, stats]) => sum + stats.nonPointCircleFeatures, 0)
  if (undrawn > 0 || nonPoint > 0) {
    console.error(`FAIL: ${undrawn} tile feature(s) no style layer draws at their zoom; ${nonPoint} non-point feature(s) in circle categories`)
    process.exit(1)
  }
}

await main()
