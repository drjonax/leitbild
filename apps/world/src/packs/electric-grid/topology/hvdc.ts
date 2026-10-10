import { polylineKm, type LonLat } from './geometry.ts'
import { compareText, hvdcBoundaryBusId } from './ids.ts'
import type { TopologyLineInput } from './input.ts'
import type { PreparedInterconnectors } from './interconnectors.ts'
import type { TopologyLedger } from './ledger.ts'
import type { TopologyHvdcLink, TopologyProvenance } from './result.ts'
import type { StationGroup } from './station-groups.ts'

// HVDC ways form networks independent of pole voltage (bipoles, electrodes and cable/line
// transitions differ in tagged voltage). A link is accepted only when the network holding the
// listed ways reaches the listed converter station, leaves the extract at a free way end (the
// foreign landfall), and the converter has an AC bus.

export type HvdcInput = {
  readonly lines: ReadonlyArray<TopologyLineInput>
  readonly stationOfKey: (key: string, coordinate: LonLat) => StationGroup | null
  readonly groupsAtPoint: (point: LonLat) => ReadonlyArray<StationGroup>
  readonly acBusOfGroup: (groupId: string) => string | null
  readonly interconnectors: PreparedInterconnectors
  readonly sourceIds: ReadonlyArray<string>
  readonly curationOfFeature: ReadonlyMap<string, string>
  readonly curationsOfInterconnector: ReadonlyMap<string, ReadonlyArray<string>>
}

export type HvdcResult = {
  readonly links: ReadonlyArray<TopologyHvdcLink>
  readonly foreignEnds: ReadonlyMap<string, LonLat>     // link id → free way end abroad
  readonly usedFeatureIds: ReadonlySet<string>
  readonly touchedGroupIds: ReadonlySet<string>
}

type Network = {
  readonly lines: TopologyLineInput[]
  readonly groupIds: Set<string>
  readonly danglingEnds: Array<{ key: string; coordinate: LonLat }>
}

const dcVoltages = (line: TopologyLineInput): ReadonlyArray<number> =>
  line.levels.flatMap(level => level.system === 'hvdc' && level.voltageKv !== null ? [level.voltageKv] : [])

