import type { TopologyCircuitsSource } from './result.ts'

// A corridor is a series of elements; an element is one way piece or a group of parallel chains
// that share both end nodes (phase-split fjord spans, double circuits mapped as separate ways).

export type CircuitEvidence = {
  readonly value: number                 // circuits; fractional for phase-split ways (cables=1 → 1/3)
  readonly source: TopologyCircuitsSource
}

export type WayPiece = {
  readonly featureId: string
  readonly osmWayIds: ReadonlyArray<string>
  readonly name: string | null
  readonly lengthKm: number
  readonly cableKm: number
  readonly circuits: CircuitEvidence
  readonly voltageSource: 'mapped' | 'inherited'
}

export type ChainElement =
  | { readonly kind: 'piece'; readonly piece: WayPiece }
  | { readonly kind: 'parallel'; readonly members: ReadonlyArray<ReadonlyArray<ChainElement>> }

export type Chain = ReadonlyArray<ChainElement>

export const pieceElement = (piece: WayPiece): ChainElement => ({ kind: 'piece', piece })

export const parallelElement = (members: ReadonlyArray<Chain>): ChainElement => ({ kind: 'parallel', members })

const mean = (values: ReadonlyArray<number>): number => values.reduce((sum, value) => sum + value, 0) / values.length

export const chainLengthKm = (chain: Chain): number =>
  chain.reduce((sum, element) => sum + (element.kind === 'piece' ? element.piece.lengthKm : mean(element.members.map(chainLengthKm))), 0)

export const chainCableKm = (chain: Chain): number =>
  chain.reduce((sum, element) => sum + (element.kind === 'piece' ? element.piece.cableKm : mean(element.members.map(chainCableKm))), 0)

export const chainPieces = (chain: Chain): ReadonlyArray<WayPiece> =>
  chain.flatMap(element => element.kind === 'piece' ? [element.piece] : element.members.flatMap(chainPieces))

export const chainParallelGroups = (chain: Chain): number =>
  chain.reduce((sum, element) => sum + (element.kind === 'piece' ? 0 : 1 + element.members.reduce((inner, member) => inner + chainParallelGroups(member), 0)), 0)

export type ChainCircuits = {
  readonly value: number
  readonly mapped: boolean               // false when no element along the corridor carries mapped evidence
  readonly source: TopologyCircuitsSource
}

// Ordered weakest first: a corridor reports the weakest source among the evidence it relies on.
const sourceStrength: Readonly<Record<TopologyCircuitsSource, number>> = {
  'inferred': 0,
  'cables-tag': 1,
  'voltage-list': 2,
  'circuits-tag': 2,
  'route-relation': 3,
  'transformer-count': 3,
}

const weakest = (sources: ReadonlyArray<TopologyCircuitsSource>): TopologyCircuitsSource =>
  [...sources].sort((left, right) => sourceStrength[left] - sourceStrength[right])[0]!

const elementCircuits = (element: ChainElement): ChainCircuits => {
  if (element.kind === 'piece') {
    const evidence = element.piece.circuits
    return { value: evidence.value, mapped: evidence.source !== 'inferred', source: evidence.source }
  }
  const members = element.members.map(chainCircuits)
  return {
    value: members.reduce((sum, member) => sum + member.value, 0),
    mapped: members.every(member => member.mapped),
    source: weakest(members.map(member => member.source)),
  }
}

// Series elements: the bottleneck among mapped elements decides; unmapped elements count only when
// nothing along the corridor is mapped.
export const chainCircuits = (chain: Chain): ChainCircuits => {
  const elements = chain.map(elementCircuits)
  const mapped = elements.filter(element => element.mapped)
  const pool = mapped.length > 0 ? mapped : elements
  const value = Math.min(...pool.map(element => element.value))
  const determining = pool.filter(element => element.value === value)
  return { value, mapped: mapped.length > 0, source: weakest(determining.map(element => element.source)) }
}

// Within 1e-6 of an integer counts as that integer (sums of thirds from phase-split cables).
const integerTolerance = 1e-6

export const isWholeCircuitCount = (value: number): boolean =>
  Math.abs(value - Math.round(value)) < integerTolerance && Math.round(value) >= 1
