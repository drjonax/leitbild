import { routeDistanceMeters, type GeoJsonPoint, type ScenarioSide } from '../../../core/model/index.ts'
import type { UnitType } from '../config-schema.ts'
import type { BoardRecords, BoardTrack, BoardUnit } from './records.ts'
import type { BoardRules } from './rules.ts'
import { clockText, distanceText, word } from './text.ts'
import type { ContactGroup, ContactRow, ContactSide, ContactsView } from './types.ts'

/**
 * The Contacts list of a sensing or firing role: the tracks in the screen's
 * picture, nothing collapsed, in two groups, each nearest first.
 *
 * - Engageable: an identified track holding a fire-control fix, of a side
 *   hostile to its own side, that one of the viewer's armed units on that
 *   side could fire on now: its effector targets the track's type and the
 *   track lies within its range. A unit's rules of engagement then decide
 *   whether it does; the unit board shows them, and "engaged by" counts the
 *   units that fired on the track in the last engagement step.
 * - Other: every other track: contacts, tracks without a fix, out of reach
 *   or destroyed.
 *
 * A track names what its side identified, its type's label and icon, never
 * the type itself; the type is found as the declared types bearing that
 * label and icon, and the track counts as a target only when every one of
 * them carries a tag the effector targets. An identity no declared type
 * bears is an error: the engine identifies only declared types. (Two types
 * sharing a label and icon are thus a target only when both are; the engine
 * knows the true type, so this conservative rule waits for T5's engine
 * follow-up.)
 *
 * A side's serials are its own, so two sides' "T-1" are different tracks. A
 * screen holding more than one side's tracks lists each side apart, under
 * the side's label as the Run declares it; in a Run that declares no sides
 * the configuration's side id is the only name a side has.
 */

/** A side's label as the Run declares it, for a screen that holds several sides' tracks. */
export type SideLabel = Pick<ScenarioSide, 'id' | 'label'>

/** The plan's wording for a track without a fire-control fix. */
export const noFixText = 'No fire-control fix: contact report only'
export const detectionHover = 'Abstract detection: range × signature × posture; no terrain or line of sight'
/** The icon of a track the side has not identified: a catalogue icon that says nothing of what was seen. */
export const contactIcon = 'circle-question-mark'

/** The side whose picture holds a track: its single audience side; the engine writes no other track. */
const observingSide = (track: BoardTrack): string => {
  if (!Array.isArray(track.audience) || track.audience.length !== 1) throw new Error(`Track ${track.label} (${track.id}) names no single observing side`)
  return track.audience[0]!
}

const tierWord = (rules: BoardRules, track: BoardTrack): string =>
  word(rules, track.tier === 'contact' ? 'contact' : track.tier === 'identified' ? 'identified' : 'destroyed')

/** The viewer's units on the track's side that are in action. */
const ownUnits = (rules: BoardRules, records: BoardRecords, track: BoardTrack): ReadonlyArray<BoardUnit & { readonly point: GeoJsonPoint }> => {
  const side = observingSide(track)
  return [...records.units.values()].filter((unit): unit is BoardUnit & { readonly point: GeoJsonPoint } =>
    rules.commands(unit) && unit.side === side && unit.integrity !== 'destroyed' && unit.point !== undefined)
}

/** The declared types bearing what a track identified; a track that identified nothing bears none. */
const identifiedTypes = (rules: BoardRules, track: BoardTrack): ReadonlyArray<UnitType> => {
  const identity = track.identity
  if (identity === undefined) return []
  const types = rules.config.unitTypes.filter(type => type.label === identity.typeLabel && type.icon === identity.icon)
  if (types.length === 0) throw new Error(`Track ${track.label} is identified as ${identity.typeLabel}/${identity.icon}, which no declared unit type bears`)
  return types
}