export const resolveHvdcLinks = (input: HvdcInput, ledger: TopologyLedger): HvdcResult => {
  const lines = [...input.lines].sort((left, right) => compareText(left.featureId, right.featureId))
  const parent = new Map<string, string>()
  const find = (value: string): string => {
    let root = value
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!
    parent.set(value, root)
    return root
  }
  const union = (left: string, right: string): void => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent.set(compareText(a, b) > 0 ? a : b, compareText(a, b) > 0 ? b : a)
  }
  const keyCount = new Map<string, number>()
  for (const line of lines) for (const key of line.vertexKeys) keyCount.set(key, (keyCount.get(key) ?? 0) + 1)
  const groupOfLineEnd = new Map<string, StationGroup>()
  for (const line of lines) {
    const node = `W|${line.featureId}`
    for (const key of line.vertexKeys) union(node, `K|${key}`)
    for (const index of line.terminalVertexIndices) {
      const key = line.vertexKeys[index]!
      const group = input.stationOfKey(key, line.coordinates[index]!)
      if (!group) continue
      groupOfLineEnd.set(key, group)
      union(node, `G|${group.id}`)
    }
  }
  const networks = new Map<string, Network>()
  for (const line of lines) {
    const root = find(`W|${line.featureId}`)
    const network = networks.get(root) ?? { lines: [], groupIds: new Set<string>(), danglingEnds: [] }
    network.lines.push(line)
    for (const index of line.terminalVertexIndices) {
      const key = line.vertexKeys[index]!
      const group = groupOfLineEnd.get(key)
      if (group) network.groupIds.add(group.id)
      else if (keyCount.get(key) === 1) network.danglingEnds.push({ key, coordinate: line.coordinates[index]! })
    }
    networks.set(root, network)
  }
  const lineByWayId = new Map<string, TopologyLineInput>()
  for (const line of lines) for (const wayId of line.osmWayIds) lineByWayId.set(wayId, line)

  const links: TopologyHvdcLink[] = []
  const foreignEnds = new Map<string, LonLat>()
  const usedFeatureIds = new Set<string>()
  const touchedGroupIds = new Set<string>()
  for (const entry of input.interconnectors.hvdc) {
    const present = entry.osmWayIds.filter(wayId => lineByWayId.has(wayId)).sort(compareText)
    const missing = entry.osmWayIds.filter(wayId => !lineByWayId.has(wayId)).sort(compareText)
    if (present.length === 0) {
      ledger.add({ reason: 'interconnector-unmatched', elementIds: [entry.id, ...entry.osmWayIds], detail: 'none of the listed ways is an operational HVDC way in the source' })
      continue
    }
    // A missing way would let a gap inside Norway pass for the foreign end.
    if (missing.length > 0) {
      ledger.add({ reason: 'interconnector-way-missing', elementIds: [entry.id, ...missing], detail: `${missing.length} listed way(s) are not operational HVDC ways in the source` })
      continue
    }
    const entryLines = [...new Set(present.map(wayId => lineByWayId.get(wayId)!))]
    const roots = [...new Set(entryLines.map(line => find(`W|${line.featureId}`)))]
    if (roots.length !== 1) {
      ledger.add({ reason: 'interconnector-split', elementIds: [entry.id, ...present], detail: `listed ways fall into ${roots.length} disconnected HVDC networks` })
      continue
    }
    const network = networks.get(roots[0]!)!
    const converter = entry.norwegianGroup
    if (!network.groupIds.has(converter.id)) {
      ledger.add({ reason: 'interconnector-terminal-mismatch', elementIds: [entry.id, ...present], stationId: converter.id, detail: `HVDC network does not reach the listed converter station ${entry.norwegianStationId}` })
      continue
    }
    // Prefer a free end on the link's own ways (the landfall of this cable) over other ends of a shared network.
    const ownKeys = new Set(entryLines.flatMap(line => line.vertexKeys))
    const foreignEnd = network.danglingEnds.find(end => ownKeys.has(end.key)) ?? network.danglingEnds[0]
    if (!foreignEnd) {
      ledger.add({ reason: 'interconnector-foreign-end-missing', elementIds: [entry.id, ...present], stationId: converter.id, detail: 'the HVDC network has no free way end, so it never leaves the extract' })
      continue
    }
    const fromBusId = input.acBusOfGroup(converter.id)
    if (!fromBusId) {
      ledger.add({ reason: 'converter-without-ac-bus', elementIds: [entry.id, ...present], stationId: converter.id, detail: 'no AC corridor at or above the minimum voltage terminates at the converter station' })
      continue
    }
    for (const line of entryLines) usedFeatureIds.add(line.featureId)
    foreignEnds.set(entry.id, foreignEnd.coordinate)
    touchedGroupIds.add(converter.id)
    const curations = [...new Set([
      ...entryLines.flatMap(line => input.curationOfFeature.get(line.featureId) ?? []),
      ...(input.curationsOfInterconnector.get(entry.id) ?? []),
    ])].sort(compareText)
    const provenance: TopologyProvenance = {
      sources: [...input.sourceIds],
      method: 'curated',
      confidence: curations.length > 0 ? 'medium' : 'high',
      note: `route mapped in OSM (${present.length} way(s)); endpoints verified against the interconnector table${curations.length > 0 ? `; corrected by ${curations.join(', ')}` : ''}`,
    }
    links.push({
      id: entry.id,
      label: entry.label,
      fromBusId,
      toBusId: hvdcBoundaryBusId(entry.externalArea),
      converterStationId: converter.id,
      dcVoltagesKv: [...new Set(entryLines.flatMap(dcVoltages))].sort((left, right) => left - right),
      // Rounded to 0.1 m so the output is byte-stable across platforms.
      lengthKm: Math.round(entryLines.reduce((sum, line) => sum + polylineKm(line.coordinates), 0) * 10_000) / 10_000,
      osmWayIds: present,
      sourceFeatureIds: entryLines.map(line => line.featureId).sort(compareText),
      provenance,
    })
  }

  for (const network of networks.values()) {
    // Converter-yard wiring lies wholly inside one station; it is station equipment, not a link.
    const insideOneStation = (line: TopologyLineInput): StationGroup | null => {
      const first = input.groupsAtPoint(line.coordinates[0]!)
      return first.find(group => line.coordinates.every(point => input.groupsAtPoint(point).some(other => other.id === group.id))) ?? null
    }
    const unusedAll = network.lines.filter(line => !usedFeatureIds.has(line.featureId))
    const unused: TopologyLineInput[] = []
    for (const line of unusedAll) {
      const station = insideOneStation(line)
      if (!station) {
        unused.push(line)
        continue
      }
      ledger.add({ reason: 'station-internal-way', elementIds: [line.featureId, ...line.osmWayIds], ...(dcVoltages(line).length > 0 ? { voltageKv: Math.max(...dcVoltages(line)) } : {}), stationId: station.id, detail: 'HVDC way lies entirely inside one station' })
    }
    if (unused.length === 0) continue
    const voltages = unused.flatMap(dcVoltages)
    ledger.add({
      reason: 'hvdc-unmatched',
      elementIds: [...unused.map(line => line.featureId), ...unused.flatMap(line => line.osmWayIds)],
      ...(voltages.length > 0 ? { voltageKv: Math.max(...voltages) } : {}),
      location: unused[0]!.coordinates[0]!,
      detail: `${unused.length} HVDC way(s) touching station(s) [${[...network.groupIds].sort(compareText).join(', ')}] are not part of a listed interconnector`,
    })
  }
  return { links: links.sort((left, right) => compareText(left.id, right.id)), foreignEnds, usedFeatureIds, touchedGroupIds }
}
