import { open, stat } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { PbfReader } from 'pbf'

// Streaming reader for the OSM PBF format (https://wiki.openstreetmap.org/wiki/PBF_Format).
// Each call reads the whole file once; visitors choose which element kinds are decoded.

export type OsmTags = Readonly<Record<string, string>>
export type OsmElementType = 'node' | 'way' | 'relation'

export interface OsmRelationMember {
  readonly type: OsmElementType
  readonly ref: number
  readonly role: string
}

export interface OsmPbfHeader {
  readonly requiredFeatures: ReadonlyArray<string>
  readonly optionalFeatures: ReadonlyArray<string>
  readonly writingProgram: string | null
  readonly source: string | null
  readonly replicationTimestamp: Date | null
  readonly replicationSequenceNumber: number | null
  readonly replicationBaseUrl: string | null
}

export interface OsmPbfVisitor {
  readonly node?: (id: number, lon: number, lat: number, tags: OsmTags) => void
  /** Location-only node visit; skips tag decoding. Ignored when `node` is set. */
  readonly nodeLocation?: (id: number, lon: number, lat: number) => void
  readonly way?: (id: number, refs: ReadonlyArray<number>, tags: OsmTags) => void
  readonly relation?: (id: number, members: ReadonlyArray<OsmRelationMember>, tags: OsmTags) => void
}

const HEADER_LENGTH_BYTES = 4
// The PBF format caps BlobHeader at 64 KiB and Blob at 32 MiB.
const MAX_BLOB_HEADER_BYTES = 64 * 1024
const MAX_BLOB_BYTES = 32 * 1024 * 1024
// Coordinates are stored in nanodegrees times the block granularity.
const NANODEGREES_PER_DEGREE = 1_000_000_000
const SUPPORTED_REQUIRED_FEATURES: ReadonlySet<string> = new Set(['OsmSchema-V0.6', 'DenseNodes'])
const EMPTY_TAGS: OsmTags = Object.freeze({})

interface BlobHeader {
  readonly type: string
  readonly datasize: number
}

interface BlockContext {
  readonly bytes: Uint8Array
  readonly strings: ReadonlyArray<string>
  readonly granularity: number
  readonly latOffset: number
  readonly lonOffset: number
  readonly groupRanges: ReadonlyArray<readonly [number, number]>
}

const readUInt32BE = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)

const readBlobHeader = (bytes: Uint8Array): BlobHeader =>
  new PbfReader(bytes).readFields((tag, header, field) => {
    if (tag === 1) header.type = field.readString()
    else if (tag === 3) header.datasize = field.readVarint()
    else field.skip(field.type)
  }, { type: '', datasize: -1 })

const inflateBlob = (bytes: Uint8Array): Uint8Array => {
  const blob = new PbfReader(bytes).readFields((tag, payload, field) => {
    if (tag === 1) payload.raw = field.readBytes()
    else if (tag === 2) payload.rawSize = field.readVarint()
    else if (tag === 3) payload.zlib = field.readBytes()
    else if (tag >= 4 && tag <= 7) payload.unsupported = tag
    else field.skip(field.type)
  }, { raw: null, zlib: null, rawSize: -1, unsupported: 0 } as {
    raw: Uint8Array | null
    zlib: Uint8Array | null
    rawSize: number
    unsupported: number
  })
  if (blob.unsupported !== 0) throw new Error(`osm-pbf: unsupported blob compression (Blob field ${blob.unsupported})`)
  if (blob.raw) return blob.raw
  if (!blob.zlib) throw new Error('osm-pbf: blob carries neither raw nor zlib data')
  const inflated = inflateSync(blob.zlib)
  if (blob.rawSize >= 0 && inflated.byteLength !== blob.rawSize) {
    throw new Error(`osm-pbf: inflated blob has ${inflated.byteLength} bytes, header declares ${blob.rawSize}`)
  }
  return inflated
}

