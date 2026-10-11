import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalPath } from '../signals.ts'
import { composedDisplayLayout } from './composition.ts'
import { limitKindName } from './display-text.ts'
import { actionOf, firstOutGroupOf, icRuleKind, icThresholdsForSignal } from './ic-thresholds.ts'
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
 */
export interface DisplayAnnunciation {
  /** What the reactor trip's group is called ("RX TRIP"), and the rules in it; null where the Plant declares none. */
  readonly reactorTrip: { readonly name: string; readonly ruleIds: ReadonlyArray<string> } | null
  /**
   * The automatic actuations other than the reactor trip (trips annunciated
   * as automatic actions), by what the display calls them: their group's
   * short label, or the trip's own title where its rule names no group.
   */
  readonly actuations: ReadonlyArray<{ readonly name: string; readonly ruleIds: ReadonlyArray<string> }>
  /**
   * The group a rule's first-out flag names, by rule id: only groups of more
   * than one rule, as being first among one says nothing (evaluation run 22
   * tagged SI "first out" 14 s after the reactor tripped).
   */
  readonly firstOutGroups: Readonly<Record<string, string>>
  /** Each alarm and trip rule's tag in an alarm row, by rule id: its limit as a chip names it, or with none, what it does. */
  readonly tags: Readonly<Record<string, string>>
}

/** The single numeric signal a rule acts on (alone, or gated by on/off states), whose limit names it. */
const limitedPath = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): VariablePath | null => {
  const numeric = (condition: ProcessPlantIcCondition): boolean =>
    condition.type === 'comparison' && typeof condition.value === 'number' && condition.operator !== '==' && condition.operator !== '!='
  const condition = rule.condition
  if (condition.type === 'comparison') return numeric(condition) ? resolveProcessPlantSignalPath(plant.graph, condition.signal) : null
  if (condition.type !== 'all') return null
  const limits = condition.conditions.filter(numeric)
  const gates = condition.conditions.filter(child => child.type === 'comparison' && typeof child.value === 'boolean')
  const only = limits[0]
  return limits.length === 1 && gates.length === condition.conditions.length - 1 && only?.type === 'comparison' ? resolveProcessPlantSignalPath(plant.graph, only.signal) : null
}

const annunciationByPlant = new WeakMap<CompiledProcessPlant, DisplayAnnunciation>()

export const displayAnnunciation = (plant: CompiledProcessPlant): DisplayAnnunciation => {
  const known = annunciationByPlant.get(plant)
  if (known !== undefined) return known
  const rules = plant.automation.rules.filter(rule => rule.enabled && icRuleKind(rule) !== 'control')
  const groupOf = new Map(rules.map(rule => [rule.id, firstOutGroupOf(plant, rule)]))
  const reactorTripRules = rules.filter(rule => groupOf.get(rule.id)?.reactorTrip === true)
  const automatic = (rule: ProcessPlantIcRule): boolean => rule.effects.some(effect => effect.type === 'trip.enter' && effect.annunciator?.role === 'automaticAction')
  const actuations = new Map<string, string[]>()
  for (const rule of rules) {
    if (!automatic(rule) || groupOf.get(rule.id)?.reactorTrip === true) continue
    const group = groupOf.get(rule.id)
    const title = rule.effects.find(effect => effect.type === 'trip.enter')!
    const name = group?.shortLabel ?? (title.type === 'trip.enter' ? title.title : rule.id)
    actuations.set(name, [...(actuations.get(name) ?? []), rule.id])
  }
  const members = new Map<string, number>()
  for (const group of groupOf.values()) if (group !== undefined) members.set(group.id, (members.get(group.id) ?? 0) + 1)
  const thresholdsOf = new Map<VariablePath, ReturnType<typeof icThresholdsForSignal>['thresholds']>()
  const tagOf = (rule: ProcessPlantIcRule): string => {
    const path = limitedPath(plant, rule)
    if (path !== null && !thresholdsOf.has(path)) thresholdsOf.set(path, icThresholdsForSignal(plant, path).thresholds)
    const threshold = path === null ? undefined : thresholdsOf.get(path)!.find(candidate => candidate.ruleId === rule.id)
    return threshold === undefined ? actionOf(plant, rule) : limitKindName(threshold)
  }
  const annunciation: DisplayAnnunciation = {
    reactorTrip: reactorTripRules.length === 0 ? null : { name: groupOf.get(reactorTripRules[0]!.id)!.shortLabel, ruleIds: reactorTripRules.map(rule => rule.id) },
    actuations: [...actuations.entries()].map(([name, ruleIds]) => ({ name, ruleIds })),
    firstOutGroups: Object.fromEntries(rules.flatMap(rule => {
      const group = groupOf.get(rule.id)
      return group !== undefined && (members.get(group.id) ?? 0) > 1 ? [[rule.id, group.shortLabel]] : []
    })),
    tags: Object.fromEntries(rules.map(rule => [rule.id, tagOf(rule)])),
  }
  annunciationByPlant.set(plant, annunciation)
  return annunciation
}
