import type { GridCuration } from '../schemas/grid-curation.ts'
import { endpointIdentity, isLine, type AuditContext } from './audit-context.ts'
import { checkStatus, type AuditCheck, type AuditFailure, type CurationStatus } from './audit-report.ts'
import { corridorCircuits } from './golden-checks.ts'

/** Backbone voltage floor in kV for the curated-share metric. */
const backboneKv = 300

const referencedCurationIds = (context: AuditContext): ReadonlySet<string> => new Set([
  ...context.graph.buses.flatMap(bus => bus.curationIds),
  ...context.graph.branches.flatMap(branch => branch.curationIds),
  ...context.graph.hvdcLinks.flatMap(link => link.curationIds),
  ...context.graph.generators.flatMap(generator => generator.curationIds),
  ...context.graph.loads.flatMap(load => load.curationIds),
  ...(context.graph.shunts ?? []).flatMap(shunt => shunt.curationIds),
])

const levelBuses = (context: AuditContext, osmId: string, voltageKv: number) => {
  const buses = context.busesOfOsmIds([osmId])
  return context.graph.busPerVoltageLevel ? buses.filter(bus => context.sameVoltageClass(bus.nominalKv, voltageKv)) : buses
}

const neighbourCount = (context: AuditContext, osmId: string, voltageKv: number): number => {
  const buses = levelBuses(context, osmId, voltageKv)
  const own = new Set(buses.map(bus => bus.id))
  const remotes = buses.flatMap(bus => (context.branchesByBus.get(bus.id) ?? [])
    .filter(branch => isLine(branch) && context.sameVoltageClass(branch.nominalKv, voltageKv))
    .map(branch => branch.fromBusId === bus.id ? branch.toBusId : branch.fromBusId)
    .filter(id => !own.has(id))
    .map(id => endpointIdentity(context.busById.get(id)!)))
  return new Set(remotes).size
}

const expiryReasons = (context: AuditContext, curation: GridCuration): ReadonlyArray<string> =>
  curation.properties.expiresWhen.flatMap(condition => {
    switch (condition.kind) {
      case 'review-by':
        return condition.date < context.asOf ? [`review date ${condition.date} has passed (audit as of ${context.asOf})`] : []
      case 'mapped-corridor-present': {
        const from = context.busesOfOsmIds([condition.fromSubstationOsmId])
        const to = context.busesOfOsmIds([condition.toSubstationOsmId])
        if (from.length === 0 || to.length === 0) return []
        return corridorCircuits(context, from, to, condition.voltageKv, 'mapped') > 0
          ? [`open data now maps a ${condition.voltageKv} kV corridor ${condition.fromSubstationOsmId} – ${condition.toSubstationOsmId}`]
          : []
      }
      case 'radial-no-longer': {
        const neighbours = neighbourCount(context, condition.substationOsmId, condition.voltageKv)
        return neighbours >= 2 ? [`${condition.substationOsmId} now has ${neighbours} neighbours at ${condition.voltageKv} kV`] : []
      }
    }
  })

const exclusionViolations = (context: AuditContext, curation: GridCuration): ReadonlyArray<string> => {
  const targets = new Set(curation.properties.targetOsmIds)
  return [
    ...context.graph.buses.filter(bus => bus.substationId !== undefined && targets.has(bus.substationId)).map(bus => `bus ${bus.id}`),
    ...context.graph.branches.filter(branch => branch.osmWayIds.some(id => targets.has(id))).map(branch => `branch ${branch.id}`),
    ...context.graph.hvdcLinks.filter(link => link.osmWayIds.some(id => targets.has(id))).map(link => `HVDC link ${link.id}`),
  ]
}