const readHeaderBlock = (bytes: Uint8Array): OsmPbfHeader => {
  const header = new PbfReader(bytes).readFields((tag, result, field) => {
    if (tag === 4) result.requiredFeatures.push(field.readString())
    else if (tag === 5) result.optionalFeatures.push(field.readString())
    else if (tag === 16) result.writingProgram = field.readString()
    else if (tag === 17) result.source = field.readString()
    else if (tag === 32) result.replicationTimestampSeconds = field.readVarint(true)
    else if (tag === 33) result.replicationSequenceNumber = field.readVarint(true)
    else if (tag === 34) result.replicationBaseUrl = field.readString()
    else field.skip(field.type)
  }, {
    requiredFeatures: [] as string[],
    optionalFeatures: [] as string[],
    writingProgram: null as string | null,
    source: null as string | null,
    replicationTimestampSeconds: null as number | null,
    replicationSequenceNumber: null as number | null,
    replicationBaseUrl: null as string | null,
  })
  const unsupported = header.requiredFeatures.filter(feature => !SUPPORTED_REQUIRED_FEATURES.has(feature))
  if (unsupported.length > 0) throw new Error(`osm-pbf: unsupported required features ${unsupported.join(', ')}`)
  return {
    requiredFeatures: header.requiredFeatures,
    optionalFeatures: header.optionalFeatures,
    writingProgram: header.writingProgram,
    source: header.source,
    replicationTimestamp: header.replicationTimestampSeconds === null
      ? null
      : new Date(header.replicationTimestampSeconds * 1000),
    replicationSequenceNumber: header.replicationSequenceNumber,
    replicationBaseUrl: header.replicationBaseUrl,
  }
}

const readBlockContext = (bytes: Uint8Array): BlockContext => {
  // Granularity and offsets follow the primitive groups on the wire, so groups are decoded in a second step.
  const context = new PbfReader(bytes).readFields((tag, result, field) => {
    if (tag === 1) {
      result.strings = field.readMessage((stringTag, strings, stringField) => {
        if (stringTag === 1) strings.push(stringField.readString())
        else stringField.skip(stringField.type)
      }, [] as string[])
    } else if (tag === 2) {
      const end = field.readVarint() + field.pos
      result.groupRanges.push([field.pos, end])
      field.pos = end
    } else if (tag === 17) result.granularity = field.readVarint()
    else if (tag === 19) result.latOffset = field.readVarint(true)
    else if (tag === 20) result.lonOffset = field.readVarint(true)
    else field.skip(field.type)
  }, {
    strings: [] as string[],
    groupRanges: [] as Array<readonly [number, number]>,
    granularity: 100,
    latOffset: 0,
    lonOffset: 0,
  })
  return { bytes, ...context }
}

const tagsOf = (
  strings: ReadonlyArray<string>,
  keys: ReadonlyArray<number>,
  vals: ReadonlyArray<number>,
): OsmTags => {
  if (keys.length === 0) return EMPTY_TAGS
  if (keys.length !== vals.length) throw new Error('osm-pbf: element has mismatched tag key/value counts')
  const tags: Record<string, string> = {}
  for (let index = 0; index < keys.length; index += 1) {
    tags[stringAt(strings, keys[index]!)] = stringAt(strings, vals[index]!)
  }
  return tags
}

const stringAt = (strings: ReadonlyArray<string>, index: number): string => {
  const value = strings[index]
  if (value === undefined) throw new Error(`osm-pbf: string table index ${index} out of range`)
  return value
}

const longitudeOf = (context: BlockContext, raw: number): number =>
  (context.lonOffset + context.granularity * raw) / NANODEGREES_PER_DEGREE

const latitudeOf = (context: BlockContext, raw: number): number =>
  (context.latOffset + context.granularity * raw) / NANODEGREES_PER_DEGREE

type NodeVisit = (id: number, lon: number, lat: number, tags: OsmTags) => void

