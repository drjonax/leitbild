import type { TopologyLedger } from './ledger.ts'
import type { TopologyOptions } from './options.ts'
import { reportSameNameStations, type StationGroup } from './station-groups.ts'

// Observations about stations for audit and curation; nothing in the model depends on them.
export const reportStations = (
  groups: ReadonlyArray<StationGroup>,
  levelsOfGroup: ReadonlyMap<string, ReadonlySet<number>>,
  usedGroups: ReadonlySet<string>,
  options: TopologyOptions,
  ledger: TopologyLedger,
): void => {
  reportSameNameStations(groups, usedGroups, options, ledger)
  for (const group of groups) {
    const levels = levelsOfGroup.get(group.id)
    if (group.roles.includes('traction') && levels) {
      ledger.add({ reason: 'traction-station-fed', elementIds: group.members.map(member => member.station.featureId), location: group.location, stationId: group.id, detail: `railway converter fed at ${[...levels].join('/')} kV 50 Hz` })
    }
    const inScope = [...group.taggedVoltagesKv].filter(kv => kv >= options.minimumKv)
    if (inScope.length === 0 || usedGroups.has(group.id)) continue
    ledger.add({
      reason: 'station-without-corridor',
      elementIds: group.members.map(member => member.station.featureId),
      voltageKv: Math.max(...inScope),
      location: group.location,
      stationId: group.id,
      detail: `${group.label} is tagged ${inScope.sort((l, r) => r - l).join('/')} kV but no corridor at or above ${options.minimumKv} kV terminates there`,
    })
  }
}
