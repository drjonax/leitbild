import { busIdOfNode, corridorBranch, type BranchContext } from './branches.ts'
import { classifyInput } from './classify.ts'
import { chainPieces } from './corridor-chain.ts'
import { freeNodeKey, isFreeNode } from './corridor-graph.ts'
import { resolveHvdcLinks } from './hvdc.ts'
import { acBoundaryBusId, compareText, hvdcBoundaryBusId, stationBusId } from './ids.ts'
import type { ExternalArea, TopologyInput, TopologyInterconnectorTable } from './input.ts'
import { prepareInterconnectors, type PreparedInterconnector } from './interconnectors.ts'
import { createTopologyLedger, topologyLedgerReasons } from './ledger.ts'
import { buildLevels, type LevelLink } from './levels.ts'
import { createTopologyOptions, type TopologyOptions } from './options.ts'
import type { TopologyBoundary, TopologyBranch, TopologyBus, TopologyResult, TopologySummary } from './result.ts'
import { groupStations, reportSameNameStations } from './station-groups.ts'
import { createStationContainers, createStationIndex } from './station-index.ts'
import { createTerminalResolver } from './terminals.ts'
import { buildTransformerBranches } from './transformers.ts'
import { inferVoltages } from './voltage-inference.ts'

// OSM power features → connected transmission network: one bus per station voltage level,
// explicit transformers, tee junctions, HVDC links and boundary buses, plus a ledger of
// everything dropped, unresolved, inferred or worth reporting.
export const compileGridTopology = (
  input: TopologyInput,
  interconnectorTable: TopologyInterconnectorTable,
  overrides: Partial<TopologyOptions> = {},
): TopologyResult => {
  const options = createTopologyOptions(overrides)
  const ledger = createTopologyLedger()
  for (const entry of input.adapterLedger) ledger.addEntry(entry)
  const sourceIds = [input.sourceId]
  const classified = classifyInput(input, options, ledger)
  const containerStations = classified.stations.flatMap(station => station.geometry ? [{ ...station, geometry: station.geometry }] : [])
  const index = createStationIndex(createStationContainers(containerStations), options)
  const groups = groupStations(index, classified.stations.filter(station => station.geometry === null), options, ledger)
  const terminals = createTerminalResolver({ lines: [...classified.acLines, ...classified.hvdcLines], busbars: classified.busbars, index, groups }, ledger)
  const interconnectors = prepareInterconnectors(interconnectorTable, groups, classified.normaliseKv, ledger)

  const inheritedKv = inferVoltages({
    unknownLines: classified.acLines.filter(line => line.levels.some(level => level.system === 'ac50' && level.voltageKv === null)),
    knownVoltagesAtKey: classified.knownVoltagesAtKey,
    isStationKey: key => terminals.busbarGroupOf(key) !== null || terminals.groupsAtPoint(terminals.coordinateOf(key)).length > 0,
  }, ledger)
  for (const line of classified.acLines) {
    const kv = inheritedKv.get(line.featureId)
    if (kv !== undefined && kv < options.minimumKv) {
      ledger.add({ reason: 'below-minimum-voltage', elementIds: [line.featureId, ...line.osmWayIds], voltageKv: kv, detail: `inherited ${kv} kV is below the ${options.minimumKv} kV model floor` })
    }
  }

  const levels = buildLevels({ acLines: classified.acLines, inheritedKv, routes: classified.routes, terminals, index, groups, interconnectors, options }, ledger)

  // AC interconnectors: a corridor reaching a foreign end must start at the listed Norwegian station
  // and use at least one listed way.
  const accepted: Array<{ link: LevelLink; entry: PreparedInterconnector | null }> = []
  const reachedEntries = new Set<string>()
  for (const link of levels.links) {
    const boundaryEnds = [link.a, link.b].filter(node => node.startsWith('B|'))
    if (boundaryEnds.length === 0) {
      accepted.push({ link, entry: null })
      continue
    }
    const entry = interconnectors.byId.get(boundaryEnds[0]!.slice(2))!
    reachedEntries.add(entry.id)
    const other = link.a === boundaryEnds[0] ? link.b : link.a
    const wayIds = chainPieces(link.chain).flatMap(piece => piece.osmWayIds)
    const usesListedWay = wayIds.some(wayId => entry.osmWayIds.includes(wayId))
    if (boundaryEnds.length === 1 && other === `S|${entry.norwegianGroup.id}` && usesListedWay) {
      accepted.push({ link, entry })
      continue
    }
    ledger.add({
      reason: 'interconnector-terminal-mismatch',
      elementIds: [entry.id, ...chainPieces(link.chain).map(piece => piece.featureId), ...wayIds],
      voltageKv: link.kv,
      stationId: entry.norwegianGroup.id,
      detail: boundaryEnds.length > 1
        ? 'corridor joins two foreign ends'
        : !usesListedWay
          ? `corridor reaching the foreign end uses none of the listed ways (from ${isFreeNode(other) ? `node ${freeNodeKey(other)}` : other.slice(2)})`
          : `corridor reaching the foreign end starts at ${isFreeNode(other) ? `node ${freeNodeKey(other)}` : other.slice(2)}, not at ${entry.norwegianGroup.id}`,
    })
  }
  for (const entry of interconnectors.ac) {
    if (reachedEntries.has(entry.id)) continue
    ledger.add({ reason: 'interconnector-unmatched', elementIds: [entry.id, ...entry.osmWayIds], voltageKv: entry.normalisedKv, location: entry.foreignEnd.location, detail: `no ${entry.normalisedKv} kV way ends within ${entry.foreignEnd.radiusKm} km of the listed foreign end` })
  }

  const levelsOfGroup = new Map<string, Set<number>>()
  const junctions = new Map<string, { key: string; kv: number; names: Set<string> }>()
  const branchContext: Omit<BranchContext, 'busLabel'> = { keyMode: input.keyMode, interconnectors, sourceIds }
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

  const buses = new Map<string, TopologyBus>()
  const addBus = (bus: TopologyBus): void => {
    if (buses.has(bus.id)) throw new Error(`topology: duplicate bus id ${bus.id}`)
    buses.set(bus.id, bus)
  }
  for (const group of groups.groups) {
    for (const kv of [...(levelsOfGroup.get(group.id) ?? [])].sort((left, right) => right - left)) {
      const untagged = group.taggedVoltagesKv.size > 0 && !group.taggedVoltagesKv.has(kv)
      if (untagged) {
        ledger.add({
          reason: 'station-level-untagged',
          elementIds: group.members.map(member => member.station.featureId),
          voltageKv: kv,
          location: group.location,
          stationId: group.id,
          detail: `${kv} kV corridors terminate at a station tagged ${[...group.taggedVoltagesKv].sort((l, r) => r - l).join('/')} kV`,
        })
      }
      addBus({
        id: stationBusId(group.id, kv),
        label: `${group.label} ${kv} kV`,
        kind: group.kind === 'substation' ? 'substation' : 'plant-terminal',
        stationId: group.id,
        stationFeatureIds: group.members.map(member => member.station.featureId),
        stationRoles: group.roles,
        vertexKey: null,
        nominalKv: kv,
        location: group.location,
        externalArea: null,
        provenance: {
          sources: sourceIds,
          method: untagged ? 'inferred' : 'mapped',
          confidence: untagged ? 'medium' : 'high',
          note: untagged ? 'voltage level taken from terminating corridors; the station is tagged otherwise' : null,
        },
      })
    }
  }
  for (const [busId, junction] of [...junctions].sort(([left], [right]) => compareText(left, right))) {
    const names = [...junction.names].sort(compareText)
    addBus({
      id: busId,
      label: `Tee ${names.length > 0 ? names.slice(0, 3).join(' / ') : junction.key} ${junction.kv} kV`,
      kind: 'junction',
      stationId: null,
      stationFeatureIds: [],
      stationRoles: [],
      vertexKey: junction.key,
      nominalKv: junction.kv,
      location: terminals.coordinateOf(junction.key),
      externalArea: null,
      provenance: { sources: sourceIds, method: 'mapped', confidence: 'high', note: 'node shared by three or more corridors' },
    })
  }

  const acBusOfGroup = (groupId: string): string | null => {
    const kvs = [...(levelsOfGroup.get(groupId) ?? [])]
    return kvs.length > 0 ? stationBusId(groupId, Math.max(...kvs)) : null
  }
  const hvdc = resolveHvdcLinks({
    lines: classified.hvdcLines,
    stationOfKey: key => terminals.busbarGroupOf(key) ?? terminals.locateKey(key)?.group ?? null,
    acBusOfGroup,
    interconnectors,
    sourceIds,
  }, ledger)

  const boundaryMap = new Map<string, { area: ExternalArea; kind: 'ac' | 'hvdc'; kv: number; entries: PreparedInterconnector[] }>()
  const noteBoundary = (busId: string, entry: PreparedInterconnector, kv: number): void => {
    const boundary = boundaryMap.get(busId) ?? { area: entry.externalArea, kind: entry.kind, kv, entries: [] }
    if (!boundary.entries.includes(entry)) boundary.entries.push(entry)
    boundaryMap.set(busId, { ...boundary, kv: Math.max(boundary.kv, kv) })
  }
  for (const { link, entry } of accepted) if (entry) noteBoundary(acBoundaryBusId(entry.externalArea, link.kv), entry, link.kv)
  for (const link of hvdc.links) {
    const entry = interconnectors.byId.get(link.id)!
    noteBoundary(hvdcBoundaryBusId(entry.externalArea), entry, entry.normalisedKv)
  }
  const boundaries: TopologyBoundary[] = []
  for (const [busId, boundary] of [...boundaryMap].sort(([left], [right]) => compareText(left, right))) {
    const entries = [...boundary.entries].sort((left, right) => compareText(left.id, right.id))
    boundaries.push({ busId, externalArea: boundary.area, kind: boundary.kind, nominalKv: boundary.kv, interconnectorIds: entries.map(entry => entry.id) })
    addBus({
      id: busId,
      label: boundary.kind === 'ac' ? `${boundary.area} boundary ${boundary.kv} kV` : `${boundary.area} HVDC boundary`,
      kind: 'boundary',
      stationId: null,
      stationFeatureIds: [],
      stationRoles: [],
      vertexKey: null,
      nominalKv: boundary.kv,
      location: entries[0]!.foreignEnd.location,
      externalArea: boundary.area,
      provenance: { sources: [interconnectorTable.sourceId], method: 'curated', confidence: 'high', note: `foreign end of ${entries.map(entry => entry.id).join(', ')}` },
    })
  }

  const busLabel = (busId: string): string => buses.get(busId)?.label ?? busId
  const branches = new Map<string, TopologyBranch>()
  const addBranch = (branch: TopologyBranch): void => {
    if (branches.has(branch.id)) throw new Error(`topology: branch id collision ${branch.id}`)
    for (const busId of [branch.fromBusId, branch.toBusId]) if (!buses.has(busId)) throw new Error(`topology: branch ${branch.id} references missing bus ${busId}`)
    branches.set(branch.id, branch)
  }
  for (const { link, entry } of accepted) addBranch(corridorBranch(link, entry?.id ?? null, { ...branchContext, busLabel }, ledger))
  const transformerBranches = buildTransformerBranches({
    groups: groups.groups,
    levelsOfGroup,
    transformers: classified.transformers,
    groupOfPoint: transformer => terminals.groupsAtPoint(transformer.location)[0] ?? null,
    normaliseKv: classified.normaliseKv,
    sourceIds,
  }, ledger)
  for (const branch of transformerBranches) addBranch(branch)

  const usedGroups = new Set([...levelsOfGroup.keys(), ...hvdc.touchedGroupIds])
  reportSameNameStations(groups.groups, usedGroups, options, ledger)
  for (const group of groups.groups) {
    if (group.roles.includes('traction') && levelsOfGroup.has(group.id)) {
      ledger.add({ reason: 'traction-station-fed', elementIds: group.members.map(member => member.station.featureId), location: group.location, stationId: group.id, detail: `railway converter fed at ${[...levelsOfGroup.get(group.id)!].join('/')} kV 50 Hz` })
    }
    const inScope = [...group.taggedVoltagesKv].filter(kv => kv >= options.minimumKv)
    if (inScope.length === 0 || usedGroups.has(group.id) || interconnectors.foreignGroupEntry.has(group.id)) continue
    ledger.add({
      reason: 'station-without-corridor',
      elementIds: group.members.map(member => member.station.featureId),
      voltageKv: Math.max(...inScope),
      location: group.location,
      stationId: group.id,
      detail: `${group.label} is tagged ${inScope.sort((l, r) => r - l).join('/')} kV but no corridor at or above ${options.minimumKv} kV terminates there`,
    })
  }

  const busList = [...buses.values()].sort((left, right) => compareText(left.id, right.id))
  const branchList = [...branches.values()].sort((left, right) => compareText(left.id, right.id))
  const entries = ledger.entries()
  const count = <T,>(items: ReadonlyArray<T>, predicate: (item: T) => boolean): number => items.filter(predicate).length
  const summary: TopologySummary = {
    buses: {
      'substation': count(busList, bus => bus.kind === 'substation'),
      'plant-terminal': count(busList, bus => bus.kind === 'plant-terminal'),
      'junction': count(busList, bus => bus.kind === 'junction'),
      'boundary': count(busList, bus => bus.kind === 'boundary'),
    },
    branches: {
      'ac_line': count(branchList, branch => branch.kind === 'ac_line'),
      'cable': count(branchList, branch => branch.kind === 'cable'),
      'transformer': count(branchList, branch => branch.kind === 'transformer'),
    },
    hvdcLinks: hvdc.links.length,
    boundaries: boundaries.length,
    levelsKv: [...new Set(busList.filter(bus => bus.kind !== 'boundary').map(bus => bus.nominalKv))].sort((left, right) => right - left),
    ledger: Object.fromEntries(topologyLedgerReasons.flatMap(reason => {
      const total = count(entries, entry => entry.reason === reason)
      return total > 0 ? [[reason, total]] : []
    })),
  }
  return {
    sourceId: input.sourceId,
    interconnectorSourceId: interconnectorTable.sourceId,
    keyMode: input.keyMode,
    options,
    buses: busList,
    branches: branchList,
    hvdcLinks: hvdc.links,
    boundaries,
    ledger: entries,
    summary,
  }
}
