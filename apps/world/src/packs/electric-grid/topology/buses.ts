import { compareText, stationBusId } from './ids.ts'
import type { ExternalArea } from './input.ts'
import type { PreparedInterconnector } from './interconnectors.ts'
import type { TopologyLedger } from './ledger.ts'
import type { TopologyBoundary, TopologyBus } from './result.ts'
import type { StationGroup } from './station-groups.ts'
import type { LonLat } from './geometry.ts'

export const stationBuses = (
  groups: ReadonlyArray<StationGroup>,
  levelsOfGroup: ReadonlyMap<string, ReadonlySet<number>>,
  sourceIds: ReadonlyArray<string>,
  ledger: TopologyLedger,
): ReadonlyArray<TopologyBus> => groups.flatMap(group =>
  [...(levelsOfGroup.get(group.id) ?? [])].sort((left, right) => right - left).map((kv): TopologyBus => {
    const untagged = group.taggedVoltagesKv.size > 0 && !group.taggedVoltagesKv.has(kv)
    if (untagged) {
      ledger.add({
        reason: 'station-level-untagged',
        elementIds: group.members.map(member => member.station.featureId),
        voltageKv: kv,
        location: group.location,
        stationId: group.id,
        detail: `${kv} kV corridors terminate at a station tagged ${[...group.taggedVoltagesKv].sort((l, r) => r - l).join('/')} kV`,
      })
    }
    return {
      id: stationBusId(group.id, kv),
      label: `${group.label} ${kv} kV`,
      kind: group.kind === 'substation' ? 'substation' : 'plant-terminal',
      stationId: group.id,
      stationFeatureIds: group.members.map(member => member.station.featureId),
      stationRoles: group.roles,
      vertexKey: null,
      mergedBusIds: [],
      mergedJunctionLocations: [],
      nominalKv: kv,
      location: group.location,
      externalArea: null,
      provenance: {
        sources: [...sourceIds],
        method: untagged ? 'inferred' : 'mapped',
        confidence: untagged ? 'medium' : 'high',
        note: untagged ? 'voltage level taken from terminating corridors; the station is tagged otherwise' : null,
      },
    }
  }))

export type JunctionSeed = { readonly key: string; readonly kv: number; readonly names: ReadonlySet<string> }

export const junctionBuses = (
  junctions: ReadonlyMap<string, JunctionSeed>,
  coordinateOf: (key: string) => LonLat,
  sourceIds: ReadonlyArray<string>,
): ReadonlyArray<TopologyBus> =>
  [...junctions].sort(([left], [right]) => compareText(left, right)).map(([busId, junction]) => {
    const names = [...junction.names].sort(compareText)
    return {
      id: busId,
      label: `Tee ${names.length > 0 ? names.slice(0, 3).join(' / ') : junction.key} ${junction.kv} kV`,
      kind: 'junction',
      stationId: null,
      stationFeatureIds: [],
      stationRoles: [],
      vertexKey: junction.key,
      mergedBusIds: [],
      mergedJunctionLocations: [],
      nominalKv: junction.kv,
      location: coordinateOf(junction.key),
      externalArea: null,
      provenance: { sources: [...sourceIds], method: 'mapped', confidence: 'high', note: 'node shared by three or more corridors' },
    }
  })

export type BoundarySeed = { readonly area: ExternalArea; readonly kind: 'ac' | 'hvdc'; readonly kv: number; readonly entries: ReadonlyArray<PreparedInterconnector> }

export const boundaryBuses = (
  seeds: ReadonlyMap<string, BoundarySeed>,
  foreignEnds: ReadonlyMap<string, LonLat>,
  tableSourceId: string,
): { readonly buses: ReadonlyArray<TopologyBus>; readonly boundaries: ReadonlyArray<TopologyBoundary> } => {
  const buses: TopologyBus[] = []
  const boundaries: TopologyBoundary[] = []
  for (const [busId, seed] of [...seeds].sort(([left], [right]) => compareText(left, right))) {
    const entries = [...seed.entries].sort((left, right) => compareText(left.id, right.id))
    boundaries.push({ busId, externalArea: seed.area, kind: seed.kind, nominalKv: seed.kv, interconnectorIds: entries.map(entry => entry.id) })
    buses.push({
      id: busId,
      label: seed.kind === 'ac' ? `${seed.area} boundary ${seed.kv} kV` : `${seed.area} HVDC boundary`,
      kind: 'boundary',
      stationId: null,
      stationFeatureIds: [],
      stationRoles: [],
      vertexKey: null,
      mergedBusIds: [],
      mergedJunctionLocations: [],
      nominalKv: seed.kv,
      location: foreignEnds.get(entries[0]!.id)!,
      externalArea: seed.area,
      provenance: { sources: [tableSourceId], method: 'curated', confidence: 'high', note: `foreign end of ${entries.map(entry => entry.id).join(', ')}` },
    })
  }
  return { buses, boundaries }
}
