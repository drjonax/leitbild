import type { AuditBus } from './audit-graph.ts'
import { describeBuses, endpointIdentity, isLine, type AuditContext } from './audit-context.ts'
import { checkStatus, type AuditCheck, type AuditFailure } from './audit-report.ts'
import { createMultigraph, maximumCircuitFlow, type AuditMultigraph } from './graph-metrics.ts'

const lineGraphs = new WeakMap<AuditContext, Map<string, AuditMultigraph>>()

/**
 * Line evidence for corridor paths: 'all' lines, or only 'mapped' lines (not curated, and with no
 * measured end outside its terminal) when asking whether open data alone yields a corridor.
 */
export type CorridorEvidence = 'all' | 'mapped'

/** Lines (not transformers) of one voltage class over all buses. */
const lineGraph = (context: AuditContext, voltageKv: number, evidence: CorridorEvidence): AuditMultigraph => {
  const cache = lineGraphs.get(context) ?? new Map<string, AuditMultigraph>()
  lineGraphs.set(context, cache)
  const key = `${voltageKv}|${evidence}`
  const cached = cache.get(key)
  if (cached) return cached
  const graph = createMultigraph(context.graph.buses.map(bus => bus.id), context.graph.branches
    .filter(branch => isLine(branch)
      && context.sameVoltageClass(branch.nominalKv, voltageKv)
      && (evidence === 'all' || (branch.curationIds.length === 0 && !context.offTerminalBranchIds.has(branch.id))))
    .map(branch => ({ a: branch.fromBusId, b: branch.toBusId, capacity: branch.circuits })))
  cache.set(key, graph)
  return graph
}

/**
 * Circuits between two bus sets along lines of one voltage class, passing only through junction
 * buses: the corridor itself, not a detour through other stations.
 */
export const corridorCircuits = (
  context: AuditContext,
  from: ReadonlyArray<AuditBus>,
  to: ReadonlyArray<AuditBus>,
  voltageKv: number,
  evidence: CorridorEvidence,
): number => maximumCircuitFlow(
  lineGraph(context, voltageKv, evidence),
  new Set(from.map(bus => bus.id)),
  new Set(to.map(bus => bus.id)),
  node => context.busById.get(node)!.kind === 'junction',
)

const stationBuses = (context: AuditContext, stationId: string): ReadonlyArray<AuditBus> =>
  context.busesOfOsmIds(context.stationById.get(stationId)!.osmIds)

const stationName = (context: AuditContext, stationId: string): string => context.stationById.get(stationId)!.name

export const goldenSubstationsCheck = (context: AuditContext): AuditCheck => {
  const failures: AuditFailure[] = []
  let present = 0
  let inMain = 0
  let degreeMet = 0
  for (const entry of context.golden.substations) {
    const name = `${stationName(context, entry.stationId)} ${entry.voltageKv} kV`
    const buses = stationBuses(context, entry.stationId)
    if (buses.length === 0) {
      failures.push({ message: `${name}: station absent from the model`, assetIds: [`golden:${entry.stationId}`] })
      continue
    }
    const busIds = new Set(buses.map(bus => bus.id))
    const level = context.graph.busPerVoltageLevel
      ? buses.filter(bus => context.sameVoltageClass(bus.nominalKv, entry.voltageKv))
      : buses
    const incident = level.flatMap(bus => (context.branchesByBus.get(bus.id) ?? [])
      .filter(branch => isLine(branch) && context.sameVoltageClass(branch.nominalKv, entry.voltageKv))
      .map(branch => context.busById.get(branch.fromBusId === bus.id ? branch.toBusId : branch.fromBusId)!)
      .filter(remote => !busIds.has(remote.id)))
    const hasLevel = context.graph.busPerVoltageLevel
      ? level.length > 0
      : level.some(bus => context.sameVoltageClass(bus.nominalKv, entry.voltageKv)) || incident.length > 0
    if (!hasLevel) {
      failures.push({ message: `${name}: the station has no ${entry.voltageKv} kV level (buses: ${describeBuses(context, buses.map(bus => bus.id))})`, assetIds: buses.map(bus => bus.id) })
      continue
    }
    present += 1
    const levelIds = level.map(bus => bus.id)
    if (level.some(bus => context.mainComponent.has(bus.id))) inMain += 1
    else failures.push({ message: `${name}: not in the main component`, assetIds: levelIds })
    const degree = new Set(incident.map(endpointIdentity)).size
    if (degree >= entry.minDegree) degreeMet += 1
    else failures.push({ message: `${name}: degree ${degree} < expected ${entry.minDegree}`, assetIds: levelIds })
  }
  const total = context.golden.substations.length
  return {
    id: 'golden-substations',
    title: 'Golden substations present at their voltage, in the main component, with their degree',
    status: checkStatus(failures.length > 0, undefined),
    summary: `${present}/${total} present, ${inMain}/${total} in the main component, ${degreeMet}/${total} with their expected degree`,
    metrics: { total, present, inMainComponent: inMain, degreeMet },
    failures,
  }
}

