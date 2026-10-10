import { chainCircuits, chainLengthKm, chainPieces, type Chain, type CircuitEvidence } from './corridor-chain.ts'
import { buildLevelGraph, freeNodeKey, isFreeNode, type CorridorLink, type LevelWay, type NodeRef } from './corridor-graph.ts'
import { compareText } from './ids.ts'
import type { TopologyLevelInput, TopologyLineInput, TopologyRouteInput } from './input.ts'
import type { PreparedInterconnectors } from './interconnectors.ts'
import type { TopologyLedger } from './ledger.ts'
import type { TopologyOptions } from './options.ts'
import type { StationGroups } from './station-groups.ts'
import type { StationIndex } from './station-index.ts'
import type { TerminalResolver } from './terminals.ts'

export type LevelLink = CorridorLink & { readonly kv: number }

export type LevelsResult = {
  readonly links: ReadonlyArray<LevelLink>
  readonly levelsKv: ReadonlyArray<number>
}

export type LevelsInput = {
  readonly acLines: ReadonlyArray<TopologyLineInput>
  readonly inheritedKv: ReadonlyMap<string, number>
  readonly routes: ReadonlyArray<TopologyRouteInput>
  readonly terminals: TerminalResolver
  readonly index: StationIndex
  readonly groups: StationGroups
  readonly interconnectors: PreparedInterconnectors
  readonly options: TopologyOptions
}

const routeCountsOf = (routes: ReadonlyArray<TopologyRouteInput>): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const route of routes) {
    for (const kv of new Set(route.voltagesKv)) {
      for (const wayId of new Set(route.osmWayIds)) counts.set(`${wayId}@${kv}`, (counts.get(`${wayId}@${kv}`) ?? 0) + 1)
    }
  }
  return counts
}

// Conductor count per circuit for three-phase AC.
const conductorsPerCircuit = 3

const circuitEvidence = (
  line: TopologyLineInput,
  level: TopologyLevelInput,
  kv: number,
  routeCounts: ReadonlyMap<string, number>,
): CircuitEvidence => {
  const routed = line.osmWayIds.map(wayId => routeCounts.get(`${wayId}@${kv}`) ?? 0)
  if (routed.every(count => count > 0)) return { value: Math.min(...routed), source: 'route-relation' }
  const singleLevel = line.levels.length === 1
  // cables=1 or 2: a phase-split way carrying part of one circuit (fjord spans), whatever circuits says.
  if (singleLevel && line.cables !== null && line.cables < conductorsPerCircuit) return { value: line.cables / conductorsPerCircuit, source: 'cables-tag' }
  if (level.circuits !== null && level.circuitsSource !== null) return { value: level.circuits, source: level.circuitsSource }
  if (singleLevel && line.cables !== null) return { value: line.cables / conductorsPerCircuit, source: 'cables-tag' }
  return { value: 1, source: 'inferred' }
}

const describeChain = (chain: Chain): { elementIds: string[]; names: string; lengthKm: number } => {
  const pieces = chainPieces(chain)
  const names = [...new Set(pieces.flatMap(piece => piece.name ? [piece.name] : []))].sort(compareText)
  return {
    elementIds: [...pieces.map(piece => piece.featureId), ...pieces.flatMap(piece => piece.osmWayIds)],
    names: names.length > 0 ? names.join(' / ') : 'unnamed',
    lengthKm: chainLengthKm(chain),
  }
}

const describeNode = (node: string): string => isFreeNode(node) ? `node ${freeNodeKey(node)}` : node.slice(2)

