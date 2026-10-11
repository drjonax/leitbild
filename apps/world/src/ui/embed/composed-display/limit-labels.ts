import type { ComposedTrendThreshold } from '../../../packs/process-plant/displays/compose.ts'
import { bySeverity } from '../../../packs/process-plant/displays/display-text.ts'
import type { ComposedDisplayThreshold } from '../../../packs/process-plant/displays/ic-thresholds.ts'
import { gatesHold, limitInForce, type GateStates, type PlantModeNow } from '../../../packs/process-plant/displays/trend-reading.ts'

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

/**
 * How a limit is drawn in the Plant's current mode: acting where the I&C
 * applies it now; idle (faint, with its modes or the states it waits for)
 * where it acts only in other modes, or only while on/off states hold that do
 * not (SI on low pressure while SI-BLOCKED reads on), even with the value
 * past it and its rule still latched; qualified (dashed) while the mode is
 * not known yet.
 */
export const limitLook = (threshold: Pick<ComposedDisplayThreshold, 'modeIds' | 'gates'>, mode: PlantModeNow, gates: GateStates): 'acting' | 'qualified' | 'idle' =>
  !gatesHold(threshold, gates) ? 'idle'
    : threshold.modeIds === undefined ? 'acting' : mode === undefined ? 'qualified' : limitInForce(threshold, mode) ? 'acting' : 'idle'

/**
 * What an idle limit's second line says it waits for, as briefly as its mode
 * label: its modes where the mode leaves it idle ("Modes 1–3"), else the
 * on/off states it requires ("SI-BLOCKED off").
 */
export const idleText = (threshold: Pick<ComposedDisplayThreshold, 'modeIds' | 'modeLabel' | 'gatedBy'>, mode: PlantModeNow): string =>
  threshold.modeIds !== undefined && mode !== undefined && !limitInForce(threshold, mode) ? threshold.modeLabel! : (threshold.gatedBy ?? []).join(', ')

/** The alarm colour a limit's label takes: its rule's severity while the rule is active and the limit acts now. */
export const limitSeverity = (
  threshold: Pick<ComposedTrendThreshold, 'modeIds' | 'gates' | 'ruleIds' | 'severity'>,
  activeRuleIds: ReadonlySet<string>,
  mode: PlantModeNow,
  gates: GateStates,
): string | null =>
  limitLook(threshold, mode, gates) !== 'idle' && threshold.ruleIds.some(ruleId => activeRuleIds.has(ruleId)) ? threshold.severity ?? 'warning' : null

/** Limits drawn as one line: every limit at one value, each with a label of its own. */
export interface LimitLine<T> {
  readonly key: string
  readonly value: number
  /** Those that act now first, then the most severe first (bySeverity): the order their label names them in. */
  readonly members: ReadonlyArray<T>
  /** As the member most in force: acting, then qualified, then idle. */
  readonly look: 'acting' | 'qualified' | 'idle'
  readonly kind: 'trip' | 'alarm'
}

/**
 * Coincident limits merged into one line (evaluation run 22 drew two
 * identical "LO TRIP 20" lines for the reactor trip and the AFW start),
 * highest value first as they read down a gutter.
 */
export const limitLines = <T extends Pick<ComposedTrendThreshold, 'value' | 'kind' | 'severity' | 'reactorTrip' | 'modeIds' | 'gates'>>(thresholds: ReadonlyArray<T>, mode: PlantModeNow, gates: GateStates): ReadonlyArray<LimitLine<T>> => {
  const rank = { acting: 0, qualified: 1, idle: 2 } as const
  const values = [...new Set(thresholds.filter(threshold => threshold.kind !== 'control').map(threshold => threshold.value))].sort((left, right) => right - left)
  return values.map(value => {
    const members = thresholds.filter(threshold => threshold.kind !== 'control' && threshold.value === value)
      .sort((left, right) => rank[limitLook(left, mode, gates)] - rank[limitLook(right, mode, gates)] || bySeverity(left, right))
    const look = members.map(member => limitLook(member, mode, gates)).sort((left, right) => rank[left] - rank[right])[0]!
    return { key: String(value), value, members, look, kind: members.some(member => member.kind === 'trip') ? 'trip' : 'alarm' }
  })
}
