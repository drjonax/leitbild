import type { GridCurationCollection } from '../schemas/grid-curation.ts'
import type { GridGolden, GridGoldenStation } from '../schemas/grid-golden.ts'
import type { AuditBranch, AuditBus, AuditGraph } from './audit-graph.ts'
import { distanceToFootprintKm } from './geodesy.ts'
import { connectedComponents, createMultigraph, type AuditMultigraph } from './graph-metrics.ts'

// Derived, read-only indices shared by the audit checks.

export interface RadialAllowance {
  readonly osmIds: ReadonlyArray<string>
  readonly voltageKv: number
  readonly source: string
}

export interface TerminalEnd {
  readonly branch: AuditBranch
  readonly bus: AuditBus
  readonly side: 'from' | 'to'
  readonly distanceKm: number
  readonly limitKm: number
}

export interface TerminalEndMeasurement {
  readonly measured: ReadonlyArray<TerminalEnd>
  readonly unmeasured: number
  readonly boundary: number
}

export interface AuditContext {
  readonly graph: AuditGraph
  readonly golden: GridGolden
  readonly curations: GridCurationCollection
  readonly asOf: string
  readonly busById: ReadonlyMap<string, AuditBus>
  readonly branchesByBus: ReadonlyMap<string, ReadonlyArray<AuditBranch>>
  /** AC multigraph over non-boundary buses; edge capacity is the branch circuit count. */
  readonly acGraph: AuditMultigraph
  readonly acComponents: ReadonlyArray<ReadonlyArray<string>>
  readonly mainComponent: ReadonlySet<string>
  readonly stationById: ReadonlyMap<string, GridGoldenStation>
  readonly busesOfOsmIds: (osmIds: ReadonlyArray<string>) => ReadonlyArray<AuditBus>
  readonly sameVoltageClass: (left: number, right: number) => boolean
  readonly radialAllowed: (bus: AuditBus) => boolean
  /** Ends of mapped (non-curated) lines against their terminal footprints. */
  readonly terminalEnds: TerminalEndMeasurement
  /** Mapped lines with a measured end outside its terminal; they are not evidence of a mapped corridor. */
  readonly offTerminalBranchIds: ReadonlySet<string>
}

export const isLine = (branch: AuditBranch): boolean => branch.kind === 'ac_line' || branch.kind === 'cable'

export const isMappedLine = (branch: AuditBranch): boolean => isLine(branch) && branch.curationIds.length === 0

const measureTerminalEnds = (
  graph: AuditGraph,
  busById: ReadonlyMap<string, AuditBus>,
  limits: { readonly polygonBufferKm: number; readonly pointRadiusKm: number },
): TerminalEndMeasurement => {
  const measured: TerminalEnd[] = []
  let unmeasured = 0
  let boundary = 0
  for (const branch of graph.branches.filter(isMappedLine)) {
    for (const side of ['from', 'to'] as const) {
      const bus = busById.get(side === 'from' ? branch.fromBusId : branch.toBusId)!
      if (bus.kind === 'boundary') {
        boundary += 1
        continue
      }
      if (branch.ends === undefined || bus.footprint === undefined) {
        unmeasured += 1
        continue
      }
      measured.push({
        branch,
        bus,
        side,
        distanceKm: distanceToFootprintKm(branch.ends[side], bus.footprint),
        limitKm: bus.footprint.kind === 'point' ? limits.pointRadiusKm : limits.polygonBufferKm,
      })
    }
  }
  return { measured, unmeasured, boundary }
}

const fail = (graph: AuditGraph, message: string): never => {
  throw new Error(`audit graph ${graph.modelId}: ${message}`)
}

const assertAuditGraph = (graph: AuditGraph): void => {
  const ids = new Set<string>()
  const register = (id: string): void => {
    if (id.trim().length === 0) fail(graph, 'asset ids must be non-empty')
    if (ids.has(id)) fail(graph, `duplicate asset id ${id}`)
    ids.add(id)
  }
  const busIds = new Set(graph.buses.map(bus => bus.id))
  const requireBus = (busId: string, subject: string): void => {
    if (!busIds.has(busId)) fail(graph, `${subject} references unknown bus ${busId}`)
  }
  const requireFinite = (value: number, subject: string, minimum: number): void => {
    if (!Number.isFinite(value) || value < minimum) fail(graph, `${subject} must be finite and at least ${minimum}`)
  }
  if (graph.buses.filter(bus => bus.kind !== 'boundary').length === 0) fail(graph, 'has no non-boundary buses')
  for (const bus of graph.buses) {
    register(bus.id)
    requireFinite(bus.nominalKv, `${bus.id} nominalKv`, Number.MIN_VALUE)
    if ((bus.kind === 'boundary') !== (bus.externalArea !== undefined)) fail(graph, `${bus.id}: externalArea is required exactly for boundary buses`)
  }
  for (const branch of graph.branches) {
    register(branch.id)
    requireBus(branch.fromBusId, branch.id)
    requireBus(branch.toBusId, branch.id)
    if (branch.fromBusId === branch.toBusId) fail(graph, `${branch.id} connects a bus to itself`)
    requireFinite(branch.nominalKv, `${branch.id} nominalKv`, Number.MIN_VALUE)
    if (!Number.isInteger(branch.circuits) || branch.circuits < 1) fail(graph, `${branch.id} circuits must be a positive integer`)
    if (branch.lengthKm !== undefined) requireFinite(branch.lengthKm, `${branch.id} lengthKm`, 0)
  }
  for (const link of graph.hvdcLinks) {
    register(link.id)
    requireBus(link.fromBusId, link.id)
    requireBus(link.toBusId, link.id)
  }
  for (const generator of graph.generators) {
    register(generator.id)
    requireBus(generator.busId, generator.id)
    requireFinite(generator.capacityMw, `${generator.id} capacityMw`, 0)
    requireFinite(generator.attachmentKm, `${generator.id} attachmentKm`, 0)
  }
  for (const load of graph.loads) {
    register(load.id)
    requireBus(load.busId, load.id)
    requireFinite(load.demandMw, `${load.id} demandMw`, 0)
    requireFinite(load.attachmentKm, `${load.id} attachmentKm`, 0)
  }
}

