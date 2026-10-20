import type { ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { processPlantOperatingMode } from '../runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { ACTION_REACH_LINKS, actionFlows, actionFlowsInto, actionStates, actsIn, armed, automaticActions, conditionBindings, feedsTransferIntake } from './actuations.ts'

/**
 * The most values a unit leads with in its overview and on its map card:
 * what an operator takes in at a glance, the energy ends among them.
 */
export const OVERVIEW_MAX_LEAD_VALUES = 6

/**
 * The most values equipment opened from an overview leads with: its column
 * has no annunciator tiles, so it holds more than an overview's six in a Full
 * HD window (the core's nuclear instruments and exit thermocouples beside its
 * power and margins).
 */
export const GENERATED_DETAIL_MAX_LEAD_VALUES = 8

/**
 * A signal an operator reads as measured: published, and read-only, or a
 * condition outside the Plant that only a scenario sets (the offsite grid's
 * voltage and frequency), which the Plant does not command.
 */
export const readsAsMeasured = (binding: Pick<ProcessSignalBinding, 'published' | 'writable' | 'actuation'>): boolean =>
  binding.published && (!binding.writable || binding.actuation === 'boundary')

/** A demand: what an operator, a controller or the I&C commands the equipment to do, which it may not follow. */
export const isDemand = (binding: Pick<ProcessSignalBinding, 'writable' | 'actuation'>): boolean =>
  binding.writable && binding.actuation === 'command'

// What may lead a display: a measured reading, never one only the simulator computes, which no instrument of a real
// plant reads (a vessel's net inventory flow).
const leadableIn = (plant: CompiledProcessPlant) => (path: VariablePath): boolean => {
  const binding = plant.graph.signalBindingByPath.get(path)
  return binding !== undefined && readsAsMeasured(binding) && binding.simulatorOnly !== true
}

/**
 * The values a unit overview leads with, chosen by what the Plant declares
 * for the mode it is in rather than by name, so a tripped unit leads with its
 * heat sink and inventory, not with a power it no longer makes. The ends of
 * the energy path keep their places however many values come before them:
 * - while a rule acting in the mode watches an energy sink (at power), the
 *   first key value of each energy source and sink a rule acting in the mode
 *   watches (a core's outlet temperature, a generator's output), last;
 * - while none does (a tripped or shut-down unit, whose heat leaves only
 *   through the transfers into its other circuits), first, as the critical
 *   safety functions are checked after a trip: the first key value of what
 *   each source heats in contact (the vessel's subcooling margin), the
 *   source's own (its outlet temperature), and what the automatic actions
 *   acting in the mode send into the side of a transfer that takes the heat
 *   (the auxiliary feed into the steam generators), started or not, so a unit
 *   whose feed has not yet started reads its heat sink at 0.
 * The leads, in as many places as the ends leave:
 * - each value a trip rule acting in the mode judges, while that trip can
 *   still act (a reactor trip whose breakers are open guards nothing more);
 * - what the automatic actions acting in the mode deliver once they have
 *   started it (the auxiliary feedwater and safety injection their pumps send
 *   through a header); one yet to act shows by the value that sets it off;
 * - the key values of the equipment rules acting in the mode judge (a
 *   pressurizer's pressure and level), in rule order.
 * A lead that reads inside the normal range its signal declares yields its
 * place to the next (containment pressure at atmospheric, every actuation on
 * it armed and far off): the one change of order the Plant's values make
 * within a mode. A trip that has done all it can watches nothing more: a
 * turbine already tripped keeps no generator output among the leads.
 * Per-loop values stay on their loop's symbols. Only what an operator reads
 * as measured leads (readsAsMeasured): never a demand, never a value only the
 * simulator computes; nor on-off states, nor the states symbols draw as a
 * position, a run or an energized state (a turbine stop valve's position, a
 * breaker's contacts).
 */
export const overviewKeyValues = (plant: CompiledProcessPlant, now: PlantNow): ReadonlyArray<VariablePath> => {
  const { leads, ends, endsFirst } = overviewCandidates(plant, now)
  const normal = (path: VariablePath): boolean => {
    const range = plant.graph.signalBindingByPath.get(path)?.limits?.normalRange
    const value = now.read(path)
    return range !== undefined && typeof value === 'number' && value >= range.min && value <= range.max
  }
  const shown = [...leads.filter(path => !normal(path)), ...leads.filter(normal)].slice(0, Math.max(0, OVERVIEW_MAX_LEAD_VALUES - ends.length))
  return (endsFirst ? [...ends, ...shown] : [...shown, ...ends]).slice(0, OVERVIEW_MAX_LEAD_VALUES)
}

/**
 * Every value the unit watches in the mode, in the order the overview leads
 * with them (overviewKeyValues): the leads, of which as many as there is room
 * for beside the energy ends, and the ends, which come first where no energy
 * sink is watched.
 */
export const overviewCandidates = (plant: CompiledProcessPlant, now: PlantNow): { readonly leads: ReadonlyArray<VariablePath>; readonly ends: ReadonlyArray<VariablePath>; readonly endsFirst: boolean } => {
  const graph = plant.graph
  const ownerOf = (path: VariablePath) => {
    const binding = graph.signalBindingByPath.get(path)
    return binding?.owner.type === 'component' ? graph.components[binding.owner.componentIndex] : undefined
  }
  const readable = leadableIn(plant)
  const drawnStates = new Set(graph.components.flatMap(component => [...component.semantics.aspects, ...component.semantics.embedded.flatMap(device => device.aspects)])
    .flatMap(aspect => aspect.state === undefined || aspect.aspect === 'level' || aspect.aspect === 'throughput' ? [] : [aspect.state.path]))
  const leadable = (path: VariablePath): boolean => {
    const owner = ownerOf(path)
    return owner !== undefined && owner.metadata?.loopId === undefined && !drawnStates.has(path)
      && graph.signalBindingByPath.get(path)?.quantity !== 'boolean' && readable(path)
  }
  const inForce = plant.automation.rules.filter(rule => rule.enabled && actsIn(rule, now.mode))
  const actions = automaticActions(plant)
  const canAct = (rule: ProcessPlantIcRule): boolean => {
    const action = actions.get(rule.id)
    return action === undefined || armed(action, now.read)
  }
  const guarding = inForce.filter(rule => ruleKind(rule) === 'trip' && canAct(rule)).flatMap(rule => conditionBindings(plant, rule.condition).map(binding => binding.path))
  const delivered = inForce.flatMap(rule => {
    const action = actions.get(rule.id)
    if (action === undefined) return []
    const started = { ...action, writes: action.writes.filter(write => now.read(write.binding.path) === write.value) }
    return actionFlows(plant, started, ACTION_REACH_LINKS).filter(flow => flow.effect === 'starts').map(flow => flow.path)
  })
  const judgedEquipment = [...new Set(inForce.filter(rule => ruleKind(rule) !== null && canAct(rule))
    .flatMap(rule => conditionBindings(plant, rule.condition).flatMap(binding => binding.owner.type === 'component' ? [binding.owner.componentIndex] : [])))]
  const keyed = judgedEquipment.flatMap(component => graph.components[component]!.semantics.keyValues)
  const watched = new Set(judgedEquipment)
  const watchedAs = (role: 'source' | 'sink') => graph.components.filter(component => watched.has(component.index) && component.semantics.energy.some(energy => energy.role === role))
  const sources = watchedAs('source')
  const sinks = watchedAs('sink')
  const first = (component: number): ReadonlyArray<VariablePath> => graph.components[component]!.semantics.keyValues.slice(0, 1)
  const ends = sinks.length > 0
    ? [...new Set(graph.components.filter(component => sources.includes(component) || sinks.includes(component)).flatMap(component => first(component.index)))].filter(readable)
    : [...new Set([
      ...sources.flatMap(source => heatedInContact(plant, source.index).flatMap(first)),
      ...sources.flatMap(source => first(source.index)),
      ...inForce.flatMap(rule => {
        const action = actions.get(rule.id)
        return action === undefined ? [] : actionFlows(plant, action, ACTION_REACH_LINKS)
          .filter(flow => flow.effect === 'starts' && feedsTransferIntake(plant, flow.path, ACTION_REACH_LINKS)).map(flow => flow.path)
      }),
    ])].filter(readable)
  const leads = [...new Set([...guarding, ...delivered, ...keyed])].filter(path => leadable(path) && !ends.includes(path))
  return { leads, ends, endsFirst: sinks.length === 0 }
}

/** The equipment a component heats through a thermal contact (a reactor core its vessel's coolant). */
const heatedInContact = (plant: CompiledProcessPlant, component: number): ReadonlyArray<number> =>
  (plant.graph.outgoingLinksByComponent[component] ?? []).map(index => plant.graph.links[index]!)
    .filter(link => link.kind === 'thermalContact').map(link => link.toComponentIndex)

/**
 * What the Plant is doing as a display is opened, which a detail's lead
 * values are chosen by: the declared operating mode it is in (null where it
 * declares none or none holds), and its live values.
 */
export interface PlantNow {
  readonly mode: string | null
  readonly read: (path: VariablePath) => unknown
}

/** The Plant's declared operating mode and live values now. */
export const plantNowOf = (system: ProcessPlantRuntimeInstance): PlantNow => {
  const modes = system.plant.automation.operatingModes
  return {
    mode: modes.length === 0 ? null : processPlantOperatingMode({ system: system.plant, runtime: system.runtime, modes })?.id ?? null,
    read: path => system.runtime.readVariableSnapshot(path).value,
  }
}

const ruleKind = (rule: ProcessPlantIcRule): 'trip' | 'alarm' | null =>
  rule.effects.some(effect => effect.type === 'trip.enter') ? 'trip'
    : rule.effects.some(effect => effect.type === 'alarm.enter') ? 'alarm'
      : null

/** The signals alarm and trip rules judge, trips first, each kind in rule order: those that act in the mode, or only in others. */
const judged = (plant: CompiledProcessPlant, mode: string | null, acting: boolean): ReadonlyArray<ProcessSignalBinding> => (['trip', 'alarm'] as const)
  .flatMap(kind => plant.automation.rules
    .filter(rule => rule.enabled && ruleKind(rule) === kind && actsIn(rule, mode) === acting)
    .flatMap(rule => conditionBindings(plant, rule.condition)))

/** Each reading the model marks as measuring nothing now, with the flag that says so. */
const silencedBy = (plant: CompiledProcessPlant, now: PlantNow): ReadonlyMap<VariablePath, VariablePath> => new Map(plant.graph.components
  .flatMap(component => component.semantics.meaningfulWhile)
  .flatMap(qualified => now.read(qualified.flag) === true ? [] : qualified.variables.map(variable => [variable, qualified.flag] as const)))

/**
 * Readings the model marks as measuring nothing now (a source range with its
 * high voltage cut).
 */
export const notMeaningfulNow = (plant: CompiledProcessPlant, now: PlantNow): ReadonlySet<VariablePath> => new Set(silencedBy(plant, now).keys())

/**
 * The flags that say whether readings measure anything (a source range's high
 * voltage), and the permissives equipment derives (P-6, P-10, P-11): they
 * qualify readings or gate protection; they are no readings of their own.
 */
const meaningFlags = (plant: CompiledProcessPlant): ReadonlySet<VariablePath> => new Set(plant.graph.components
  .flatMap(component => [...component.semantics.meaningfulWhile.map(qualified => qualified.flag), ...component.semantics.permissives]))

/** The equipment a trip commands that has done all it can (no write of it left to make): a tripped reactor's core. */
const commandedByActedTrips = (plant: CompiledProcessPlant, now: PlantNow): ReadonlySet<number> => new Set([...automaticActions(plant).values()]
  .filter(action => !armed(action, now.read)).flatMap(action => action.writes.map(write => write.component)))

/**
 * What says equipment that declares shutdown readings has stopped, once a
 * trip commanding it has acted, as E-0 verifies a reactor trip first: its
 * declared on/off readings (rods on bottom), the states every trip commanding
 * it moves (both reactor trip breakers), then its declared readings (power
 * range and startup rate, falling). None while every trip commanding it can
 * still act (at power), or for equipment that declares none.
 */
const stoppedReadings = (plant: CompiledProcessPlant, component: number, acted: ReadonlySet<number>): ReadonlyArray<VariablePath> => {
  const declared = plant.graph.components[component]!.semantics.shutdownReadings
  if (declared.length === 0 || !acted.has(component)) return []
  const moved = [...automaticActions(plant).values()].filter(action => action.writes.some(write => write.component === component))
    .map(action => actionStates(plant, action).map(state => state.path))
  const common = (moved[0] ?? []).filter(path => moved.every(paths => paths.includes(path)))
  const state = (path: VariablePath): boolean => plant.graph.signalBindingByPath.get(path)?.quantity === 'boolean'
  return [...declared.filter(state), ...common, ...declared.filter(path => !state(path))]
}

/**
 * What a detail's lead values depend on besides its equipment: the same key
 * draws the same values. Its parts: the mode, the readings measuring nothing
 * now, and the equipment whose shutdown readings lead (stoppedReadings).
 */
export const leadValuesKey = (plant: CompiledProcessPlant, now: PlantNow): string => {
  const stopped = [...commandedByActedTrips(plant, now)].map(component => plant.graph.components[component]!)
    .filter(component => component.semantics.shutdownReadings.length > 0).map(component => String(component.id)).sort()
  return `${now.mode ?? 'no mode'}|${[...notMeaningfulNow(plant, now)].sort().join(',')}|${stopped.join(',')}`
}

// A signal belongs to the node that owns its path and to the equipment it is
// bound to, as the alarms related to a display count it (ic/thresholds.ts):
// the core's outlet temperature and the RCS subcooling margin are both bound
// to the reactor coolant system.
const equipmentOf = (binding: ProcessSignalBinding): ReadonlyArray<string> => [
  String(binding.path).split('.')[0]!,
  ...(binding.equipmentId === undefined ? [] : [String(binding.equipmentId)]),
]

/**
 * The values a detail of some equipment leads with, for the Plant as it is
 * when the detail is opened: once a trip commanding it has acted, what says
 * it stopped (stoppedReadings: rods on bottom, both trip breakers, power
 * falling; a faceplate takes these over where the detail draws one); the
 * signals of its equipment that alarm and
 * trip rules acting in the current mode judge (trips first); what automatic
 * actions acting in the mode on those signals send into it (the auxiliary
 * feedwater a steam generator's low-low level starts, into that steam
 * generator); the key values its kind declares; its instruments (signals
 * with a tag); then the signals only rules of other modes judge (a
 * feedwater flow alarm that acts at power, opened at shutdown). A reading the
 * model marks as measuring nothing now (a de-energized source range) gives
 * its place to the flag that says so, shown as a state, so the detail says
 * the instrument is off rather than nothing; while the reading measures, it
 * is shown and its flag is not. An instrument reading the same quantity over
 * a wider span follows the reading it widens. A permissive (P-10 on the core)
 * is never a value of its own: the source range's high voltage is the
 * instrument fact, its state the logic's. A program leads only right after
 * the reading it programs (Tref after Tavg, a pressurizer's level program
 * after its level), never alone (HMI review of run 25: Tref without Tavg).
 * Only what an operator reads as measured leads, never a value only the
 * simulator computes. Each is taken in turn from every item, so parallel
 * equipment is compared value by value.
 */
export const equipmentKeyValues = (plant: CompiledProcessPlant, components: ReadonlyArray<number>, now: PlantNow): ReadonlyArray<VariablePath> => {
  const graph = plant.graph
  const ownerOf = (binding: { readonly owner: { readonly type: string; readonly componentIndex?: number } } | undefined) =>
    binding?.owner.type === 'component' ? binding.owner.componentIndex : undefined
  const readable = leadableIn(plant)
  const own = (component: number) => graph.signalBindings.filter(binding => ownerOf(binding) === component)
  const equipment = (component: number) => new Set(own(component).flatMap(equipmentOf))
  const onEquipment = (bindings: ReadonlyArray<ProcessSignalBinding>) => (component: number): ReadonlyArray<VariablePath> => {
    const keys = equipment(component)
    return [...new Set(bindings.filter(binding => equipmentOf(binding).some(key => keys.has(key))).map(binding => binding.path))]
  }
  // An instrument that reads the same quantity over a wider span ranks beside the reading it widens (a steam
  // generator's wide-range level beside its narrow range), on each item, so parallel items still compare in turn.
  const wider = new Map(components.flatMap(component => graph.components[component]!.semantics.widerRanges.flatMap(range => range.while === undefined ? [[range.reading, range.wider] as const] : [])))
  const widened = (paths: ReadonlyArray<VariablePath>): ReadonlyArray<VariablePath> => paths.flatMap(path => wider.has(path) ? [path, wider.get(path)!] : [path])
  const inTurn = (listOf: (component: number) => ReadonlyArray<VariablePath>): ReadonlyArray<VariablePath> => {
    const lists = components.map(component => widened(listOf(component)).filter(readable))
    return Array.from({ length: Math.max(0, ...lists.map(list => list.length)) }, (_, rank) => lists.flatMap(list => list.slice(rank, rank + 1))).flat()
  }
  const actions = [...automaticActions(plant).values()].filter(action => actsIn(action.rule, now.mode))
  const sentInto = (component: number): ReadonlyArray<VariablePath> => {
    const keys = equipment(component)
    return actions
      .filter(action => conditionBindings(plant, action.rule.condition).some(binding => equipmentOf(binding).some(key => keys.has(key))))
      .flatMap(action => actionFlowsInto(plant, action, component).map(flow => flow.path))
  }
  const acted = commandedByActedTrips(plant, now)
  const ranked = [...new Set([
    ...inTurn(component => stoppedReadings(plant, component, acted)),
    ...inTurn(onEquipment(judged(plant, now.mode, true))),
    ...inTurn(sentInto),
    ...inTurn(component => graph.components[component]!.semantics.keyValues),
    ...inTurn(component => own(component).filter(binding => binding.tagId !== undefined).map(binding => binding.path)),
    ...inTurn(onEquipment(judged(plant, now.mode, false))),
  ])]
  // A reading that measures nothing now gives its place to the flag that says so, shown as a state (the source
  // range's high voltage off above P-6); while it measures, the reading itself says the flag is on.
  const silenced = new Map([...silencedBy(plant, now)].filter(([, flag]) => readable(flag)))
  const out = meaningFlags(plant)
  const shown = [...new Set(ranked.flatMap(path => silenced.has(path) ? [silenced.get(path)!] : out.has(path) ? [] : [path]))]
  // A program goes right after its reading, which comes along where it is not shown (Tavg before Tref).
  const programmed = new Map(components.flatMap(component => graph.components[component]!.semantics.programs.map(program => [program.program, program.reading] as const)))
  const paired: VariablePath[] = []
  for (const path of shown) {
    const reading = programmed.get(path)
    if (paired.includes(path) || (reading !== undefined && !readable(reading))) continue
    if (reading === undefined) paired.push(path)
    else if (paired.includes(reading)) paired.splice(paired.indexOf(reading) + 1, 0, path)
    else paired.push(reading, path)
  }
  return paired.slice(0, GENERATED_DETAIL_MAX_LEAD_VALUES)
}
