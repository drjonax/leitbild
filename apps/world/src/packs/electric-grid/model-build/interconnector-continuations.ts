import { z } from 'zod'
import { pointInPolygon } from '../../../reference-data/point-in-polygon.ts'
import type { GridInterconnectorTable } from '../schemas/grid-interconnector.ts'
import { compareText } from '../topology/ids.ts'
import type { TopologyBranch, TopologyHvdcLink } from '../topology/result.ts'
import { haversineKm, type LonLat } from './geo.ts'

// The interconnectors' routes beyond the Norway extract. The extract holds the OSM ways that touch
// Norway, so a cable stops where its next way begins abroad. A pinned Overpass snapshot holds the
// power lines and cables connected to each interconnector's free way end, and the substations along
// them; the build follows the mapped ways from that end to the first station they reach, and the
// map draws the interconnector to it. Presentation only: the model, its boundary buses and every
// electrical value stay as the extract gives them.
//
// A snapshot covers the systems it names. HVDC links are continued: their networks are separate, so
// following shared nodes stays on each cable. AC ties are not yet: following shared nodes from a
// tie's end floods the Swedish 400 kV grid (the query timed out), so ties end where the extract
// does, on land a few km past the border.

export const overpassEndpoint = 'https://overpass-api.de/api/interpreter'
export const continuationSourceId = 'osm:overpass-interconnector-continuations'

/**
 * How far from its free ends a system's continuations are searched, km: an HVDC cable runs on to a
 * converter inland, an AC tie to its station (Varangerbotn – Ivalo crosses 130 km of Finland).
 * A safety bound only: the ways themselves end at stations.
 */
export const continuationReachKm = { hvdc: 250, ac: 200 } as const

/** Transmission ways only: a voltage tag (or one value of a list) of 130 kV or more, so no distribution line joins the flood. */
const transmissionVoltage = '(^|;)(1[3-9][0-9]|[2-9][0-9][0-9])[0-9][0-9][0-9]($|;)'

/** A free way end the snapshot starts from. */
export interface ContinuationSeed {
  readonly interconnectorId: string
  readonly system: 'hvdc' | 'ac'
  readonly nodeId: number
  readonly location: LonLat
  /** The station the interconnector table names abroad (the converter of an HVDC link). */
  readonly terminalName: string
}

const latLon = z.object({ lat: z.number().finite(), lon: z.number().finite() }).strict()
const tags = z.record(z.string(), z.string())
const overpassElementSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('node'), id: z.number().int().positive(), lat: z.number().finite(), lon: z.number().finite(), tags: tags.optional() }).strict(),
  z.object({
    type: z.literal('way'),
    id: z.number().int().positive(),
    bounds: z.object({ minlat: z.number(), minlon: z.number(), maxlat: z.number(), maxlon: z.number() }).strict().optional(),
    nodes: z.array(z.number().int().positive()).min(2),
    geometry: z.array(latLon).min(2),
    tags: tags.optional(),
  }).strict().refine(way => way.nodes.length === way.geometry.length, 'a way needs one geometry point per node'),
  z.object({
    type: z.literal('relation'),
    id: z.number().int().positive(),
    bounds: z.object({ minlat: z.number(), minlon: z.number(), maxlat: z.number(), maxlon: z.number() }).strict().optional(),
    members: z.array(z.object({
      type: z.enum(['node', 'way', 'relation']),
      ref: z.number().int().positive(),
      role: z.string(),
      geometry: z.array(latLon.nullable()).optional(),
      lat: z.number().finite().optional(),
      lon: z.number().finite().optional(),
    }).strict()),
    tags: tags.optional(),
  }).strict(),
])
export type OverpassElement = z.infer<typeof overpassElementSchema>

/** The pinned snapshot: the query, the OSM data time it reflects, and its elements (ODbL). */
export const continuationSnapshotSchema = z.object({
  kind: z.literal('osm-overpass-interconnector-continuations'),
  source: z.object({
    id: z.literal(continuationSourceId),
    endpoint: z.url(),
    query: z.string().min(1),
    /** The OSM data time of the answer (Overpass `osm3s.timestamp_osm_base`). */
    snapshotAt: z.iso.datetime(),
    retrievedAt: z.iso.datetime(),
    licence: z.object({ id: z.literal('osm-odbl-1.0'), attribution: z.string().min(1) }).strict(),
  }).strict(),
  /** The systems whose interconnectors the snapshot continues; the others end where the extract does. */
  systems: z.array(z.enum(['hvdc', 'ac'])).min(1),
  seeds: z.array(z.object({
    interconnectorId: z.string().regex(/^(ac|hvdc):[a-z0-9-]+$/),
    system: z.enum(['hvdc', 'ac']),
    nodeId: z.number().int().positive(),
    location: z.tuple([z.number().finite(), z.number().finite()]),
    terminalName: z.string().min(1),
  }).strict()).min(1),
  elements: z.array(overpassElementSchema),
}).strict()
export type ContinuationSnapshot = z.infer<typeof continuationSnapshotSchema>

