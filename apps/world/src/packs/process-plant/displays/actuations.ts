import type { CompiledProcessLink, ProcessSignalBinding, VariablePath } from '../graph/index.ts'
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

/**
 * The automatic actions that command any of these components: the trips that
 * moved what a display shows (every turbine trip, manual, on loss of load or
 * on a reactor trip, shuts the turbine's stop valve and rejects its load).
 */
export const commandingActions = (plant: CompiledProcessPlant, components: ReadonlySet<number>): ReadonlyArray<AutomaticAction> =>
  [...automaticActions(plant).values()].filter(action => action.writes.some(write => components.has(write.component)))

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

/**
 * Whether a flow through equipment reaches, within `reach` links downstream,
 * the side of a transfer that takes the heat (the auxiliary feed through its
 * header into a steam generator's secondary): what keeps a heat sink, as
 * opposed to flow into the circuit that gives the heat (safety injection into
 * the cold legs).
 */
export const feedsTransferIntake = (plant: CompiledProcessPlant, flow: VariablePath, reach: number): boolean => {
  const graph = plant.graph
  const owner = graph.signalBindingByPath.get(flow)?.owner
  if (owner?.type !== 'component') return false
  const carriers = new Set((graph.outgoingLinksByComponent[owner.componentIndex] ?? []).map(index => graph.links[index]!).filter(link => link.kind === 'fluidFlow').map(linkCarrier))
  return [...downstreamLinks(graph, [owner.componentIndex], carriers, reach)].some(index => {
    const link = graph.links[index]!
    const target = graph.components[link.toComponentIndex]!
    const circuit = target.ports[String(link.toPortName)]?.circuit
    return circuit !== undefined && target.semantics.energy.some(role => role.role === 'transfer' && role.to === circuit)
  })
}

/**
 * What a header sends to each of its destinations: along each branch that
 * leaves it, through the equipment in series on it (a valve), the published
 * flow nearest the equipment the branch ends in (the auxiliary feed to each
 * steam generator), within `reach` links. None where fewer than two branches
 * publish a flow: one branch's flow is the header's own.
 */
export const branchFlows = (plant: CompiledProcessPlant, header: number, reach: number): ReadonlyArray<{ readonly path: VariablePath; readonly destination: number }> => {
  const graph = plant.graph
  const flowOf = (link: CompiledProcessLink): VariablePath | undefined => link.variables.find(variable => String(variable.path).endsWith('.flowKgPerS'))?.path
  const branches = (graph.outgoingLinksByComponent[header] ?? []).map(index => graph.links[index]!).filter(link => link.kind === 'fluidFlow').flatMap(first => {
    const carriers = new Set([linkCarrier(first)])
    const branch = [first]
    for (let step = 1; step < reach; step += 1) {
      const next = nextLinks(graph, branch.at(-1)!, carriers)
      if (next.length !== 1) break
      branch.push(next[0]!)
    }
    const published = branch.flatMap(link => {
      const path = flowOf(link)
      return path !== undefined && graph.signalBindingByPath.get(path)?.published === true ? [path] : []
    })
    return published.length === 0 ? [] : [{ path: published.at(-1)!, destination: branch.at(-1)!.toComponentIndex }]
  })
  return branches.length < 2 ? [] : branches
}

/** Whether what a component sends out reaches another within `reach` links downstream, along the services it delivers. */
export const feeds = (plant: CompiledProcessPlant, source: number, target: number, reach: number): boolean => {
  const graph = plant.graph
  const carriers = new Set((graph.outgoingLinksByComponent[source] ?? []).map(index => graph.links[index]!).filter(link => link.kind === 'fluidFlow').map(linkCarrier))
  return [...downstreamLinks(graph, [source], carriers, reach)].some(index => graph.links[index]!.toComponentIndex === target)
}

/**
 * Whether a write starts or stops equipment, opens or shuts it: a run
 * command starts a pump while true; a position command opens a valve above
 * zero, or a breaker while it reads closed; an isolation input shuts it.
 * Null for any other write (rod insertion), or an isolation released.
 */
const writeEffect = (plant: CompiledProcessPlant, write: AutomaticAction['writes'][number]): 'starts' | 'stops' | null => {
  const component = plant.graph.components[write.component]!
  const aspect = component.semantics.aspects.find(candidate => candidate.command === write.binding.path || candidate.isolation === write.binding.path)
  if (aspect === undefined || (aspect.aspect !== 'running' && aspect.aspect !== 'position')) return null
  const on = write.value === true || (typeof write.value === 'number' && write.value > 0)
  if (aspect.isolation === write.binding.path) return on ? 'stops' : null
  return on ? 'starts' : 'stops'
}

/** Whether a command starts a pump (or other running equipment) or stops it; null for any other command. */
const startsOrStops = (plant: CompiledProcessPlant, write: AutomaticAction['writes'][number]): 'starts' | 'stops' | null =>
  plant.graph.components[write.component]!.semantics.aspects.some(aspect => aspect.aspect === 'running' && aspect.command === write.binding.path) ? writeEffect(plant, write) : null

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
 * or whose isolation input it sets (feed valves it isolates), not other
 * commands it writes (rod insertion).
 */
export const actionEquipment = (plant: CompiledProcessPlant, action: AutomaticAction): ReadonlyArray<number> => [...new Set(action.writes
  .filter(write => writeEffect(plant, write) !== null)
  .map(write => write.component))]

/**
 * The states that say an action moved what it commands: for each run or
 * position command or isolation input it writes, the state of that aspect of
 * the component, or of a device it bundles (a turbine stop valve's position
 * for the turbine trip's stop command); none where the model solves none.
 */
export const actionStates = (plant: CompiledProcessPlant, action: AutomaticAction): ReadonlyArray<{ readonly component: number; readonly path: VariablePath }> => {
  const states = new Map<VariablePath, number>()
  for (const write of action.writes) {
    const component = plant.graph.components[write.component]!
    for (const aspect of [...component.semantics.aspects, ...component.semantics.embedded.flatMap(device => device.aspects)]) {
      if ((aspect.command === write.binding.path || aspect.isolation === write.binding.path) && aspect.state !== undefined && !states.has(aspect.state.path)) states.set(aspect.state.path, write.component)
    }
  }
  return [...states].map(([path, component]) => ({ component, path }))
}

/**
 * The flows the equipment an action runs or moves sends straight into a
 * component, the lines from it into the component, and whether the action
 * delivers or isolates them: the auxiliary feed it starts into one steam
 * generator, the steam a turbine trip shuts off from its turbine.
 */
export const actionFlowsInto = (plant: CompiledProcessPlant, action: AutomaticAction, component: number): ReadonlyArray<{ readonly path: VariablePath; readonly effect: 'starts' | 'stops' }> => {
  const graph = plant.graph
  const effectOn = new Map<number, 'starts' | 'stops'>()
  for (const write of action.writes) {
    const effect = writeEffect(plant, write)
    if (effect !== null && !effectOn.has(write.component)) effectOn.set(write.component, effect)
  }
  const flows = new Map<VariablePath, 'starts' | 'stops'>()
  for (const link of (graph.incomingLinksByComponent[component] ?? []).map(index => graph.links[index]!)) {
    const effect = effectOn.get(link.fromComponentIndex)
    if (link.kind !== 'fluidFlow' || effect === undefined) continue
    const path = linkFlowBinding(graph, link.index).flowPath
    if (!flows.has(path)) flows.set(path, effect)
  }
  return [...flows].map(([path, effect]) => ({ path, effect }))
}
