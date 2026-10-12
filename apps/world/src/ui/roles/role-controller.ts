import { seesForRoleSet, type RoleClass, type RunRoles, type ScenarioSide } from '../../core/model/index.ts'

/**
 * The role picker's and role bar's interaction logic, free of the DOM. A
 * screen holds a set of roles and plays their union; every change produces a
 * whole new set, which the screen applies in place.
 */

/** A role or preset as the picker and the switcher offer it, numbered for P then digit. */
export interface RoleEntry {
  readonly kind: 'role' | 'preset'
  readonly id: string
  readonly label: string
  readonly roleIds: ReadonlyArray<string>
  readonly roleClass: RoleClass | null
  /** The digit that switches to this entry after P; entries past nine have none. */
  readonly key: string | null
}

export const roleEntries = (declaration: RunRoles): ReadonlyArray<RoleEntry> => [
  ...declaration.roles.map(role => ({ kind: 'role' as const, id: role.id, label: role.label, roleIds: [role.id], roleClass: role.class })),
  ...declaration.presets.map(preset => ({ kind: 'preset' as const, id: preset.id, label: preset.label, roleIds: preset.roles, roleClass: null })),
].map((entry, index) => ({ ...entry, key: index < 9 ? String(index + 1) : null }))

/** A set of declared role ids in declaration order, without repeats or unknown ids. */
export const orderedRoleSet = (declaration: RunRoles, roleIds: ReadonlyArray<string>): ReadonlyArray<string> =>
  declaration.roles.map(role => role.id).filter(roleId => roleIds.includes(roleId))

export const roleLabels = (declaration: RunRoles, roleIds: ReadonlyArray<string>): ReadonlyArray<string> =>
  declaration.roles.filter(role => roleIds.includes(role.id)).map(role => role.label)

/**
 * The sides whose pictures a set of roles plays, in declaration order: none
 * for a truth view (it sees everything) and none in a Run without sides.
 */
export const sidesSeen = (declaration: RunRoles, roleIds: ReadonlyArray<string>): ReadonlyArray<ScenarioSide> => {
  const sees = seesForRoleSet(declaration, roleIds)
  return sees === 'all' ? [] : (declaration.sides ?? []).filter(side => sees.includes(side.id))
}

/**
 * The role bar's warning when a held set sees more than one side. Whether
 * sides oppose each other is a Pack's notion; core warns on any two, since
 * one screen then shows what fair play keeps apart.
 */
export const sidesWarning = (declaration: RunRoles, roleIds: ReadonlyArray<string>): string | null => {
  const seen = sidesSeen(declaration, roleIds)
  return seen.length < 2 ? null : `This screen sees ${seen.map(side => side.label).join(' and ')} together: play fair`
}

/** A role-aware Pack may say what a role commands; with no such Pack the line is absent. */
export type RoleCommandsDescriber = (roleId: string) => string | null

export interface RoleCard extends RoleEntry {
  readonly ticked: boolean
  /** Screens holding this role now (role cards only). */
  readonly holders: number | null
  /** The sides this role or preset sees, each shown in its colour; none for a truth role. */
  readonly sides: ReadonlyArray<ScenarioSide>
}

export const pickerCards = (declaration: RunRoles, config: {
  readonly ticked: ReadonlyArray<string>
  readonly holders: Readonly<Record<string, number>>
}): ReadonlyArray<RoleCard> => roleEntries(declaration).map(entry => ({
  ...entry,
  ticked: entry.roleIds.every(roleId => config.ticked.includes(roleId)),
  holders: entry.kind === 'role' ? config.holders[entry.id] ?? 0 : null,
  sides: sidesSeen(declaration, entry.roleIds),
}))

/** Ticking a preset ticks all its roles; unticking it unticks them. */
export const togglePickerEntry = (declaration: RunRoles, ticked: ReadonlyArray<string>, entryId: string): ReadonlyArray<string> => {
  const entry = roleEntries(declaration).find(candidate => candidate.id === entryId)
  if (!entry) throw new Error(`Unknown role or preset: ${entryId}`)
  const allTicked = entry.roleIds.every(roleId => ticked.includes(roleId))
  return orderedRoleSet(declaration, allTicked
    ? ticked.filter(roleId => !entry.roleIds.includes(roleId))
    : [...ticked, ...entry.roleIds])
}

export type RoleSetChange =
  | { readonly kind: 'set'; readonly roleIds: ReadonlyArray<string> }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly reason: string }

const changeTo = (held: ReadonlyArray<string>, next: ReadonlyArray<string>): RoleSetChange =>
  next.length === held.length && next.every(roleId => held.includes(roleId)) ? { kind: 'unchanged' } : { kind: 'set', roleIds: next }

