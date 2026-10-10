import { compareText, corridorBranchId } from './ids.ts'
import type { TopologyLedger } from './ledger.ts'
import type { TopologyBranch, TopologyBus, TopologyProvenance } from './result.ts'

// A junction where c mapped circuits of the section to one station meet exactly c single-circuit
// lines is a shared tower, not a tee: the lines are cut into the station on separate circuits
// (loop-in) or share a multi-circuit section into it, and meet only on the station's busbar. OSM
// draws them through one tower node, which the corridor graph reads as a junction. Each line then
// continues to the station on its own circuit of the section, and the junction disappears. A
// junction on a mapped switching point (busbars outside a station) is a real node and stays.

export const sharedTowerRule = {
  id: 'shared-tower-split',
  source: 'c mapped circuits into one station meeting c single-circuit lines at one tower node are c separate circuits (in-out loop-in or shared double-circuit section); NVE Nettanlegg5 ends such lines at the station',
} as const

const confidenceRank = { high: 2, medium: 1, low: 0 } as const

const weaker = (left: TopologyProvenance['confidence'], right: TopologyProvenance['confidence']): TopologyProvenance['confidence'] =>
  confidenceRank[left] <= confidenceRank[right] ? left : right

const roundKm = (km: number): number => Math.round(km * 10_000) / 10_000

/** The line `leg` (junction – far end) continued over `section` (junction – station) on one circuit. */
const continueToStation = (leg: TopologyBranch, section: TopologyBranch, junction: TopologyBus, busLabel: (busId: string) => string): TopologyBranch => {
  const farEnd = leg.fromBusId === junction.id ? leg.toBusId : leg.fromBusId
  const station = section.fromBusId === junction.id ? section.toBusId : section.fromBusId
  const [fromBusId, toBusId] = [farEnd, station].sort(compareText) as [string, string]
  const osmWayIds = [...new Set([...leg.osmWayIds, ...section.osmWayIds])].sort(compareText)
  const names = [...new Set([...leg.names, ...section.names])].sort(compareText)
  const lengthKm = roundKm(leg.lengthKm! + section.lengthKm!)
  const cableLengthKm = roundKm(leg.cableLengthKm! + section.cableLengthKm!)
  const notes = [leg.provenance.note, section.provenance.note, `continued across shared tower ${junction.vertexKey} into ${busLabel(station)} by rule ${sharedTowerRule.id}`]
    .filter((note): note is string => note !== null)
  return {
    ...leg,
    id: corridorBranchId(leg.nominalKv, osmWayIds, [fromBusId, toBusId]),
    label: names.length > 0 ? names.join(' / ') : `${busLabel(fromBusId)} – ${busLabel(toBusId)}`,
    kind: cableLengthKm > lengthKm / 2 ? 'cable' : 'ac_line',
    fromBusId,
    toBusId,
    lengthKm,
    cableLengthKm,
    circuits: 1,
    voltageSource: leg.voltageSource === 'inherited' || section.voltageSource === 'inherited' ? 'inherited' : 'mapped',
    osmWayIds,
    sourceFeatureIds: [...new Set([...leg.sourceFeatureIds, ...section.sourceFeatureIds])].sort(compareText),
    names,
    parallelSpanGroups: leg.parallelSpanGroups + section.parallelSpanGroups,
    provenance: {
      sources: [...new Set([...leg.provenance.sources, ...section.provenance.sources])],
      method: leg.provenance.method === 'curated' || section.provenance.method === 'curated' ? 'curated' : 'inferred',
      confidence: weaker(weaker(leg.provenance.confidence, section.provenance.confidence), 'medium'),
      note: notes.join('; '),
    },
  }
}

interface SharedTower {
  readonly junction: TopologyBus
  readonly station: string
  readonly sections: ReadonlyArray<TopologyBranch>
  readonly legs: ReadonlyArray<TopologyBranch>
}

