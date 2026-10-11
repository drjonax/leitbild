import { compareText } from './ids.ts'
import { polylineKm } from './geometry.ts'
import type { TopologyLineInput } from './input.ts'
import {
  chainCircuits,
  isWholeCircuitCount,
  parallelElement,
  pieceElement,
  type Chain,
  type CircuitEvidence,
} from './corridor-chain.ts'

// One voltage level: ways are cut at break vertices (terminals, way ends, nodes shared by several
// ways), parallel spans are merged, free pass-through nodes are contracted, dangling stubs pruned.

export type LevelWay = {
  readonly line: TopologyLineInput
  readonly circuits: CircuitEvidence
  readonly voltageSource: 'mapped' | 'inherited'
}

export type KeyOccurrence = {
  readonly wayEnds: number
  readonly interior: number
  readonly terminalCandidate: boolean
}

export type NodeRef =
  | { readonly kind: 'station'; readonly groupId: string }
  | { readonly kind: 'free' }

export type CorridorLink = { readonly id: number; readonly a: string; readonly b: string; readonly chain: Chain }

export type DanglingCorridor = {
  readonly chain: Chain
  readonly anchor: string | null          // the connected end; null when both ends dangle
  readonly danglingKeys: ReadonlyArray<string>
}

export type LevelGraphResult = {
  readonly nodeOfKey: ReadonlyMap<string, string>
  readonly links: ReadonlyArray<CorridorLink>
  readonly junctionKeys: ReadonlyArray<string>
  readonly dangling: ReadonlyArray<DanglingCorridor>
  readonly selfLoops: ReadonlyArray<{ readonly node: string; readonly chain: Chain }>
  readonly stationInternal: ReadonlyArray<{ readonly groupId: string; readonly chain: Chain }>
  readonly parallelMerges: ReadonlyArray<{ readonly a: string; readonly b: string; readonly chain: Chain }>
}

export type LevelGraphInput = {
  readonly ways: ReadonlyArray<LevelWay>
  readonly resolveNode: (key: string, occurrence: KeyOccurrence) => NodeRef
  // True when every vertex of the way between `from` and `to` lies in the station.
  readonly pieceInsideStation: (line: TopologyLineInput, from: number, to: number, groupId: string) => boolean
  // The key of the switching point a free vertex lies on (all its vertices are one node), or null.
  readonly switchingPointOf: (key: string) => string | null
}

export const isFreeNode = (nodeId: string): boolean => nodeId.startsWith('F|')
export const freeNodeKey = (nodeId: string): string => nodeId.slice(2)

const collectOccurrences = (ways: ReadonlyArray<LevelWay>): Map<string, { wayEnds: number; interior: number; terminalCandidate: boolean }> => {
  const occurrences = new Map<string, { wayEnds: number; interior: number; terminalCandidate: boolean }>()
  for (const { line } of ways) {
    const candidates = new Set(line.terminalVertexIndices)
    const last = line.vertexKeys.length - 1
    line.vertexKeys.forEach((key, index) => {
      const entry = occurrences.get(key) ?? { wayEnds: 0, interior: 0, terminalCandidate: false }
      if (index === 0 || index === last) entry.wayEnds += 1
      else entry.interior += 1
      if (candidates.has(index)) entry.terminalCandidate = true
      occurrences.set(key, entry)
    })
  }
  return occurrences
}