const entryFor = (declaration: RunRoles, entryId: string): RoleEntry | undefined =>
  roleEntries(declaration).find(entry => entry.id === entryId)

/** `+`: hold this role or preset too. */
export const addEntry = (declaration: RunRoles, held: ReadonlyArray<string>, entryId: string): RoleSetChange => {
  const entry = entryFor(declaration, entryId)
  if (!entry) return { kind: 'refused', reason: `Unknown role or preset: ${entryId}` }
  return changeTo(held, orderedRoleSet(declaration, [...held, ...entry.roleIds]))
}

/** `×`: stop holding a role. A screen always keeps at least one. */
export const dropRole = (declaration: RunRoles, held: ReadonlyArray<string>, roleId: string): RoleSetChange => {
  if (!held.includes(roleId)) return { kind: 'unchanged' }
  const next = orderedRoleSet(declaration, held.filter(candidate => candidate !== roleId))
  if (next.length === 0) return { kind: 'refused', reason: 'A screen keeps at least one role; add another before dropping this one' }
  return changeTo(held, next)
}

/** A chip click or P then digit: hold exactly this role or preset. */
export const switchToEntry = (declaration: RunRoles, held: ReadonlyArray<string>, entryId: string): RoleSetChange => {
  const entry = entryFor(declaration, entryId)
  if (!entry) return { kind: 'refused', reason: `Unknown role or preset: ${entryId}` }
  return changeTo(held, orderedRoleSet(declaration, entry.roleIds))
}

export interface RoleBarChip {
  readonly id: string
  readonly label: string
  readonly roleClass: RoleClass
  readonly droppable: boolean
  /** The sides this role sees, each shown in its colour; none for a truth role. */
  readonly sides: ReadonlyArray<ScenarioSide>
}

export interface RoleBarModel {
  readonly chips: ReadonlyArray<RoleBarChip>
  /** Entries the `+` menu offers: those not already wholly held. */
  readonly addable: ReadonlyArray<RoleEntry>
  readonly entries: ReadonlyArray<RoleEntry>
  /** Shown as a band when the held set sees more than one side. */
  readonly sidesWarning: string | null
}

export const roleBarModel = (declaration: RunRoles, held: ReadonlyArray<string>): RoleBarModel => {
  const entries = roleEntries(declaration)
  return {
    chips: declaration.roles.filter(role => held.includes(role.id)).map(role => ({
      id: role.id, label: role.label, roleClass: role.class, droppable: held.length > 1, sides: sidesSeen(declaration, [role.id]),
    })),
    addable: entries.filter(entry => !entry.roleIds.every(roleId => held.includes(roleId))),
    entries,
    sidesWarning: sidesWarning(declaration, held),
  }
}

/** After P, the next digit within this window switches. */
export const roleKeyArmWindowMs = 1_500

export interface RoleKeyState {
  readonly armedAt: number | null
}

export const idleRoleKeys: RoleKeyState = { armedAt: null }

export interface RoleKeyInput {
  readonly key: string
  readonly repeat: boolean
  readonly modified: boolean
  /** A text field, a modal or another owner of the keyboard has focus. */
  readonly inert: boolean
  readonly now: number
}

export interface RoleKeyStep {
  readonly state: RoleKeyState
  /** The key belongs to the role bar; the caller prevents its default. */
  readonly handled: boolean
  readonly change: RoleSetChange | null
}

export const roleKeyStep = (
  state: RoleKeyState,
  input: RoleKeyInput,
  declaration: RunRoles,
  held: ReadonlyArray<string>,
): RoleKeyStep => {
  if (input.inert || input.modified || input.repeat) return { state: idleRoleKeys, handled: false, change: null }
  const armed = state.armedAt !== null && input.now - state.armedAt <= roleKeyArmWindowMs
  if (input.key === 'p' || input.key === 'P') return { state: { armedAt: input.now }, handled: true, change: null }
  if (!armed) return { state: idleRoleKeys, handled: false, change: null }
  if (input.key === 'Escape') return { state: idleRoleKeys, handled: true, change: null }
  const entry = roleEntries(declaration).find(candidate => candidate.key === input.key)
  if (!entry) return { state: idleRoleKeys, handled: false, change: null }
  return { state: idleRoleKeys, handled: true, change: switchToEntry(declaration, held, entry.id) }
}

/** The bar's own words for a held set, e.g. "EMS dispatcher + Police dispatcher". */
export const roleSetText = (declaration: RunRoles, roleIds: ReadonlyArray<string>): string =>
  roleLabels(declaration, roleIds).join(' + ')