export const curationStatuses = (context: AuditContext): ReadonlyArray<CurationStatus> => {
  const referenced = referencedCurationIds(context)
  return context.curations.features.map((curation): CurationStatus => {
    const properties = curation.properties
    const expired = expiryReasons(context, curation)
    if (expired.length > 0) return { id: curation.id, kind: properties.kind, status: 'expired', reasons: expired }
    if (properties.kind === 'exclude-feature') {
      const violations = exclusionViolations(context, curation)
      return violations.length > 0
        ? { id: curation.id, kind: properties.kind, status: 'violated', reasons: violations.map(asset => `excluded feature is present as ${asset}`) }
        : { id: curation.id, kind: properties.kind, status: 'applied', reasons: [] }
    }
    if (properties.kind === 'assert-radial') {
      return levelBuses(context, properties.substationOsmId, properties.voltageKv).length > 0
        ? { id: curation.id, kind: properties.kind, status: 'applied', reasons: [] }
        : { id: curation.id, kind: properties.kind, status: 'unused', reasons: [`no ${properties.voltageKv} kV bus of ${properties.substationOsmId} in the model`] }
    }
    return referenced.has(curation.id)
      ? { id: curation.id, kind: properties.kind, status: 'applied', reasons: [] }
      : { id: curation.id, kind: properties.kind, status: 'unused', reasons: ['no model asset references this curation'] }
  })
}

export const curationsCheck = (context: AuditContext, statuses: ReadonlyArray<CurationStatus>): AuditCheck => {
  const thresholds = context.golden.thresholds
  const known = new Set(context.curations.features.map(curation => curation.id))
  const failures: AuditFailure[] = statuses.filter(status => status.status !== 'applied').map(status => ({
    message: `curation ${status.id} (${status.kind}) is ${status.status}: ${status.reasons.join('; ')}`,
    assetIds: [`curation:${status.id}`],
  }))
  const assetsByUnknown = new Map<string, string[]>()
  for (const asset of [...context.graph.buses, ...context.graph.branches, ...context.graph.hvdcLinks, ...context.graph.generators, ...context.graph.loads]) {
    for (const id of asset.curationIds) {
      if (known.has(id)) continue
      const list = assetsByUnknown.get(id)
      if (list) list.push(asset.id)
      else assetsByUnknown.set(id, [asset.id])
    }
  }
  for (const [id, assets] of assetsByUnknown) failures.push({ message: `model assets reference unknown curation ${id}`, assetIds: assets })
  const backboneLines = context.graph.branches.filter(branch => isLine(branch) && branch.nominalKv >= backboneKv)
  const withoutLength = backboneLines.filter(branch => branch.lengthKm === undefined)
  const lengths = backboneLines.flatMap(branch => branch.lengthKm === undefined ? [] : [{ km: branch.lengthKm, curated: branch.curationIds.length > 0 }])
  const totalKm = lengths.reduce((sum, entry) => sum + entry.km, 0)
  const curatedKm = lengths.filter(entry => entry.curated).reduce((sum, entry) => sum + entry.km, 0)
  const curatedShare = totalKm === 0 ? 0 : curatedKm / totalKm
  if (curatedShare > thresholds.maxCuratedShare300kv) {
    failures.push({ message: `curated share of ≥300 kV line length ${(curatedShare * 100).toFixed(2)} % > ${(thresholds.maxCuratedShare300kv * 100).toFixed(2)} %`, assetIds: backboneLines.filter(branch => branch.curationIds.length > 0).map(branch => branch.id) })
  }
  const unmeasured = withoutLength.length > 0
    ? `${withoutLength.length} ≥300 kV lines have no length (${withoutLength.map(branch => branch.id).join(', ')})`
    : undefined
  const count = (kind: CurationStatus['status']): number => statuses.filter(status => status.status === kind).length
  return {
    id: 'curations',
    title: 'Curated corrections applied, unexpired, and within the curated-length budget',
    status: checkStatus(failures.length > 0, unmeasured),
    summary: `${count('applied')}/${statuses.length} applied, ${count('unused')} unused, ${count('expired')} expired, ${count('violated')} violated; curated ≥300 kV length ${(curatedShare * 100).toFixed(2)} % (max ${(thresholds.maxCuratedShare300kv * 100).toFixed(2)} %)`,
    metrics: {
      total: statuses.length,
      applied: count('applied'),
      unused: count('unused'),
      expired: count('expired'),
      violated: count('violated'),
      curatedKm300kv: curatedKm,
      curatedShare300kv: curatedShare,
    },
    failures,
    ...(unmeasured === undefined ? {} : { unmeasured }),
  }
}
