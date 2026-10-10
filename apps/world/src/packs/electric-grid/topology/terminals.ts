import type { LonLat } from './geometry.ts'
import { compareText } from './ids.ts'
import type { TopologyBusbarInput, TopologyLineInput } from './input.ts'
import type { TopologyLedger } from './ledger.ts'
import type { StationGroup, StationGroups } from './station-groups.ts'
import type { StationHit, StationIndex } from './station-index.ts'

// Decides which station a vertex belongs to. A way end inside a station polygon, within the
// polygon buffer, or within the point-station radius is a terminal candidate; every buffer and
// radius use is logged. Busbars and bays connect inside their own station; busbars and bays
// mapped without any station join the lines that touch them into one switching point.

export type StationLocation = { readonly group: StationGroup; readonly hit: StationHit }

export type SpanningBusbar = { readonly busbar: TopologyBusbarInput; readonly groups: ReadonlyArray<StationGroup> }

export type TerminalResolver = {
  readonly coordinateOf: (key: string) => LonLat
  readonly locateKey: (key: string) => StationLocation | null
  readonly busbarGroupOf: (key: string) => StationGroup | null
  readonly groupsAtPoint: (point: LonLat) => ReadonlyArray<StationGroup>
  readonly containingGroups: (point: LonLat) => ReadonlyArray<StationGroup>
  readonly noteTerminal: (key: string, kv: number, location: StationLocation) => void
  // Busbars and bays touching several stations; each vertex joins only its own station.
  readonly spanningBusbars: ReadonlyArray<SpanningBusbar>
  /**
   * The one vertex key standing for a switching point mapped as busbars or bays outside every
   * station that line vertices touch; null for any other key.
   */
  readonly switchingPointOf: (key: string) => string | null
  readonly flush: () => void
}

export type TerminalResolverInput = {
  readonly lines: ReadonlyArray<TopologyLineInput>
  readonly busbars: ReadonlyArray<TopologyBusbarInput>
  readonly index: StationIndex
  readonly groups: StationGroups
  readonly bufferReviewM: number
}

export const createTerminalResolver = (input: TerminalResolverInput, ledger: TopologyLedger): TerminalResolver => {
  const coordinates = new Map<string, LonLat>()
  const featuresAtKey = new Map<string, Set<string>>()
  for (const line of input.lines) {
    line.vertexKeys.forEach((key, index) => { if (!coordinates.has(key)) coordinates.set(key, line.coordinates[index]!) })
    for (const index of line.terminalVertexIndices) {
      const key = line.vertexKeys[index]!
      const set = featuresAtKey.get(key)
      if (set) set.add(line.featureId)
      else featuresAtKey.set(key, new Set([line.featureId]))
    }
  }
  for (const busbar of input.busbars) {
    busbar.vertexKeys.forEach((key, index) => { if (!coordinates.has(key)) coordinates.set(key, busbar.coordinates[index]!) })
  }
  const coordinateOf = (key: string): LonLat => {
    const coordinate = coordinates.get(key)
    if (!coordinate) throw new Error(`topology terminals: vertex key ${key} has no coordinate`)
    return coordinate
  }

  const cache = new Map<string, StationLocation | null>()
  const locatePoint = (point: LonLat, key: string | null): StationLocation | null => {
    const hits = input.index.locate(point)
    const best = hits[0]
    if (!best) return null
    const group = input.groups.groupOf(best.container)
    const rivals = hits.filter(hit => hit.tier === best.tier && input.groups.groupOf(hit.container).id !== group.id)
    if (key !== null && rivals.length > 0) {
      ledger.add({
        reason: 'ambiguous-container',
        elementIds: [best.container.station.featureId, ...rivals.map(hit => hit.container.station.featureId)],
        location: point,
        stationId: group.id,
        detail: `vertex ${key} lies ${best.method} several stations; chose ${group.id} (${best.method === 'inside' ? 'smallest polygon' : 'nearest'})`,
      })
    }
    return { group, hit: best }
  }
  const locateKey = (key: string): StationLocation | null => {
    if (cache.has(key)) return cache.get(key)!
    const location = locatePoint(coordinateOf(key), key)
    cache.set(key, location)
    return location
  }

  const busbarGroups = new Map<string, StationGroup>()
  const spanningBusbars: SpanningBusbar[] = []
  const freeBusbars: TopologyBusbarInput[] = []
  for (const busbar of [...input.busbars].sort((left, right) => compareText(left.featureId, right.featureId))) {
    const located = busbar.vertexKeys.map((key, index) => ({ key, location: locatePoint(busbar.coordinates[index]!, null) }))
    const groups = [...new Set(located.flatMap(entry => entry.location ? [entry.location.group] : []))]
    const elementIds = [busbar.featureId, ...busbar.osmWayIds]
    if (groups.length === 0) {
      freeBusbars.push(busbar)
      continue
    }
    if (groups.length > 1) {
      spanningBusbars.push({ busbar, groups: [...groups].sort((left, right) => compareText(left.id, right.id)) })
      for (const entry of located) if (entry.location && !busbarGroups.has(entry.key)) busbarGroups.set(entry.key, entry.location.group)
      continue
    }
    for (const key of busbar.vertexKeys) if (!busbarGroups.has(key)) busbarGroups.set(key, groups[0]!)
  }

  const switchingPoints = createSwitchingPoints(freeBusbars, input.lines, ledger)

  const notes = new Map<string, { location: StationLocation; kvs: Set<number> }>()
  return {
    coordinateOf,
    locateKey,
    busbarGroupOf: key => busbarGroups.get(key) ?? null,
    spanningBusbars,
    switchingPointOf: key => switchingPoints.get(key) ?? null,
    groupsAtPoint: point => [...new Set(input.index.locate(point).map(hit => input.groups.groupOf(hit.container)))],
    containingGroups: point => [...new Set(input.index.containing(point).map(container => input.groups.groupOf(container)))],
    noteTerminal: (key, kv, location) => {
      if (location.hit.method === 'inside') return
      const note = notes.get(key)
      if (note) note.kvs.add(kv)
      else notes.set(key, { location, kvs: new Set([kv]) })
    },
    flush: () => {
      for (const [key, { location, kvs }] of notes) {
        const levels = [...kvs].sort((left, right) => left - right)
        ledger.add({
          reason: location.hit.method === 'point-radius'
            ? 'terminal-point-radius'
            : location.hit.distanceM > input.bufferReviewM ? 'terminal-buffer-review' : 'terminal-buffer',
          elementIds: [...(featuresAtKey.get(key) ?? []), location.hit.container.station.featureId],
          voltageKv: levels[levels.length - 1]!,
          location: coordinateOf(key),
          stationId: location.group.id,
          distanceM: location.hit.distanceM,
          detail: `way end ${key} at ${levels.join('/')} kV joined to ${location.group.id} ${location.hit.method === 'point-radius'
            ? 'within the point-station radius'
            : location.hit.distanceM > input.bufferReviewM ? `${location.hit.distanceM.toFixed(1)} m outside its polygon, beyond the ${input.bufferReviewM} m review threshold` : 'within the polygon buffer'}`,
        })
      }
      notes.clear()
    },
  }
}