const visitDenseNodes = (context: BlockContext, pbf: PbfReader, visit: NodeVisit, decodeTags: boolean): void => {
  const dense = pbf.readMessage((tag, result, field) => {
    if (tag === 1) field.readPackedSVarint(result.ids)
    else if (tag === 8) field.readPackedSVarint(result.lats)
    else if (tag === 9) field.readPackedSVarint(result.lons)
    else if (tag === 10 && decodeTags) field.readPackedVarint(result.keysVals)
    else field.skip(field.type)
  }, { ids: [] as number[], lats: [] as number[], lons: [] as number[], keysVals: [] as number[] })
  if (dense.lats.length !== dense.ids.length || dense.lons.length !== dense.ids.length) {
    throw new Error('osm-pbf: dense node arrays have different lengths')
  }
  let id = 0
  let lat = 0
  let lon = 0
  let cursor = 0
  for (let index = 0; index < dense.ids.length; index += 1) {
    id += dense.ids[index]!
    lat += dense.lats[index]!
    lon += dense.lons[index]!
    let tags: Record<string, string> | null = null
    while (cursor < dense.keysVals.length) {
      const keyIndex = dense.keysVals[cursor++]!
      if (keyIndex === 0) break
      const valueIndex = dense.keysVals[cursor++]
      if (valueIndex === undefined) throw new Error('osm-pbf: dense node keys_vals ends inside a tag')
      tags ??= {}
      tags[stringAt(context.strings, keyIndex)] = stringAt(context.strings, valueIndex)
    }
    visit(id, longitudeOf(context, lon), latitudeOf(context, lat), tags ?? EMPTY_TAGS)
  }
}

const visitNode = (context: BlockContext, pbf: PbfReader, visit: NodeVisit): void => {
  const node = pbf.readMessage((tag, result, field) => {
    if (tag === 1) result.id = field.readSVarint()
    else if (tag === 2) field.readPackedVarint(result.keys)
    else if (tag === 3) field.readPackedVarint(result.vals)
    else if (tag === 8) result.lat = field.readSVarint()
    else if (tag === 9) result.lon = field.readSVarint()
    else field.skip(field.type)
  }, { id: 0, keys: [] as number[], vals: [] as number[], lat: 0, lon: 0 })
  visit(node.id, longitudeOf(context, node.lon), latitudeOf(context, node.lat), tagsOf(context.strings, node.keys, node.vals))
}

const visitWay = (context: BlockContext, pbf: PbfReader, visit: NonNullable<OsmPbfVisitor['way']>): void => {
  const way = pbf.readMessage((tag, result, field) => {
    if (tag === 1) result.id = field.readVarint(true)
    else if (tag === 2) field.readPackedVarint(result.keys)
    else if (tag === 3) field.readPackedVarint(result.vals)
    else if (tag === 8) field.readPackedSVarint(result.refDeltas)
    else field.skip(field.type)
  }, { id: 0, keys: [] as number[], vals: [] as number[], refDeltas: [] as number[] })
  const refs: number[] = []
  let ref = 0
  for (const delta of way.refDeltas) {
    ref += delta
    refs.push(ref)
  }
  visit(way.id, refs, tagsOf(context.strings, way.keys, way.vals))
}

const memberTypeOf = (raw: number): OsmElementType => {
  if (raw === 0) return 'node'
  if (raw === 1) return 'way'
  if (raw === 2) return 'relation'
  throw new Error(`osm-pbf: unknown relation member type ${raw}`)
}

const visitRelation = (context: BlockContext, pbf: PbfReader, visit: NonNullable<OsmPbfVisitor['relation']>): void => {
  const relation = pbf.readMessage((tag, result, field) => {
    if (tag === 1) result.id = field.readVarint(true)
    else if (tag === 2) field.readPackedVarint(result.keys)
    else if (tag === 3) field.readPackedVarint(result.vals)
    else if (tag === 8) field.readPackedVarint(result.roles)
    else if (tag === 9) field.readPackedSVarint(result.memberDeltas)
    else if (tag === 10) field.readPackedVarint(result.types)
    else field.skip(field.type)
  }, { id: 0, keys: [] as number[], vals: [] as number[], roles: [] as number[], memberDeltas: [] as number[], types: [] as number[] })
  if (relation.roles.length !== relation.memberDeltas.length || relation.types.length !== relation.memberDeltas.length) {
    throw new Error(`osm-pbf: relation ${relation.id} has mismatched member arrays`)
  }
  const members: OsmRelationMember[] = []
  let ref = 0
  for (let index = 0; index < relation.memberDeltas.length; index += 1) {
    ref += relation.memberDeltas[index]!
    members.push({
      type: memberTypeOf(relation.types[index]!),
      ref,
      role: stringAt(context.strings, relation.roles[index]!),
    })
  }
  visit(relation.id, members, tagsOf(context.strings, relation.keys, relation.vals))
}

const nodeVisitOf = (visitor: OsmPbfVisitor): NodeVisit | null => {
  if (visitor.node) return visitor.node
  const location = visitor.nodeLocation
  return location ? (id, lon, lat) => location(id, lon, lat) : null
}

