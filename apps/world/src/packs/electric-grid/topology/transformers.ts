import { compareText, stationBusId, transformerBranchId } from './ids.ts'
import type { TopologyTransformerInput } from './input.ts'
import type { TopologyLedger } from './ledger.ts'
import type { TopologyBranch } from './result.ts'
import type { StationGroup } from './station-groups.ts'

// Every station with buses at several AC levels gets transformer branches that connect all its
// levels: mapped OSM transformers first, then inferred units between adjacent levels that the
// mapped ones leave disconnected.

export type TransformerInput = {
  readonly groups: ReadonlyArray<StationGroup>
  readonly levelsOfGroup: ReadonlyMap<string, ReadonlySet<number>>
  readonly transformers: ReadonlyArray<TopologyTransformerInput>
  readonly groupOfPoint: (transformer: TopologyTransformerInput) => StationGroup | null
  readonly normaliseKv: (kv: number) => number
  readonly sourceIds: ReadonlyArray<string>
}

type MappedPair = { readonly ids: string[]; readonly ratings: Array<number | null> }

export const buildTransformerBranches = (input: TransformerInput, ledger: TopologyLedger): ReadonlyArray<TopologyBranch> => {
  const mapped = new Map<string, Map<string, MappedPair>>()
  for (const transformer of [...input.transformers].sort((left, right) => compareText(left.featureId, right.featureId))) {
    const windings = [...new Set(transformer.voltagesKv.map(input.normaliseKv))].sort((left, right) => right - left)
    const group = input.groupOfPoint(transformer)
    const levels = group ? input.levelsOfGroup.get(group.id) : undefined
    const high = windings[0]
    const low = windings[1]
    if (!group || high === undefined || low === undefined || !levels?.has(high) || !levels.has(low)) {
      ledger.add({
        reason: 'transformer-unmatched',
        elementIds: [transformer.featureId],
        location: transformer.location,
        ...(group ? { stationId: group.id } : {}),
        detail: !group
          ? 'transformer lies outside every station'
          : windings.length < 2
            ? 'transformer has fewer than two mapped winding voltages'
            : `windings ${high}/${low} kV are not both modelled levels of the station`,
      })
      continue
    }
    const pairs = mapped.get(group.id) ?? new Map<string, MappedPair>()
    const key = `${high}|${low}`
    const pair = pairs.get(key) ?? { ids: [], ratings: [] }
    pair.ids.push(transformer.featureId)
    pair.ratings.push(transformer.ratingMva)
    pairs.set(key, pair)
    mapped.set(group.id, pairs)
  }

  const branches: TopologyBranch[] = []
  for (const group of input.groups) {
    const levels = [...(input.levelsOfGroup.get(group.id) ?? [])].sort((left, right) => right - left)
    if (levels.length < 2) continue
    const component = new Map(levels.map(kv => [kv, kv]))
    const rootOf = (kv: number): number => {
      let root = kv
      while (component.get(root) !== root) root = component.get(root)!
      return root
    }
    const join = (high: number, low: number): void => { component.set(rootOf(low), rootOf(high)) }
    const branch = (high: number, low: number, units: MappedPair | null): TopologyBranch => ({
      id: transformerBranchId(group.id, high, low),
      label: `${group.label} ${high}/${low} kV`,
      kind: 'transformer',
      fromBusId: stationBusId(group.id, high),
      toBusId: stationBusId(group.id, low),
      nominalKv: high,
      lowKv: low,
      lengthKm: null,
      cableLengthKm: null,
      circuits: units ? units.ids.length : 1,
      circuitsSource: units ? 'transformer-count' : 'inferred',
      voltageSource: 'mapped',
      ratingMva: units && units.ratings.every(rating => rating !== null)
        ? units.ratings.reduce<number>((sum, rating) => sum + rating!, 0)
        : null,
      osmWayIds: [],
      sourceFeatureIds: units ? [...units.ids] : [],
      osmTransformerIds: units ? [...units.ids] : [],
      names: [],
      parallelSpanGroups: 0,
      interconnectorId: null,
      provenance: units
        ? { sources: [...input.sourceIds], method: 'mapped', confidence: 'high', note: null }
        : {
            sources: [...input.sourceIds],
            method: 'inferred',
            confidence: 'medium',
            note: `station has ${high} kV and ${low} kV buses and no mapped transformer joins these levels`,
          },
    })
    for (const [key, units] of [...(mapped.get(group.id) ?? new Map<string, MappedPair>())].sort(([left], [right]) => compareText(left, right))) {
      const [high, low] = key.split('|').map(Number) as [number, number]
      join(high, low)
      branches.push(branch(high, low, units))
    }
    for (let index = 1; index < levels.length; index += 1) {
      const high = levels[index - 1]!
      const low = levels[index]!
      if (rootOf(high) === rootOf(low)) continue
      join(high, low)
      branches.push(branch(high, low, null))
      ledger.add({
        reason: 'transformer-inferred',
        elementIds: group.members.map(member => member.station.featureId),
        voltageKv: high,
        location: group.location,
        stationId: group.id,
        detail: `inferred ${high}/${low} kV transformer joining the station's levels`,
      })
    }
  }
  return branches
}
