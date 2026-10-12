import { geoPointFromLonLat, type GeoJsonPoint, type ScenarioRole } from '../../../core/model/index.ts'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../../../core/scenarios/definition.ts'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import { einsatzCommandIds, isEinsatzCommand } from '../capabilities.ts'
import { prepareCommand } from '../commands.ts'
import type { UnitType } from '../config-schema.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { advanceEngine, commitIntent, executeIntent, type EnginePorts } from '../engine/engine.ts'
import { commandsEveryUnit, type EngineActor, type Intent } from '../engine/intents.ts'
import { emptyEngineState, unitTypeOf, type EngineState, type Transition, type UnitRecord } from '../engine/model.ts'
import { einsatzScenarioRoles } from '../groups.ts'
import { einsatzPackId, groupRoleId } from '../ids.ts'
import { taskItemSchema, unitItemSchema } from '../scenario.ts'
import { openViewer, type EinsatzViewer } from '../viewer.ts'
import scripted from '../../../scenarios/halden-border.scenario.json'
import humanRed from '../../../scenarios/halden-border-human-red.scenario.json'

/**
 * Test-only harness that plays the built-in halden-border Definitions
 * headless on the Einsatz engine with the direct router: items expand
 * through the same intents as the scenario codec, timeline cues run as the
 * timeline actor, and a play issues a side's orders through the command
 * path with that side's commanding group role. Units, roles and tasks are
 * found by side, component and group, never by name. Production code never
 * imports this file.
 */

export const borderDefinitions = {
  scripted: scenarioDefinitionSchema.parse(scripted),
  humanRed: scenarioDefinitionSchema.parse(humanRed),
} as const

export const ports: EnginePorts = { routing: createDirectRoutingAdapter() }

const selectionOf = (definition: ScenarioDefinition) => {
  const selection = definition.packs.find(pack => pack.id === einsatzPackId)
  if (selection === undefined) throw new Error(`${definition.id} has no Einsatz Pack Selection`)
  return selection
}

export const borderConfig = (definition: ScenarioDefinition = borderDefinitions.scripted) => einsatzConfigSchema.parse(selectionOf(definition).config)

const authored: EngineActor = { by: 'scenario', commandable: commandsEveryUnit }

const itemIntent = (raw: unknown): Intent => {
  const item = raw as { readonly type?: unknown }
  if (item.type === 'unit') {
    const unit = unitItemSchema.parse({ ...item, pack: einsatzPackId })
    return {
      kind: 'unit.create', id: unit.id, label: unit.label, type: unit.unitType, at: geoPointFromLonLat(...unit.position),
      ...(unit.side === undefined ? {} : { side: unit.side }),
      ...(unit.group === undefined ? {} : { group: unit.group }),
      ...(unit.base === undefined ? {} : { base: geoPointFromLonLat(...unit.base) }),
      ...(unit.properties === undefined ? {} : { properties: unit.properties }),
    }
  }
  const task = taskItemSchema.parse({ ...item, pack: einsatzPackId })
  return {
    kind: 'task.create', id: task.id, label: task.label, template: task.template, at: geoPointFromLonLat(...task.position),
    ...(task.side === undefined ? {} : { side: task.side }),
    ...(task.loads === undefined ? {} : { loads: task.loads }),
  }
}

/** The engine state a Definition starts from: its items, in order, at its start time. */
export const borderStart = (definition: ScenarioDefinition = borderDefinitions.scripted): EngineState => {
  const sides = (definition.sides ?? []).map(side => side.id)
  let state = emptyEngineState({ config: borderConfig(definition), sides, timeMs: Date.parse(definition.world.startsAt) })
  for (const item of selectionOf(definition).items) {
    const outcome = commitIntent(state, itemIntent(item), authored, [])
    if (!outcome.ok) throw new Error(`Item ${item.id}: ${outcome.reason}`)
    state = outcome.state
  }
  return state
}

/** An order at a Run second: a Capability and its input, as a cue or a screen sends it. */
export interface TimedOrder {
  readonly atS: number
  readonly capabilityId: string
  readonly input: unknown
}

export const timelineOf = (definition: ScenarioDefinition): TimedOrder[] => (definition.timeline?.cues ?? []).flatMap(cue => cue.actions.flatMap(action =>
  action.type === 'invoke_capability' ? [{ atS: cue.at.seconds, capabilityId: action.capabilityId, input: action.input }] : []))

/** Every role of a Definition's Runs: the roles it declares, then the role each Einsatz group derives, as compile merges them. */
export const borderRoles = (definition: ScenarioDefinition): ReadonlyArray<ScenarioRole> =>
  [...(definition.roles ?? []), ...einsatzScenarioRoles(selectionOf(definition).config, { sides: definition.sides ?? [] })]

