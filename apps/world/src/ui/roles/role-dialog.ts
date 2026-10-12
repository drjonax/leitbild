import { seesForRoleSet, type RoleClass, type RoleSees, type RunRoles, type ScenarioRole, type ScenarioSide } from '../../core/model/index.ts'
import { orderedRoleSet, roleSetText, sidesSeen, sidesWarning, type RoleSetChange } from './role-controller.ts'
import { sameRoleSet } from './role-session.ts'

/**
 * The role dialog's interaction logic, free of the DOM: the Groups dialog of
 * owner amendment A9, generic over any Pack's roles. It opens when a screen
 * joins a Run that declares roles and from the role bar.
 *
 * - A tree lists the roles that carry a category under their category, each
 *   with two boxes. **Control** holds the role: the screen's role set, which
 *   the Run enforces with union semantics. **See** is this tab's display
 *   filter, which no server reads; a Pack may hide its own objects of unseen
 *   roles. Control implies See: ticking Control ticks See, and unticking See
 *   unticks Control. See is per role: an unseen role's objects stay hidden
 *   even when another held role commands them.
 * - Presets and the roles without a category are one-tap rows above the tree;
 *   a row ticks Control (and See) of all its roles, or unticks them when all
 *   are ticked already.
 * - In a Run with sides the dialog lists the roles of one chosen side: those
 *   that see it, and every truth role. Choosing another side is the honour
 *   system: the roles held stay held, and a set seeing two sides shows the
 *   role bar's warning.
 */

export interface RoleDialogDraft {
  /** The side whose roles are listed; null in a Run without sides. */
  readonly side: string | null
  /** Control: the roles the screen is to hold, in declaration order. */
  readonly control: ReadonlyArray<string>
  /** Roles whose See box is unticked; never a controlled one. */
  readonly hidden: ReadonlyArray<string>
}

/** What applying the dialog sets: the role set to hold and this tab's unseen roles. */
export interface RoleDialogResult {
  readonly roleIds: ReadonlyArray<string>
  readonly hidden: ReadonlyArray<string>
}

const roleById = (declaration: RunRoles, roleId: string): ScenarioRole => {
  const role = declaration.roles.find(entry => entry.id === roleId)
  if (role === undefined) throw new Error(`Unknown role: ${roleId}`)
  return role
}

const declaredHidden = (declaration: RunRoles, hidden: ReadonlyArray<string>, control: ReadonlyArray<string>): ReadonlyArray<string> =>
  orderedRoleSet(declaration, hidden).filter(roleId => !control.includes(roleId))

/**
 * The dialog as it opens: the roles held ticked, the unseen roles unticked,
 * and the first side the held roles see, or else the first side declared.
 */
export const openRoleDialog = (declaration: RunRoles, held: ReadonlyArray<string>, hidden: ReadonlyArray<string>): RoleDialogDraft => {
  const control = orderedRoleSet(declaration, held)
  const side = declaration.sides === undefined ? null : (sidesSeen(declaration, control)[0] ?? declaration.sides[0]!).id
  return { side, control, hidden: declaredHidden(declaration, hidden, control) }
}

export const chooseSide = (declaration: RunRoles, draft: RoleDialogDraft, sideId: string): RoleDialogDraft => {
  if (!(declaration.sides ?? []).some(side => side.id === sideId)) throw new Error(`Unknown side: ${sideId}`)
  return { ...draft, side: sideId }
}

/** Control on: the role is held, and so seen. Control off: the role stays seen. */
export const toggleControl = (declaration: RunRoles, draft: RoleDialogDraft, roleId: string): RoleDialogDraft => {
  roleById(declaration, roleId)
  if (draft.control.includes(roleId)) return { ...draft, control: draft.control.filter(entry => entry !== roleId) }
  return { ...draft, control: orderedRoleSet(declaration, [...draft.control, roleId]), hidden: draft.hidden.filter(entry => entry !== roleId) }
}

/** See off: the role is unseen and no longer held. See on: it is seen again. */
export const toggleSee = (declaration: RunRoles, draft: RoleDialogDraft, roleId: string): RoleDialogDraft => {
  roleById(declaration, roleId)
  if (draft.hidden.includes(roleId)) return { ...draft, hidden: draft.hidden.filter(entry => entry !== roleId) }
  return { ...draft, control: draft.control.filter(entry => entry !== roleId), hidden: orderedRoleSet(declaration, [...draft.hidden, roleId]) }
}

const presetRoleIds = (declaration: RunRoles, entryId: string): ReadonlyArray<string> => {
  const preset = declaration.presets.find(entry => entry.id === entryId)
  if (preset !== undefined) return preset.roles
  return [roleById(declaration, entryId).id]
}

/** A preset row: holds (and sees) all its roles, or drops them all when all are held. */
export const togglePreset = (declaration: RunRoles, draft: RoleDialogDraft, entryId: string): RoleDialogDraft => {
  const roleIds = presetRoleIds(declaration, entryId)
  if (roleIds.every(roleId => draft.control.includes(roleId))) return { ...draft, control: draft.control.filter(roleId => !roleIds.includes(roleId)) }
  return {
    ...draft,
    control: orderedRoleSet(declaration, [...draft.control, ...roleIds]),
    hidden: draft.hidden.filter(roleId => !roleIds.includes(roleId)),
  }
}

export const roleDialogResult = (draft: RoleDialogDraft): RoleDialogResult => ({ roleIds: draft.control, hidden: draft.hidden })

/** The change a role bar asks the Run for: none when the dialog left the role set as it was. */
export const roleDialogChange = (held: ReadonlyArray<string>, result: RoleDialogResult): RoleSetChange =>
  sameRoleSet(held, result.roleIds) ? { kind: 'unchanged' } : { kind: 'set', roleIds: result.roleIds }

