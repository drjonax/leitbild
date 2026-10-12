import { motionOf, unitTypeOf, type Catalog, type EngineState, type UnitMotion, type UnitRecord } from './model.ts'
import { hasLoad, isDestroyed, isFree } from './rules.ts'
import { byId } from './values.ts'

/**
 * Standing orders that move a unit: `deliver` takes load picked up on task
 * to the nearest accepting public or own-side site; `return` brings an idle
 * unit away from base home after `afterIdleS`; `withdraw` brings a unit home
 * once it is damaged, unless it has been given a movement order since. All
 * run as intents through the same validation as commands. `roe` sets a
 * unit's initial rules of engagement and `onStepLost` runs in the
 * engagement step.
 */
export const standingOrders = ['deliver', 'return', 'withdraw'] as const
export type StandingOrder = typeof standingOrders[number]

/** The unit alert a standing order raises when it cannot be carried out; any new order to the unit clears it. */
export const orderFailedCode = (order: StandingOrder): string => `${order}_failed`
export const orderAlertCodes: ReadonlyArray<string> = standingOrders.map(orderFailedCode)

export interface DueReflex {
  readonly unitId: string
  readonly order: StandingOrder
}

/**
 * The absolute Run-time boundary, every 2 s, at which a failed reflex is
 * evaluated again. The engagement step (detection, fire gate, fire,
 * transitions) runs at the same boundaries.
 */
export const boundaryMs = 2_000
export const nextBoundaryMs = (timeMs: number): number => (Math.floor(timeMs / boundaryMs) + 1) * boundaryMs

/** Orders that move a unit; any of them given by an actor after a step loss stands in for withdrawing. */
const movementVerbs: ReadonlyArray<NonNullable<UnitRecord['lastAction']>['verb']> = ['send', 'divert', 'move', 'deliver', 'recall', 'hold', 'release']

/** A damaged unit with a `withdraw` order heads home once, unloaded first, unless an actor has moved it since the step loss. */
const withdrawPending = (catalog: Catalog, unit: UnitRecord): boolean => {
  if (unit.integrity !== 'damaged' || unit.integritySinceMs === undefined || unitTypeOf(catalog, unit).standingOrders?.withdraw?.whenDamaged !== true) return false
  if (hasLoad(unit) || unit.phase === 'returning' || (unit.atBase && unit.phase === 'available')) return false
  const action = unit.lastAction
  const movedSince = action !== undefined && action.atMs >= unit.integritySinceMs && movementVerbs.includes(action.verb) && !action.by.startsWith('standing-order:')
  return !movedSince
}

/** The standing order a unit waits on, and the Run time from which it may fire. */
const pendingOrder = (catalog: Catalog, unit: UnitRecord): { readonly order: StandingOrder; readonly fromMs: number } | undefined => {
  if (isDestroyed(unit)) return undefined
  const orders = unitTypeOf(catalog, unit).standingOrders
  if (unit.phase === 'holding' && hasLoad(unit) && orders?.deliver === 'nearest-accepting') return { order: 'deliver', fromMs: unit.phaseSinceMs }
  if (withdrawPending(catalog, unit)) return { order: 'withdraw', fromMs: unit.integritySinceMs! }
  if (unit.phase === 'available' && !unit.atBase && isFree(unit) && orders?.return !== undefined) {
    return { order: 'return', fromMs: unit.phaseSinceMs + orders.return.afterIdleS * 1_000 }
  }
  return undefined
}

/** When a unit's standing order fires: once due, and after a failed attempt at the next 2 s boundary. */
export const reflexDueMs = (catalog: Catalog, unit: UnitRecord, motion: UnitMotion): number | undefined => {
  const pending = pendingOrder(catalog, unit)
  if (pending === undefined) return undefined
  return motion.reflexAttemptMs === undefined ? pending.fromMs : Math.max(pending.fromMs, nextBoundaryMs(motion.reflexAttemptMs))
}

/** Standing orders due at the state's time, in unit id order. */
export const dueReflexes = (state: Pick<EngineState, 'catalog' | 'units' | 'motion' | 'timeMs'>): DueReflex[] =>
  [...state.units.values()].sort(byId).flatMap(unit => {
    const due = reflexDueMs(state.catalog, unit, motionOf(state, unit.id))
    const order = pendingOrder(state.catalog, unit)?.order
    return due !== undefined && order !== undefined && due <= state.timeMs ? [{ unitId: unit.id, order }] : []
  })
