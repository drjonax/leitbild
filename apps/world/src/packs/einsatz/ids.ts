import type { AdapterId } from '../../core/model/index.ts'

/** The Pack id every Einsatz object carries, the local runtime's id and the adapter id its objects' provenance names. */
export const einsatzPackId = 'einsatz'
export const einsatzRuntimeId = 'einsatz.local'
export const einsatzAdapterId = 'adapter:einsatz.local' as AdapterId

/**
 * How `lastAction.by` names a standing order: this prefix and the order's id.
 * A role whose label starts so is refused, so a person's order never reads
 * as a standing order; core actor ids start with `actor:`.
 */
export const standingOrderByPrefix = 'standing-order:'
export const standingOrderBy = (order: string): string => `${standingOrderByPrefix}${order}`
export const isStandingOrderBy = (by: string): boolean => by.startsWith(standingOrderByPrefix)
