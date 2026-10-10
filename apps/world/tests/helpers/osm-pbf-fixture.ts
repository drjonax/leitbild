import { deflateSync } from 'node:zlib'
import { PbfWriter } from 'pbf'

// Minimal OSM PBF encoder for hand-made test fixtures (https://wiki.openstreetmap.org/wiki/PBF_Format).

type Tags = Readonly<Record<string, string>>

export interface FixtureNode {
  readonly id: number
  readonly lon: number
  readonly lat: number
  readonly tags?: Tags
}

export interface FixtureWay {
  readonly id: number
  readonly refs: ReadonlyArray<number>
  readonly tags?: Tags
}

export interface FixtureRelation {
  readonly id: number
  readonly members: ReadonlyArray<{ readonly type: 'node' | 'way' | 'relation'; readonly ref: number; readonly role?: string }>
  readonly tags?: Tags
}

export interface FixtureOsm {
  readonly replicationTimestamp: Date | null
  readonly nodes: ReadonlyArray<FixtureNode>
  readonly ways?: ReadonlyArray<FixtureWay>
  readonly relations?: ReadonlyArray<FixtureRelation>
}

const GRANULARITY = 100
const MEMBER_TYPE = { node: 0, way: 1, relation: 2 } as const

const deltas = (values: ReadonlyArray<number>): number[] => {
  let previous = 0
  return values.map(value => {
    const delta = value - previous
    previous = value
    return delta
  })
}

const createStringTable = () => {
  const strings = ['']
  const index = new Map<string, number>([['', 0]])
  return {
    strings,
    of: (value: string): number => {
      const existing = index.get(value)
      if (existing !== undefined) return existing
      strings.push(value)
      index.set(value, strings.length - 1)
      return strings.length - 1
    },
  }
}

const encodeHeaderBlock = (fixture: FixtureOsm): Uint8Array => {
  const pbf = new PbfWriter()
  pbf.writeStringField(4, 'OsmSchema-V0.6')
  pbf.writeStringField(4, 'DenseNodes')
  pbf.writeStringField(16, 'leitbild-test-fixture')
  if (fixture.replicationTimestamp) {
    pbf.writeVarintField(32, Math.floor(fixture.replicationTimestamp.getTime() / 1000))
    pbf.writeVarintField(33, 4935)
    pbf.writeStringField(34, 'https://download.geofabrik.de/europe/norway-updates')
  }
  return pbf.finish()
}

const encodePrimitiveBlock = (fixture: FixtureOsm): Uint8Array => {
  const table = createStringTable()
  const nodes = [...fixture.nodes].sort((left, right) => left.id - right.id)
  const keysVals: number[] = []
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node.tags ?? {})) keysVals.push(table.of(key), table.of(value))
    keysVals.push(0)
  }
  const ways = (fixture.ways ?? []).map(way => ({
    id: way.id,
    keys: Object.keys(way.tags ?? {}).map(table.of),
    vals: Object.values(way.tags ?? {}).map(table.of),
    refs: deltas(way.refs),
  }))
  const relations = (fixture.relations ?? []).map(relation => ({
    id: relation.id,
    keys: Object.keys(relation.tags ?? {}).map(table.of),
    vals: Object.values(relation.tags ?? {}).map(table.of),
    roles: relation.members.map(member => table.of(member.role ?? '')),
    memids: deltas(relation.members.map(member => member.ref)),
    types: relation.members.map(member => MEMBER_TYPE[member.type]),
  }))

  const pbf = new PbfWriter()
  pbf.writeMessage(1, (strings: ReadonlyArray<string>, writer) => {
    for (const value of strings) writer.writeBytesField(1, new TextEncoder().encode(value))
  }, table.strings)
  pbf.writeMessage(2, (_unused: null, group) => {
    group.writeMessage(2, (_dense: null, dense) => {
      dense.writePackedSVarint(1, deltas(nodes.map(node => node.id)))
      dense.writePackedSVarint(8, deltas(nodes.map(node => Math.round(node.lat * 1e9 / GRANULARITY))))
      dense.writePackedSVarint(9, deltas(nodes.map(node => Math.round(node.lon * 1e9 / GRANULARITY))))
      dense.writePackedVarint(10, keysVals)
    }, null)
  }, null)
  if (ways.length > 0) {
    pbf.writeMessage(2, (_unused: null, group) => {
      for (const way of ways) {
        group.writeMessage(3, (_way: null, writer) => {
          writer.writeVarintField(1, way.id)
          writer.writePackedVarint(2, way.keys)
          writer.writePackedVarint(3, way.vals)
          writer.writePackedSVarint(8, way.refs)
        }, null)
      }
    }, null)
  }
  if (relations.length > 0) {
    pbf.writeMessage(2, (_unused: null, group) => {
      for (const relation of relations) {
        group.writeMessage(4, (_relation: null, writer) => {
          writer.writeVarintField(1, relation.id)
          writer.writePackedVarint(2, relation.keys)
          writer.writePackedVarint(3, relation.vals)
          writer.writePackedVarint(8, relation.roles)
          writer.writePackedSVarint(9, relation.memids)
          writer.writePackedVarint(10, relation.types)
        }, null)
      }
    }, null)
  }
  pbf.writeVarintField(17, GRANULARITY)
  return pbf.finish()
}

const encodeBlob = (type: string, payload: Uint8Array): Uint8Array => {
  const blob = new PbfWriter()
  blob.writeVarintField(2, payload.byteLength)
  blob.writeBytesField(3, deflateSync(payload))
  const blobBytes = blob.finish()
  const header = new PbfWriter()
  header.writeStringField(1, type)
  header.writeVarintField(3, blobBytes.byteLength)
  const headerBytes = header.finish()
  const out = new Uint8Array(4 + headerBytes.byteLength + blobBytes.byteLength)
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength, false)
  out.set(headerBytes, 4)
  out.set(blobBytes, 4 + headerBytes.byteLength)
  return out
}

export const encodeOsmPbf = (fixture: FixtureOsm): Uint8Array => {
  const header = encodeBlob('OSMHeader', encodeHeaderBlock(fixture))
  const data = encodeBlob('OSMData', encodePrimitiveBlock(fixture))
  const out = new Uint8Array(header.byteLength + data.byteLength)
  out.set(header, 0)
  out.set(data, header.byteLength)
  return out
}

export const writeOsmPbfFixture = async (path: string, fixture: FixtureOsm): Promise<void> => {
  await Bun.write(path, encodeOsmPbf(fixture))
}
