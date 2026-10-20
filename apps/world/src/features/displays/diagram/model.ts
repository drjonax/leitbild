// The validated, canonically ordered form of a DiagramGraph. Every later
// stage works on indices into these arrays, so no stage can depend on input
// order, Map iteration order or ids: nodes sort by (partition, rank), ports by
// rank, edges by (endpoints, port ranks, rank).
import type { DiagramGraph, DiagramNode, DiagramProfile, DiagramRoom } from './diagram.ts'

export type Role = DiagramNode['role']

export interface ModelPort {
  readonly id: string
  readonly rank: string
  /** How the port's edges use it; a port is never both a source and a target. */
  readonly use: 'source' | 'target' | 'unused'
}

export interface ModelNode {
  readonly index: number
  readonly id: string
  readonly rank: string
  readonly role: Role
  /** Footprint in screen cells. */
  readonly width: number
  readonly height: number
  /** Sorted by rank. */
  readonly ports: ReadonlyArray<ModelPort>
  /** Index into Model.partitions. */
  readonly partition: number | null
  readonly lines: ReadonlyArray<{ readonly width: number; readonly height: number; readonly required: boolean }>
  readonly portInset: number
  /** A common node's reach past its port tracks at its screen top and bottom (DiagramNode.ends); a grid step where it declares none. */
  readonly ends: { readonly top: number; readonly bottom: number } | null
  readonly frameable: boolean
  /** Widest flap label; 0 when the node has none. */
  readonly flapWidth: number
  /** Lines the flap takes. */
  readonly flapLines: number
}

export interface ModelEdge {
  readonly index: number
  readonly id: string
  readonly from: number
  readonly fromPort: number
  readonly to: number
  readonly toPort: number
}

export interface Model {
  readonly nodes: ReadonlyArray<ModelNode>
  readonly edges: ReadonlyArray<ModelEdge>
  /** Partition keys in partition order. */
  readonly partitions: ReadonlyArray<string>
}

/** Locale-independent string order. */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0
const isSize = (value: number): boolean => Number.isFinite(value) && value >= 0

export const validateProfile = (profile: DiagramProfile): void => {
  const issues: string[] = []
  if (!Number.isInteger(profile.grid) || profile.grid <= 0 || profile.grid % 2 !== 0) issues.push('grid must be a positive even integer')
  if (!Number.isInteger(profile.cell) || profile.cell <= 0 || profile.cell % profile.grid !== 0) issues.push('cell must be a positive multiple of grid')
  if (!(profile.pipe.outline > 0) || !Number.isFinite(profile.pipe.outline)) issues.push('pipe.outline must be positive')
  if (!isSize(profile.pipe.cornerRadius)) issues.push('pipe.cornerRadius must be a size')
  if (!isSize(profile.pipe.crossingHalfGap)) issues.push('pipe.crossingHalfGap must be a size')
  if (!isSize(profile.pipe.trackGap)) issues.push('pipe.trackGap must be a size')
  for (const key of ['textClearance', 'frameMargin', 'flapHeight', 'flapLabelPadding'] as const) if (!isSize(profile[key])) issues.push(`${key} must be a size`)
  for (const [key, value] of Object.entries(profile.limits)) if (!isCount(value)) issues.push(`limits.${key} must be a count`)
  if (profile.fit.length === 0) issues.push('fit needs at least one rung')
  const rungs = profile.fit.map(rung => `${rung.detail}/${rung.text}`)
  if (new Set(rungs).size !== rungs.length) issues.push('fit repeats a rung')
  if (issues.length > 0) throw new Error(`invalid diagram profile: ${issues.join('; ')}`)
}

export const validateRoom = (room: DiagramRoom): void => {
  const issues = (['maxWidth', 'maxHeight'] as const).filter(key => !(room[key] > 0) || !Number.isFinite(room[key])).map(key => `${key} must be positive`)
  if (issues.length > 0) throw new Error(`invalid diagram room: ${issues.join('; ')}`)
}

