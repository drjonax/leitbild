import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'
import { processPlantIcLifecycleIdFor } from '../runtime/index.ts'
import { resolveProcessPlantSignalPath } from '../signals.ts'
import { composedDisplayLayout } from './composition.ts'
import { limitOrderName } from './display-text.ts'
import { energyEnds } from '../graph/index.ts'
import { automaticActions } from './actuations.ts'
import { firstOutGroupOf, icRuleKind, icThresholdsForSignal, UNDECLARED_ACTION } from '../ic/thresholds.ts'
import { flapText } from './mimic/bindings.ts'
import { textWidth, unmeasurable } from './mimic/text-metrics.ts'

// The Plant's annunciator systems as its I&C config declares them, in their
// declared order, each with the rules whose alarms and trips name it: the
// first level an overview summarises its alarms by. The config guarantees
// that every alarm names exactly one declared system, so a quiet tile is a
// quiet system.

export interface AnnunciatorSystem {
  readonly id: string
  /** As operators name it ("Reactor coolant system"). */
  readonly name: string
  /** What its tile says at the display's tile width: the name, or the declared short label where the name does not fit. Never cut. */
  readonly label: string
  /** The rules whose alarms or trips it annunciates. */
  readonly ruleIds: ReadonlyArray<string>
}

export type AnnunciatorSystemsResult =
  | { readonly ok: true; readonly systems: ReadonlyArray<AnnunciatorSystem> }
  | { readonly ok: false; readonly issues: ReadonlyArray<string> }

const fits = (text: string, room: number): boolean => unmeasurable('tag', text).length === 0 && textWidth('tag', text) <= room

/** The declared systems with what each tile says at a tile width (composedDisplayLayout.annunciatorTile.widths). */
export const annunciatorSystems = (plant: CompiledProcessPlant, tileWidth: number): AnnunciatorSystemsResult => {
  const ruleIds = new Map<string, string[]>()
  for (const rule of plant.automation.rules) {
    if (!rule.enabled) continue
    const systems = new Set(rule.effects.flatMap(effect => (effect.type === 'alarm.enter' || effect.type === 'trip.enter') && effect.annunciator?.system !== undefined ? [effect.annunciator.system] : []))
    for (const system of systems) ruleIds.set(system, [...(ruleIds.get(system) ?? []), rule.id])
  }
  const room = tileWidth - composedDisplayLayout.annunciatorTile.inset
  const issues: string[] = []
  const systems = plant.automation.annunciatorSystems.map(system => {
    const label = [system.label, system.shortLabel].find((candidate): candidate is string => candidate !== undefined && fits(candidate, room))
    if (label === undefined) issues.push(`annunciator system ${system.id}: neither "${system.label}" nor its short label${system.shortLabel === undefined ? ' (none declared)' : ` "${system.shortLabel}"`} fits a tile ${room} px wide; declare a short label that does`)
    return { id: system.id, name: system.label, label: label ?? system.label, ruleIds: ruleIds.get(system.id) ?? [] }
  })
  return issues.length > 0 ? { ok: false, issues } : { ok: true, systems }
}

/**
 * How a display names what the Plant's alarms and trips do, from what its
 * I&C declares: the banner leads with the reactor trip's first-out, a line
 * apart lists the other automatic actuations active, a first-out flag names
 * its group, and each alarm row is tagged as its limit is named on a chip, a
 * badge and a trend line ("LO-LO · RX TRIP"). Nothing is read from a rule's
 * id or title.
 *
 * Groups belong to what a rule annunciates, not to the rule: a rule that
 * trips the reactor besides its own actuation annunciates both, its own trip
 * in its actuation's group ("SI") and the reactor trip in the reactor trip's
 * group, so the reactor trip's first-out can be the one safety injection
 * caused while SI is still listed as actuated, and its row is tagged as a
 * reactor trip. Each is keyed by the id of the alarm or trip it annunciates
 * (an alarm row's id).
 */
