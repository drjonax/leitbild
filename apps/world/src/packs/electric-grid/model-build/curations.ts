import type { GridCuration, GridCurationCollection } from '../schemas/grid-curation.ts'
import type { TopologyCuration, TopologyCurationSet, TopologyInput, TopologyInputFeature, TopologyTransformerInput } from '../topology/input.ts'
import { compareText } from '../topology/ids.ts'
import type { BuildLedger } from './ledger.ts'

// How each curation kind reaches the model build:
//   assert-in-service, add-interconnector-ways → the topology compiler (before matching);
//   exclude-feature, offshore-load             → their target features leave the topology input;
//   add-line, add-terminal                     → curated branches after compilation (curated-branches.ts);
//   attach-via-regional-grid                   → a registered plant's bus (generators.ts);
//   split-plant                                → a registered plant's generators at several stations (generators.ts);
//   attach-load-via-regional-grid              → a municipality's load bus (loads.ts);
//   add-shunt-device                           → the shunt of its bus (network.ts);
//   add-transformer-units                      → transformer units in the topology input, rated (curated-ratings.ts);
//   set-line-rating, set-transformer-rating    → a branch's rating (curated-ratings.ts);
//   set-circuits                               → a line's circuit count before the line rules (curated-circuits.ts);
//   normally-open                              → the line starts open in the Operating Points (normally-open.ts);
//   add-network-equivalent                     → a sub-transmission equivalent branch (network-equivalents.ts);
//   assert-radial, boundary                    → the audit only.

export const curationSourceId = (feature: GridCuration): string => `curation:${feature.id}`

const evidenceText = (feature: GridCuration): ReadonlyArray<string> =>
  feature.properties.evidence.map(entry => `${entry.url} (${entry.ref})`)

export const topologyCurationSet = (collection: GridCurationCollection, sourceId: string): TopologyCurationSet => ({
  sourceId,
  records: collection.features.flatMap((feature): TopologyCuration[] => {
    const properties = feature.properties
    if (properties.kind === 'assert-in-service') {
      return [{ kind: 'assert-in-service', id: curationSourceId(feature), targetOsmIds: properties.targetOsmIds, reason: properties.reason, evidence: evidenceText(feature) }]
    }
    if (properties.kind === 'add-interconnector-ways') {
      return [{
        kind: 'add-interconnector-ways',
        id: curationSourceId(feature),
        interconnectorId: properties.interconnectorId,
        osmWayIds: properties.osmWayIds,
        reason: properties.reason,
        evidence: evidenceText(feature),
      }]
    }
    return []
  }),
})

const featureOsmIds = (feature: TopologyInputFeature): ReadonlyArray<string> =>
  'osmWayIds' in feature && feature.kind !== 'route' ? [feature.featureId, ...feature.osmWayIds] : [feature.featureId]

/** Removes the targets of exclude-feature and offshore-load records from the topology input. */
export const withoutCuratedExclusions = (input: TopologyInput, collection: GridCurationCollection, ledger: BuildLedger): TopologyInput => {
  const owner = new Map<string, GridCuration>()
  for (const feature of collection.features) {
    const kind = feature.properties.kind
    if (kind !== 'exclude-feature' && kind !== 'offshore-load') continue
    for (const target of feature.properties.targetOsmIds) owner.set(target, feature)
  }
  const matched = new Set<string>()
  const features = input.features.filter(feature => {
    const hits = featureOsmIds(feature).filter(id => owner.has(id))
    if (hits.length === 0) return true
    for (const hit of hits) matched.add(hit)
    const curation = owner.get(hits[0]!)!
    ledger.add({
      reason: curation.properties.kind === 'offshore-load' ? 'offshore-supply-explained' : 'excluded-by-curation',
      elementIds: [curationSourceId(curation), feature.featureId],
      detail: `${feature.kind} ${feature.featureId} left out of the topology by ${curationSourceId(curation)}: ${curation.properties.reason}`,
    })
    return false
  })
  for (const [target, curation] of [...owner].sort(([left], [right]) => left.localeCompare(right))) {
    if (matched.has(target)) continue
    throw new Error(`${curationSourceId(curation)}: target ${target} is not in the topology input; update or remove the record`)
  }
  return { ...input, features }
}

/**
 * Adds the units of each add-transformer-units record to the topology input as transformers at the
 * record's point, which must lie in the station: the compiler joins the levels with them as with
 * mapped units, and curated-ratings.ts rates them. A point outside the station leaves the units
 * unmatched, and the rating then finds no transformer and fails the build.
 */
export const withCuratedTransformerUnits = (input: TopologyInput, collection: GridCurationCollection, ledger: BuildLedger): TopologyInput => {
  const units: TopologyTransformerInput[] = []
  for (const feature of [...collection.features].sort((left, right) => compareText(left.id, right.id))) {
    const properties = feature.properties
    if (properties.kind !== 'add-transformer-units') continue
    if (feature.geometry.type !== 'Point') throw new Error(`${curationSourceId(feature)}: add-transformer-units is located by a Point`)
    const location = feature.geometry.coordinates
    for (let unit = 1; unit <= properties.units; unit += 1) {
      units.push({ kind: 'transformer', featureId: `${curationSourceId(feature)}/unit-${unit}`, lifecycle: 'operational', location: [location[0], location[1]], voltagesKv: [properties.highKv, properties.lowKv], ratingMva: null })
    }
    ledger.add({
      reason: 'transformer-units-added',
      elementIds: [curationSourceId(feature), properties.substationOsmId],
      mw: properties.units * properties.unitRatingMva,
      detail: `${properties.units} × ${properties.unitRatingMva} MVA ${properties.highKv}/${properties.lowKv} kV at ${properties.substationOsmId}: ${properties.reason}`,
    })
  }
  return { ...input, features: [...input.features, ...units] }
}