/** The unit types of each group, from the Definition's items and the units its cues create. */
const groupTypes = (definition: ScenarioDefinition): ReadonlyMap<string, ReadonlySet<string>> => {
  const created = timelineOf(definition).flatMap(order => order.capabilityId === einsatzCommandIds.unitCreate ? [order.input as { readonly type: string; readonly group?: string }] : [])
  const members = [
    ...selectionOf(definition).items.flatMap(item => (item as { readonly type?: unknown }).type === 'unit' ? [unitItemSchema.parse({ ...item, pack: einsatzPackId })] : []).map(unit => ({ type: unit.unitType, group: unit.group })),
    ...created.map(input => ({ type: input.type, group: input.group })),
  ]
  const byGroup = new Map<string, Set<string>>()
  for (const member of members) if (member.group !== undefined) byGroup.set(member.group, new Set([...(byGroup.get(member.group) ?? []), member.type]))
  return byGroup
}

/** The unit types a side's groups hold in the Definition. */
export const sideTypes = (definition: ScenarioDefinition, side: string): ReadonlySet<string> =>
  new Set(borderConfig(definition).groups.filter(group => group.side === side).flatMap(group => [...groupTypes(definition).get(group.id) ?? []]))

/** The group a side's units of a type belong to in the Definition, so a test scene places its units where the Definition does. */
export const groupOf = (definition: ScenarioDefinition, side: string, typeId: string): string => {
  const group = borderConfig(definition).groups.find(entry => entry.side === side && groupTypes(definition).get(entry.id)?.has(typeId) === true)
  if (group === undefined) throw new Error(`No group of side ${side} holds units of type ${typeId}`)
  return group.id
}

/** A screen holding one group's role: the group of a side whose unit types pass a predicate. */
const groupViewer = (definition: ScenarioDefinition, side: string, holds: (typeId: string) => boolean, what: string): EinsatzViewer => {
  const types = groupTypes(definition)
  const group = borderConfig(definition).groups.find(entry => entry.side === side && [...types.get(entry.id) ?? []].some(holds))
  const role = group === undefined ? undefined : borderRoles(definition).find(entry => entry.id === groupRoleId(group.id))
  if (role === undefined) throw new Error(`No group of side ${side} holds ${what}`)
  return { class: 'operator', sees: role.sees ?? 'all', roles: [role] }
}

/** The group role that commands a side's units of a type with this component, from the Definition's groups and units. */
export const commanderOf = (definition: ScenarioDefinition, side: string, component: keyof UnitType['components']): EinsatzViewer => {
  const config = borderConfig(definition)
  return groupViewer(definition, side, typeId => config.unitTypes.find(type => type.id === typeId)?.components[component] !== undefined, `units with ${component}`)
}

/** The group role that commands a side's units of a type, from the Definition's groups and units. */
export const roleCommanding = (definition: ScenarioDefinition, side: string, typeId: string): EinsatzViewer => {
  const type = borderConfig(definition).unitTypes.find(entry => entry.id === typeId)
  if (type === undefined) throw new Error(`No unit type ${typeId}`)
  return groupViewer(definition, side, held => held === typeId, type.label)
}

/** The group roles commanding a side's units that fire or identify: the screen of the side's military command. */
export const sensingCommandOf = (definition: ScenarioDefinition, side: string): EinsatzViewer => {
  const config = borderConfig(definition)
  const sensing = config.unitTypes.filter(type => type.components.effector !== undefined || (type.components.sensor?.identifyM ?? 0) > 0).map(type => type.id)
  const roles = borderRoles(definition)
  const held = config.groups
    .filter(group => group.side === side && [...groupTypes(definition).get(group.id) ?? []].some(typeId => sensing.includes(typeId)))
    .map(group => roles.find(role => role.id === groupRoleId(group.id))!)
  if (held.length === 0) throw new Error(`No group of side ${side} fires or identifies`)
  return { class: 'operator', sees: [side], roles: held }
}

/** A screen holding several screens' roles at once: the union of their pictures, as a role set is. */
export const together = (...viewers: ReadonlyArray<EinsatzViewer>): EinsatzViewer => {
  const roles = viewers.flatMap(viewer => viewer.roles)
  const sees = viewers.some(viewer => viewer.sees === 'all') ? 'all' : [...new Set(viewers.flatMap(viewer => viewer.sees === 'all' ? [] : viewer.sees))]
  return { class: viewers.some(viewer => viewer.class === 'controller') ? 'controller' : 'operator', sees, roles }
}

/** A side's units whose type passes a predicate, in id order. */
export const unitsWhere = (state: EngineState, side: string, predicate: (type: UnitType) => boolean): UnitRecord[] =>
  [...state.units.values()].filter(unit => unit.side === side && predicate(unitTypeOf(state.catalog, unit))).sort((a, b) => a.id < b.id ? -1 : 1)