/**
 * Busbars and bays outside every station form clusters of shared vertices. A cluster that the
 * vertices of two or more lines touch is a switching point (an outdoor switching station mapped
 * without a station outline): every vertex of it maps to its lowest vertex key, so the lines
 * meeting there share one node. Any other cluster joins nothing and is ledgered as dropped.
 */
const createSwitchingPoints = (
  busbars: ReadonlyArray<TopologyBusbarInput>,
  lines: ReadonlyArray<TopologyLineInput>,
  ledger: TopologyLedger,
): ReadonlyMap<string, string> => {
  const parent = new Map<string, string>()
  const find = (key: string): string => {
    let root = key
    while (parent.get(root) !== root) root = parent.get(root)!
    parent.set(key, root)
    return root
  }
  const union = (left: string, right: string): void => {
    const a = find(left)
    const b = find(right)
    if (a === b) return
    if (compareText(a, b) < 0) parent.set(b, a)
    else parent.set(a, b)
  }
  for (const busbar of busbars) for (const key of busbar.vertexKeys) if (!parent.has(key)) parent.set(key, key)
  for (const busbar of busbars) for (const key of busbar.vertexKeys.slice(1)) union(busbar.vertexKeys[0]!, key)
  const linesAtRoot = new Map<string, Set<string>>()
  for (const line of lines) {
    for (const key of line.vertexKeys) {
      if (!parent.has(key)) continue
      const root = find(key)
      const set = linesAtRoot.get(root) ?? new Set<string>()
      set.add(line.featureId)
      linesAtRoot.set(root, set)
    }
  }
  const busbarsAtRoot = new Map<string, TopologyBusbarInput[]>()
  for (const busbar of busbars) {
    const root = find(busbar.vertexKeys[0]!)
    busbarsAtRoot.set(root, [...(busbarsAtRoot.get(root) ?? []), busbar])
  }
  const canonical = new Map<string, string>()
  for (const [root, members] of [...busbarsAtRoot].sort(([left], [right]) => compareText(left, right))) {
    const elementIds = members.flatMap(busbar => [busbar.featureId, ...busbar.osmWayIds])
    const touching = [...(linesAtRoot.get(root) ?? [])].sort(compareText)
    if (touching.length < 2) {
      ledger.add({ reason: 'busbar-outside-station', elementIds: [...elementIds, ...touching], location: members[0]!.coordinates[0]!, detail: `busbar/bay has no vertex in or near a station and touches ${touching.length === 0 ? 'no line' : 'one line only'}` })
      continue
    }
    for (const busbar of members) for (const key of busbar.vertexKeys) canonical.set(key, root)
    const location = members.flatMap(busbar => busbar.vertexKeys.map((key, index) => [key, busbar.coordinates[index]!] as const)).find(([key]) => key === root)![1]
    ledger.add({
      reason: 'switching-point-joined',
      elementIds: [...elementIds, ...touching],
      location,
      detail: `${members.length} busbar/bay way${members.length === 1 ? '' : 's'} outside every station join ${touching.length} lines at one switching point (vertex ${root})`,
    })
  }
  return canonical
}
