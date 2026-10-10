import { resolveAcTies } from './ac-ties.ts'
import { busIdOfNode, corridorBranch, type BranchContext } from './branches.ts'
import { mergeBuses, shortBranchTies } from './bus-merge.ts'
import { busbarTies } from './busbar-ties.ts'
import { boundaryBuses, junctionBuses, stationBuses, type BoundarySeed } from './buses.ts'
import { classifyInput } from './classify.ts'
import { chainPieces } from './corridor-chain.ts'
import { freeNodeKey, isFreeNode } from './corridor-graph.ts'
import { applyCurations } from './curations.ts'
import type { LonLat } from './geometry.ts'
import { resolveHvdcLinks } from './hvdc.ts'
import { acBoundaryBusId, compareText, hvdcBoundaryBusId, stationBusId } from './ids.ts'
import type { TopologyCurationSet, TopologyInput, TopologyInterconnectorTable } from './input.ts'
import { prepareInterconnectors, type PreparedInterconnector } from './interconnectors.ts'
import { createTopologyLedger, topologyLedgerReasons } from './ledger.ts'
import { buildLevels, ledgerDanglingCorridor, type LevelLink } from './levels.ts'
import { createTopologyOptions, type TopologyOptions } from './options.ts'
import { reportStations } from './reports.ts'
import type { TopologyBranch, TopologyBus, TopologyResult, TopologySummary } from './result.ts'
import { groupStations } from './station-groups.ts'
import { createStationContainers, createStationIndex } from './station-index.ts'
import { createTerminalResolver } from './terminals.ts'
import { buildTransformerBranches } from './transformers.ts'
import { inferVoltages } from './voltage-inference.ts'