export const buildLevelGraph = (input: LevelGraphInput): LevelGraphResult => {
  const occurrences = collectOccurrences(input.ways)
  const nodeOfKey = new Map<string, string>()
  const nodeIdOf = (key: string, ref: NodeRef): string => ref.kind === 'station' ? `S|${ref.groupId}` : `F|${input.switchingPointOf(key) ?? key}`
  for (const [key, occurrence] of occurrences) nodeOfKey.set(key, nodeIdOf(key, input.resolveNode(key, occurrence)))

  const links = new Map<number, CorridorLink>()
  const incident = new Map<string, Set<number>>()
  let nextId = 0
  const selfLoops: Array<{ node: string; chain: Chain }> = []
  const stationInternal: Array<{ groupId: string; chain: Chain }> = []
  const parallelMerges: Array<{ a: string; b: string; chain: Chain }> = []
  const worklist = new Set<string>()

  const attach = (node: string, id: number): void => {
    const set = incident.get(node)
    if (set) set.add(id)
    else incident.set(node, new Set([id]))
  }
  const addLink = (a: string, b: string, chain: Chain): void => {
    if (a === b) {
      selfLoops.push({ node: a, chain })
      if (isFreeNode(a)) worklist.add(a)
      return
    }
    const id = nextId
    nextId += 1
    links.set(id, { id, a, b, chain })
    attach(a, id)
    attach(b, id)
  }
  const removeLink = (id: number): CorridorLink => {
    const link = links.get(id)!
    links.delete(id)
    incident.get(link.a)!.delete(id)
    incident.get(link.b)!.delete(id)
    return link
  }
  const otherEnd = (link: CorridorLink, node: string): string => link.a === node ? link.b : link.a

  for (const way of input.ways) {
    const { line } = way
    const last = line.vertexKeys.length - 1
    let start = 0
    for (let index = 1; index <= last; index += 1) {
      const key = line.vertexKeys[index]!
      const node = nodeOfKey.get(key)!
      const occurrence = occurrences.get(key)!
      const isBreak = index === last || !isFreeNode(node) || occurrence.wayEnds + occurrence.interior >= 2 || input.switchingPointOf(key) !== null
      if (!isBreak) continue
      const a = nodeOfKey.get(line.vertexKeys[start]!)!
      const lengthKm = polylineKm(line.coordinates, start, index)
      const chain: Chain = [pieceElement({
        featureId: line.featureId,
        osmWayIds: line.osmWayIds,
        name: line.name,
        lengthKm,
        cableKm: line.kind === 'cable' ? lengthKm : 0,
        circuits: way.circuits,
        voltageSource: way.voltageSource,
      })]
      if (a === node && a.startsWith('S|') && input.pieceInsideStation(line, start, index, a.slice(2))) {
        stationInternal.push({ groupId: a.slice(2), chain })
      } else {
        addLink(a, node, chain)
      }
      start = index
    }
  }
  for (const node of incident.keys()) if (isFreeNode(node)) worklist.add(node)

  const mergeParallels = (node: string): void => {
    const byOther = new Map<string, number[]>()
    for (const id of [...incident.get(node) ?? []].sort((left, right) => left - right)) {
      const other = otherEnd(links.get(id)!, node)
      const list = byOther.get(other)
      if (list) list.push(id)
      else byOther.set(other, [id])
    }
    for (const [other, ids] of byOther) {
      if (ids.length < 2) continue
      const chain: Chain = [parallelElement(ids.map(id => removeLink(id).chain))]
      parallelMerges.push({ a: node, b: other, chain })
      addLink(node, other, chain)
      if (isFreeNode(other)) worklist.add(other)
    }
  }
  const contract = (node: string): void => {
    const ids = [...incident.get(node) ?? []]
    if (ids.length !== 2) return
    const first = removeLink(ids[0]!)
    const second = removeLink(ids[1]!)
    const u = otherEnd(first, node)
    const v = otherEnd(second, node)
    addLink(u, v, [...first.chain, ...second.chain])
    if (isFreeNode(u)) worklist.add(u)
    if (isFreeNode(v)) worklist.add(v)
  }
  const drain = (): void => {
    while (worklist.size > 0) {
      const node = worklist.values().next().value!
      worklist.delete(node)
      mergeParallels(node)
      contract(node)
    }
  }
  drain()

  const dangling: DanglingCorridor[] = []
  const degree = (node: string): number => incident.get(node)?.size ?? 0
  for (;;) {
    const stubs = [...links.values()]
      .filter(link => (isFreeNode(link.a) && degree(link.a) === 1) || (isFreeNode(link.b) && degree(link.b) === 1))
      .sort((left, right) => left.id - right.id)
    if (stubs.length === 0) break
    for (const stub of stubs) {
      const danglingEnds = [stub.a, stub.b].filter(node => isFreeNode(node) && degree(node) === 1)
      const anchors = [stub.a, stub.b].filter(node => !danglingEnds.includes(node))
      removeLink(stub.id)
      dangling.push({ chain: stub.chain, anchor: anchors[0] ?? null, danglingKeys: danglingEnds.map(freeNodeKey) })
      for (const anchor of anchors) if (isFreeNode(anchor)) worklist.add(anchor)
    }
    drain()
  }

  // Phase-split ways that run all the way between two terminals form one circuit together.
  const byPair = new Map<string, number[]>()
  for (const link of [...links.values()].sort((left, right) => left.id - right.id)) {
    if (isFreeNode(link.a) || isFreeNode(link.b)) continue
    const circuits = chainCircuits(link.chain)
    if (!circuits.mapped || isWholeCircuitCount(circuits.value)) continue
    const pair = [link.a, link.b].sort(compareText).join('\u0000')
    const list = byPair.get(pair)
    if (list) list.push(link.id)
    else byPair.set(pair, [link.id])
  }
  for (const ids of byPair.values()) {
    if (ids.length < 2) continue
    const first = links.get(ids[0]!)!
    const chain: Chain = [parallelElement(ids.map(id => removeLink(id).chain))]
    parallelMerges.push({ a: first.a, b: first.b, chain })
    addLink(first.a, first.b, chain)
  }

  const junctionKeys = [...incident.entries()]
    .filter(([node, set]) => isFreeNode(node) && set.size >= 3)
    .map(([node]) => freeNodeKey(node))
    .sort(compareText)
  return {
    nodeOfKey,
    links: [...links.values()].sort((left, right) => left.id - right.id),
    junctionKeys,
    dangling,
    selfLoops,
    stationInternal,
    parallelMerges,
  }
}
