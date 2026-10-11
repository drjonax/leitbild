import { stationBusId } from './ids.ts'
import type { TopologyLedger } from './ledger.ts'
import type { BusTie } from './bus-merge.ts'
import type { TopologyOptions } from './options.ts'
import type { SpanningBusbar } from './terminals.ts'

// A busbar or bay that spans two station polygons of its own voltage connects those stations at
// that level (PM 2026-10-10). The busbar voltage decides; an untagged busbar takes the one level
// every touched station is tagged with. The stations' buses at that level are merged later; a
// station that lacks the level gains it, so its transformers reach the shared busbar.
export const busbarTies = (
  spanning: ReadonlyArray<SpanningBusbar>,
  levelsOfGroup: Map<string, Set<number>>,
  normaliseKv: (kv: number) => number,
  options: TopologyOptions,
  ledger: TopologyLedger,
): ReadonlyArray<BusTie> => {
  const ties: BusTie[] = []
  for (const { busbar, groups } of spanning) {
    const elementIds = [busbar.featureId, ...busbar.osmWayIds, ...groups.map(group => group.representative.station.featureId)]
    const stationsDetail = groups.map(group => group.id).join(', ')
    const tagged = [...new Set(busbar.voltagesKv.map(normaliseKv))]
    const taggedStations = groups.filter(group => group.taggedVoltagesKv.size > 0)
    const candidates = tagged.length > 0
      ? tagged
      : taggedStations.length === 0 ? [] : [...taggedStations[0]!.taggedVoltagesKv].filter(kv => taggedStations.every(group => group.taggedVoltagesKv.has(kv)))
    const inScope = candidates.filter(kv => kv >= options.minimumKv)
    if (candidates.length > 0 && inScope.length === 0) {
      ledger.add({ reason: 'below-minimum-voltage', elementIds, voltageKv: Math.max(...candidates), detail: `busbar/bay at ${candidates.join('/')} kV spans stations ${stationsDetail}` })
      continue
    }
    const levels = inScope.filter(kv =>
      groups.every(group => group.taggedVoltagesKv.size === 0 || group.taggedVoltagesKv.has(kv)) &&
      groups.some(group => levelsOfGroup.get(group.id)?.has(kv)))
    if (levels.length === 0) {
      ledger.add({
        reason: 'busbar-spans-stations',
        elementIds,
        location: busbar.coordinates[0]!,
        detail: inScope.length === 0
          ? `busbar/bay without a voltage spans stations ${stationsDetail} with no common tagged level`
          : `busbar/bay at ${inScope.join('/')} kV spans stations ${stationsDetail} that are not all tagged with it or carry no corridor at it`,
      })
      continue
    }
    for (const kv of levels) {
      for (const group of groups) {
        const set = levelsOfGroup.get(group.id) ?? new Set<number>()
        set.add(kv)
        levelsOfGroup.set(group.id, set)
      }
      for (const group of groups.slice(1)) {
        ties.push({
          a: stationBusId(groups[0]!.id, kv),
          b: stationBusId(group.id, kv),
          reason: 'busbar-tie-merged',
          elementIds,
          voltageKv: kv,
          detail: `busbar/bay ${busbar.featureId} spans ${groups[0]!.id} and ${group.id} at ${kv} kV`,
          removedBranchId: null,
        })
      }
    }
  }
  return ties
}