export interface DisplayAnnunciation {
  /** What the reactor trip's group is called ("RX TRIP"), and the trips annunciated in it; null where the Plant declares none. */
  readonly reactorTrip: { readonly name: string; readonly ids: ReadonlyArray<string> } | null
  /**
   * The automatic actuations other than the reactor trip (trips annunciated
   * as automatic actions), by what the display calls them: their group's
   * short label, or the trip's own title where it names no group.
   */
  readonly actuations: ReadonlyArray<{ readonly name: string; readonly ids: ReadonlyArray<string> }>
  /**
   * The group an alarm's or trip's first-out flag names, by its id: only
   * groups of more than one, as being first among one says nothing
   * (evaluation run 22 tagged SI "first out" 14 s after the reactor tripped).
   */
  readonly firstOutGroups: Readonly<Record<string, string>>
  /**
   * Each alarm's and trip's tag in an alarm row, by its id: its limit's order
   * and what it annunciates does ("LO-LO · RX TRIP"), or with no limit, what
   * it does. What it does is its own group's, not its rule's: the reactor
   * trip safety injection causes reads "LO-LO · RX TRIP" beside SI's own
   * "LO-LO · SI" (QA review of run 22). An alarm with no limit on one value
   * says what it watches, in the words its drawing's flap uses ("DEAD ·
   * ALM", "L LO & F LO · ALM"), never a bare ALM (HMI review of run 23).
   */
  readonly tags: Readonly<Record<string, string>>
  /**
   * The first-out group each alarm or trip names, by its id, as chips and
   * the banner name what it does ("SI", "AFW START"): what an annunciator
   * tile says its system's active alarms do.
   */
  readonly groups: Readonly<Record<string, string>>
  /** The groups' names in the order a tile lists them: the reactor trip's first, then as the I&C declares them. */
  readonly groupOrder: ReadonlyArray<string>
  /**
   * The alarms and trips a first-out group's actuation brings in as its
   * expected consequences, as their annunciators declare (expectedAfter),
   * by id: the group's name, whose first-out they follow ("RX TRIP"), and
   * how long after it they are expected (panel-presenters.ts expectedAfter).
   */
  readonly expected: Readonly<Record<string, { readonly after: string; readonly withinMs: number }>>
  /**
   * The equipment each alarm or trip annunciates on, by id, as its
   * annunciator declares it: an alarm that came in with a first-out on the
   * same equipment is the first-out's own condition, never expected after it
   * (panel-presenters.ts expectedAfter).
   */
  readonly equipment: Readonly<Record<string, string>>
  /**
   * The energy ends (energyEnds) each group's own actuations command, by the
   * group's name, so its banner label opens them: RX TRIP the core whose rods
   * it inserts, TURB TRIP the turbine. A group that commands none opens
   * nothing (AFW START starts pumps and opens valves).
   */
  readonly ends: Readonly<Record<string, ReadonlyArray<string>>>
}

/**
 * The single numeric signal a display draws the rule's limit on, alone or
 * inside a combined condition (ic/thresholds.ts), whose limit names it; null
 * where it draws it on none, or on several.
 */
const limitedPath = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): VariablePath | null => {
  const numeric = (condition: ProcessPlantIcCondition): ReadonlyArray<VariablePath> =>
    condition.type === 'comparison' ? (typeof condition.value === 'number' && condition.operator !== '==' && condition.operator !== '!=' ? [resolveProcessPlantSignalPath(plant.graph, condition.signal)] : [])
      : condition.type === 'not' ? numeric(condition.condition) : condition.conditions.flatMap(numeric)
  const drawn = [...new Set(numeric(rule.condition))].filter(path => icThresholdsForSignal(plant, path).thresholds.some(threshold => threshold.ruleId === rule.id))
  return drawn.length === 1 ? drawn[0]! : null
}

const watchesByPlant = new WeakMap<CompiledProcessPlant, ReadonlyMap<string, string>>()

/**
 * What each alarm rule with no limit on one value watches, by rule id, in
 * the words its drawing's flap uses ("L LO & F LO", "DEAD"): its alarm row's
 * tag and a chip on any of its values name it so, apart from another alarm at
 * the same limit. A steam generator's low level with low feed and its
 * power-operation feed flow alarm both set LO 150 kg/s on the feed flow;
 * after a trip the second clears with its mode while the first stays active,
 * and a chip reading "LO · ALM" read as the cleared one (HMI review of run 25).
 */
export const alarmWatches = (plant: CompiledProcessPlant): ReadonlyMap<string, string> => {
  const known = watchesByPlant.get(plant)
  if (known !== undefined) return known
  const watches = new Map(plant.automation.rules
    .filter(rule => rule.enabled && icRuleKind(rule) === 'alarm' && limitedPath(plant, rule) === null)
    .map(rule => [rule.id, flapText(plant, rule, undefined).watches] as const))
  watchesByPlant.set(plant, watches)
  return watches
}

const annunciationByPlant = new WeakMap<CompiledProcessPlant, DisplayAnnunciation>()

