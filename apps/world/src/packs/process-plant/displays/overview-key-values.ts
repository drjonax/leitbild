import type { ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import { COMPOSED_READOUTS_MAX_SIGNALS } from './composition.ts'
import { icTripWatchedPaths } from './ic-thresholds.ts'

const readableIn = (plant: CompiledProcessPlant) => (path: VariablePath): boolean => {
  const binding = plant.graph.signalBindingByPath.get(path)
  return binding !== undefined && !binding.writable && binding.published
}

// The few values a unit overview leads with, chosen by what the Plant
// declares rather than by name: each signal a trip rule judges on equipment
// outside the loops (a reactor's power, a pressurizer's pressure, a
// containment's pressure; per-loop values stay on their loop's symbols), then
// the first key value of each energy source and sink (a core's outlet
// temperature, a generator's output). Unpublished signals are left out; so
// are writable ones, which would show a demand, and the states symbols draw
// (a turbine stop valve's position, a breaker's contacts).
export const overviewKeyValues = (plant: CompiledProcessPlant): ReadonlyArray<VariablePath> => {
  const graph = plant.graph
  const ownerOf = (path: VariablePath) => {
    const binding = graph.signalBindingByPath.get(path)
    return binding?.owner.type === 'component' ? graph.components[binding.owner.componentIndex] : undefined
  }
  const readable = readableIn(plant)
  const drawn = new Set(graph.components.flatMap(component => [...component.semantics.aspects, ...component.semantics.embedded.flatMap(device => device.aspects)])
    .flatMap(aspect => aspect.state === undefined ? [] : [aspect.state.path]))
  const tripWatched = icTripWatchedPaths(plant).filter(path => {
    const owner = ownerOf(path)
    return owner !== undefined && owner.metadata?.loopId === undefined && !drawn.has(path)
  })
  const energyEnds = graph.components
    .filter(component => component.semantics.energy.some(role => role.role === 'source' || role.role === 'sink'))
    .flatMap(component => component.semantics.keyValues.slice(0, 1))
  return [...new Set([...tripWatched, ...energyEnds])].filter(readable).slice(0, COMPOSED_READOUTS_MAX_SIGNALS)
}

/**
 * What the Plant is doing as a display is opened, which a detail's lead
 * values are chosen by: the declared operating mode it is in (null where it
 * declares none or none holds), and its live values.
 */
export interface PlantNow {
  readonly mode: string | null
  readonly read: (path: VariablePath) => unknown
}

const ruleKind = (rule: ProcessPlantIcRule): 'trip' | 'alarm' | null =>
  rule.effects.some(effect => effect.type === 'trip.enter') ? 'trip'
    : rule.effects.some(effect => effect.type === 'alarm.enter') ? 'alarm'
      : null

const conditionBindings = (plant: CompiledProcessPlant, condition: ProcessPlantIcCondition): ReadonlyArray<ProcessSignalBinding> =>
  condition.type === 'comparison' ? [resolveProcessPlantSignalBinding(plant.graph, condition.signal)]
    : condition.type === 'not' ? conditionBindings(plant, condition.condition)
      : condition.conditions.flatMap(child => conditionBindings(plant, child))

// As the I&C runs: a rule declared for some modes acts only while the Plant is in one of them.
const actsIn = (rule: ProcessPlantIcRule, mode: string | null): boolean =>
  rule.modes === undefined || (mode !== null && rule.modes.includes(mode))

/** The signals alarm and trip rules judge, trips first, each kind in rule order: those that act in the mode, or only in others. */
const judged = (plant: CompiledProcessPlant, mode: string | null, acting: boolean): ReadonlyArray<ProcessSignalBinding> => (['trip', 'alarm'] as const)
  .flatMap(kind => plant.automation.rules
    .filter(rule => rule.enabled && ruleKind(rule) === kind && actsIn(rule, mode) === acting)
    .flatMap(rule => conditionBindings(plant, rule.condition)))

/**
 * Readings the model marks as measuring nothing now (a source range with its
 * high voltage cut), with the flags that say so: neither is what equipment
 * leads with while it is out.
 */
export const notMeaningfulNow = (plant: CompiledProcessPlant, now: PlantNow): ReadonlySet<VariablePath> => new Set(plant.graph.components
  .flatMap(component => component.semantics.meaningfulWhile)
  .flatMap(qualified => now.read(qualified.flag) === true ? [] : [qualified.flag, ...qualified.variables]))

/** What a detail's lead values depend on besides its equipment: the same key draws the same values. */
export const leadValuesKey = (plant: CompiledProcessPlant, now: PlantNow): string =>
  `${now.mode ?? 'no mode'}|${[...notMeaningfulNow(plant, now)].sort().join(',')}`

// A signal belongs to the node that owns its path and to the equipment it is
// bound to, as the alarms related to a display count it (ic-thresholds.ts):
// the core's outlet temperature and the RCS subcooling margin are both bound
// to the reactor coolant system.
const equipmentOf = (binding: ProcessSignalBinding): ReadonlyArray<string> => [
  String(binding.path).split('.')[0]!,
  ...(binding.equipmentId === undefined ? [] : [String(binding.equipmentId)]),
]

/**
 * The values a detail of some equipment leads with, for the Plant as it is
 * when the detail is opened: the signals of its equipment that alarm and
 * trip rules acting in the current mode judge (trips first), then the key
 * values its kind declares, then its instruments (signals with a tag), then
 * the signals only rules of other modes judge (a feedwater flow alarm that
 * acts at power, opened at shutdown). Readings the model marks as measuring
 * nothing now (a de-energized source range) come last. Each is taken in turn
 * from every item, so parallel equipment is compared value by value.
 */
export const equipmentKeyValues = (plant: CompiledProcessPlant, components: ReadonlyArray<number>, now: PlantNow): ReadonlyArray<VariablePath> => {
  const graph = plant.graph
  const ownerOf = (binding: { readonly owner: { readonly type: string; readonly componentIndex?: number } } | undefined) =>
    binding?.owner.type === 'component' ? binding.owner.componentIndex : undefined
  const readable = readableIn(plant)
  const own = (component: number) => graph.signalBindings.filter(binding => ownerOf(binding) === component)
  const equipment = (component: number) => new Set(own(component).flatMap(equipmentOf))
  const onEquipment = (bindings: ReadonlyArray<ProcessSignalBinding>) => (component: number): ReadonlyArray<VariablePath> => {
    const keys = equipment(component)
    return [...new Set(bindings.filter(binding => equipmentOf(binding).some(key => keys.has(key))).map(binding => binding.path))]
  }
  const inTurn = (listOf: (component: number) => ReadonlyArray<VariablePath>): ReadonlyArray<VariablePath> => {
    const lists = components.map(component => listOf(component).filter(readable))
    return Array.from({ length: Math.max(0, ...lists.map(list => list.length)) }, (_, rank) => lists.flatMap(list => list.slice(rank, rank + 1))).flat()
  }
  const ranked = [...new Set([
    ...inTurn(onEquipment(judged(plant, now.mode, true))),
    ...inTurn(component => graph.components[component]!.semantics.keyValues),
    ...inTurn(component => own(component).filter(binding => binding.tagId !== undefined).map(binding => binding.path)),
    ...inTurn(onEquipment(judged(plant, now.mode, false))),
  ])]
  const out = notMeaningfulNow(plant, now)
  return [...ranked.filter(path => !out.has(path)), ...ranked.filter(path => out.has(path))].slice(0, COMPOSED_READOUTS_MAX_SIGNALS)
}