const findSharedTower = (
  junction: TopologyBus,
  incident: ReadonlyArray<TopologyBranch>,
  busById: ReadonlyMap<string, TopologyBus>,
): SharedTower | null => {
  if (incident.some(branch => branch.kind === 'transformer' || branch.interconnectorId !== null)) return null
  const otherEnd = (branch: TopologyBranch): string => branch.fromBusId === junction.id ? branch.toBusId : branch.fromBusId
  const stations = [...new Set(incident.map(otherEnd))].filter(busId => {
    const kind = busById.get(busId)!.kind
    return kind === 'substation' || kind === 'plant-terminal'
  }).sort(compareText)
  for (const station of stations) {
    const sections = incident.filter(branch => otherEnd(branch) === station)
    if (sections.some(section => section.circuitsSource === 'inferred')) continue
    const circuits = sections.reduce((sum, section) => sum + section.circuits, 0)
    const legs = incident.filter(branch => otherEnd(branch) !== station)
    if (circuits < 2 || legs.length !== circuits || legs.some(leg => leg.circuits !== 1)) continue
    return { junction, station, sections, legs }
  }
  return null
}

export const splitSharedTowers = (
  buses: ReadonlyArray<TopologyBus>,
  branches: ReadonlyArray<TopologyBranch>,
  isSwitchingPoint: (bus: TopologyBus) => boolean,
  ledger: TopologyLedger,
): { readonly buses: ReadonlyArray<TopologyBus>; readonly branches: ReadonlyArray<TopologyBranch> } => {
  const busById = new Map(buses.map(bus => [bus.id, bus]))
  const current = new Map(branches.map(branch => [branch.id, branch]))
  const removedJunctions = new Set<string>()
  const busLabel = (busId: string): string => busById.get(busId)!.label
  const candidates = buses.filter(bus => bus.kind === 'junction' && !isSwitchingPoint(bus)).sort((left, right) => compareText(left.id, right.id))
  // A split can turn a neighbouring junction into a shared tower, so scan until nothing changes.
  for (let changed = true; changed;) {
    changed = false
    const incident = new Map<string, TopologyBranch[]>()
    for (const branch of current.values()) {
      for (const busId of [branch.fromBusId, branch.toBusId]) incident.set(busId, [...(incident.get(busId) ?? []), branch])
    }
    for (const junction of candidates) {
      if (removedJunctions.has(junction.id)) continue
      const tower = findSharedTower(junction, [...(incident.get(junction.id) ?? [])].sort((left, right) => compareText(left.id, right.id)), busById)
      if (tower === null) continue
      const slots = tower.sections.flatMap(section => Array.from({ length: section.circuits }, () => section))
      const continued = tower.legs.map((leg, index) => continueToStation(leg, slots[index]!, junction, busLabel))
      for (const branch of [...tower.sections, ...tower.legs]) current.delete(branch.id)
      for (const branch of continued) {
        if (current.has(branch.id)) throw new Error(`topology shared towers: branch id collision ${branch.id} at ${junction.id}`)
        current.set(branch.id, branch)
      }
      removedJunctions.add(junction.id)
      ledger.add({
        reason: 'shared-tower-split',
        elementIds: [junction.id, ...tower.sections.flatMap(section => section.osmWayIds), ...tower.legs.flatMap(leg => leg.osmWayIds)],
        voltageKv: junction.nominalKv,
        location: junction.location,
        ...(busById.get(tower.station)!.stationId === null ? {} : { stationId: busById.get(tower.station)!.stationId! }),
        detail: `${tower.legs.length} single-circuit lines meet ${tower.legs.length} circuits into ${busLabel(tower.station)} at tower node ${junction.vertexKey}: each continues to the station on its own circuit (${continued.map(branch => branch.label).join('; ')})`,
      })
      changed = true
      break
    }
  }
  return {
    buses: buses.filter(bus => !removedJunctions.has(bus.id)),
    branches: [...current.values()].sort((left, right) => compareText(left.id, right.id)),
  }
}
