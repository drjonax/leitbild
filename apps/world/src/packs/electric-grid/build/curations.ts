import type { GridCuration, GridCurationCollection } from '../schemas/grid-curation.ts'
import type { TopologyCuration, TopologyCurationSet, TopologyInput, TopologyInputFeature } from '../topology/input.ts'
import type { BuildLedger } from './ledger.ts'

// How each curation kind reaches the model build:
//   assert-in-service, add-interconnector-ways → the topology compiler (before matching);
//   exclude-feature, offshore-load             → their target features leave the topology input;
//   add-line, add-terminal                     → curated branches after compilation (curated-branches.ts);
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
