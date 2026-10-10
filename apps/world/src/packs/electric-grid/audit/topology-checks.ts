import type { AuditBranch, AuditBus } from './audit-graph.ts'
import { describeBuses, isLine, isMappedLine, type AuditContext } from './audit-context.ts'
import { checkStatus, type AuditCheck, type AuditFailure } from './audit-report.ts'
import { bridgesAndArticulationPoints, connectedComponents, createMultigraph } from './graph-metrics.ts'

/** Backbone voltage floor in kV: Statnett's 300 kV and 420 kV transmission levels. */
const backboneKv = 300
/** Regional transmission floor in kV for the ≥132 kV connectivity share. */
const regionalKv = 132

const ratio = (part: number, whole: number): number => whole === 0 ? 0 : part / whole
const formatShare = (value: number): string => `${(value * 100).toFixed(1)} %`

export const componentsCheck = (context: AuditContext): AuditCheck => {
  const thresholds = context.golden.thresholds
  const buses = context.graph.buses.filter(bus => bus.kind !== 'boundary')
  const inMain = (bus: AuditBus): boolean => context.mainComponent.has(bus.id)
  const share = (minimumKv: number) => {
    const eligible = buses.filter(bus => bus.nominalKv >= minimumKv)
    return { eligible, outside: eligible.filter(bus => !inMain(bus)), value: ratio(eligible.filter(inMain).length, eligible.length) }
  }
  const backbone = share(backboneKv)
  const regional = share(regionalKv)
  const totalLoad = context.graph.loads.reduce((sum, load) => sum + load.demandMw, 0)
  const mainLoad = context.graph.loads.filter(load => context.mainComponent.has(load.busId)).reduce((sum, load) => sum + load.demandMw, 0)
  const loadShare = ratio(mainLoad, totalLoad)
  const failures: AuditFailure[] = context.acComponents.slice(1).map((component, index) => ({
    message: `component ${index + 2} (${component.length} buses) is separated from the main component: ${describeBuses(context, component)}`,
    assetIds: component,
  }))
  const shareFailure = (label: string, value: number, minimum: number, outside: ReadonlyArray<AuditBus>): void => {
    if (value < minimum) failures.push({ message: `${label} in the main component ${formatShare(value)} < ${formatShare(minimum)}`, assetIds: outside.map(bus => bus.id) })
  }
  shareFailure('≥300 kV bus share', backbone.value, thresholds.minLargestComponentBusShare300kv, backbone.outside)
  shareFailure('≥132 kV bus share', regional.value, thresholds.minLargestComponentBusShare132kv, regional.outside)
  if (loadShare < thresholds.minLargestComponentLoadShare) {
    failures.push({
      message: `load share in the main component ${formatShare(loadShare)} < ${formatShare(thresholds.minLargestComponentLoadShare)}`,
      assetIds: context.graph.loads.filter(load => !context.mainComponent.has(load.busId)).map(load => load.id),
    })
  }
  const unmeasured = [
    ...(backbone.eligible.length === 0 ? ['the model has no ≥300 kV buses'] : []),
    ...(totalLoad === 0 ? ['the model has no load'] : []),
  ]
  const failed = context.acComponents.length > thresholds.maxComponents || failures.length > 0
  return {
    id: 'components',
    title: 'Connected components (boundary buses excluded)',
    status: checkStatus(failed, unmeasured.length > 0 ? unmeasured.join('; ') : undefined),
    summary: `${context.acComponents.length} components (max ${thresholds.maxComponents}); main component holds ${formatShare(backbone.value)} of ≥300 kV buses, ${formatShare(regional.value)} of ≥132 kV buses, ${formatShare(loadShare)} of load`,
    metrics: {
      components: context.acComponents.length,
      componentSizes: context.acComponents.map(component => component.length),
      busShare300kv: backbone.value,
      busShare132kv: regional.value,
      loadShare,
    },
    failures,
    ...(unmeasured.length > 0 ? { unmeasured: unmeasured.join('; ') } : {}),
  }
}

const backboneGraph = (context: AuditContext) => {
  const buses = context.graph.buses.filter(bus => bus.kind !== 'boundary' && bus.nominalKv >= backboneKv)
  const ids = new Set(buses.map(bus => bus.id))
  const branches = context.graph.branches.filter(branch => branch.nominalKv >= backboneKv && ids.has(branch.fromBusId) && ids.has(branch.toBusId))
  const graph = createMultigraph(buses.map(bus => bus.id), branches.map(branch => ({ a: branch.fromBusId, b: branch.toBusId, capacity: branch.circuits })))
  return { buses, branches, graph }
}

/**
 * A bus in a cut-off part needs no allowance when it is another voltage level of a station that
 * keeps a bus outside the part (a level behind its own station transformer).
 */
