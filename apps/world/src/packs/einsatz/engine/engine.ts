import { routeDistanceMeters, type RouteImpact } from '../../../core/model/index.ts'
import { refusalCode } from '../refusal.ts'
import { closeDraft, openDraft, putUnit, setMotion, unitIn } from './draft.ts'
import { refused, type Refused } from './intent-support.ts'
import { commandsEveryUnit, type EngineActor, type Intent, type Plan, type RouteNeed } from './intents.ts'
import { motionOf, raiseAlert, unitTypeOf, type EngineState, type Leg, type Transition, type UnitRecord } from './model.ts'
import { prepareLeg, type RoutePort } from './movement.ts'
import { planHold, planRecall, planSend } from './orders.ts'
import { settle, stepUntil } from './phases.ts'
import { planSiteSet, planTaskClose, planTaskCreate, planUnitAdjust, planUnitCreate } from './records.ts'
import { orderFailedCode, type DueReflex, type StandingOrder } from './reflexes.ts'
import { isDestroyed, isSite, linksToSite } from './rules.ts'
import { patch, sameValue } from './values.ts'
import { loadText } from './wording.ts'

/**
 * The Einsatz engine API: pure functions from an engine state to the next
 * state plus the transitions that changed `packData`. Routing is the only
 * port; it is asked before a change is committed. A commit validates the
 * intent again against the state it applies to and accepts only legs routed
 * from that state's positions. Callers serialize calls.
 */

export interface EnginePorts {
  readonly routing: RoutePort
}

export type IntentOutcome =
  | { readonly ok: true; readonly state: EngineState; readonly transitions: ReadonlyArray<Transition>; readonly notes: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string }

export interface AdvanceOutcome {
  readonly state: EngineState
  readonly transitions: ReadonlyArray<Transition>
}

/** Validates an intent against the state: refused with `<code>: <message>`, or the routes it needs and how it applies. */
export const planIntent = (state: EngineState, intent: Intent, actor: EngineActor): Plan => {
  switch (intent.kind) {
    case 'send': return planSend(state, intent, actor)
    case 'recall': return planRecall(state, intent, actor)
    case 'hold': return planHold(state, intent, actor)
    case 'task.create': return planTaskCreate(state, intent, actor)
    case 'task.close': return planTaskClose(state, intent, actor)
    case 'site.set': return planSiteSet(state, intent, actor)
    case 'unit.create': return planUnitCreate(state, intent, actor)
    case 'unit.adjust': return planUnitAdjust(state, intent, actor)
  }
}

/** A leg routed for one of a plan's route needs, carrying the need it answers. */
export interface PreparedLeg {
  readonly route: RouteNeed
  readonly leg: Leg
}

/**
 * The legs a plan on this state needs, keyed by unit. A leg must answer a
 * route need of this plan exactly, from the same point to the same point:
 * one routed from an earlier state would move its unit back along an old
 * path, so it is an error and is never applied.
 */
const legsFor = (routes: ReadonlyArray<RouteNeed>, prepared: ReadonlyArray<PreparedLeg>): ReadonlyMap<string, Leg> => {
  const byUnit = new Map(prepared.map(entry => [entry.route.unitId, entry]))
  const unanswered = routes.filter(route => !sameValue(byUnit.get(route.unitId)?.route, route)).map(route => route.unitId)
  if (unanswered.length > 0 || byUnit.size !== routes.length || prepared.length !== routes.length) {
    throw new Error(`State changed while routing ${unanswered.length > 0 ? unanswered.join(', ') : 'this intent'}; plan and route again`)
  }
  return new Map(prepared.map(entry => [entry.route.unitId, entry.leg]))
}

/** Applies an intent with legs prepared for it on this same state, validating it again first. Settles what it makes due at once. */
export const commitIntent = (state: EngineState, intent: Intent, actor: EngineActor, prepared: ReadonlyArray<PreparedLeg>): IntentOutcome => {
  const plan = planIntent(state, intent, actor)
  if (!plan.ok) return plan
  const legs = legsFor(plan.routes, prepared)
  const draft = openDraft(state)
  plan.apply(draft, legs)
  settle(draft)
  return { ok: true, state: closeDraft(draft), transitions: draft.transitions, notes: plan.notes }
}

/** Routes for every unit of an intent, in order; the first that cannot be routed refuses the intent. */
export const prepareLegs = async (state: EngineState, routes: ReadonlyArray<RouteNeed>, routing: RoutePort): Promise<{ readonly ok: true; readonly legs: ReadonlyArray<PreparedLeg> } | Refused> => {
  const legs: PreparedLeg[] = []
  for (const route of routes) {
    const unit = state.units.get(route.unitId)
    if (unit === undefined) throw new Error(`Einsatz unit not found: ${route.unitId}`)
    const mobility = unitTypeOf(state.catalog, unit).components.mobility
    if (mobility === undefined) throw new Error(`${unit.id}: a route was requested for a unit without mobility`)
    const prepared = await prepareLeg(routing, mobility, route.from, route.to, unit.label)
    if (!prepared.ok) return prepared
    legs.push({ route, leg: prepared.leg })
  }
  return { ok: true, legs }
}