const visitBlock = (bytes: Uint8Array, visitor: OsmPbfVisitor): void => {
  const context = readBlockContext(bytes)
  const nodeVisit = nodeVisitOf(visitor)
  const decodeNodeTags = visitor.node !== undefined
  for (const [start, end] of context.groupRanges) {
    const pbf = new PbfReader(context.bytes)
    pbf.pos = start
    pbf.readFields((tag, _result, field) => {
      if (tag === 1 && nodeVisit) visitNode(context, field, nodeVisit)
      else if (tag === 2 && nodeVisit) visitDenseNodes(context, field, nodeVisit, decodeNodeTags)
      else if (tag === 3 && visitor.way) visitWay(context, field, visitor.way)
      else if (tag === 4 && visitor.relation) visitRelation(context, field, visitor.relation)
      else field.skip(field.type)
    }, null, end)
  }
}

const readExactly = async (
  file: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
): Promise<Uint8Array> => {
  const buffer = new Uint8Array(length)
  const { bytesRead } = await file.read(buffer, 0, length, offset)
  if (bytesRead !== length) throw new Error(`osm-pbf: truncated file at byte ${offset}`)
  return buffer
}

/** Reads every blob of the file in order; returns the validated OSMHeader. */
export const readOsmPbf = async (path: string, visitor: OsmPbfVisitor): Promise<OsmPbfHeader> => {
  const size = (await stat(path)).size
  const file = await open(path, 'r')
  let header: OsmPbfHeader | null = null
  try {
    let offset = 0
    while (offset < size) {
      const headerLength = readUInt32BE(await readExactly(file, offset, HEADER_LENGTH_BYTES))
      offset += HEADER_LENGTH_BYTES
      if (headerLength <= 0 || headerLength > MAX_BLOB_HEADER_BYTES) {
        throw new Error(`osm-pbf: invalid blob header length ${headerLength} at byte ${offset}`)
      }
      const blobHeader = readBlobHeader(await readExactly(file, offset, headerLength))
      offset += headerLength
      if (blobHeader.datasize < 0 || blobHeader.datasize > MAX_BLOB_BYTES) {
        throw new Error(`osm-pbf: invalid blob size ${blobHeader.datasize} at byte ${offset}`)
      }
      const blob = inflateBlob(await readExactly(file, offset, blobHeader.datasize))
      offset += blobHeader.datasize
      if (blobHeader.type === 'OSMHeader') {
        if (header) throw new Error('osm-pbf: file contains more than one OSMHeader blob')
        header = readHeaderBlock(blob)
      } else if (blobHeader.type === 'OSMData') {
        if (!header) throw new Error('osm-pbf: OSMData blob precedes the OSMHeader blob')
        visitBlock(blob, visitor)
      } else {
        throw new Error(`osm-pbf: unknown blob type "${blobHeader.type}"`)
      }
    }
  } finally {
    await file.close()
  }
  if (!header) throw new Error(`osm-pbf: ${path} has no OSMHeader blob`)
  return header
}

/** Reads only the leading OSMHeader blob. */
export const readOsmPbfHeader = async (path: string): Promise<OsmPbfHeader> => {
  const file = await open(path, 'r')
  try {
    const headerLength = readUInt32BE(await readExactly(file, 0, HEADER_LENGTH_BYTES))
    if (headerLength <= 0 || headerLength > MAX_BLOB_HEADER_BYTES) {
      throw new Error(`osm-pbf: invalid blob header length ${headerLength} at byte ${HEADER_LENGTH_BYTES}`)
    }
    const blobHeader = readBlobHeader(await readExactly(file, HEADER_LENGTH_BYTES, headerLength))
    if (blobHeader.type !== 'OSMHeader') throw new Error(`osm-pbf: first blob of ${path} is "${blobHeader.type}", not OSMHeader`)
    if (blobHeader.datasize < 0 || blobHeader.datasize > MAX_BLOB_BYTES) {
      throw new Error(`osm-pbf: invalid OSMHeader blob size ${blobHeader.datasize}`)
    }
    return readHeaderBlock(inflateBlob(await readExactly(file, HEADER_LENGTH_BYTES + headerLength, blobHeader.datasize)))
  } finally {
    await file.close()
  }
}
