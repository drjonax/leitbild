import type { AuditBranch } from './audit-graph.ts'

// The topology splits a way where it meets a tee junction or passes through a station, so several
// branches may carry one way. Branches with the same way set at one voltage are consecutive
// segments of it when they chain into a simple path; any other arrangement (two branches between
// the same buses, branches that do not chain) builds the same ways twice. A terminal a branch
// shares with another branch on one of its ways is a split point: the branch's geometric end
// there is a vertex inside the way, not one of the way's ends.

export interface WaySetGroup {
  readonly key: string
  readonly branches: ReadonlyArray<AuditBranch>
  /** True when the branches chain into one simple path of distinct buses. */
  readonly segments: boolean
  /** Inner buses of the path, where the way is split; empty when not segments. */
  readonly splitBusIds: ReadonlySet<string>
}

const waySetKey = (branch: Pick<AuditBranch, 'nominalKv' | 'osmWayIds'>): string =>
  `${branch.nominalKv}|${[...new Set(branch.osmWayIds)].sort().join('|')}`

const pathInnerBuses = (branches: ReadonlyArray<AuditBranch>): ReadonlySet<string> | null => {
  const neighbours = new Map<string, string[]>()
  for (const branch of branches) {
    for (const [bus, other] of [[branch.fromBusId, branch.toBusId], [branch.toBusId, branch.fromBusId]] as const) {
      neighbours.set(bus, [...(neighbours.get(bus) ?? []), other])
    }
  }
  if (branches.length !== neighbours.size - 1) return null
  if ([...neighbours.values()].some(list => list.length > 2 || new Set(list).size !== list.length)) return null
  const start = [...neighbours.keys()][0]!
  const seen = new Set([start])
  const stack = [start]
  while (stack.length > 0) {
    for (const next of neighbours.get(stack.pop()!)!) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  if (seen.size !== neighbours.size) return null
  return new Set([...neighbours].filter(([, list]) => list.length === 2).map(([bus]) => bus))
}

/** Groups of two or more branches sharing a voltage and an OSM way set; branches without ways are left out. */
export const waySetGroups = (branches: ReadonlyArray<AuditBranch>): ReadonlyArray<WaySetGroup> => {
  const byKey = new Map<string, AuditBranch[]>()
  for (const branch of branches) {
    if (branch.osmWayIds.length === 0) continue
    const key = waySetKey(branch)
    byKey.set(key, [...(byKey.get(key) ?? []), branch])
  }
  return [...byKey].filter(([, group]) => group.length > 1).map(([key, group]) => {
    const inner = pathInnerBuses(group)
    return { key, branches: group, segments: inner !== null, splitBusIds: inner ?? new Set<string>() }
  })
}

/** Per branch, its terminals shared with another branch that carries one of its ways at its voltage. */
export const splitTerminals = (branches: ReadonlyArray<AuditBranch>): ReadonlyMap<string, ReadonlySet<string>> => {
  const byWay = new Map<string, AuditBranch[]>()
  for (const branch of branches) {
    for (const wayId of new Set(branch.osmWayIds)) {
      const key = `${branch.nominalKv}|${wayId}`
      byWay.set(key, [...(byWay.get(key) ?? []), branch])
    }
  }
  const split = new Map<string, Set<string>>()
  for (const sharing of byWay.values()) {
    if (sharing.length < 2) continue
    for (const branch of sharing) {
      for (const other of sharing) {
        if (other === branch) continue
        for (const bus of [branch.fromBusId, branch.toBusId]) {
          if (bus !== other.fromBusId && bus !== other.toBusId) continue
          const set = split.get(branch.id) ?? new Set<string>()
          set.add(bus)
          split.set(branch.id, set)
        }
      }
    }
  }
  return split
}
