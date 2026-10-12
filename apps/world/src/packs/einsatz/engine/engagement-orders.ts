import type { UnitComponents } from '../config-schema.ts'
import { roeWords, wordFor } from '../lexicon.ts'
import type { TrackRecord } from './combat-model.ts'
import { putUnit, unitIn } from './draft.ts'
import { actionBy, notInPicture, refused, type Refused } from './intent-support.ts'
import type { EngineActor, IntentOf, Plan } from './intents.ts'
import { unitTypeOf, type EngineState, type UnitRecord } from './model.ts'
import { isDestroyed } from './rules.ts'
import { patch } from './values.ts'
import { unitWord } from './wording.ts'

/**
 * Orders to a unit's weapons: its rules of engagement and a priority
 * target. Neither moves the unit; both are state checks, so a stale order
 * is refused for what has changed.
 */

type Effector = NonNullable<UnitComponents['effector']>

const armedUnit = (state: EngineState, unit: UnitRecord): { readonly ok: true; readonly unit: UnitRecord; readonly effector: Effector } | Refused => {
  if (isDestroyed(unit)) return refused('unit_unavailable', `${unit.label} is ${unitWord(state.catalog, unit, 'destroyed')}`)
  const effector = unitTypeOf(state.catalog, unit).components.effector
  return effector === undefined ? refused('no_effector', `${unit.label} cannot fire`) : { ok: true, unit, effector }
}

const armed = (state: EngineState, unitId: string): { readonly ok: true; readonly unit: UnitRecord; readonly effector: Effector } | Refused => {
  const unit = state.units.get(unitId)
  return unit === undefined ? notInPicture() : armedUnit(state, unit)
}

const unchanged = (note: string): Plan => ({ ok: true, routes: [], notes: [note], apply: () => undefined })

/** Sets a unit's rules of engagement from the next engagement step on. */
export const planSetRoe = (state: EngineState, intent: IntentOf<'set-roe'>, actor: EngineActor): Plan => {
  const checked = armed(state, intent.unitId)
  if (!checked.ok) return checked
  const { unit } = checked
  if (unit.roe === intent.roe) return unchanged(`${unit.label} already ${roeWords[intent.roe]}`)
  return {
    ok: true, routes: [], notes: [],
    apply: draft => {
      putUnit(draft, patch(unitIn(draft, unit.id), { roe: intent.roe, lastAction: actionBy(draft, actor, 'set', undefined, roeWords[intent.roe]) }))
    },
  }
}

/** Why a unit may not take a track as priority target, in the track's and the configuration's words; undefined when it may. */
const notEngageable = (state: EngineState, unit: UnitRecord, effector: Effector, track: TrackRecord): string | undefined => {
  const lexicon = state.catalog.config.lexicon
  if (track.tier === 'destroyed') return `${track.label} is ${wordFor(lexicon, 'destroyed').toLowerCase()}`
  if (track.tier === 'contact' || track.identity === undefined) return `${track.label} is a ${wordFor(lexicon, 'contact').toLowerCase()} report only`
  const named = `${track.label} (${track.identity.typeLabel})`
  if (!(state.catalog.config.hostility[unit.side!] ?? []).includes(track.identity.side)) return `${named} is not hostile`
  const subject = state.units.get(track.subjectId)
  const targetable = subject !== undefined && unitTypeOf(state.catalog, subject).tags.some(tag => effector.targets.includes(tag))
  return targetable ? undefined : `${unit.label} cannot engage ${named}`
}

/**
 * Why a unit may not take a track as its target, by a priority-target order
 * or an engage step: it cannot fire, the track is another side's, or it is
 * no identified, hostile track of a type its effector engages.
 */
export const engageRefusal = (state: EngineState, unit: UnitRecord, track: TrackRecord): Refused | undefined => {
  const checked = armedUnit(state, unit)
  if (!checked.ok) return checked
  if (track.side !== unit.side) return refused('cross_side_reference', `${unit.label} cannot engage another side's track`)
  const reason = notEngageable(state, unit, checked.effector, track)
  return reason === undefined ? undefined : refused('track_not_engageable', reason)
}

/**
 * Names an own-side track as the unit's priority target: an identified,
 * hostile track its effector can engage. Whether it fires still depends on
 * the fire gate at each engagement step: a fix, range and the ROE.
 */
export const planEngage = (state: EngineState, intent: IntentOf<'engage'>, actor: EngineActor): Plan => {
  const checked = armed(state, intent.unitId)
  if (!checked.ok) return checked
  const { unit } = checked
  const track = state.combat.tracks.get(intent.trackId)
  if (track === undefined) return notInPicture()
  const refusedTrack = engageRefusal(state, unit, track)
  if (refusedTrack) return refusedTrack
  if (unit.engage === track.id) return unchanged(`${unit.label} already engaging ${track.label}`)
  return {
    ok: true, routes: [], notes: [],
    apply: draft => {
      putUnit(draft, patch(unitIn(draft, unit.id), { engage: track.id, lastAction: actionBy(draft, actor, 'engage', track.id) }))
    },
  }
}