const sameStationLevel = (context: AuditContext, bus: AuditBus, part: ReadonlySet<string>): boolean =>
  bus.substationId !== undefined && context.busesOfOsmIds([bus.substationId]).some(other => !part.has(other.id))

/** A cut-off part is explained when it holds a station and every station bus in it is allow-listed or a same-station level. */
const explainedPart = (context: AuditContext, busIds: ReadonlyArray<string>): boolean => {
  const part = new Set(busIds)
  const buses = busIds.map(id => context.busById.get(id)!)
  return buses.some(bus => bus.kind !== 'junction')
    && buses.every(bus => bus.kind === 'junction' || context.radialAllowed(bus) || sameStationLevel(context, bus, part))
}

const notAllowListed = (context: AuditContext, busIds: ReadonlyArray<string>): ReadonlyArray<string> => {
  const part = new Set(busIds)
  return busIds.filter(id => {
    const bus = context.busById.get(id)!
    return bus.kind === 'junction' || !(context.radialAllowed(bus) || sameStationLevel(context, bus, part))
  })
}

export const backboneRadialChecks = (context: AuditContext): ReadonlyArray<AuditCheck> => {
  const thresholds = context.golden.thresholds
  const backbone = backboneGraph(context)
  const { bridges, articulationPoints } = bridgesAndArticulationPoints(backbone.graph)
  const bridgeFailures: AuditFailure[] = []
  for (const edgeIndex of bridges) {
    const branch: AuditBranch = backbone.branches[edgeIndex]!
    const parts = connectedComponents(backbone.graph, { edgeIndex })
    const fromPart = parts.find(part => part.includes(branch.fromBusId))!
    const toPart = parts.find(part => part.includes(branch.toBusId))!
    const cutOff = fromPart.length <= toPart.length ? fromPart : toPart
    if (explainedPart(context, cutOff)) continue
    bridgeFailures.push({
      message: `${branch.label} (${branch.nominalKv} kV) is a bridge cutting off ${describeBuses(context, cutOff)}; not allow-listed: ${describeBuses(context, notAllowListed(context, cutOff))}`,
      assetIds: [branch.id, ...cutOff],
    })
  }
  const articulationFailures: AuditFailure[] = []
  for (const node of articulationPoints) {
    const neighbours = new Set((backbone.graph.incident.get(node) ?? []).map(edge => edge.a === node ? edge.b : edge.a))
    const parts = connectedComponents(backbone.graph, { node }).filter(part => part.some(id => neighbours.has(id)))
    const unexplained = parts.slice(1).filter(part => !explainedPart(context, part))
    if (unexplained.length === 0) continue
    const cutOff = unexplained.flat()
    articulationFailures.push({
      message: `${describeBuses(context, [node])} is an articulation point; losing it cuts off ${describeBuses(context, cutOff)}`,
      assetIds: [node, ...cutOff],
    })
  }
  const degreeFailures: AuditFailure[] = []
  let weakBuses = 0
  for (const bus of backbone.buses) {
    const degree = backbone.graph.incident.get(bus.id)?.length ?? 0
    if (degree > 1) continue
    weakBuses += 1
    if (bus.kind !== 'junction' && context.radialAllowed(bus)) continue
    degreeFailures.push({
      message: `${bus.label} (${bus.nominalKv} kV) has ${degree} ≥300 kV branch${degree === 1 ? '' : 'es'} and is not on the radial allow-list`,
      assetIds: [bus.id],
    })
  }
  const unmeasured = backbone.buses.length === 0 ? 'the model has no ≥300 kV buses' : undefined
  return [{
    id: 'bridges-300kv',
    title: 'Bridges in the ≥300 kV network against the radial allow-list',
    status: checkStatus(bridgeFailures.length > thresholds.maxUnexplainedBridges300kv, unmeasured),
    summary: `${bridges.length} bridges, ${bridgeFailures.length} not explained by the radial allow-list (max ${thresholds.maxUnexplainedBridges300kv})`,
    metrics: { bridges: bridges.length, unexplainedBridges: bridgeFailures.length },
    failures: bridgeFailures,
    ...(unmeasured === undefined ? {} : { unmeasured }),
  }, {
    id: 'articulation-points-300kv',
    title: 'Articulation points in the ≥300 kV network against the radial allow-list',
    status: checkStatus(articulationFailures.length > thresholds.maxUnexplainedArticulationPoints300kv, unmeasured),
    summary: `${articulationPoints.length} articulation points, ${articulationFailures.length} not explained (max ${thresholds.maxUnexplainedArticulationPoints300kv})`,
    metrics: { articulationPoints: articulationPoints.length, unexplainedArticulationPoints: articulationFailures.length },
    failures: articulationFailures,
    ...(unmeasured === undefined ? {} : { unmeasured }),
  }, {
    id: 'degree-one-300kv',
    title: '≥300 kV buses with at most one ≥300 kV branch',
    status: checkStatus(degreeFailures.length > thresholds.maxUnexplainedDegreeOne300kv, unmeasured),
    summary: `${weakBuses} buses with degree ≤ 1, ${degreeFailures.length} not on the radial allow-list (max ${thresholds.maxUnexplainedDegreeOne300kv})`,
    metrics: { degreeOneBuses: weakBuses, unexplainedDegreeOneBuses: degreeFailures.length },
    failures: degreeFailures,
    ...(unmeasured === undefined ? {} : { unmeasured }),
  }]
}

