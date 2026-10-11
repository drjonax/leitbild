import { compareText } from './ids.ts'
import type { TopologyLineInput } from './input.ts'
import type { TopologyLedger } from './ledger.ts'

// A 50 Hz way without a mapped voltage inherits one only when every end of its chain of
// voltage-less ways meets ways of one common voltage, or ends in a station tagged with that voltage
// (a voltage-less last span into a station; PM 2026-10-10), with at least one end on a way.
// Chains never continue through stations.

export type StationAtKey = { readonly stationId: string; readonly taggedKv: ReadonlySet<number> }

export type VoltageInferenceInput = {
  readonly unknownLines: ReadonlyArray<TopologyLineInput>
  readonly knownVoltagesAtKey: ReadonlyMap<string, ReadonlySet<number>>
  readonly stationAtKey: (key: string) => StationAtKey | null
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
      if (input.stationAtKey(key)) continue
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
    const stations = ends.map((key, index) => contacts[index]!.size === 0 ? input.stationAtKey(key) : null)
    const evidence = contacts.map((set, index) => set.size > 0 ? set : stations[index]?.taggedKv ?? new Set<number>())
    const common = evidence.length === 0
      ? []
      : [...evidence[0]!].filter(kv => evidence.every(set => set.has(kv))).sort((left, right) => left - right)
    const ids = members.map(line => line.featureId)
    const wayEnds = contacts.filter(set => set.size > 0).length
    if (ends.length >= 2 && wayEnds >= 1 && evidence.every(set => set.size > 0) && common.length === 1) {
      const kv = common[0]!
      for (const line of members) assigned.set(line.featureId, kv)
      const stationEnds = stations.flatMap(station => station ? [station.stationId] : [])
      ledger.add({
        reason: 'voltage-inherited',
        elementIds: [...ids, ...members.flatMap(line => line.osmWayIds)],
        voltageKv: kv,
        ...(stationEnds[0] ? { stationId: stationEnds[0] } : {}),
        detail: stationEnds.length === 0
          ? `${members.length} voltage-less way(s); all ${ends.length} chain ends meet ${kv} kV ways`
          : `${members.length} voltage-less way(s); ${wayEnds} chain end(s) meet ${kv} kV ways and ${stationEnds.length} end(s) terminate in station(s) tagged ${kv} kV: ${stationEnds.join(', ')}`,
      })
      continue
    }
    const describeEnd = (key: string, index: number): string => {
      const set = contacts[index]!
      if (set.size > 0) return `${[...set].sort((l, r) => l - r).join('/')} kV`
      const station = stations[index]
      return station ? `station ${station.stationId} tagged ${[...station.taggedKv].sort((l, r) => r - l).join('/') || 'without voltage'}` : 'nothing'
    }
    const unmet = evidence.filter(set => set.size === 0).length
    const why = ends.length < 2
      ? `chain has ${ends.length} free end(s)`
      : unmet > 0
        ? `${unmet} of ${ends.length} chain ends meet neither a way of known voltage nor a voltage-tagged station`
        : wayEnds === 0
          ? 'every chain end is in a station; none meets a way of known voltage'
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
