import { groupKey, simulationMs, type AlertRow, type AlertRowState } from './rows.ts'

// First-out annunciation from the alert facets (plan v3.1 §2.2, §5.4): one
// tile per first-out group a strip group's alarms name, each showing the
// group's lowest-ranked alarm in its own words; rank 1 is the first out. The
// group's id is never shown (R21). Tiles keep the order their groups came in.

export interface AnnunciatorTile {
  readonly firstOutGroup: string
  /** The shown alarm's own message. */
  readonly label: string
  readonly state: AlertRowState
  readonly rank: number
  readonly rowKey: string
}

export const annunciatorTiles = (rows: ReadonlyArray<AlertRow>, group: string): ReadonlyArray<AnnunciatorTile> => {
  const lowest = new Map<string, AlertRow>()
  for (const row of rows) {
    const firstOut = row.alert.firstOut
    if (firstOut === undefined || row.priority === 'none' || groupKey(row) !== group) continue
    const held = lowest.get(firstOut.group)
    if (held === undefined || firstOut.rank < held.alert.firstOut!.rank || (firstOut.rank === held.alert.firstOut!.rank && row.key < held.key)) lowest.set(firstOut.group, row)
  }
  return [...lowest.entries()]
    .sort(([leftGroup, left], [rightGroup, right]) => (simulationMs(left) ?? Infinity) - (simulationMs(right) ?? Infinity) || leftGroup.localeCompare(rightGroup))
    .map(([firstOutGroup, row]) => ({ firstOutGroup, label: row.alert.message, state: row.state, rank: row.alert.firstOut!.rank, rowKey: row.key }))
}
