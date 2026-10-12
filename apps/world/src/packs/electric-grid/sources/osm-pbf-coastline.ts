import { readOsmPbf } from './osm-pbf-reader.ts'

// OSM coastline (natural=coastline ways) of a pinned PBF: the land/sea boundary the load
// attachment uses to tell a station across open water from one on the same shore. Two passes:
// the coastline ways and their node references, then the locations of exactly those nodes.

export const osmCoastlineSourceId = 'osm:pbf-coastline:NO'

export interface OsmCoastline {
  /** Coastline ways in way-id order, each as [lon, lat] vertices in way order. */
  readonly lines: ReadonlyArray<ReadonlyArray<readonly [number, number]>>
  readonly wayCount: number
  readonly nodeCount: number
}

export const extractOsmCoastline = async (path: string): Promise<OsmCoastline> => {
  const ways: Array<{ readonly id: number; readonly refs: ReadonlyArray<number> }> = []
  await readOsmPbf(path, {
    way: (id, refs, tags) => {
      if (tags.natural === 'coastline') ways.push({ id, refs: [...refs] })
    },
  })
  ways.sort((left, right) => left.id - right.id)
  const ids = new Float64Array(ways.reduce((sum, way) => sum + way.refs.length, 0))
  let offset = 0
  for (const way of ways) for (const ref of way.refs) ids[offset++] = ref
  ids.sort()
  let unique = 0
  for (let index = 0; index < ids.length; index += 1) if (index === 0 || ids[index] !== ids[index - 1]) ids[unique++] = ids[index]!
  const nodeIds = ids.subarray(0, unique)
  const lon = new Float64Array(unique).fill(Number.NaN)
  const lat = new Float64Array(unique).fill(Number.NaN)
  // PBF node blocks are sorted by id (osmium output), so one merge pass locates every referenced node.
  let cursor = 0
  let previous = -Infinity
  await readOsmPbf(path, {
    nodeLocation: (id, nodeLon, nodeLat) => {
      if (id < previous) throw new Error(`osm-pbf-coastline: ${path} lists node ${id} after ${previous}; nodes must be sorted by id`)
      previous = id
      while (cursor < unique && nodeIds[cursor]! < id) cursor += 1
      if (cursor < unique && nodeIds[cursor] === id) {
        lon[cursor] = nodeLon
        lat[cursor] = nodeLat
      }
    },
  })
  const indexOf = (id: number): number => {
    let low = 0
    let high = unique - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const value = nodeIds[middle]!
      if (value === id) return middle
      if (value < id) low = middle + 1
      else high = middle - 1
    }
    return -1
  }
  const lines = ways.map(way => way.refs.map((ref): readonly [number, number] => {
    const index = indexOf(ref)
    if (index < 0 || Number.isNaN(lon[index]!)) throw new Error(`osm-pbf-coastline: coastline way ${way.id} references node ${ref}, which ${path} does not contain`)
    return [lon[index]!, lat[index]!]
  }))
  return { lines, wayCount: ways.length, nodeCount: unique }
}