export const buildLevels = (input: LevelsInput, ledger: TopologyLedger): LevelsResult => {
  const { terminals, interconnectors, options } = input
  const routeCounts = routeCountsOf(input.routes)
  const waysByKv = new Map<number, LevelWay[]>()
  for (const line of input.acLines) {
    for (const level of line.levels) {
      if (level.system !== 'ac50') continue
      const inherited = level.voltageKv === null ? input.inheritedKv.get(line.featureId) : undefined
      const kv = level.voltageKv ?? inherited
      if (kv === undefined || kv < options.minimumKv) continue
      const list = waysByKv.get(kv) ?? []
      list.push({ line, circuits: circuitEvidence(line, level, kv, routeCounts), voltageSource: level.voltageKv === null ? 'inherited' : 'mapped' })
      waysByKv.set(kv, list)
    }
  }
  const levelsKv = [...waysByKv.keys()].sort((left, right) => right - left)
  const links: LevelLink[] = []
  const lineById = new Map(input.acLines.map(line => [line.featureId, line]))
  const stationGroupsOfFeature = new Map<string, Set<string>>()
  const throughPasses = new Map<string, { featureId: string; groupId: string; kvs: Set<number>; location: readonly [number, number] }>()

  for (const kv of levelsKv) {
    const ways = waysByKv.get(kv)!
    const resolveNode = (key: string, occurrence: { wayEnds: number; interior: number; terminalCandidate: boolean }): NodeRef => {
      const busbarGroup = terminals.busbarGroupOf(key)
      let groupId: string | null = busbarGroup?.id ?? null
      // Ways that share a node inside a station polygon meet in that station, even mid-way.
      const sharedNode = occurrence.wayEnds + occurrence.interior >= 2
      if (!groupId && (occurrence.terminalCandidate || sharedNode)) {
        const candidate = terminals.locateKey(key)
        const located = candidate && (occurrence.terminalCandidate || candidate.hit.method === 'inside') ? candidate : null
        if (located) {
          const tagged = located.group.taggedVoltagesKv
          if (tagged.size === 0 || tagged.has(kv) || occurrence.interior === 0) {
            groupId = located.group.id
            terminals.noteTerminal(key, kv, located)
          } else {
            ledger.add({
              reason: 'endpoint-in-incompatible-station',
              elementIds: [located.hit.container.station.featureId],
              voltageKv: kv,
              location: terminals.coordinateOf(key),
              stationId: located.group.id,
              detail: `${kv} kV ${occurrence.terminalCandidate ? 'way end' : 'shared node'} ${key} inside a station tagged ${[...tagged].sort((l, r) => r - l).join('/')} kV while a ${kv} kV way continues through it; not a terminal`,
            })
          }
        }
      }
      if (groupId) {
        const foreign = interconnectors.foreignGroupEntry.get(groupId)
        if (!foreign) return { kind: 'station', groupId }
        return foreign.kind === 'ac' && foreign.normalisedKv === kv ? { kind: 'boundary', interconnectorId: foreign.id } : { kind: 'free' }
      }
      if (occurrence.wayEnds === 1 && occurrence.interior === 0) {
        const entry = interconnectors.acForeignEndAt(terminals.coordinateOf(key), kv)
        if (entry) return { kind: 'boundary', interconnectorId: entry.id }
      }
      return { kind: 'free' }
    }
    const pieceInsideStation = (line: TopologyLineInput, from: number, to: number, groupId: string): boolean => {
      for (let index = from; index <= to; index += 1) {
        if (!terminals.groupsAtPoint(line.coordinates[index]!).some(group => group.id === groupId)) return false
      }
      return true
    }
    const graph = buildLevelGraph({ ways, resolveNode, pieceInsideStation })
    for (const link of graph.links) links.push({ ...link, kv })

    const consumed = new Set<string>()
    const consume = (chain: Chain): void => { for (const piece of chainPieces(chain)) consumed.add(piece.featureId) }
    for (const link of graph.links) consume(link.chain)
    for (const stub of graph.dangling) {
      consume(stub.chain)
      const described = describeChain(stub.chain)
      const ends = stub.danglingKeys.map(key => {
        const location = terminals.coordinateOf(key)
        return { key, location, nearest: input.index.nearest(location, options.nearestStationSearchKm) }
      }).sort((left, right) => (left.nearest?.distanceKm ?? Infinity) - (right.nearest?.distanceKm ?? Infinity))
      const end = ends[0]!
      const nearestGroup = end.nearest ? input.groups.groupOf(end.nearest.container) : null
      ledger.add({
        reason: stub.anchor === null ? 'corridor-isolated' : 'corridor-dangling',
        elementIds: described.elementIds,
        voltageKv: kv,
        location: end.location,
        ...(end.nearest && nearestGroup ? { distanceM: end.nearest.distanceKm * 1000, stationId: nearestGroup.id } : {}),
        detail: `${described.names}, ${described.lengthKm.toFixed(2)} km${stub.anchor ? ` from ${describeNode(stub.anchor)}` : ''}; free end ${end.key}${end.nearest ? ` is ${(end.nearest.distanceKm * 1000).toFixed(0)} m from the nearest station` : ` has no station within ${options.nearestStationSearchKm} km`}`,
      })
    }
    for (const loop of graph.selfLoops) {
      consume(loop.chain)
      const described = describeChain(loop.chain)
      ledger.add({
        reason: 'corridor-self-loop',
        elementIds: described.elementIds,
        voltageKv: kv,
        detail: `${described.names}, ${described.lengthKm.toFixed(2)} km leaves and re-enters ${describeNode(loop.node)}`,
      })
    }
    for (const merge of graph.parallelMerges) {
      const described = describeChain(merge.chain)
      const circuits = chainCircuits(merge.chain)
      ledger.add({
        reason: 'parallel-spans-merged',
        elementIds: described.elementIds,
        voltageKv: kv,
        detail: `${merge.chain[0]?.kind === 'parallel' ? merge.chain[0].members.length : 1} parallel spans between ${describeNode(merge.a)} and ${describeNode(merge.b)} merged (${Number(circuits.value.toFixed(3))} circuit(s))`,
      })
    }
    const internal = new Map<string, { groupId: string; elementIds: string[] }>()
    for (const piece of graph.stationInternal) {
      for (const way of chainPieces(piece.chain)) {
        if (!internal.has(way.featureId)) internal.set(way.featureId, { groupId: piece.groupId, elementIds: [way.featureId, ...way.osmWayIds] })
      }
    }
    for (const way of ways) {
      const featureId = way.line.featureId
      if (consumed.has(featureId)) continue
      const piece = internal.get(featureId)
      if (!piece) throw new Error(`topology levels: ${featureId} at ${kv} kV was neither modelled nor recorded`)
      ledger.add({ reason: 'station-internal-way', elementIds: piece.elementIds, voltageKv: kv, stationId: piece.groupId, detail: 'way lies entirely inside one station' })
    }

    for (const { line } of ways) {
      const groups = stationGroupsOfFeature.get(line.featureId) ?? new Set<string>()
      for (const key of line.vertexKeys) {
        const node = graph.nodeOfKey.get(key)!
        if (node.startsWith('S|')) groups.add(node.slice(2))
      }
      stationGroupsOfFeature.set(line.featureId, groups)
      const candidates = new Set(line.terminalVertexIndices)
      line.vertexKeys.forEach((key, index) => {
        if (candidates.has(index) || !isFreeNode(graph.nodeOfKey.get(key)!)) return
        for (const group of terminals.containingGroups(line.coordinates[index]!)) {
          const id = `${line.featureId}\u0000${group.id}`
          const entry = throughPasses.get(id) ?? { featureId: line.featureId, groupId: group.id, kvs: new Set<number>(), location: line.coordinates[index]! }
          entry.kvs.add(kv)
          throughPasses.set(id, entry)
        }
      })
    }
  }
  terminals.flush()

  for (const pass of [...throughPasses.values()].sort((left, right) => compareText(left.featureId, right.featureId) || compareText(left.groupId, right.groupId))) {
    if (stationGroupsOfFeature.get(pass.featureId)?.has(pass.groupId)) continue
    const line = lineById.get(pass.featureId)!
    ledger.add({
      reason: 'passes-through-station',
      elementIds: [pass.featureId, ...line.osmWayIds],
      voltageKv: Math.max(...pass.kvs),
      location: pass.location,
      stationId: pass.groupId,
      detail: `interior vertices of a ${[...pass.kvs].sort((l, r) => r - l).join('/')} kV way lie inside ${pass.groupId}; not a terminal${line.osmWayIds.length > 1 ? ` (source feature merges ${line.osmWayIds.length} ways; their joints are unknown)` : ''}`,
    })
  }
  return { links, levelsKv }
}
