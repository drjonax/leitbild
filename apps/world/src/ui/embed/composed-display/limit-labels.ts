// Where limit labels go: down a trend's right gutter, or along the head of a
// comparison's scale. Each label sits at its line where it can and is pushed
// along it, keeping a leader, so labels never overlap. Only where the room is
// too short for all of them do the labels that matter least fold into a
// neighbour's count ("(+1)"), never an active limit or one a value is heading
// for while a less important one could give way.

export interface LabelSlot {
  readonly key: string
  /** Where the label starts (top or left edge) when it sits at its line. */
  readonly want: number
  /** Its height down a gutter, its width along a scale. */
  readonly size: number
  /** A folded label joins a kept one of its own group (the limit's direction) where there is one. */
  readonly group: string
  /** Lower ranks are kept first when the labels do not all fit (limitLabelRanks). */
  readonly rank: number
}

export interface PlacedLabel {
  readonly key: string
  readonly start: number
  /** The labels folded into this one, counted after its name. */
  readonly folded: ReadonlyArray<string>
}

/**
 * Keeps labels by rank while they fit the room, then places them in order,
 * each at its line or pushed just clear of the one before it, and pulled
 * back from the room's end so the last one stays inside it. Labels given in
 * the order they read keep that order where several want one place.
 */
export const stackLabels = (
  slots: ReadonlyArray<LabelSlot>,
  room: { readonly start: number; readonly end: number },
): ReadonlyArray<PlacedLabel> => {
  const kept = new Set<LabelSlot>()
  let used = 0
  for (const slot of [...slots].sort((left, right) => left.rank - right.rank)) {
    // The most important label is always kept, even in a room too short for it.
    if (kept.size > 0 && used + slot.size > room.end - room.start) continue
    kept.add(slot)
    used += slot.size
  }
  const ordered = slots.filter(slot => kept.has(slot)).sort((left, right) => left.want - right.want)
  const starts = ordered.map(slot => slot.want)
  for (let index = 0; index < ordered.length; index += 1) {
    starts[index] = Math.max(starts[index]!, index === 0 ? room.start : starts[index - 1]! + ordered[index - 1]!.size)
  }
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    starts[index] = Math.min(starts[index]!, index === ordered.length - 1 ? room.end - ordered[index]!.size : starts[index + 1]! - ordered[index]!.size)
  }
  const middle = (slot: LabelSlot, start: number): number => start + slot.size / 2
  const folded = new Map(ordered.map(slot => [slot.key, [] as string[]]))
  for (const slot of slots.filter(candidate => !kept.has(candidate))) {
    const own = ordered.filter(candidate => candidate.group === slot.group)
    const nearest = (own.length > 0 ? own : ordered)
      .reduce((best, candidate) => Math.abs(middle(candidate, candidate.want) - middle(slot, slot.want)) < Math.abs(middle(best, best.want) - middle(slot, slot.want)) ? candidate : best)
    folded.get(nearest.key)!.push(slot.key)
  }
  return ordered.map((slot, index) => ({ key: slot.key, start: starts[index]!, folded: folded.get(slot.key)! }))
}

export interface RankedLimit {
  readonly key: string
  readonly value: number
  /** The severity of its active rule; null while the rule is quiet. */
  readonly active: string | null
  /** A value on the panel is heading for it (limitAhead). */
  readonly ahead: boolean
  /** It acts in the Plant's current mode (limitInForce). */
  readonly inForce: boolean
}

/**
 * The order limit labels are kept in when they do not all fit: active limits,
 * critical ones first; then each limit a value is heading for; then the rest,
 * nearest the value first; last those that do not act in the current mode.
 */
export const limitLabelRanks = (limits: ReadonlyArray<RankedLimit>, current: number | undefined): ReadonlyMap<string, number> => {
  const tier = (limit: RankedLimit): number => limit.active === 'critical' ? 0 : limit.active !== null ? 1 : limit.ahead ? 2 : limit.inForce ? 3 : 4
  const distance = (limit: RankedLimit): number => current === undefined ? 0 : Math.abs(limit.value - current)
  const ranked = [...limits].sort((left, right) => tier(left) - tier(right) || distance(left) - distance(right))
  return new Map(ranked.map((limit, index) => [limit.key, index]))
}
