import { motionOf, unitTypeOf, type Catalog, type EngineState, type UnitMotion, type UnitRecord } from './model.ts'
import { hasLoad, isDestroyed, isFree } from './rules.ts'
import { byId } from './values.ts'

/**
 * Standing orders this engine runs: `deliver` takes load picked up on task
 * to the nearest accepting public or own-side site; `return` brings an idle
 * unit away from base home after `afterIdleS`. Both run as intents through
 * the same validation as commands. `roe`, `withdraw` and `onStepLost` belong
 * to the engagement step.
 */
export const standingOrders = ['deliver', 'return'] as const
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

/** The standing order a unit waits on, and the Run time from which it may fire. */
const pendingOrder = (catalog: Catalog, unit: UnitRecord): { readonly order: StandingOrder; readonly fromMs: number } | undefined => {
  if (isDestroyed(unit)) return undefined
  const orders = unitTypeOf(catalog, unit).standingOrders
  if (unit.phase === 'holding' && hasLoad(unit) && orders?.deliver === 'nearest-accepting') return { order: 'deliver', fromMs: unit.phaseSinceMs }
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