export const displayAnnunciation = (plant: CompiledProcessPlant): DisplayAnnunciation => {
  const known = annunciationByPlant.get(plant)
  if (known !== undefined) return known
  const rules = plant.automation.rules.filter(rule => rule.enabled && icRuleKind(rule) !== 'control')
  // Every alarm and trip the rules annunciate, with the group it names.
  const annunciated = rules.flatMap(rule => rule.effects.flatMap(effect => effect.type === 'alarm.enter' || effect.type === 'trip.enter' ? [{
    id: processPlantIcLifecycleIdFor(effect.type === 'alarm.enter' ? 'alarm' : 'trip', rule.id, effect.id),
    rule,
    effect,
    group: effect.annunciator?.firstOutGroup === undefined ? undefined : plant.automation.firstOutGroups.find(group => group.id === effect.annunciator!.firstOutGroup),
  }] : []))
  const reactorTrips = annunciated.filter(entry => entry.group?.reactorTrip === true)
  const actuations = new Map<string, string[]>()
  for (const { id, effect, group } of annunciated) {
    if (effect.type !== 'trip.enter' || effect.annunciator?.role !== 'automaticAction' || group?.reactorTrip === true) continue
    const name = group?.shortLabel ?? effect.title
    actuations.set(name, [...(actuations.get(name) ?? []), id])
  }
  const members = new Map<string, number>()
  for (const { group } of annunciated) if (group !== undefined) members.set(group.id, (members.get(group.id) ?? 0) + 1)
  const thresholdsOf = new Map<VariablePath, ReturnType<typeof icThresholdsForSignal>['thresholds']>()
  const orderOf = (rule: ProcessPlantIcRule): string | null => {
    const path = limitedPath(plant, rule)
    if (path !== null && !thresholdsOf.has(path)) thresholdsOf.set(path, icThresholdsForSignal(plant, path).thresholds)
    const threshold = path === null ? undefined : thresholdsOf.get(path)!.find(candidate => candidate.ruleId === rule.id)
    return threshold === undefined ? null : limitOrderName(threshold)
  }
  // What an annunciated alarm or trip does, as a threshold's action names it (ic/thresholds.ts actionOf), from its own group.
  const actionOfEntry = ({ effect, group }: (typeof annunciated)[number]): string =>
    effect.type === 'alarm.enter' ? 'ALM' : group?.shortLabel ?? UNDECLARED_ACTION
  const tagOf = (entry: (typeof annunciated)[number]): string => {
    const order = orderOf(entry.rule)
    if (order !== null) return `${order} · ${actionOfEntry(entry)}`
    const watches = entry.effect.type === 'alarm.enter' ? alarmWatches(plant).get(entry.rule.id) : undefined
    return watches === undefined ? actionOfEntry(entry) : `${watches} · ${actionOfEntry(entry)}`
  }
  const declared = plant.automation.firstOutGroups
  const annunciation: DisplayAnnunciation = {
    reactorTrip: reactorTrips.length === 0 ? null : { name: reactorTrips[0]!.group!.shortLabel, ids: reactorTrips.map(entry => entry.id) },
    actuations: [...actuations.entries()].map(([name, ids]) => ({ name, ids })),
    firstOutGroups: Object.fromEntries(annunciated.flatMap(({ id, group }) => group !== undefined && (members.get(group.id) ?? 0) > 1 ? [[id, group.shortLabel]] : [])),
    tags: Object.fromEntries(annunciated.map(entry => [entry.id, tagOf(entry)])),
    groups: Object.fromEntries(annunciated.flatMap(({ id, group }) => group === undefined ? [] : [[id, group.shortLabel]])),
    groupOrder: [...declared.filter(group => group.reactorTrip), ...declared.filter(group => !group.reactorTrip)].map(group => group.shortLabel),
    ends: Object.fromEntries(declared.flatMap(group => {
      const commanding = [...automaticActions(plant).values()].filter(action => firstOutGroupOf(plant, action.rule)?.id === group.id)
      const commanded = energyEnds(plant.graph).filter(end => commanding.some(action => action.writes.some(write => write.component === end.component.index)))
      return commanded.length === 0 ? [] : [[group.shortLabel, [...new Set(commanded.map(end => String(end.component.id)))]]]
    })),
    equipment: Object.fromEntries(annunciated.flatMap(({ id, effect }) => effect.annunciator?.equipmentId === undefined ? [] : [[id, effect.annunciator.equipmentId]])),
    expected: Object.fromEntries(annunciated.flatMap(({ id, effect }) => {
      const expected = effect.annunciator?.expectedAfter
      const after = expected === undefined ? undefined : declared.find(group => group.id === expected.firstOutGroup)
      return expected === undefined || after === undefined ? [] : [[id, { after: after.shortLabel, withinMs: expected.withinMs }]]
    })),
  }
  annunciationByPlant.set(plant, annunciation)
  return annunciation
}