// OSM power features → connected transmission network: one bus per station voltage level,
// explicit transformers, tee junctions, HVDC links and boundary buses, plus a ledger of
// everything dropped, unresolved, inferred, curated or worth reporting.
export const compileGridTopology = (
  input: TopologyInput,
  interconnectorTable: TopologyInterconnectorTable,
  curationSet: TopologyCurationSet,
  overrides: Partial<TopologyOptions> = {},
): TopologyResult => {
  const options = createTopologyOptions(overrides)
  const ledger = createTopologyLedger()
  for (const entry of input.adapterLedger) ledger.addEntry(entry)
  const sourceIds = [input.sourceId]
  const curated = applyCurations(input.features, interconnectorTable, curationSet, ledger)
  const classified = classifyInput({ ...input, features: curated.features }, options, ledger)
  const containerStations = classified.stations.flatMap(station => station.geometry ? [{ ...station, geometry: station.geometry }] : [])
  const index = createStationIndex(createStationContainers(containerStations), options)
  const groups = groupStations(index, classified.stations.filter(station => station.geometry === null), options, ledger)
  const terminals = createTerminalResolver({
    lines: [...classified.acLines, ...classified.hvdcLines],
    busbars: classified.busbars,
    index,
    groups,
    bufferReviewM: options.substationBufferReviewM,
  }, ledger)
  const interconnectors = prepareInterconnectors(curated.interconnectors, groups, classified.normaliseKv, ledger)

  const inheritedKv = inferVoltages({
    unknownLines: classified.acLines.filter(line => line.levels.some(level => level.system === 'ac50' && level.voltageKv === null)),
    knownVoltagesAtKey: classified.knownVoltagesAtKey,
    stationAtKey: key => {
      const group = terminals.busbarGroupOf(key) ?? terminals.groupsAtPoint(terminals.coordinateOf(key))[0] ?? null
      return group ? { stationId: group.id, taggedKv: group.taggedVoltagesKv } : null
    },
  }, ledger)
  for (const line of classified.acLines) {
    const kv = inheritedKv.get(line.featureId)
    if (kv !== undefined && kv < options.minimumKv) {
      ledger.add({ reason: 'below-minimum-voltage', elementIds: [line.featureId, ...line.osmWayIds], voltageKv: kv, detail: `inherited ${kv} kV is below the ${options.minimumKv} kV model floor` })
    }
  }

  const levels = buildLevels({ acLines: classified.acLines, inheritedKv, routes: classified.routes, terminals, index, groups, options }, ledger)
  const acTies = resolveAcTies(levels, interconnectors, terminals.coordinateOf, ledger)
  for (const stub of acTies.unclaimed) ledgerDanglingCorridor(stub, { terminals, index, groups, options }, ledger)
  const accepted: Array<{ link: LevelLink; entry: PreparedInterconnector | null }> = [
    ...levels.links.map(link => ({ link, entry: null })),
    ...acTies.ties.map(tie => ({ link: tie.link, entry: tie.entry })),
  ]
  const foreignEnds = new Map<string, LonLat>(acTies.ties.map(tie => [tie.entry.id, tie.foreignEnd]))

  const levelsOfGroup = new Map<string, Set<number>>()
  const junctions = new Map<string, { key: string; kv: number; names: Set<string> }>()
  const branchContext: Omit<BranchContext, 'busLabel'> = { keyMode: input.keyMode, interconnectors, sourceIds, curationOfFeature: curated.curationOfFeature }
  for (const { link } of accepted) {
    for (const node of [link.a, link.b]) {
      if (node.startsWith('S|')) {
        const set = levelsOfGroup.get(node.slice(2)) ?? new Set<number>()
        set.add(link.kv)
        levelsOfGroup.set(node.slice(2), set)
      } else if (isFreeNode(node)) {
        const busId = busIdOfNode(branchContext, node, link.kv)
        const junction = junctions.get(busId) ?? { key: freeNodeKey(node), kv: link.kv, names: new Set<string>() }
        for (const piece of chainPieces(link.chain)) if (piece.name) junction.names.add(piece.name)
        junctions.set(busId, junction)
      }
    }
  }
  const tiesFromBusbars = busbarTies(terminals.spanningBusbars, levelsOfGroup, classified.normaliseKv, options, ledger)

  const buses = new Map<string, TopologyBus>()
  const addBus = (bus: TopologyBus): void => {
    if (buses.has(bus.id)) throw new Error(`topology: duplicate bus id ${bus.id}`)
    buses.set(bus.id, bus)
  }
  for (const bus of stationBuses(groups.groups, levelsOfGroup, sourceIds, ledger)) addBus(bus)
  for (const bus of junctionBuses(junctions, terminals.coordinateOf, sourceIds)) addBus(bus)

  const hvdc = resolveHvdcLinks({
    lines: classified.hvdcLines,
    stationOfKey: key => terminals.busbarGroupOf(key) ?? terminals.locateKey(key)?.group ?? null,
    groupsAtPoint: terminals.groupsAtPoint,
    acBusOfGroup: groupId => {
      const kvs = [...(levelsOfGroup.get(groupId) ?? [])]
      return kvs.length > 0 ? stationBusId(groupId, Math.max(...kvs)) : null
    },
    interconnectors,
    sourceIds,
    curationOfFeature: curated.curationOfFeature,
    curationsOfInterconnector: curated.curationsOfInterconnector,
  }, ledger)

  const boundarySeeds = new Map<string, BoundarySeed>()
  const noteBoundary = (busId: string, entry: PreparedInterconnector, kv: number): void => {
    const seed = boundarySeeds.get(busId) ?? { area: entry.externalArea, kind: entry.kind, kv, entries: [] }
    boundarySeeds.set(busId, { ...seed, kv: Math.max(seed.kv, kv), entries: seed.entries.includes(entry) ? seed.entries : [...seed.entries, entry] })
  }
  for (const { link, entry } of accepted) if (entry) noteBoundary(acBoundaryBusId(entry.externalArea, link.kv), entry, link.kv)
  for (const link of hvdc.links) {
    const entry = interconnectors.byId.get(link.id)!
    noteBoundary(hvdcBoundaryBusId(entry.externalArea), entry, entry.normalisedKv)
    foreignEnds.set(entry.id, hvdc.foreignEnds.get(entry.id)!)
  }
  const boundary = boundaryBuses(boundarySeeds, foreignEnds, interconnectorTable.sourceId)
  for (const bus of boundary.buses) addBus(bus)

  const busLabel = (busId: string): string => buses.get(busId)?.label ?? busId
  const branches = new Map<string, TopologyBranch>()
  const addBranch = (branch: TopologyBranch): void => {
    if (branches.has(branch.id)) throw new Error(`topology: branch id collision ${branch.id}`)
    for (const busId of [branch.fromBusId, branch.toBusId]) if (!buses.has(busId)) throw new Error(`topology: branch ${branch.id} references missing bus ${busId}`)
    branches.set(branch.id, branch)
  }
  for (const { link, entry } of accepted) addBranch(corridorBranch(link, entry?.id ?? null, { ...branchContext, busLabel }, ledger))
  for (const branch of buildTransformerBranches({
    groups: groups.groups,
    levelsOfGroup,
    transformers: classified.transformers,
    groupOfPoint: transformer => terminals.groupsAtPoint(transformer.location)[0] ?? null,
    normaliseKv: classified.normaliseKv,
    sourceIds,
  }, ledger)) addBranch(branch)

  reportStations(groups.groups, levelsOfGroup, new Set([...levelsOfGroup.keys(), ...hvdc.touchedGroupIds]), options, ledger)

  const branchList = [...branches.values()].sort((left, right) => compareText(left.id, right.id))
  const merged = mergeBuses(buses, branchList, hvdc.links, [...shortBranchTies(branchList, buses, options.zeroImpedanceMaxM), ...tiesFromBusbars], ledger)
  const entries = ledger.entries()
  const count = <T,>(items: ReadonlyArray<T>, predicate: (item: T) => boolean): number => items.filter(predicate).length
  const summary: TopologySummary = {
    buses: {
      'substation': count(merged.buses, bus => bus.kind === 'substation'),
      'plant-terminal': count(merged.buses, bus => bus.kind === 'plant-terminal'),
      'junction': count(merged.buses, bus => bus.kind === 'junction'),
      'boundary': count(merged.buses, bus => bus.kind === 'boundary'),
    },
    branches: {
      'ac_line': count(merged.branches, branch => branch.kind === 'ac_line'),
      'cable': count(merged.branches, branch => branch.kind === 'cable'),
      'transformer': count(merged.branches, branch => branch.kind === 'transformer'),
    },
    hvdcLinks: merged.hvdcLinks.length,
    boundaries: boundary.boundaries.length,
    levelsKv: [...new Set(merged.buses.filter(bus => bus.kind !== 'boundary').map(bus => bus.nominalKv))].sort((left, right) => right - left),
    ledger: Object.fromEntries(topologyLedgerReasons.flatMap(reason => {
      const total = count(entries, entry => entry.reason === reason)
      return total > 0 ? [[reason, total]] : []
    })),
  }
  return {
    sourceId: input.sourceId,
    interconnectorSourceId: interconnectorTable.sourceId,
    curationSourceId: curationSet.sourceId,
    keyMode: input.keyMode,
    options,
    buses: merged.buses,
    branches: merged.branches,
    hvdcLinks: merged.hvdcLinks,
    boundaries: boundary.boundaries,
    ledger: entries,
    summary,
  }
}
