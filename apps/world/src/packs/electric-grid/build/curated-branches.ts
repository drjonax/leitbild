import type { PriceArea } from '../schemas/grid-ids.ts'
import type { GridCuration, GridCurationCollection } from '../schemas/grid-curation.ts'
import type { GridBranchV2, GridBusV2 } from '../schemas/grid-model.ts'
import { polylineKm } from '../topology/geometry.ts'
import { compareText, stationToken } from '../topology/ids.ts'
import type { TopologyLedgerEntry } from '../topology/ledger.ts'
import { lineParameters } from './electrical.ts'
import { roundSignificant, roundTo, type LonLat } from './geo.ts'
import type { BuildLedger } from './ledger.ts'
import { v2OsmWayIds } from './network.ts'
import { corridorPath } from './paths.ts'
import type { SidecarFeatures } from './sidecar-features.ts'
import { curationSourceId } from './curations.ts'

// add-line and add-terminal curations → curated branches (and the terminal bus an add-terminal
// record gives a plant that open data leaves without one).

export interface CuratedNetwork {
  readonly buses: ReadonlyArray<GridBusV2>
  readonly branches: ReadonlyArray<GridBranchV2>
  readonly paths: ReadonlyMap<string, ReadonlyArray<LonLat>>
}

const slugOf = (feature: GridCuration): string => feature.id

export const curatedNetwork = (config: {
  readonly curations: GridCurationCollection
  readonly buses: ReadonlyArray<GridBusV2>
  /** Station feature ids of each topology station, by station id. */
  readonly stationOfFeature: (featureId: string) => string | undefined
  readonly topologyLedger: ReadonlyArray<TopologyLedgerEntry>
  readonly sidecar: SidecarFeatures
  readonly priceAreaOf: (location: LonLat) => PriceArea
  readonly osmSourceId: string
  readonly ledger: BuildLedger
}): CuratedNetwork => {
  const busById = new Map(config.buses.map(bus => [bus.id, bus]))
  const addedBuses: GridBusV2[] = []
  const branches: GridBranchV2[] = []
  const paths = new Map<string, ReadonlyArray<LonLat>>()
  const fail = (feature: GridCuration, message: string): never => { throw new Error(`${curationSourceId(feature)}: ${message}`) }

  const levelBus = (feature: GridCuration, osmId: string, kv: number, create: boolean): GridBusV2 => {
    const stationId = config.stationOfFeature(osmId)
    if (stationId !== undefined) {
      const bus = busById.get(`bus:${stationId}@${kv}`)
      if (bus !== undefined) return bus
    }
    if (!create) return fail(feature, `${osmId} has no ${kv} kV bus in the model`)
    const anchor = config.sidecar.anchor(osmId) ?? fail(feature, `${osmId} is not a station of the sidecar`)
    const substationId = stationId ?? stationToken(osmId)
    const bus: GridBusV2 = {
      id: `bus:${substationId}@${kv}`,
      label: `${anchor.name ?? osmId} ${kv} kV`,
      kind: anchor.category === 'plant' ? 'plant-terminal' : 'substation',
      substationId,
      nominalKv: kv,
      location: [roundTo(anchor.location[0], 6), roundTo(anchor.location[1], 6)],
      priceArea: config.priceAreaOf(anchor.location),
      provenance: { sources: [config.osmSourceId, curationSourceId(feature)], method: 'curated', confidence: 'medium', note: `terminal level added by ${curationSourceId(feature)}` },
    }
    busById.set(bus.id, bus)
    addedBuses.push(bus)
    return bus
  }

  const branch = (feature: GridCuration, from: GridBusV2, to: GridBusV2, kv: number, path: ReadonlyArray<LonLat>, wayIds: ReadonlyArray<string>, circuits: number, cable: boolean): void => {
    const lengthKm = polylineKm(path)
    const parameters = lineParameters({ nominalKv: kv, lengthKm, cableLengthKm: cable ? lengthKm : 0, circuits })
    const [fromBus, toBus] = [from, to].sort((left, right) => compareText(left.id, right.id)) as [GridBusV2, GridBusV2]
    const id = `branch:curated-${slugOf(feature)}`
    branches.push({
      id,
      label: `${fromBus.label.replace(/ \d+ kV$/, '')} – ${toBus.label.replace(/ \d+ kV$/, '')}`,
      kind: cable ? 'cable' : 'ac_line',
      fromBusId: fromBus.id,
      toBusId: toBus.id,
      nominalKv: kv,
      lengthKm: roundTo(lengthKm, 4),
      circuits,
      ratingMw: parameters.ratingMw,
      emergencyRatingMw: parameters.emergencyRatingMw,
      emergencyDurationSeconds: parameters.emergencyDurationSeconds,
      reactancePu: roundSignificant(parameters.reactancePu, 6),
      resistancePu: roundSignificant(parameters.resistancePu, 6),
      chargingSusceptancePu: roundSignificant(parameters.chargingSusceptancePu, 6),
      osmWayIds: v2OsmWayIds(wayIds),
      provenance: {
        sources: [config.osmSourceId, curationSourceId(feature)],
        method: 'curated',
        confidence: 'medium',
        note: `${feature.properties.reason} Electrical values by rules ${parameters.ruleIds.join(', ')}.`,
      },
    })
    paths.set(id, fromBus.id === from.id ? path : [...path].reverse())
    config.ledger.add({ reason: 'curated-branch-added', elementIds: [id, curationSourceId(feature), ...wayIds], detail: `${feature.properties.kind}: ${from.label} – ${to.label}, ${roundTo(lengthKm, 2)} km` })
  }

  for (const feature of [...config.curations.features].sort((left, right) => compareText(left.id, right.id))) {
    const properties = feature.properties
    if (properties.kind === 'add-line') {
      if (feature.geometry.type !== 'LineString') return fail(feature, 'add-line needs a LineString')
      const from = levelBus(feature, properties.fromSubstationOsmId, properties.voltageKv, false)
      const to = levelBus(feature, properties.toSubstationOsmId, properties.voltageKv, false)
      branch(feature, from, to, properties.voltageKv, feature.geometry.coordinates, properties.targetOsmIds.filter(id => id.startsWith('way/') && config.sidecar.way(id) !== undefined), properties.circuits, false)
    }
    if (properties.kind === 'add-terminal') {
      const dangling = config.topologyLedger.find(entry => entry.reason === 'corridor-dangling' && entry.elementIds.includes(properties.wayOsmId))
        ?? fail(feature, `${properties.wayOsmId} is no longer a dangling corridor; the curation can expire`)
      const wayIds = dangling.elementIds.filter(id => id.startsWith('way/') && config.sidecar.way(id) !== undefined)
      const terminal = levelBus(feature, properties.substationOsmId, properties.voltageKv, true)
      const remote = levelBus(feature, properties.remoteSubstationOsmId, properties.voltageKv, false)
      const ways = wayIds.map(id => config.sidecar.way(id)!)
      const path = corridorPath(ways, remote.location, terminal.location) ?? fail(feature, `the ways of ${properties.wayOsmId} do not chain from ${remote.label} towards ${terminal.label}`)
      branch(feature, remote, terminal, properties.voltageKv, [...path, terminal.location], wayIds, 1, false)
    }
  }
  return { buses: addedBuses, branches, paths }
}