/**
 * This tab's unseen roles once the screen holds a new role set. A held role
 * is seen (Control implies See), so holding a role, from the dialog, a P
 * then digit switch or a stored set, ticks its See box for good: dropping
 * the role later keeps it seen until See is unticked again.
 */
export const hiddenOnceHeld = (hidden: ReadonlyArray<string>, held: ReadonlyArray<string>): ReadonlyArray<string> =>
  hidden.filter(roleId => !held.includes(roleId))

/**
 * The roles a screen shows, for Pack views: every declared role but the
 * unseen ones, and always the roles it holds, since Control implies See.
 * Seeing is per role, not per object: a Pack hides the objects of an unseen
 * role even when another held role commands them.
 */
export const seenRoleIdsFor = (declaration: RunRoles, held: ReadonlyArray<string>, hidden: ReadonlyArray<string>): ReadonlyArray<string> =>
  declaration.roles.map(role => role.id).filter(roleId => held.includes(roleId) || !hidden.includes(roleId))

/** Whether a role or role set seeing this is listed for the chosen side: one that sees it, or the truth. */
const listedFor = (side: string | null, sees: RoleSees | undefined): boolean =>
  side === null || sees === undefined || sees === 'all' || sees.includes(side)

export interface RoleDialogSide {
  readonly id: string
  readonly label: string
  readonly colour: string
  readonly chosen: boolean
}

/** A one-tap row: a preset, or a role without a category. */
export interface RoleDialogPresetRow {
  readonly kind: 'preset' | 'role'
  readonly id: string
  readonly label: string
  readonly roleIds: ReadonlyArray<string>
  readonly roleClass: RoleClass | null
  /** Every role of the row is held. */
  readonly ticked: boolean
  /** Screens holding the role now; null for a preset or while unknown. */
  readonly holders: number | null
  /** The sides it sees, each shown in its colour; none for a truth role. */
  readonly sides: ReadonlyArray<ScenarioSide>
}

/** A role of the tree, with its two boxes. */
export interface RoleDialogRow {
  readonly id: string
  readonly label: string
  readonly control: boolean
  readonly see: boolean
  readonly holders: number | null
  readonly sides: ReadonlyArray<ScenarioSide>
}

export interface RoleDialogCategory {
  readonly label: string
  readonly rows: ReadonlyArray<RoleDialogRow>
}

export interface RoleDialogModel {
  /** Empty in a Run without sides. */
  readonly sides: ReadonlyArray<RoleDialogSide>
  readonly presets: ReadonlyArray<RoleDialogPresetRow>
  /** Categories in the order their first role is declared. */
  readonly categories: ReadonlyArray<RoleDialogCategory>
  /** Held roles the chosen side does not list, by label, so nothing held is out of sight. */
  readonly alsoHeld: ReadonlyArray<string>
  /** Shown when the roles to hold see more than one side. */
  readonly warning: string | null
  readonly canApply: boolean
  readonly applyText: string
}

export const roleDialogModel = (declaration: RunRoles, draft: RoleDialogDraft, context: {
  readonly mode: 'join' | 'switch'
  /** The roles the screen holds now; none when joining. */
  readonly held: ReadonlyArray<string>
  /** Screens holding each role now, from the public presence; null while unknown. */
  readonly holders: Readonly<Record<string, number>> | null
}): RoleDialogModel => {
  const holdersOf = (roleId: string): number | null => context.holders === null ? null : context.holders[roleId] ?? 0
  const listed = declaration.roles.filter(role => listedFor(draft.side, role.sees))
  const presets: RoleDialogPresetRow[] = [
    ...declaration.presets
      .filter(preset => listedFor(draft.side, seesForRoleSet(declaration, preset.roles)))
      .map(preset => ({ kind: 'preset' as const, id: preset.id, label: preset.label, roleIds: preset.roles, roleClass: null, holders: null })),
    ...listed
      .filter(role => role.category === undefined)
      .map(role => ({ kind: 'role' as const, id: role.id, label: role.label, roleIds: [role.id], roleClass: role.class, holders: holdersOf(role.id) })),
  ].map(row => ({ ...row, ticked: row.roleIds.every(roleId => draft.control.includes(roleId)), sides: sidesSeen(declaration, row.roleIds) }))
  const categories: RoleDialogCategory[] = []
  for (const role of listed) {
    if (role.category === undefined) continue
    const row: RoleDialogRow = {
      id: role.id,
      label: role.label,
      control: draft.control.includes(role.id),
      see: !draft.hidden.includes(role.id),
      holders: holdersOf(role.id),
      sides: sidesSeen(declaration, [role.id]),
    }
    const category = categories.find(entry => entry.label === role.category)
    if (category === undefined) categories.push({ label: role.category, rows: [row] })
    else categories.splice(categories.indexOf(category), 1, { label: category.label, rows: [...category.rows, row] })
  }
  const listedIds = new Set(listed.map(role => role.id))
  const canApply = draft.control.length > 0
  const played = roleSetText(declaration, draft.control)
  return {
    sides: (declaration.sides ?? []).map(side => ({ id: side.id, label: side.label, colour: side.colour, chosen: side.id === draft.side })),
    presets,
    categories,
    alsoHeld: declaration.roles.filter(role => draft.control.includes(role.id) && !listedIds.has(role.id)).map(role => role.label),
    warning: sidesWarning(declaration, draft.control),
    canApply,
    applyText: !canApply
      ? context.mode === 'join' ? 'Tick a role to join' : 'Tick at least one role'
      : context.mode === 'join' ? `Join as ${played}` : sameRoleSet(context.held, draft.control) ? 'Apply' : `Play ${played}`,
  }
}