/** Scouts sense and identify but carry no weapon; shooters carry one. */
export const isScout = (type: UnitType): boolean => type.components.sensor !== undefined && type.components.sensor.identifyM > 0 && type.components.effector === undefined && type.components.durability !== undefined
export const isShooter = (type: UnitType): boolean => type.components.effector !== undefined

export const pointAt = (lonLat: readonly [number, number]): GeoJsonPoint => geoPointFromLonLat(...lonLat)

/** Steps lost per side: one for damaged, two for destroyed, over units that can take damage. */
export const stepsLost = (state: EngineState, side: string): number => [...state.units.values()]
  .filter(unit => unit.side === side && unitTypeOf(state.catalog, unit).components.durability !== undefined)
  .reduce((sum, unit) => sum + (unit.integrity === 'destroyed' ? 2 : unit.integrity === 'damaged' ? 1 : 0), 0)

export interface PlayContext {
  readonly state: EngineState
  readonly elapsedS: number
}

/** A side's play: orders at fixed Run seconds, and orders it decides at each boundary from its own picture. */
export interface Play {
  readonly side: string
  readonly viewer: EinsatzViewer
  readonly orders: ReadonlyArray<TimedOrder>
  readonly react?: (context: PlayContext) => ReadonlyArray<Omit<TimedOrder, 'atS'>>
}

export interface PlayLog {
  readonly state: EngineState
  readonly transitions: ReadonlyArray<Transition>
  readonly refusals: ReadonlyArray<{ readonly atS: number; readonly capabilityId: string; readonly reason: string }>
}

const freshId = (state: EngineState, kind: 'unit' | 'task'): string => {
  for (let number = 1; ; number++) {
    const id = `${kind}:${number}`
    if (!state.units.has(id) && !state.tasks.has(id)) return id
  }
}

/** Runs one order as its caller, against the roles the Definition declares: refused orders are logged, never thrown. */
export const runOrder = async (state: EngineState, order: Omit<TimedOrder, 'atS'>, viewer: EinsatzViewer, by: string, declared: ReadonlyArray<ScenarioRole>): Promise<{ readonly state: EngineState; readonly transitions: ReadonlyArray<Transition>; readonly reason?: string }> => {
  if (!isEinsatzCommand(order.capabilityId)) throw new Error(`Not an Einsatz command: ${order.capabilityId}`)
  const prepared = prepareCommand({ state, viewer, roles: declared, by, newId: kind => freshId(state, kind) }, order.capabilityId, order.input)
  if (!prepared.ok) return { state, transitions: [], reason: prepared.reason }
  const outcome = await executeIntent(state, prepared.intent, prepared.actor, ports)
  return outcome.ok ? { state: outcome.state, transitions: outcome.transitions } : { state, transitions: [], reason: outcome.reason }
}

/**
 * Plays a Definition for `untilS` Run seconds in 2 s steps: at each step the
 * engine advances (running the engagement step), then the timeline's cues
 * due, then the play's orders due, then what the play decides.
 */
export const playBorder = async (input: { readonly definition?: ScenarioDefinition; readonly plays?: ReadonlyArray<Play>; readonly untilS: number; readonly start?: EngineState }): Promise<PlayLog> => {
  const definition = input.definition ?? borderDefinitions.scripted
  let state = input.start ?? borderStart(definition)
  const startMs = state.timeMs
  const transitions: Transition[] = []
  const refusals: Array<PlayLog['refusals'][number]> = []
  const cues = timelineOf(definition)
  const plays = input.plays ?? []
  const roles = borderRoles(definition)
  const apply = async (atS: number, order: Omit<TimedOrder, 'atS'>, viewer: EinsatzViewer, by: string): Promise<void> => {
    const result = await runOrder(state, order, viewer, by, roles)
    state = result.state
    transitions.push(...result.transitions)
    if (result.reason !== undefined) refusals.push({ atS, capabilityId: order.capabilityId, reason: result.reason })
  }
  for (let elapsedS = 0; elapsedS <= input.untilS; elapsedS += 2) {
    const advanced = await advanceEngine(state, startMs + elapsedS * 1_000, ports)
    state = advanced.state
    transitions.push(...advanced.transitions)
    for (const cue of cues.filter(entry => entry.atS > elapsedS - 2 && entry.atS <= elapsedS)) await apply(elapsedS, cue, openViewer, 'timeline')
    for (const play of plays) {
      for (const order of play.orders.filter(entry => entry.atS > elapsedS - 2 && entry.atS <= elapsedS)) await apply(elapsedS, order, play.viewer, `play:${play.side}`)
      for (const order of play.react?.({ state, elapsedS }) ?? []) await apply(elapsedS, order, play.viewer, `play:${play.side}`)
    }
  }
  return { state, transitions, refusals }
}
