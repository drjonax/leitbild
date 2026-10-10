import { compareText } from './ids.ts'
import type { TopologyLineInput } from './input.ts'
import type { TopologyLedger } from './ledger.ts'

// A 50 Hz way without a mapped voltage inherits one only when every end of its chain of
// voltage-less ways meets ways of one common voltage. Chains never continue through stations.

export type VoltageInferenceInput = {
  readonly unknownLines: ReadonlyArray<TopologyLineInput>
  readonly knownVoltagesAtKey: ReadonlyMap<string, ReadonlySet<number>>
  readonly stationAtKey: (key: string) => string | null    // station group id at a vertex, if any
}

const endKeys = (line: TopologyLineInput): readonly [string, string] =>
  [line.vertexKeys[0]!, line.vertexKeys[line.vertexKeys.length - 1]!]

export const inferVoltages = (input: VoltageInferenceInput, ledger: TopologyLedger): ReadonlyMap<string, number> => {
  const lines = [...input.unknownLines].sort((left, right) => compareText(left.featureId, right.featureId))
  const parent = lines.map((_, index) => index)
  const find = (value: number): number => {
    let root = value
    while (parent[root] !== root) root = parent[root]!
    parent[value] = root
    return root
  }
  const firstAtKey = new Map<string, number>()
  lines.forEach((line, index) => {
    for (const key of new Set(line.vertexKeys)) {
      if (input.stationAtKey(key) !== null) continue
      const other = firstAtKey.get(key)
      if (other === undefined) firstAtKey.set(key, index)
      else {
        const a = find(index)
        const b = find(other)
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
      }
    }
  })
  const clusters = new Map<number, TopologyLineInput[]>()
  lines.forEach((line, index) => {
    const root = find(index)
    const list = clusters.get(root)
    if (list) list.push(line)
    else clusters.set(root, [line])
  })

  const assigned = new Map<string, number>()
  for (const members of clusters.values()) {
    const counts = new Map<string, number>()
    for (const line of members) for (const key of line.vertexKeys) counts.set(key, (counts.get(key) ?? 0) + 1)
    const ends = [...new Set(members.flatMap(endKeys).filter(key => counts.get(key) === 1))].sort(compareText)
    const contacts = ends.map(key => input.knownVoltagesAtKey.get(key) ?? new Set<number>())
    const common = contacts.length === 0
      ? []
      : [...contacts[0]!].filter(kv => contacts.every(set => set.has(kv))).sort((left, right) => left - right)
    const ids = members.map(line => line.featureId)
    if (ends.length >= 2 && contacts.every(set => set.size > 0) && common.length === 1) {
      const kv = common[0]!
      for (const line of members) assigned.set(line.featureId, kv)
      ledger.add({
        reason: 'voltage-inherited',
        elementIds: [...ids, ...members.flatMap(line => line.osmWayIds)],
        voltageKv: kv,
        detail: `${members.length} voltage-less way(s); all ${ends.length} chain ends meet ${kv} kV ways`,
      })
      continue
    }
    const describeEnd = (key: string, index: number): string => {
      const set = contacts[index]!
      if (set.size > 0) return `${[...set].sort((l, r) => l - r).join('/')} kV`
      const station = input.stationAtKey(key)
      return station ? `station ${station}` : 'nothing'
    }
    const unmet = contacts.filter(set => set.size === 0).length
    const why = ends.length < 2
      ? `chain has ${ends.length} free end(s)`
      : unmet > 0
        ? `${unmet} of ${ends.length} chain ends meet no way of known voltage`
        : 'no single voltage common to all chain ends'
    const met = contacts.flatMap(set => [...set])
    ledger.add({
      reason: 'voltage-unknown',
      elementIds: [...ids, ...members.flatMap(line => line.osmWayIds)],
      ...(met.length > 0 ? { voltageKv: Math.max(...met) } : {}),
      detail: `${members.length} voltage-less way(s): ${why}; ends meet ${ends.map(describeEnd).join(' | ') || 'nothing'}`,
    })
  }
  return assigned
}
