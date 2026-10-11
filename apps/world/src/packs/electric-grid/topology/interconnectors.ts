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
}

const idPattern = { ac: /^ac:[a-z0-9-]+$/, hvdc: /^hvdc:[a-z0-9-]+$/ }

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
  return {
    ac: prepared.filter(entry => entry.kind === 'ac'),
    hvdc: prepared.filter(entry => entry.kind === 'hvdc'),
    byId: new Map(prepared.map(entry => [entry.id, entry])),
  }
}
