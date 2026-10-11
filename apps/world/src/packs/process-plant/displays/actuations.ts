import type { ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import { downstreamLinks, linkCarrier, nextLinks } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import { linkFlowBinding } from './mimic/bindings.ts'

// What the Plant's protection sets going, read from its declared I&C rules:
// a trip that writes equipment commands is an automatic action (auxiliary
// feedwater, safety injection, feedwater isolation). Displays lead with what
// such actions still guard and with what they deliver; nothing here names
// equipment or signals.

/** A trip that commands equipment: each command it writes, on the component it commands, and the value it writes. */
export interface AutomaticAction {
  readonly rule: ProcessPlantIcRule
  readonly writes: ReadonlyArray<{ readonly binding: ProcessSignalBinding; readonly component: number; readonly value: number | boolean }>
}

const isTrip = (rule: ProcessPlantIcRule): boolean => rule.effects.some(effect => effect.type === 'trip.enter')

const actionsByPlant = new WeakMap<CompiledProcessPlant, ReadonlyMap<string, AutomaticAction>>()

/** The Plant's automatic actions by rule id, in rule order. */
export const automaticActions = (plant: CompiledProcessPlant): ReadonlyMap<string, AutomaticAction> => {
  const cached = actionsByPlant.get(plant)
  if (cached !== undefined) return cached
  const actions = new Map<string, AutomaticAction>()
  for (const rule of plant.automation.rules) {
    if (!rule.enabled || !isTrip(rule)) continue
    const writes = rule.effects.flatMap(effect => {
      if (effect.type !== 'writeSignal') return []
      const binding = resolveProcessPlantSignalBinding(plant.graph, effect.signal)
      return binding.owner.type === 'component' && binding.actuation === 'command'
        ? [{ binding, component: binding.owner.componentIndex, value: effect.value }]
        : []
    })
    if (writes.length > 0) actions.set(rule.id, { rule, writes })
  }
  actionsByPlant.set(plant, actions)
  return actions
}

/** As the I&C runs: a rule declared for some modes acts only while the Plant is in one of them. */
export const actsIn = (rule: ProcessPlantIcRule, mode: string | null): boolean =>
  rule.modes === undefined || (mode !== null && rule.modes.includes(mode))

/**
 * Whether an action can still act: some command it writes does not yet read
 * what it would write. A reactor trip whose breakers are already open guards
 * nothing more; its value is no protection to lead with.
 */
export const armed = (action: AutomaticAction, read: (path: VariablePath) => unknown): boolean =>
  action.writes.some(write => read(write.binding.path) !== write.value)

/** Every signal a condition judges. */
export const conditionBindings = (plant: CompiledProcessPlant, condition: ProcessPlantIcCondition): ReadonlyArray<ProcessSignalBinding> =>
  condition.type === 'comparison' ? [resolveProcessPlantSignalBinding(plant.graph, condition.signal)]
    : condition.type === 'not' ? conditionBindings(plant, condition.condition)
      : condition.conditions.flatMap(child => conditionBindings(plant, child))

/**
 * The flow a component's outflow becomes: the throughput of the nearest
 * equipment downstream that declares one (the header a pump discharges
 * into), within the reach a mimic follows.
 */
export const throughputDownstream = (plant: CompiledProcessPlant, component: number, reach: number): ReadonlyArray<VariablePath> => {
  const graph = plant.graph
  const outgoing = (graph.outgoingLinksByComponent[component] ?? []).map(index => graph.links[index]!).filter(link => link.kind === 'fluidFlow')
  const carriers = new Set(outgoing.map(linkCarrier))
  let frontier = outgoing
  const seen = new Set(frontier.map(link => link.index))
  for (let step = 0; step < reach && frontier.length > 0; step += 1) {
    const found = [...new Set(frontier.flatMap(link => graph.components[link.toComponentIndex]!.semantics.aspects
      .flatMap(aspect => aspect.aspect === 'throughput' && aspect.state !== undefined ? [aspect.state.path] : [])))]
    if (found.length > 0) return found
    frontier = frontier.flatMap(link => nextLinks(graph, link, carriers)).filter(link => !seen.has(link.index))
    for (const link of frontier) seen.add(link.index)
  }
  return []
}

/** Whether what a component sends out reaches another within `reach` links downstream, along the services it delivers. */
export const feeds = (plant: CompiledProcessPlant, source: number, target: number, reach: number): boolean => {
  const graph = plant.graph
  const carriers = new Set((graph.outgoingLinksByComponent[source] ?? []).map(index => graph.links[index]!).filter(link => link.kind === 'fluidFlow').map(linkCarrier))
  return [...downstreamLinks(graph, [source], carriers, reach)].some(index => graph.links[index]!.toComponentIndex === target)
}

/** Whether a command starts a pump (or other running equipment) or stops it; null for any other command. */
const startsOrStops = (plant: CompiledProcessPlant, write: AutomaticAction['writes'][number]): 'starts' | 'stops' | null => {
  const running = plant.graph.components[write.component]!.semantics.aspects.find(aspect => aspect.aspect === 'running')
  if (running?.command !== write.binding.path) return null
  return write.value === true || (typeof write.value === 'number' && write.value > 0) ? 'starts' : 'stops'
}

/**
 * What an action delivers or isolates: the throughput downstream of the
 * running equipment it starts (the auxiliary feedwater it pumps) or stops
 * (the main feedwater it isolates).
 */
export const actionFlows = (plant: CompiledProcessPlant, action: AutomaticAction, reach: number): ReadonlyArray<{ readonly path: VariablePath; readonly effect: 'starts' | 'stops' }> => {
  const flows = new Map<VariablePath, 'starts' | 'stops'>()
  for (const write of action.writes) {
    const effect = startsOrStops(plant, write)
    if (effect === null) continue
    for (const path of throughputDownstream(plant, write.component, reach)) if (!flows.has(path)) flows.set(path, effect)
  }
  return [...flows].map(([path, effect]) => ({ path, effect }))
}

/**
 * The equipment an action runs or moves: the components whose declared run
 * or position command it writes (pumps it starts, valves it opens or shuts),
 * not other commands it writes (rod insertion).
 */
export const actionEquipment = (plant: CompiledProcessPlant, action: AutomaticAction): ReadonlyArray<number> => [...new Set(action.writes
  .filter(write => plant.graph.components[write.component]!.semantics.aspects
    .some(aspect => (aspect.aspect === 'running' || aspect.aspect === 'position') && aspect.command === write.binding.path))
  .map(write => write.component))]

/** The flows the equipment an action runs or moves sends straight into a component: the lines from it into the component (auxiliary feed into one steam generator). */
export const actionFlowsInto = (plant: CompiledProcessPlant, action: AutomaticAction, component: number): ReadonlyArray<VariablePath> => {
  const graph = plant.graph
  const commanded = new Set(actionEquipment(plant, action))
  return [...new Set((graph.incomingLinksByComponent[component] ?? [])
    .map(index => graph.links[index]!)
    .filter(link => link.kind === 'fluidFlow' && commanded.has(link.fromComponentIndex))
    .map(link => linkFlowBinding(graph, link.index).flowPath))]
}
