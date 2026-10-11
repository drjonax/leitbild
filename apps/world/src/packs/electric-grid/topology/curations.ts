import { compareText } from './ids.ts'
import type { TopologyCurationSet, TopologyInputFeature, TopologyInterconnectorTable } from './input.ts'
import type { TopologyLedger } from './ledger.ts'

export type CurationOutcome = {
  readonly features: ReadonlyArray<TopologyInputFeature>
  readonly interconnectors: TopologyInterconnectorTable
  readonly curationOfFeature: ReadonlyMap<string, string>      // feature id → curation id that put it in service
  readonly curationsOfInterconnector: ReadonlyMap<string, ReadonlyArray<string>>
}

const curationIdPattern = /^curation:[a-z0-9-]+$/
const osmIdPattern = /^(node|way|relation)\/\d+$/
const wayIdPattern = /^way\/\d+$/

const validate = (set: TopologyCurationSet): void => {
  const seen = new Set<string>()
  for (const record of set.records) {
    const fail = (problem: string): never => { throw new Error(`topology curations: ${record.id} ${problem}`) }
    if (!curationIdPattern.test(record.id)) fail('does not match curation:<slug>')
    if (seen.has(record.id)) fail('is listed twice')
    seen.add(record.id)
    if (record.reason.trim().length === 0) fail('has no reason')
    if (record.evidence.length === 0 || record.evidence.some(item => item.trim().length === 0)) fail('has no evidence')
    const targets = record.kind === 'assert-in-service' ? record.targetOsmIds : record.osmWayIds
    const pattern = record.kind === 'assert-in-service' ? osmIdPattern : wayIdPattern
    if (targets.length === 0 || !targets.every(target => pattern.test(target))) fail('names no valid OSM targets')
  }
}

const idsOf = (feature: TopologyInputFeature): ReadonlyArray<string> =>
  'osmWayIds' in feature && feature.kind !== 'route' ? [feature.featureId, ...feature.osmWayIds] : [feature.featureId]

// Applies curation records before compilation; a record never acts beyond its named targets.
export const applyCurations = (
  features: ReadonlyArray<TopologyInputFeature>,
  table: TopologyInterconnectorTable,
  set: TopologyCurationSet,
  ledger: TopologyLedger,
): CurationOutcome => {
  validate(set)
  const records = [...set.records].sort((left, right) => compareText(left.id, right.id))
  const curationOfFeature = new Map<string, string>()
  const byTarget = new Map<string, TopologyInputFeature[]>()
  for (const feature of features) {
    for (const id of idsOf(feature)) {
      const list = byTarget.get(id)
      if (list) list.push(feature)
      else byTarget.set(id, [feature])
    }
  }
  for (const record of records) {
    if (record.kind !== 'assert-in-service') continue
    for (const target of [...new Set(record.targetOsmIds)].sort(compareText)) {
      const matches = byTarget.get(target) ?? []
      const base = { elementIds: [record.id, target, ...matches.map(feature => feature.featureId)] }
      if (matches.length === 0) {
        ledger.add({ ...base, reason: 'curation-target-missing', detail: `${record.id}: ${target} is not in the source` })
        continue
      }
      const stale = matches.filter(feature => feature.lifecycle !== 'operational')
      if (stale.length === 0) {
        ledger.add({ ...base, reason: 'curation-unneeded', detail: `${record.id}: ${target} is already in service in the source; the curation can expire` })
        continue
      }
      for (const feature of stale) curationOfFeature.set(feature.featureId, record.id)
      ledger.add({ ...base, reason: 'curation-applied', detail: `${record.id}: ${target} tagged ${stale.map(feature => feature.lifecycle).join('/')} is treated as in service (${record.reason}; evidence ${record.evidence.join(', ')})` })
    }
  }

  const extraWays = new Map<string, Set<string>>()
  const curationsOfInterconnector = new Map<string, string[]>()
  for (const record of records) {
    if (record.kind !== 'add-interconnector-ways') continue
    const entry = table.interconnectors.find(candidate => candidate.id === record.interconnectorId)
    if (!entry) {
      ledger.add({ elementIds: [record.id, record.interconnectorId], reason: 'curation-target-missing', detail: `${record.id}: interconnector ${record.interconnectorId} is not in the table` })
      continue
    }
    const listed = new Set(entry.osmWayIds)
    const added = record.osmWayIds.filter(wayId => !listed.has(wayId))
    if (added.length === 0) {
      ledger.add({ elementIds: [record.id, record.interconnectorId, ...record.osmWayIds], reason: 'curation-unneeded', detail: `${record.id}: the table already lists every way` })
      continue
    }
    const set = extraWays.get(entry.id) ?? new Set<string>()
    for (const wayId of added) set.add(wayId)
    extraWays.set(entry.id, set)
    curationsOfInterconnector.set(entry.id, [...(curationsOfInterconnector.get(entry.id) ?? []), record.id])
    ledger.add({ elementIds: [record.id, record.interconnectorId, ...added], reason: 'curation-applied', detail: `${record.id}: adds ${added.join(', ')} to ${record.interconnectorId} (${record.reason}; evidence ${record.evidence.join(', ')})` })
  }

  return {
    features: features.map(feature => curationOfFeature.has(feature.featureId) ? { ...feature, lifecycle: 'operational' } : feature),
    interconnectors: {
      ...table,
      interconnectors: table.interconnectors.map(entry => extraWays.has(entry.id)
        ? { ...entry, osmWayIds: [...entry.osmWayIds, ...[...extraWays.get(entry.id)!].sort(compareText)] }
        : entry),
    },
    curationOfFeature,
    curationsOfInterconnector,
  }
}