/** Each interconnector's free way end, from the topology, with the station the table names abroad. */
export const continuationSeeds = (config: {
  readonly branches: ReadonlyArray<TopologyBranch>
  readonly hvdcLinks: ReadonlyArray<TopologyHvdcLink>
  readonly table: GridInterconnectorTable
}): ReadonlyArray<ContinuationSeed> => {
  const terminalName = (id: string): string => {
    const entry = config.table.links.find(link => link.id === id)
    if (entry === undefined) throw new Error(`interconnector ${id} is not in the interconnector table`)
    return entry.foreignTerminal.name
  }
  const seeds: ContinuationSeed[] = [
    ...config.branches.flatMap(branch => branch.interconnectorId === null || branch.foreignEnd === null ? [] : [{
      interconnectorId: branch.interconnectorId,
      system: 'ac' as const,
      nodeId: Number(branch.foreignEnd.key),
      location: branch.foreignEnd.location,
      terminalName: terminalName(branch.interconnectorId),
    }]),
    ...config.hvdcLinks.map(link => ({
      interconnectorId: link.id,
      system: 'hvdc' as const,
      nodeId: Number(link.foreignEnd.key),
      location: link.foreignEnd.location,
      terminalName: terminalName(link.id),
    })),
  ]
  for (const seed of seeds) {
    if (!Number.isSafeInteger(seed.nodeId) || seed.nodeId <= 0) throw new Error(`${seed.interconnectorId}: free end ${seed.nodeId} is not an OSM node id`)
  }
  return seeds.sort((left, right) => compareText(left.interconnectorId, right.interconnectorId))
}

/**
 * The Overpass query of a snapshot: from each system's free ends, every power line and cable
 * connected through shared nodes within its reach, and the substations within 150 m of their nodes.
 */
export const continuationQuery = (seeds: ReadonlyArray<ContinuationSeed>): string => {
  const flood = (system: 'hvdc' | 'ac'): ReadonlyArray<string> => {
    const ids = [...new Set(seeds.filter(seed => seed.system === system).map(seed => seed.nodeId))].sort((left, right) => left - right)
    if (ids.length === 0) return []
    const reach = continuationReachKm[system] * 1000
    return [
      `node(id:${ids.join(',')})->.${system}Seeds;`,
      `way(bn.${system}Seeds)["power"~"^(cable|line)$"];`,
      `complete { node(w)->.ends; way(bn.ends)["power"~"^(cable|line)$"]["voltage"~"${transmissionVoltage}"](around.${system}Seeds:${reach}); }`,
      `(._;)->.${system}Ways;`,
    ]
  }
  return [
    '[out:json][timeout:180];',
    ...flood('hvdc'),
    ...flood('ac'),
    `(${seeds.some(seed => seed.system === 'hvdc') ? '.hvdcWays;' : ''}${seeds.some(seed => seed.system === 'ac') ? '.acWays;' : ''})->.routes;`,
    'node(w.routes)->.routeNodes;',
    'nwr(around.routeNodes:150)["power"="substation"]->.stations;',
    '(.routes; .stations;);',
    'out body geom qt;',
  ].join('\n')
}

export interface ContinuedRoute {
  readonly interconnectorId: string
  /** From the free end (first point) along the mapped ways to the station, [lon, lat]. */
  readonly path: ReadonlyArray<LonLat>
  readonly osmWayIds: ReadonlyArray<string>
  readonly station: { readonly osmId: string; readonly name: string | null; readonly location: LonLat; readonly namedInTable: boolean }
}

type Ring = ReadonlyArray<LonLat>
interface Station {
  readonly osmId: string
  readonly name: string | null
  readonly rings: ReadonlyArray<Ring>
  readonly point: LonLat | null
  readonly anchor: LonLat
}

const stationRadiusKm = 0.15