export const voltageMismatchCheck = (context: AuditContext): AuditCheck => {
  const thresholds = context.golden.thresholds
  const failures: AuditFailure[] = []
  for (const branch of context.graph.branches.filter(isLine)) {
    const ends = [context.busById.get(branch.fromBusId)!, context.busById.get(branch.toBusId)!]
    const mismatched = ends.filter(bus => !context.sameVoltageClass(branch.nominalKv, bus.nominalKv))
    if (mismatched.length === 0) continue
    failures.push({
      message: `${branch.label} (${branch.nominalKv} kV) ends at ${describeBuses(context, mismatched.map(bus => bus.id))}`,
      assetIds: [branch.id, ...mismatched.map(bus => bus.id)],
    })
  }
  return {
    id: 'voltage-mismatch',
    title: 'Line voltage against terminal bus voltage (transformers excepted)',
    status: checkStatus(failures.length > thresholds.maxVoltageMismatches, undefined),
    summary: `${failures.length} lines end at a bus of another voltage class (max ${thresholds.maxVoltageMismatches})`,
    metrics: { mismatchedLines: failures.length, lines: context.graph.branches.filter(isLine).length },
    failures,
  }
}

export const parallelDuplicateCheck = (context: AuditContext): AuditCheck => {
  const thresholds = context.golden.thresholds
  const lines = context.graph.branches.filter(isMappedLine)
  const withoutWays = lines.filter(branch => branch.osmWayIds.length === 0)
  const groups = new Map<string, AuditBranch[]>()
  for (const branch of lines) {
    if (branch.osmWayIds.length === 0) continue
    const key = [...new Set(branch.osmWayIds)].sort().join('|')
    const group = groups.get(key)
    if (group) group.push(branch)
    else groups.set(key, [branch])
  }
  const failures: AuditFailure[] = [...groups.values()].filter(group => group.length > 1).map(group => ({
    message: `${group.length} branches share the same OSM way set (${group[0]!.osmWayIds.length} ways): ${group.map(branch => branch.label).join(', ')}`,
    assetIds: group.map(branch => branch.id),
  }))
  const duplicates = failures.reduce((sum, failure) => sum + failure.assetIds.length - 1, 0)
  const unmeasured = withoutWays.length > 0 ? `${withoutWays.length} of ${lines.length} mapped lines carry no OSM way ids` : undefined
  return {
    id: 'parallel-duplicates',
    title: 'Branches built twice from the same OSM ways',
    status: checkStatus(duplicates > thresholds.maxParallelDuplicates, unmeasured),
    summary: `${duplicates} duplicate branches in ${failures.length} way sets (max ${thresholds.maxParallelDuplicates})`,
    metrics: { duplicateBranches: duplicates, duplicateWaySets: failures.length, linesWithoutWayIds: withoutWays.length },
    failures,
    ...(unmeasured === undefined ? {} : { unmeasured }),
  }
}

export const offTerminalEndsCheck = (context: AuditContext): AuditCheck => {
  const thresholds = context.golden.thresholds
  const { measured, unmeasured: unmeasuredEnds, boundary: boundaryEnds } = context.terminalEnds
  const failures: AuditFailure[] = measured.filter(end => end.distanceKm > end.limitKm).map(end => ({
    message: `${end.branch.label} (${end.branch.nominalKv} kV): ${end.side} end lies ${end.distanceKm.toFixed(2)} km outside ${end.bus.label}`,
    assetIds: [end.branch.id, end.bus.id],
  }))
  const unmeasured = unmeasuredEnds > 0 ? `${unmeasuredEnds} line ends lack reference geometry or a terminal footprint` : undefined
  return {
    id: 'off-terminal-ends',
    title: 'Mapped line ends outside their terminal station',
    status: checkStatus(failures.length > thresholds.maxOffTerminalEnds, unmeasured),
    summary: `${failures.length} of ${measured.length} measured line ends lie outside their terminal (max ${thresholds.maxOffTerminalEnds})${unmeasuredEnds > 0 ? `; ${unmeasuredEnds} ends unmeasured` : ''}`,
    metrics: { offTerminalEnds: failures.length, measuredEnds: measured.length, unmeasuredEnds, boundaryEnds },
    failures,
    ...(unmeasured === undefined ? {} : { unmeasured }),
  }
}
