import { haversineKm, type LonLat } from './geometry.ts'
import { compareText } from './ids.ts'
import type { TopologyInterconnector, TopologyInterconnectorTable } from './input.ts'
import type { TopologyLedger } from './ledger.ts'
import type { StationGroup, StationGroups } from './station-groups.ts'

export type PreparedInterconnector = TopologyInterconnector & {
  readonly normalisedKv: number
  readonly norwegianGroup: StationGroup
}

export type PreparedInterconnectors = {
  readonly ac: ReadonlyArray<PreparedInterconnector>
  readonly hvdc: ReadonlyArray<PreparedInterconnector>
  readonly byId: ReadonlyMap<string, PreparedInterconnector>
  // Stations inside a foreign end radius are foreign: their lines end at the boundary.
  readonly foreignGroupEntry: ReadonlyMap<string, PreparedInterconnector>
  // The AC interconnector at `kv` whose foreign end covers `point`, nearest first.
  readonly acForeignEndAt: (point: LonLat, kv: number) => PreparedInterconnector | null
}

const idPattern = { ac: /^interconnector:[a-z0-9-]+$/, hvdc: /^hvdc:[a-z0-9-]+$/ }

export const prepareInterconnectors = (
  table: TopologyInterconnectorTable,
  groups: StationGroups,
  normaliseKv: (kv: number) => number,
  ledger: TopologyLedger,
): PreparedInterconnectors => {
  const prepared: PreparedInterconnector[] = []
  const seen = new Set<string>()
  for (const entry of [...table.interconnectors].sort((left, right) => compareText(left.id, right.id))) {
    if (seen.has(entry.id)) throw new Error(`topology interconnectors: duplicate id ${entry.id}`)
    seen.add(entry.id)
    if (!idPattern[entry.kind].test(entry.id)) throw new Error(`topology interconnectors: id ${entry.id} does not match the ${entry.kind} id grammar`)
    if (entry.osmWayIds.length === 0) throw new Error(`topology interconnectors: ${entry.id} lists no OSM ways`)
    if (!(entry.foreignEnd.radiusKm > 0)) throw new Error(`topology interconnectors: ${entry.id} needs a positive foreign end radius`)
    const norwegianGroup = groups.groupByFeatureId.get(entry.norwegianStationId)
    if (!norwegianGroup) {
      ledger.add({
        reason: 'interconnector-unmatched',
        elementIds: [entry.id],
        detail: `Norwegian station ${entry.norwegianStationId} is not an operational station in the source`,
      })
      continue
    }
    prepared.push({ ...entry, normalisedKv: normaliseKv(entry.voltageKv), norwegianGroup })
  }

  const foreignGroupEntry = new Map<string, PreparedInterconnector>()
  for (const group of groups.groups) {
    const covering = prepared
      .filter(entry => haversineKm(group.location, entry.foreignEnd.location) <= entry.foreignEnd.radiusKm)
      .sort((left, right) => haversineKm(group.location, left.foreignEnd.location) - haversineKm(group.location, right.foreignEnd.location))
    const entry = covering[0]
    if (!entry) continue
    if (prepared.some(candidate => candidate.norwegianGroup.id === group.id)) {
      throw new Error(`topology interconnectors: foreign end of ${entry.id} covers the Norwegian station ${group.id}`)
    }
    foreignGroupEntry.set(group.id, entry)
    ledger.add({
      reason: 'foreign-station',
      elementIds: group.members.map(member => member.station.featureId),
      location: group.location,
      stationId: group.id,
      detail: `station lies at the foreign end of ${entry.id}; its lines end at the ${entry.externalArea} boundary`,
    })
  }

  const ac = prepared.filter(entry => entry.kind === 'ac')
  return {
    ac,
    hvdc: prepared.filter(entry => entry.kind === 'hvdc'),
    byId: new Map(prepared.map(entry => [entry.id, entry])),
    foreignGroupEntry,
    acForeignEndAt: (point, kv) => ac
      .filter(entry => entry.normalisedKv === kv && haversineKm(point, entry.foreignEnd.location) <= entry.foreignEnd.radiusKm)
      .sort((left, right) => haversineKm(point, left.foreignEnd.location) - haversineKm(point, right.foreignEnd.location) || compareText(left.id, right.id))[0] ?? null,
  }
}