export const createAuditContext = (
  graph: AuditGraph,
  golden: GridGolden,
  curations: GridCurationCollection,
  asOf: string,
): AuditContext => {
  assertAuditGraph(graph)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`audit asOf must be an ISO date, got ${asOf}`)
  const busById = new Map(graph.buses.map(bus => [bus.id, bus]))
  const branchesByBus = new Map<string, AuditBranch[]>(graph.buses.map(bus => [bus.id, []]))
  for (const branch of graph.branches) {
    branchesByBus.get(branch.fromBusId)!.push(branch)
    branchesByBus.get(branch.toBusId)!.push(branch)
  }
  const acNodes = graph.buses.filter(bus => bus.kind !== 'boundary').map(bus => bus.id)
  const acNodeSet = new Set(acNodes)
  const acGraph = createMultigraph(acNodes, graph.branches
    .filter(branch => acNodeSet.has(branch.fromBusId) && acNodeSet.has(branch.toBusId))
    .map(branch => ({ a: branch.fromBusId, b: branch.toBusId, capacity: branch.circuits })))
  const acComponents = connectedComponents(acGraph)
  const busesBySubstation = new Map<string, AuditBus[]>()
  for (const bus of graph.buses) {
    if (bus.substationId === undefined) continue
    const list = busesBySubstation.get(bus.substationId)
    if (list) list.push(bus)
    else busesBySubstation.set(bus.substationId, [bus])
  }
  const tolerance = golden.thresholds.voltageClassTolerance
  const sameVoltageClass = (left: number, right: number): boolean => Math.abs(left - right) <= tolerance * Math.max(left, right)
  const allowances: RadialAllowance[] = [
    ...golden.radialAllowList.map(entry => ({
      osmIds: golden.stations.find(station => station.id === entry.stationId)!.osmIds,
      voltageKv: entry.voltageKv,
      source: `golden:${entry.stationId}`,
    })),
    ...curations.features.flatMap(feature => feature.properties.kind === 'assert-radial'
      ? [{ osmIds: [feature.properties.substationOsmId], voltageKv: feature.properties.voltageKv, source: `curation:${feature.id}` }]
      : []),
  ]
  const radialAllowed = (bus: AuditBus): boolean => {
    const substationId = bus.substationId
    if (substationId === undefined) return false
    return allowances.some(allowance => allowance.osmIds.includes(substationId)
      && (!graph.busPerVoltageLevel || sameVoltageClass(bus.nominalKv, allowance.voltageKv)))
  }
  const terminalEnds = measureTerminalEnds(graph, busById, {
    polygonBufferKm: golden.thresholds.terminalPolygonBufferKm,
    pointRadiusKm: golden.thresholds.terminalPointRadiusKm,
  })
  return {
    graph,
    golden,
    curations,
    asOf,
    busById,
    branchesByBus,
    acGraph,
    acComponents,
    mainComponent: new Set(acComponents[0] ?? []),
    stationById: new Map(golden.stations.map(station => [station.id, station])),
    busesOfOsmIds: osmIds => osmIds.flatMap(osmId => busesBySubstation.get(osmId) ?? []),
    sameVoltageClass,
    radialAllowed,
    terminalEnds,
    offTerminalBranchIds: new Set(terminalEnds.measured.filter(end => end.distanceKm > end.limitKm).map(end => end.branch.id)),
  }
}

/** Remote endpoint identity for degree counting: the remote station, or the bus itself. */
export const endpointIdentity = (bus: AuditBus): string =>
  bus.substationId === undefined ? `bus:${bus.id}` : `station:${bus.substationId}`

export const describeBuses = (context: AuditContext, busIds: ReadonlyArray<string>, limit = 8): string => {
  const labels = busIds.map(id => {
    const bus = context.busById.get(id)!
    return `${bus.label} (${bus.nominalKv} kV)`
  })
  return labels.length > limit ? `${labels.slice(0, limit).join(', ')} and ${labels.length - limit} more` : labels.join(', ')
}