/** Whether one of the viewer's armed units on the track's side could fire on it now, its rules of engagement aside. */
export const engageable = (rules: BoardRules, records: BoardRecords, track: BoardTrack): boolean => {
  const types = identifiedTypes(rules, track)
  const identity = track.identity
  if (track.tier !== 'identified' || !track.fix || identity === undefined || track.point === undefined) return false
  const point = track.point
  return ownUnits(rules, records, track).some(unit => {
    const effector = rules.typeOf(unit).components.effector
    if (effector === undefined || unit.side === undefined) return false
    return (rules.config.hostility[unit.side] ?? []).includes(identity.side)
      && types.every(type => type.tags.some(tag => effector.targets.includes(tag)))
      && routeDistanceMeters(unit.point, point) <= effector.rangeM
  })
}

const nearestMetres = (rules: BoardRules, records: BoardRecords, track: BoardTrack): number => {
  const point = track.point
  if (point === undefined) return Number.POSITIVE_INFINITY
  return Math.min(Number.POSITIVE_INFINITY, ...ownUnits(rules, records, track).map(unit => routeDistanceMeters(unit.point, point)))
}

const contactRow = (rules: BoardRules, records: BoardRecords, track: BoardTrack, metres: number, nowMs: number): ContactRow => {
  const engagedBy = [...records.units.values()].filter(unit => unit.target === track.id && unit.side === observingSide(track)).length
  return {
    id: track.id,
    label: track.label,
    tierText: tierWord(rules, track),
    typeLabel: track.identity?.typeLabel ?? null,
    icon: track.identity?.icon ?? contactIcon,
    ageText: track.observedAtMs === undefined ? null : clockText((nowMs - track.observedAtMs) / 1_000),
    distanceText: Number.isFinite(metres) ? distanceText(metres) : null,
    fixText: track.tier !== 'destroyed' && !track.fix ? noFixText : null,
    engagedText: engagedBy > 0 ? `engaged by ${engagedBy}` : null,
    destroyed: track.tier === 'destroyed',
  }
}

const byLabel = (a: BoardTrack, b: BoardTrack): number => a.label.localeCompare(b.label, 'en', { numeric: true }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The observing sides in declared order; in a Run that declares no sides, by id. A track of a side the Run does not declare is an error. */
const sideOrder = (observing: ReadonlySet<string>, declared: ReadonlyArray<SideLabel>): ReadonlyArray<SideLabel> => {
  if (declared.length === 0) return [...observing].sort().map(id => ({ id, label: id }))
  const undeclared = [...observing].filter(id => !declared.some(side => side.id === id))
  if (undeclared.length > 0) throw new Error(`The screen holds tracks of sides the Run does not declare: ${undeclared.join(', ')}`)
  return declared.filter(side => observing.has(side.id))
}

/**
 * The screen's tracks in the Contacts list. `sides` are the sides the Run
 * declares, for their labels; none in a Run that declares none.
 */
export const contactsView = (rules: BoardRules, records: BoardRecords, nowMs: number, sides: ReadonlyArray<SideLabel>): ContactsView => {
  const ranked = [...records.tracks.values()]
    .map(track => ({ track, side: observingSide(track), metres: nearestMetres(rules, records, track), engageable: engageable(rules, records, track) }))
    .sort((a, b) => a.metres - b.metres || byLabel(a.track, b.track))
  const group = (entries: typeof ranked, wanted: boolean, heading: string): ContactGroup => {
    const rows: ReadonlyArray<ContactRow> = entries
      .filter(entry => entry.engageable === wanted)
      .map(entry => contactRow(rules, records, entry.track, entry.metres, nowMs))
    return { heading, rows, empty: rows.length === 0 ? word(rules, 'noTracks') : null }
  }
  const sideOf = (entries: typeof ranked, label: string | null): ContactSide => ({
    label,
    engageable: group(entries, true, word(rules, 'engageable')),
    other: group(entries, false, word(rules, 'otherTracks')),
  })
  const observing = new Set(ranked.map(entry => entry.side))
  const listed = observing.size <= 1
    ? [sideOf(ranked, null)]
    : sideOrder(observing, sides).map(side => sideOf(ranked.filter(entry => entry.side === side.id), side.label))
  return { heading: word(rules, 'tracks'), sides: listed, hover: detectionHover }
}
