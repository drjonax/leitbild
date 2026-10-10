import type { LonLat } from './geometry.ts'
import { compareText } from './ids.ts'
import type { TopologyBusbarInput, TopologyLineInput } from './input.ts'
import type { TopologyLedger } from './ledger.ts'
import type { StationGroup, StationGroups } from './station-groups.ts'
import type { StationHit, StationIndex } from './station-index.ts'

// Decides which station a vertex belongs to. A way end inside a station polygon, within the
// polygon buffer, or within the point-station radius is a terminal candidate; every buffer and
// radius use is logged. Busbars and bays only ever connect inside their own station.

export type StationLocation = { readonly group: StationGroup; readonly hit: StationHit }

export type TerminalResolver = {
  readonly coordinateOf: (key: string) => LonLat
  readonly locateKey: (key: string) => StationLocation | null
  readonly busbarGroupOf: (key: string) => StationGroup | null
  readonly groupsAtPoint: (point: LonLat) => ReadonlyArray<StationGroup>
  readonly containingGroups: (point: LonLat) => ReadonlyArray<StationGroup>
  readonly noteTerminal: (key: string, kv: number, location: StationLocation) => void
  readonly flush: () => void
}

export type TerminalResolverInput = {
  readonly lines: ReadonlyArray<TopologyLineInput>
  readonly busbars: ReadonlyArray<TopologyBusbarInput>
  readonly index: StationIndex
  readonly groups: StationGroups
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
  for (const busbar of [...input.busbars].sort((left, right) => compareText(left.featureId, right.featureId))) {
    const located = busbar.vertexKeys.map((key, index) => ({ key, location: locatePoint(busbar.coordinates[index]!, null) }))
    const groups = [...new Set(located.flatMap(entry => entry.location ? [entry.location.group] : []))]
    const elementIds = [busbar.featureId, ...busbar.osmWayIds]
    if (groups.length === 0) {
      ledger.add({ reason: 'busbar-outside-station', elementIds, location: busbar.coordinates[0]!, detail: 'busbar/bay has no vertex in or near a station' })
      continue
    }
    if (groups.length > 1) {
      ledger.add({
        reason: 'busbar-spans-stations',
        elementIds,
        location: busbar.coordinates[0]!,
        detail: `busbar/bay touches stations ${groups.map(group => group.id).sort(compareText).join(', ')}; each vertex joins only the station it lies in`,
      })
      for (const entry of located) if (entry.location && !busbarGroups.has(entry.key)) busbarGroups.set(entry.key, entry.location.group)
      continue
    }
    for (const key of busbar.vertexKeys) if (!busbarGroups.has(key)) busbarGroups.set(key, groups[0]!)
  }

  const notes = new Map<string, { location: StationLocation; kvs: Set<number> }>()
  return {
    coordinateOf,
    locateKey,
    busbarGroupOf: key => busbarGroups.get(key) ?? null,
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
          reason: location.hit.method === 'buffer' ? 'terminal-buffer' : 'terminal-point-radius',
          elementIds: [...(featuresAtKey.get(key) ?? []), location.hit.container.station.featureId],
          voltageKv: levels[levels.length - 1]!,
          location: coordinateOf(key),
          stationId: location.group.id,
          distanceM: location.hit.distanceM,
          detail: `way end ${key} at ${levels.join('/')} kV joined to ${location.group.id} ${location.hit.method === 'buffer' ? 'within the polygon buffer' : 'within the point-station radius'}`,
        })
      }
      notes.clear()
    },
  }
}