/** A binary min-heap of [km, node], ties broken by node id so routes are deterministic. */
const createQueue = () => {
  const items: Array<readonly [number, number]> = []
  const less = (a: readonly [number, number], b: readonly [number, number]): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
  const swap = (i: number, j: number): void => { [items[i], items[j]] = [items[j]!, items[i]!] }
  return {
    push: (km: number, node: number): void => {
      items.push([km, node])
      for (let index = items.length - 1; index > 0 && less(items[index]!, items[(index - 1) >> 1]!); index = (index - 1) >> 1) swap(index, (index - 1) >> 1)
    },
    pop: (): readonly [number, number] | undefined => {
      if (items.length <= 1) return items.pop()
      const top = items[0]!
      items[0] = items.pop()!
      for (let index = 0; ;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < items.length && less(items[left]!, items[smallest]!)) smallest = left
        if (right < items.length && less(items[right]!, items[smallest]!)) smallest = right
        if (smallest === index) break
        swap(index, smallest)
        index = smallest
      }
      return top
    },
  }
}

const ringOf = (geometry: ReadonlyArray<{ readonly lat: number; readonly lon: number } | null>): Ring | null => {
  const points = geometry.filter(point => point !== null).map(point => [point.lon, point.lat] as const)
  if (points.length < 4) return null
  const [first, last] = [points[0]!, points[points.length - 1]!]
  return first[0] === last[0] && first[1] === last[1] ? points : null
}

/** Stations a route can end at: no cable joint (transition) and no distribution substation it merely passes. */
const passedStationKinds = new Set(['transition', 'distribution', 'minor_distribution'])
const transmissionStation = (stationTags: Readonly<Record<string, string>>): boolean => {
  if (passedStationKinds.has(stationTags.substation ?? '')) return false
  const volts = (stationTags.voltage ?? '').split(';').map(Number).filter(Number.isFinite)
  return volts.length === 0 || Math.max(...volts) >= 130_000
}

/** A part of a station mapped without a name (a converter hall) takes the name of a named station of the same site. */
const siteKm = 0.5
const namedSites = (stations: ReadonlyArray<Station>): ReadonlyArray<Station> => stations.map(station => {
  if (station.name !== null) return station
  const site = stations
    .filter(other => other.name !== null && haversineKm(other.anchor, station.anchor) <= siteKm)
    .sort((left, right) => haversineKm(left.anchor, station.anchor) - haversineKm(right.anchor, station.anchor))[0]
  return site === undefined ? station : { ...station, name: site.name }
})

const stationsOf = (elements: ReadonlyArray<OverpassElement>): ReadonlyArray<Station> => elements.flatMap((element): Station[] => {
  if (element.tags?.power !== 'substation' || !transmissionStation(element.tags)) return []
  const name = element.tags.name ?? null
  if (element.type === 'node') return [{ osmId: `node/${element.id}`, name, rings: [], point: [element.lon, element.lat], anchor: [element.lon, element.lat] }]
  const rings = element.type === 'way'
    ? [ringOf(element.geometry)].filter(ring => ring !== null)
    : element.members.flatMap(member => member.type === 'way' && member.role !== 'inner' && member.geometry !== undefined ? [ringOf(member.geometry)].filter(ring => ring !== null) : [])
  if (rings.length === 0) return []
  const points = rings.flat()
  const anchor: LonLat = [points.reduce((sum, point) => sum + point[0], 0) / points.length, points.reduce((sum, point) => sum + point[1], 0) / points.length]
  return [{ osmId: `${element.type}/${element.id}`, name, rings, point: null, anchor }]
})

/** Inside a station's outline; a station mapped as a point holds only a way end within its radius. */
const holds = (station: Station, point: LonLat, wayEnd: boolean): boolean =>
  station.point !== null
    ? wayEnd && haversineKm(station.point, point) <= stationRadiusKm
    : station.rings.some(ring => pointInPolygon(point, { type: 'Polygon', coordinates: [ring] }))

/** Of the stations holding a point, the one the table names, else a named one, else the first. */
const preferredStation = (holding: ReadonlyArray<Station>, terminalName: string): Station | undefined =>
  holding.find(station => nameMatches(station.name, terminalName)) ?? holding.find(station => station.name !== null) ?? holding[0]

const nameMatches = (name: string | null, terminalName: string): boolean => {
  if (name === null) return false
  const wanted = terminalName.toLowerCase().split(/[^\p{L}]+/u).filter(word => word.length >= 4)
  const have = name.toLowerCase()
  return wanted.some(word => have.includes(word))
}

