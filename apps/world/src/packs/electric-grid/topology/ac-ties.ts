import { chainPieces, type Chain } from './corridor-chain.ts'
import type { LonLat } from './geometry.ts'
import type { PreparedInterconnector, PreparedInterconnectors } from './interconnectors.ts'
import type { TopologyLedger } from './ledger.ts'
import { describeNode, type LevelDangling, type LevelLink, type LevelsResult } from './levels.ts'

// AC ties: the listed ways must all be in one or more corridors that start at the listed Norwegian
// station and end at a free way end (the mapped line leaves the extract abroad). Such a corridor
// becomes a branch to the area's boundary bus; anything else is ledgered, never guessed.

export type AcTie = { readonly link: LevelLink; readonly entry: PreparedInterconnector; readonly foreignEnd: LonLat }

export type AcTieResult = {
  readonly ties: ReadonlyArray<AcTie>
  readonly unclaimed: ReadonlyArray<LevelDangling>
}

const waysOf = (chain: Chain): ReadonlyArray<string> => chainPieces(chain).flatMap(piece => piece.osmWayIds)

export const resolveAcTies = (
  levels: LevelsResult,
  interconnectors: PreparedInterconnectors,
  coordinateOf: (key: string) => LonLat,
  ledger: TopologyLedger,
): AcTieResult => {
  const ties: AcTie[] = []
  const claimed = new Set<LevelDangling>()
  let syntheticId = -1
  for (const entry of interconnectors.ac) {
    const kv = entry.normalisedKv
    const listed = new Set(entry.osmWayIds)
    const usesListed = (chain: Chain): boolean => waysOf(chain).some(wayId => listed.has(wayId))
    const present = new Set([...levels.links, ...levels.dangling].filter(item => item.kv === kv).flatMap(item => waysOf(item.chain)))
    const missing = entry.osmWayIds.filter(wayId => !present.has(wayId))
    const stubs = levels.dangling.filter(stub => stub.kv === kv && usesListed(stub.chain))
    const base = { elementIds: [entry.id, ...entry.osmWayIds], voltageKv: kv, stationId: entry.norwegianGroup.id }
    if (stubs.length === 0) {
      const linked = levels.links.filter(link => link.kv === kv && usesListed(link.chain))
      ledger.add(linked.length > 0
        ? { ...base, reason: 'interconnector-terminal-mismatch', detail: `listed ways run between ${linked.map(link => `${describeNode(link.a)} and ${describeNode(link.b)}`).join('; ')}; no free end abroad` }
        : { ...base, reason: 'interconnector-unmatched', detail: `no ${kv} kV corridor uses the listed ways` })
      continue
    }
    if (missing.length > 0) {
      ledger.add({ ...base, reason: 'interconnector-way-missing', detail: `${missing.join(', ')} not operational ${kv} kV ways in the source` })
      continue
    }
    const inStubs = new Set(stubs.flatMap(stub => waysOf(stub.chain)))
    const elsewhere = entry.osmWayIds.filter(wayId => !inStubs.has(wayId))
    if (elsewhere.length > 0) {
      ledger.add({ ...base, reason: 'interconnector-terminal-mismatch', detail: `${elsewhere.join(', ')} lie in corridors that do not reach the border` })
      continue
    }
    for (const stub of stubs) {
      const anchoredHere = stub.anchor === `S|${entry.norwegianGroup.id}`
      if (!anchoredHere || claimed.has(stub)) {
        ledger.add({
          ...base,
          reason: 'interconnector-terminal-mismatch',
          detail: claimed.has(stub)
            ? 'the corridor is already claimed by another interconnector'
            : `the corridor to the free end starts at ${stub.anchor ? describeNode(stub.anchor) : 'another free end'}, not at ${entry.norwegianGroup.id}`,
        })
        continue
      }
      claimed.add(stub)
      ties.push({
        link: { id: syntheticId, a: stub.anchor!, b: `B|${entry.id}`, chain: stub.chain, kv },
        entry,
        foreignEnd: coordinateOf(stub.danglingKeys[0]!),
      })
      syntheticId -= 1
    }
  }
  return { ties, unclaimed: levels.dangling.filter(stub => !claimed.has(stub)) }
}