export const goldenCorridorsCheck = (context: AuditContext): AuditCheck => {
  const failures: AuditFailure[] = []
  let connected = 0
  let circuitsMet = 0
  for (const corridor of context.golden.corridors) {
    const from = stationBuses(context, corridor.fromStationId)
    const to = stationBuses(context, corridor.toStationId)
    const name = `${corridor.name} ${corridor.voltageKv} kV`
    const missing = [...(from.length === 0 ? [corridor.fromStationId] : []), ...(to.length === 0 ? [corridor.toStationId] : [])]
    if (missing.length > 0) {
      failures.push({ message: `${name}: station ${missing.map(id => stationName(context, id)).join(' and ')} absent`, assetIds: missing.map(id => `golden:${id}`) })
      continue
    }
    const circuits = corridorCircuits(context, from, to, corridor.voltageKv, 'all')
    const endpoints = [...from, ...to].map(bus => bus.id)
    if (circuits === 0) {
      failures.push({ message: `${name}: no ${corridor.voltageKv} kV path between the stations through junctions only`, assetIds: [`golden:${corridor.id}`, ...endpoints] })
      continue
    }
    connected += 1
    if (circuits >= corridor.minCircuits) circuitsMet += 1
    else failures.push({ message: `${name}: ${circuits} of ${corridor.minCircuits} circuits`, assetIds: [`golden:${corridor.id}`, ...endpoints] })
  }
  const total = context.golden.corridors.length
  return {
    id: 'golden-corridors',
    title: 'Golden corridors as connected paths with their circuits',
    status: checkStatus(failures.length > 0, undefined),
    summary: `${connected}/${total} connected, ${circuitsMet}/${total} with their circuits`,
    metrics: { total, connected, circuitsMet },
    failures,
  }
}

export const goldenExcludedCorridorsCheck = (context: AuditContext): AuditCheck => {
  const failures: AuditFailure[] = []
  for (const corridor of context.golden.excludedCorridors) {
    const from = stationBuses(context, corridor.fromStationId)
    const to = stationBuses(context, corridor.toStationId)
    if (from.length === 0 || to.length === 0) continue
    const circuits = corridorCircuits(context, from, to, corridor.voltageKv, 'all')
    if (circuits === 0) continue
    failures.push({
      message: `${corridor.name}: the model energises ${circuits} circuit${circuits === 1 ? '' : 's'} although ${corridor.reason}`,
      assetIds: [`golden:${corridor.id}`, ...from.map(bus => bus.id), ...to.map(bus => bus.id)],
    })
  }
  const total = context.golden.excludedCorridors.length
  return {
    id: 'golden-excluded-corridors',
    title: 'Corridors that must not be energised (under construction or decommissioned)',
    status: checkStatus(failures.length > 0, undefined),
    summary: `${total - failures.length}/${total} correctly absent`,
    metrics: { total, energised: failures.length },
    failures,
  }
}

export const goldenInterconnectorsCheck = (context: AuditContext): AuditCheck => {
  const failures: AuditFailure[] = []
  let present = 0
  // Entries sharing station, area, kind and voltage (Skagerrak 1–4) need that many links or circuits.
  const groupKey = (entry: typeof context.golden.interconnectors[number]): string => `${entry.stationId}|${entry.neighbourArea}|${entry.kind}|${entry.voltageKv}`
  const groupSize = new Map<string, number>()
  for (const entry of context.golden.interconnectors) groupSize.set(groupKey(entry), (groupSize.get(groupKey(entry)) ?? 0) + 1)
  for (const entry of context.golden.interconnectors) {
    const name = `${entry.name} (${entry.kind.toUpperCase()}, ${entry.neighbourArea})`
    const buses = stationBuses(context, entry.stationId)
    const boundary = context.graph.buses.filter(bus => bus.kind === 'boundary' && bus.externalArea === entry.neighbourArea)
    if (buses.length === 0) {
      failures.push({ message: `${name}: Norwegian station ${stationName(context, entry.stationId)} absent`, assetIds: [`golden:${entry.id}`] })
      continue
    }
    if (boundary.length === 0) {
      failures.push({ message: `${name}: the model has no boundary bus for ${entry.neighbourArea}`, assetIds: [`golden:${entry.id}`] })
      continue
    }
    const stationIds = new Set(buses.map(bus => bus.id))
    const boundaryIds = new Set(boundary.map(bus => bus.id))
    const connections = entry.kind === 'hvdc'
      ? context.graph.hvdcLinks.filter(link => (stationIds.has(link.fromBusId) && boundaryIds.has(link.toBusId)) || (stationIds.has(link.toBusId) && boundaryIds.has(link.fromBusId))).length
      : corridorCircuits(context, buses, boundary, entry.voltageKv, 'all')
    const required = groupSize.get(groupKey(entry))!
    if (connections >= required) {
      present += 1
      continue
    }
    const what = entry.kind === 'hvdc' ? 'HVDC links' : `${entry.voltageKv} kV circuits`
    failures.push({ message: `${name}: ${connections} of ${required} ${what} from ${stationName(context, entry.stationId)} to the ${entry.neighbourArea} boundary`, assetIds: [`golden:${entry.id}`, ...stationIds] })
  }
  const total = context.golden.interconnectors.length
  return {
    id: 'golden-interconnectors',
    title: 'Golden interconnectors as boundary connections or HVDC links',
    status: checkStatus(failures.length > 0, undefined),
    summary: `${present}/${total} present`,
    metrics: { total, present },
    failures,
  }
}