const runIntent = async (state: EngineState, intent: Intent, actor: EngineActor, ports: EnginePorts): Promise<IntentOutcome> => {
  const plan = planIntent(state, intent, actor)
  if (!plan.ok) return plan
  const legs = await prepareLegs(state, plan.routes, ports.routing)
  if (!legs.ok) return legs
  return commitIntent(state, intent, actor, legs.legs)
}

/**
 * The nearest accepting site, by straight-line distance and then id, that
 * is public or the unit's side's and accepts every class it carries.
 */
const deliverIntent = (state: EngineState, unit: UnitRecord): { readonly ok: true; readonly intent: Intent } | Refused => {
  const from = motionOf(state, unit.id).point
  const sites = [...state.units.values()]
    .filter(site => isSite(state.catalog, site) && site.accepting === true && !isDestroyed(site) && linksToSite(state.catalog, unit, site)
      && Object.keys(unit.load).every(classId => unitTypeOf(state.catalog, site).components.receiving!.accepts.includes(classId)))
    .map(site => ({ site, distance: routeDistanceMeters(from, motionOf(state, site.id).point) }))
    .sort((a, b) => a.distance - b.distance || (a.site.id < b.site.id ? -1 : 1))
  const nearest = sites[0]
  if (nearest === undefined) return refused('site_not_accepting', `No site accepts ${loadText(state.catalog, unit.load)}`)
  return { ok: true, intent: { kind: 'send', units: [unit.id], to: { siteId: nearest.site.id } } }
}

const orderWords: Readonly<Record<StandingOrder, string>> = { deliver: 'Deliver', return: 'Return' }

/**
 * A standing order that cannot be carried out raises its alert on the unit,
 * which holds where it is; the order is evaluated again at the next 2 s
 * boundary. It is never a runtime failure and never skipped silently.
 */
const reflexFailed = (state: EngineState, due: DueReflex, reason: string): AdvanceOutcome => {
  const draft = openDraft(state)
  const unit = unitIn(draft, due.unitId)
  const message = `${orderWords[due.order]} failed: ${reason.slice(refusalCode(reason).length + 2)}`
  setMotion(draft, unit.id, { reflexAttemptMs: draft.timeMs })
  putUnit(draft, patch(unit, { alerts: raiseAlert(unit.alerts, { code: orderFailedCode(due.order), message, sinceMs: draft.timeMs }) }))
  return { state: closeDraft(draft), transitions: draft.transitions }
}

const runReflex = async (state: EngineState, due: DueReflex, ports: EnginePorts): Promise<AdvanceOutcome> => {
  const unit = unitIn(state, due.unitId)
  const actor: EngineActor = { by: `standing-order:${due.order}`, commandable: commandsEveryUnit }
  const order = due.order === 'deliver' ? deliverIntent(state, unit) : { ok: true as const, intent: { kind: 'recall' as const, unitId: unit.id } }
  const outcome = order.ok ? await runIntent(state, order.intent, actor, ports) : order
  return outcome.ok ? outcome : reflexFailed(state, due, outcome.reason)
}

const reflexRoundBudget = 100_000

/**
 * Advances to `targetMs`, running each standing order at the exact Run time
 * it falls due through the same validation as a command.
 */
export const advanceEngine = async (state: EngineState, targetMs: number, ports: EnginePorts): Promise<AdvanceOutcome> => {
  let current = state
  const transitions: Transition[] = []
  for (let round = 0; ; round++) {
    if (round > reflexRoundBudget) throw new Error('Einsatz standing-order budget exceeded')
    const step = stepUntil(current, targetMs)
    current = step.state
    transitions.push(...step.transitions)
    if (step.reflexes.length === 0) return { state: current, transitions }
    for (const due of step.reflexes) {
      const outcome = await runReflex(current, due, ports)
      current = outcome.state
      transitions.push(...outcome.transitions)
    }
  }
}

/**
 * Executes an intent at the state's Run time, then the standing orders it
 * makes due at that moment, such as delivering elsewhere when a site stops
 * accepting.
 */
export const executeIntent = async (state: EngineState, intent: Intent, actor: EngineActor, ports: EnginePorts): Promise<IntentOutcome> => {
  const outcome = await runIntent(state, intent, actor, ports)
  if (!outcome.ok) return outcome
  const settled = await advanceEngine(outcome.state, outcome.state.timeMs, ports)
  return { ok: true, state: settled.state, transitions: [...outcome.transitions, ...settled.transitions], notes: outcome.notes }
}

/**
 * Replaces the canonical route impacts on a unit. They set its pace from now
 * on; they are route meaning, not `packData`, so this is no transition.
 */
export const setRouteImpacts = (state: EngineState, unitId: string, impacts: ReadonlyArray<RouteImpact>): EngineState => {
  const motion = motionOf(state, unitId)
  return { ...state, motion: new Map(state.motion).set(unitId, { ...motion, impacts }) }
}
