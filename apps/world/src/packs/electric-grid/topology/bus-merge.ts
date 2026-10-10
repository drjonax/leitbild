import { compareText } from './ids.ts'
import type { TopologyLedger, TopologyLedgerReason } from './ledger.ts'
import type { TopologyBranch, TopologyBus, TopologyHvdcLink } from './result.ts'

// Zero-impedance connections join buses: corridors shorter than the threshold (their impedance is
// below what a DC flow can carry stably) and busbars that span two stations of the same voltage.
// The surviving bus is the most specific kind (substation, plant terminal, junction), then the bus
// of the station with the most voltage levels, then the smallest id; it lists every bus it
// absorbed. Boundary buses are never merged.

export type BusTie = {
  readonly a: string
  readonly b: string
  readonly reason: Extract<TopologyLedgerReason, 'short-branch-merged' | 'busbar-tie-merged'>
  readonly elementIds: ReadonlyArray<string>
  readonly voltageKv: number
  readonly detail: string
  readonly removedBranchId: string | null
}

export type MergedNetwork = {
  readonly buses: ReadonlyArray<TopologyBus>
  readonly branches: ReadonlyArray<TopologyBranch>
  readonly hvdcLinks: ReadonlyArray<TopologyHvdcLink>
}

const kindRank: Readonly<Record<TopologyBus['kind'], number>> = { 'substation': 0, 'plant-terminal': 1, 'junction': 2, 'boundary': 3 }

export const shortBranchTies = (branches: ReadonlyArray<TopologyBranch>, buses: ReadonlyMap<string, TopologyBus>, maximumM: number): ReadonlyArray<BusTie> =>
  branches.flatMap(branch => {
    if (branch.kind === 'transformer' || branch.lengthKm === null || branch.lengthKm * 1000 >= maximumM) return []
    if (buses.get(branch.fromBusId)!.kind === 'boundary' || buses.get(branch.toBusId)!.kind === 'boundary') return []
    return [{
      a: branch.fromBusId,
      b: branch.toBusId,
      reason: 'short-branch-merged' as const,
      elementIds: [branch.id, ...branch.osmWayIds],
      voltageKv: branch.nominalKv,
      detail: `${(branch.lengthKm * 1000).toFixed(1)} m ${branch.kind} ${branch.label}`,
      removedBranchId: branch.id,
    }]
  })

export const mergeBuses = (
  buses: ReadonlyMap<string, TopologyBus>,
  branches: ReadonlyArray<TopologyBranch>,
  hvdcLinks: ReadonlyArray<TopologyHvdcLink>,
  ties: ReadonlyArray<BusTie>,
  ledger: TopologyLedger,
): MergedNetwork => {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.has(root)) root = parent.get(root)!
    if (root !== id) parent.set(id, root)
    return root
  }
  // A station with more voltage levels keeps its bus, so its transformers stay inside one station.
  const levelCount = new Map<string, number>()
  for (const bus of buses.values()) if (bus.stationId !== null) levelCount.set(bus.stationId, (levelCount.get(bus.stationId) ?? 0) + 1)
  const levelsOf = (bus: TopologyBus): number => bus.stationId === null ? 0 : levelCount.get(bus.stationId)!
  const better = (left: string, right: string): string => {
    const a = buses.get(left)!
    const b = buses.get(right)!
    const order = kindRank[a.kind] - kindRank[b.kind] || levelsOf(b) - levelsOf(a) || compareText(left, right)
    return order < 0 ? left : right
  }
  for (const tie of ties) {
    const a = find(tie.a)
    const b = find(tie.b)
    if (a === b) continue
    const keep = better(a, b)
    parent.set(keep === a ? b : a, keep)
  }
  const survivorOf = (id: string): string => find(id)

  const removed = new Set(ties.flatMap(tie => tie.removedBranchId ? [tie.removedBranchId] : []))
  for (const tie of ties) {
    ledger.add({
      reason: tie.reason,
      elementIds: tie.elementIds,
      voltageKv: tie.voltageKv,
      detail: `${tie.detail}: ${tie.a} and ${tie.b} join bus ${survivorOf(tie.a)}`,
    })
  }

  const absorbed = new Map<string, TopologyBus[]>()
  for (const bus of buses.values()) {
    const survivor = survivorOf(bus.id)
    if (survivor === bus.id) continue
    const list = absorbed.get(survivor)
    if (list) list.push(bus)
    else absorbed.set(survivor, [bus])
  }
  const mergedBuses: TopologyBus[] = []
  for (const bus of buses.values()) {
    if (survivorOf(bus.id) !== bus.id) continue
    const joined = absorbed.get(bus.id)
    if (!joined) {
      mergedBuses.push(bus)
      continue
    }
    const ids = joined.map(other => other.id).sort(compareText)
    mergedBuses.push({
      ...bus,
      mergedBusIds: ids,
      mergedJunctionLocations: [...bus.mergedJunctionLocations, ...joined.flatMap(other => other.kind === 'junction' ? [other.location, ...other.mergedJunctionLocations] : other.mergedJunctionLocations)]
        .sort((left, right) => left[0] - right[0] || left[1] - right[1]),
      stationFeatureIds: [...new Set([...bus.stationFeatureIds, ...joined.flatMap(other => other.stationFeatureIds)])].sort(compareText),
      stationRoles: [...new Set([...bus.stationRoles, ...joined.flatMap(other => other.stationRoles)])].sort(compareText),
      provenance: { ...bus.provenance, note: [bus.provenance.note, `joined by zero-impedance connections with ${ids.join(', ')}`].filter(note => note !== null).join('; ') },
    })
  }

  const mergedBranches: TopologyBranch[] = []
  for (const branch of branches) {
    if (removed.has(branch.id)) continue
    const fromBusId = survivorOf(branch.fromBusId)
    const toBusId = survivorOf(branch.toBusId)
    if (fromBusId === toBusId) {
      ledger.add({
        reason: 'corridor-self-loop',
        elementIds: [branch.id, ...branch.osmWayIds, ...branch.osmTransformerIds],
        voltageKv: branch.nominalKv,
        detail: `${branch.label} runs in parallel with a zero-impedance connection; both ends joined bus ${fromBusId}`,
      })
      continue
    }
    mergedBranches.push(fromBusId === branch.fromBusId && toBusId === branch.toBusId ? branch : { ...branch, fromBusId, toBusId })
  }
  return {
    buses: mergedBuses.sort((left, right) => compareText(left.id, right.id)),
    branches: mergedBranches.sort((left, right) => compareText(left.id, right.id)),
    hvdcLinks: hvdcLinks.map(link => ({ ...link, fromBusId: survivorOf(link.fromBusId) })),
  }
}