export const buildModel = (graph: DiagramGraph): Model => {
  const issues: string[] = []
  if (graph.nodes.length === 0) issues.push('a diagram needs at least one node')

  // Partitions: one order per key, one key per order.
  const partitionOrderByKey = new Map<string, number>()
  for (const node of graph.nodes) {
    if (node.partition === undefined) continue
    if (node.partition.key.length === 0 || !Number.isInteger(node.partition.order)) issues.push(`node ${node.id} has an invalid partition`)
    const known = partitionOrderByKey.get(node.partition.key)
    if (known !== undefined && known !== node.partition.order) issues.push(`partition ${node.partition.key} has two orders`)
    partitionOrderByKey.set(node.partition.key, node.partition.order)
  }
  const partitionEntries = [...partitionOrderByKey].sort((a, b) => a[1] - b[1])
  for (let i = 1; i < partitionEntries.length; i++) {
    if (partitionEntries[i]![1] === partitionEntries[i - 1]![1]) issues.push(`partitions ${partitionEntries[i - 1]![0]} and ${partitionEntries[i]![0]} share order ${partitionEntries[i]![1]}`)
  }
  const partitions = partitionEntries.map(([key]) => key)
  const partitionIndex = new Map(partitions.map((key, index) => [key, index]))

  // Node order: partition-less nodes first, then partition by partition; rank within.
  const partitionOf = (node: DiagramNode): number | null => (node.partition === undefined ? null : partitionIndex.get(node.partition.key) ?? null)
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (ids.has(node.id)) issues.push(`node id ${node.id} is not unique`)
    ids.add(node.id)
    if (node.role === 'bar' || node.role === 'common') {
      if (node.partition !== undefined) issues.push(`${node.role} ${node.id} cannot belong to a partition; it serves partitions`)
    }
    if (node.role !== 'bar' && (!Number.isInteger(node.cells.width) || node.cells.width < 1 || !Number.isInteger(node.cells.height) || node.cells.height < 1)) {
      issues.push(`node ${node.id} needs a footprint of whole cells`)
    }
    for (const line of node.text.lines) if (!isSize(line.width) || !(line.height > 0) || !Number.isFinite(line.height)) issues.push(`node ${node.id} has a text line of invalid size`)
    if (!isSize(node.portInset)) issues.push(`node ${node.id} has an invalid port inset`)
    if (node.ends !== undefined && (node.role !== 'common' || !isSize(node.ends.top) || !isSize(node.ends.bottom))) issues.push(`node ${node.id} has ends but is not a common node, or they are not sizes`)
    if (node.flapWidth !== undefined && (!node.frameable || !isSize(node.flapWidth))) issues.push(`node ${node.id} has a flap width but is not frameable, or the width is invalid`)
    if (node.flapLines !== undefined && (!node.frameable || !Number.isInteger(node.flapLines) || node.flapLines < 1)) issues.push(`node ${node.id} has flap lines but is not frameable, or the count is not a whole number of lines`)
    const portIds = new Set<string>()
    const portRanks = new Set<string>()
    for (const port of node.ports) {
      if (portIds.has(port.id)) issues.push(`node ${node.id} repeats port ${port.id}`)
      if (portRanks.has(port.rank)) issues.push(`node ${node.id} repeats port rank ${port.rank}`)
      portIds.add(port.id)
      portRanks.add(port.rank)
    }
  }
  const sortedNodes = [...graph.nodes].sort((a, b) => ((partitionOf(a) ?? -1) - (partitionOf(b) ?? -1)) || compareText(a.rank, b.rank))
  for (let i = 1; i < sortedNodes.length; i++) {
    const a = sortedNodes[i - 1]!
    const b = sortedNodes[i]!
    if (partitionOf(a) === partitionOf(b) && a.rank === b.rank) issues.push(`nodes ${a.id} and ${b.id} share rank ${a.rank} in one partition`)
  }
  const nodeIndex = new Map(sortedNodes.map((node, index) => [node.id, index]))
  const sortedPorts = sortedNodes.map(node => [...node.ports].sort((a, b) => compareText(a.rank, b.rank)))

  // Edges: endpoints must exist and respect port direction.
  const uses = sortedPorts.map(ports => ports.map(() => new Set<'source' | 'target'>()))
  const resolved: Array<{ edge: DiagramGraph['edges'][number]; from: number; fromPort: number; to: number; toPort: number }> = []
  const edgeIds = new Set<string>()
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) issues.push(`edge id ${edge.id} is not unique`)
    edgeIds.add(edge.id)
    const from = nodeIndex.get(edge.from.node)
    const to = nodeIndex.get(edge.to.node)
    if (from === undefined || to === undefined) {
      issues.push(`edge ${edge.id} names a missing node`)
      continue
    }
    if (from === to) {
      issues.push(`edge ${edge.id} connects node ${edge.from.node} to itself`)
      continue
    }
    const fromPort = sortedPorts[from]!.findIndex(port => port.id === edge.from.port)
    const toPort = sortedPorts[to]!.findIndex(port => port.id === edge.to.port)
    if (fromPort < 0 || toPort < 0) {
      issues.push(`edge ${edge.id} names a missing port`)
      continue
    }
    if (sortedPorts[from]![fromPort]!.direction === 'in') issues.push(`edge ${edge.id} leaves through in-port ${edge.from.node}.${edge.from.port}`)
    if (sortedPorts[to]![toPort]!.direction === 'out') issues.push(`edge ${edge.id} enters through out-port ${edge.to.node}.${edge.to.port}`)
    uses[from]![fromPort]!.add('source')
    uses[to]![toPort]!.add('target')
    resolved.push({ edge, from, fromPort, to, toPort })
  }
  sortedNodes.forEach((node, n) => sortedPorts[n]!.forEach((port, p) => {
    if (uses[n]![p]!.size > 1) issues.push(`port ${node.id}.${port.id} is both a source and a target; split it into an in-port and an out-port`)
  }))

  const portRank = (n: number, p: number): string => sortedPorts[n]![p]!.rank
  resolved.sort((a, b) =>
    (a.from - b.from) || compareText(portRank(a.from, a.fromPort), portRank(b.from, b.fromPort))
    || (a.to - b.to) || compareText(portRank(a.to, a.toPort), portRank(b.to, b.toPort))
    || compareText(a.edge.rank, b.edge.rank))
  for (let i = 1; i < resolved.length; i++) {
    const a = resolved[i - 1]!
    const b = resolved[i]!
    if (a.from === b.from && a.fromPort === b.fromPort && a.to === b.to && a.toPort === b.toPort && a.edge.rank === b.edge.rank) {
      issues.push(`edges ${a.edge.id} and ${b.edge.id} are indistinguishable; give them distinct ranks`)
    }
  }
  if (issues.length > 0) throw new Error(`invalid diagram graph: ${issues.join('; ')}`)

  const nodes: ModelNode[] = sortedNodes.map((node, index) => ({
    index,
    id: node.id,
    rank: node.rank,
    role: node.role,
    width: node.role === 'bar' ? 0 : node.cells.width,
    height: node.role === 'bar' ? 0 : node.cells.height,
    ports: sortedPorts[index]!.map((port, p) => {
      const use = uses[index]![p]!
      return { id: port.id, rank: port.rank, use: use.has('source') ? 'source' : use.has('target') ? 'target' : 'unused' }
    }),
    partition: partitionOf(node),
    lines: node.text.lines,
    portInset: node.portInset,
    ends: node.ends ?? null,
    frameable: node.frameable,
    flapWidth: node.flapWidth ?? 0,
    flapLines: node.flapLines ?? 1,
  }))
  const edges: ModelEdge[] = resolved.map((entry, index) => ({
    index,
    id: entry.edge.id,
    from: entry.from,
    fromPort: entry.fromPort,
    to: entry.to,
    toPort: entry.toPort,
  }))
  return { nodes, edges, partitions }
}
