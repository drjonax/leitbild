import type { GridCurationCollection } from '../schemas/grid-curation.ts'
import type { GridBranchV2, GridBusV2 } from '../schemas/grid-model.ts'
import { compareText } from '../topology/ids.ts'
import { curationSourceId } from './curations.ts'
import { networkEquivalentParameters, networkEquivalentRule, type LineRatings } from './electrical.ts'
import { roundSignificant } from './geo.ts'
import type { BuildLedger } from './ledger.ts'

// add-network-equivalent curations → one branch each between two model buses of different voltage,
// standing for sub-transmission below the model's 132 kV floor. Kind transformer (the element
// joins two voltage levels), id branch:curated-<record>, labelled as an equivalent, no OSM ways.

export interface NetworkEquivalent {
  readonly branch: GridBranchV2
  readonly ratings: LineRatings
}

export const networkEquivalents = (config: {
  readonly curations: GridCurationCollection
  readonly buses: ReadonlyArray<GridBusV2>
  readonly stationOfFeature: (featureId: string) => string | undefined
  readonly ledger: BuildLedger
}): ReadonlyArray<NetworkEquivalent> => {
  const busById = new Map(config.buses.map(bus => [bus.id, bus]))
  return [...config.curations.features].sort((left, right) => compareText(left.id, right.id)).flatMap((feature): NetworkEquivalent[] => {
    const properties = feature.properties
    if (properties.kind !== 'add-network-equivalent') return []
    const id = curationSourceId(feature)
    const levelBus = (osmId: string, kv: number): GridBusV2 => {
      const stationId = config.stationOfFeature(osmId)
      if (stationId === undefined) throw new Error(`${id}: ${osmId} is not a station of the topology`)
      const bus = busById.get(`bus:${stationId}@${kv}`)
      if (bus === undefined) throw new Error(`${id}: ${osmId} has no ${kv} kV bus`)
      return bus
    }
    const [high, low] = [levelBus(properties.fromSubstationOsmId, properties.fromKv), levelBus(properties.toSubstationOsmId, properties.toKv)]
      .sort((left, right) => right.nominalKv - left.nominalKv) as [GridBusV2, GridBusV2]
    const parameters = networkEquivalentParameters({ viaKv: properties.viaKv, routeKm: properties.routeKm, circuits: properties.circuits })
    const name = (bus: GridBusV2): string => bus.label.replace(/ \d+ kV$/, '')
    const branch: GridBranchV2 = {
      id: `branch:curated-${feature.id}`,
      label: `Network equivalent (not a mapped line): ${properties.viaKv} kV ${name(high)} – ${name(low)}, ${properties.circuits} × ${properties.routeKm} km`,
      kind: 'transformer',
      fromBusId: high.id,
      toBusId: low.id,
      nominalKv: high.nominalKv,
      circuits: properties.circuits,
      ratingMw: parameters.ratingMw,
      emergencyRatingMw: parameters.emergencyRatingMw,
      emergencyDurationSeconds: parameters.emergencyDurationSeconds,
      reactancePu: roundSignificant(parameters.reactancePu, 6),
      resistancePu: roundSignificant(parameters.resistancePu, 6),
      chargingSusceptancePu: 0,
      tapRatio: 1,
      osmWayIds: [],
      provenance: {
        sources: [id],
        method: 'curated',
        confidence: 'low',
        note: `equivalent of out-of-scope sub-transmission (${properties.viaKv} kV, below the model's 132 kV floor), not a mapped line: ${properties.reason} Impedance and rating by rule ${networkEquivalentRule.id} (${parameters.ruleIds.join(', ')}), with ${parameters.endTransformerMva} MVA transformation at each end.`,
      },
    }
    config.ledger.add({
      reason: 'network-equivalent-added',
      elementIds: [branch.id, id, high.id, low.id],
      mw: parameters.ratingMw,
      detail: `${branch.label}: x ${branch.reactancePu} pu, r ${branch.resistancePu} pu, ${parameters.ratingMw} MW at the reference air`,
    })
    return [{ branch, ratings: parameters.ratings }]
  })
}
