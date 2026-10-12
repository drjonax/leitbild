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
/**
 * How `lastAction.by` names the engine starting a unit's next step: run like
 * a standing order, so it never counts as a person's order, yet it only
 * carries on what a person queued, and the log does not call it one.
 */
export const chainStepBy = standingOrderBy('chain')

/** The cause a step removal records when it undoes the order that created the step. */
export const undoCause = 'undo'

/**
 * The operator role a declared group becomes, and back. Configuration ids
 * never hold a colon, so no authority entry or declared id can take the form;
 * a declared role of this form naming no group is refused.
 */
export const groupRolePrefix = 'group:'
export const groupRoleId = (groupId: string): string => `${groupRolePrefix}${groupId}`
/** The group a role id names, or undefined for any other role. */
export const groupOfRoleId = (roleId: string): string | undefined =>
  roleId.startsWith(groupRolePrefix) ? roleId.slice(groupRolePrefix.length) : undefined