/**
 * Each seed's route from its free end along the snapshot's lines and cables that lie outside the
 * Norway extract to the first station they reach, preferring a station the table names. A seed
 * whose ways reach no station is an error naming it: the drawing never guesses an end.
 */
export const continueInterconnectors = (config: {
  readonly snapshot: ContinuationSnapshot
  /** OSM way ids already in the Norway extract ("way/123"): the routes there are the model's own. */
  readonly extractWayIds: ReadonlySet<string>
}): ReadonlyArray<ContinuedRoute> => {
  const ways = config.snapshot.elements.flatMap(element => element.type === 'way'
    && (element.tags?.power === 'line' || element.tags?.power === 'cable')
    && !config.extractWayIds.has(`way/${element.id}`) ? [element] : [])
    .sort((left, right) => left.id - right.id)
  const stations = namedSites(stationsOf(config.snapshot.elements))
  const location = new Map<number, LonLat>()
  const edges = new Map<number, Array<{ readonly to: number; readonly km: number; readonly wayId: number }>>()
  const connect = (a: number, b: number, km: number, wayId: number): void => {
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const list = edges.get(from)
      if (list === undefined) edges.set(from, [{ to, km, wayId }])
      else list.push({ to, km, wayId })
    }
  }
  for (const way of ways) {
    way.nodes.forEach((nodeId, index) => {
      location.set(nodeId, [way.geometry[index]!.lon, way.geometry[index]!.lat])
      if (index > 0) connect(way.nodes[index - 1]!, nodeId, haversineKm(location.get(way.nodes[index - 1]!)!, location.get(nodeId)!), way.id)
    })
  }
  const stationsAt = new Map<number, ReadonlyArray<Station>>()
  for (const [nodeId, point] of location) {
    const holding = stations.filter(candidate => holds(candidate, point, edges.get(nodeId)!.length === 1))
    if (holding.length > 0) stationsAt.set(nodeId, holding)
  }
  return config.snapshot.seeds.map((seed): ContinuedRoute => {
    // A way of the extract can already end in the station abroad (Ofoten – Ritsem).
    const home = stations.filter(station => holds(station, seed.location, true))
    if (home.length > 0) {
      const station = preferredStation(home, seed.terminalName)!
      return {
        interconnectorId: seed.interconnectorId,
        path: [seed.location],
        osmWayIds: [],
        station: { osmId: station.osmId, name: station.name, location: station.anchor, namedInTable: nameMatches(station.name, seed.terminalName) },
      }
    }
    if (!edges.has(seed.nodeId)) throw new Error(`${seed.interconnectorId}: no mapped line or cable continues from its free end node/${seed.nodeId} in the snapshot`)
    // Shortest paths from the free end over the continuation's ways.
    const distance = new Map<number, number>([[seed.nodeId, 0]])
    const previous = new Map<number, { readonly node: number; readonly wayId: number }>()
    const done = new Set<number>()
    const queue = createQueue()
    queue.push(0, seed.nodeId)
    const reached: Array<{ readonly node: number; readonly km: number; readonly station: Station }> = []
    for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
      const [km, node] = item
      if (done.has(node)) continue
      done.add(node)
      const station = preferredStation(stationsAt.get(node) ?? [], seed.terminalName)
      // A station ends the route: a line ends in it, and the route never runs on through it.
      if (station !== undefined && node !== seed.nodeId) {
        reached.push({ node, km, station })
        continue
      }
      for (const edge of edges.get(node) ?? []) {
        const next = km + edge.km
        if (next < (distance.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          distance.set(edge.to, next)
          previous.set(edge.to, { node, wayId: edge.wayId })
          queue.push(next, edge.to)
        }
      }
    }
    const named = reached.filter(entry => nameMatches(entry.station.name, seed.terminalName))
    const end = named[0] ?? reached[0]
    if (end === undefined) throw new Error(`${seed.interconnectorId}: its mapped ways beyond node/${seed.nodeId} reach no substation in the snapshot`)
    const nodes: number[] = []
    const wayIds = new Set<string>()
    for (let current: number | undefined = end.node; current !== undefined; current = previous.get(current)?.node) {
      nodes.push(current)
      const step = previous.get(current)
      if (step !== undefined) wayIds.add(`way/${step.wayId}`)
    }
    nodes.reverse()
    return {
      interconnectorId: seed.interconnectorId,
      path: nodes.map(node => location.get(node)!),
      osmWayIds: [...wayIds].sort(compareText),
      station: { osmId: end.station.osmId, name: end.station.name, location: end.station.anchor, namedInTable: named.length > 0 },
    }
  })
}
