import { chainCableKm, chainCircuits, chainLengthKm, chainParallelGroups, chainPieces, isWholeCircuitCount } from './corridor-chain.ts'
import { freeNodeKey } from './corridor-graph.ts'
import { acBoundaryBusId, compareText, corridorBranchId, junctionBusId, stationBusId } from './ids.ts'
import type { LonLat } from './geometry.ts'
import type { TopologyKeyMode } from './input.ts'
import type { PreparedInterconnectors } from './interconnectors.ts'
import type { TopologyLedger } from './ledger.ts'
import type { LevelLink } from './levels.ts'
import type { TopologyBranch, TopologyProvenance } from './result.ts'

export type BranchContext = {
  readonly keyMode: TopologyKeyMode
  readonly interconnectors: PreparedInterconnectors
  readonly sourceIds: ReadonlyArray<string>
  readonly curationOfFeature: ReadonlyMap<string, string>
  readonly busLabel: (busId: string) => string
}

export const busIdOfNode = (context: Pick<BranchContext, 'keyMode' | 'interconnectors'>, node: string, kv: number): string => {
  if (node.startsWith('S|')) return stationBusId(node.slice(2), kv)
  if (node.startsWith('B|')) return acBoundaryBusId(context.interconnectors.byId.get(node.slice(2))!.externalArea, kv)
  return junctionBusId(context.keyMode, freeNodeKey(node), kv)
}

// Kilometre lengths are rounded to 0.1 m so the output is byte-stable across platforms.
const roundKm = (km: number): number => Math.round(km * 10_000) / 10_000

export const corridorBranch = (
  link: LevelLink,
  interconnector: { readonly id: string; readonly foreignEnd: LonLat } | null,
  context: BranchContext,
  ledger: TopologyLedger,
): TopologyBranch => {
  const pieces = chainPieces(link.chain)
  const osmWayIds = [...new Set(pieces.flatMap(piece => piece.osmWayIds))].sort(compareText)
  const sourceFeatureIds = [...new Set(pieces.map(piece => piece.featureId))].sort(compareText)
  const names = [...new Set(pieces.flatMap(piece => piece.name ? [piece.name] : []))].sort(compareText)
  const a = busIdOfNode(context, link.a, link.kv)
  const b = busIdOfNode(context, link.b, link.kv)
  const [fromBusId, toBusId] = link.a.startsWith('B|') ? [b, a] : link.b.startsWith('B|') ? [a, b] : [a, b].sort(compareText) as [string, string]
  const lengthKm = chainLengthKm(link.chain)
  const cableKm = chainCableKm(link.chain)
  const circuits = chainCircuits(link.chain)
  const whole = circuits.mapped && isWholeCircuitCount(circuits.value)
  const circuitCount = whole ? Math.round(circuits.value) : Math.max(1, Math.round(circuits.value))
  const inherited = pieces.some(piece => piece.voltageSource === 'inherited')
  const id = corridorBranchId(link.kv, osmWayIds, [fromBusId, toBusId])
  if (!whole) {
    ledger.add({
      reason: 'circuits-inferred',
      elementIds: [id, ...osmWayIds],
      voltageKv: link.kv,
      detail: circuits.mapped
        ? `mapped conductors give ${Number(circuits.value.toFixed(3))} circuits; modelled as ${circuitCount}`
        : `no circuits, cables or route relation mapped; modelled as ${circuitCount}`,
    })
  }
  const curations = [...new Set(pieces.flatMap(piece => context.curationOfFeature.get(piece.featureId) ?? []))].sort(compareText)
  const notes = [
    ...(curations.length > 0 ? [`lifecycle tag overridden by ${curations.join(', ')}`] : []),
    ...(inherited ? ['voltage inherited from adjacent ways'] : []),
    ...(!whole ? [`circuit count inferred (${circuitCount})`] : []),
  ]
  const provenance: TopologyProvenance = {
    sources: [...context.sourceIds],
    method: curations.length > 0 ? 'curated' : notes.length > 0 ? 'inferred' : 'mapped',
    confidence: inherited ? 'low' : notes.length > 0 ? 'medium' : 'high',
    note: notes.length > 0 ? notes.join('; ') : null,
  }
  return {
    id,
    label: names.length > 0 ? names.join(' / ') : `${context.busLabel(fromBusId)} – ${context.busLabel(toBusId)}`,
    kind: cableKm > lengthKm / 2 ? 'cable' : 'ac_line',
    fromBusId,
    toBusId,
    nominalKv: link.kv,
    lowKv: null,
    lengthKm: roundKm(lengthKm),
    cableLengthKm: roundKm(cableKm),
    circuits: circuitCount,
    circuitsSource: whole ? circuits.source : 'inferred',
    voltageSource: inherited ? 'inherited' : 'mapped',
    ratingMva: null,
    osmWayIds,
    sourceFeatureIds,
    osmTransformerIds: [],
    names,
    parallelSpanGroups: chainParallelGroups(link.chain),
    interconnectorId: interconnector?.id ?? null,
    foreignEnd: interconnector?.foreignEnd ?? null,
    provenance,
  }
}
