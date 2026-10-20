import type { CompiledProcessLink, ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import { energyEnds, linkCarrier, nextLinks, previousLinks } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule, ProcessPlantIcSafetyFunctionCondition, ProcessPlantIcStatusTreeNode } from '../runtime/index.ts'
import { processPlantIcLifecycleIdFor } from '../runtime/ic/control-protection-lifecycle.ts'
import { findProcessPlantSignalBinding, resolveProcessPlantSignalBinding, type ProcessPlantSignalReference } from '../signals.ts'
import { actionStates, automaticActions, conditionBindings, type AutomaticAction } from './actuations.ts'
import { z } from 'zod'
import type {
  CompiledFaceplate,
  FaceplateColumnSpec,
  FaceplateCondition,
  FaceplateCriterion,
  FaceplateHead,
  FaceplateHeld,
  FaceplateLoopColumn,
  FaceplateRowSpec,
  FaceplateRule,
  FaceplateSource,
  FaceplateWrite,
} from './faceplate-live.ts'
import { displayValue, unitLabel } from '../quantity-text.ts'
import { actionOf, firstOutGroupOf } from '../ic/thresholds.ts'
import { presentationFor } from './mimic/presentation.ts'
import { MIMIC_REACH_LINKS } from './mimic/scope.ts'
import { equipmentKeyValues, isDemand, readsAsMeasured, type PlantNow } from './overview-key-values.ts'

// A faceplate: everything about one end of the Plant's energy path (what
// heats its coolant, what takes the work out of its steam) on one panel,
// in columns by function, one line per row. Only the energy ends the model
// declares get one. Every row comes from a bounded source, read from
// declared semantics and I&C, never from names:
// (1) protection: the first-out groups whose rules all command the end; the
//     states of what every rule of a group commands, on one row; the
//     readings the end declares say it has stopped; its rules, active ones
//     by name (not the first out of the group the trip banner leads with,
//     which states it) and the rest counted; the rules elsewhere that act on
//     what the group moved, while they can. Where the banner states the
//     cause, the outcome comes first; elsewhere the cause does;
// (2) critical safety functions that judge a reading of the end's
//     equipment: every leaf of their trees under their chip, and their
//     checks while they apply; a function sharing a leaf with an earlier
//     column joins it;
// (3) port circuits, only for an end no safety function judges: each port's
//     line up to the first header or junction, and what joins it there,
//     titled by the port;
// (4) programs: a reading, its program and its deviation on one row;
// (5) the end's remaining instruments (of a system whose stop the end's
//     shutdown readings verify, only those) and the detail's lead values the
//     sources above left out, beside the readings of their own instrument
//     system, else in the port column of their discipline;
// (6) per loop, one table: what the end's own loop lines read, what the
//     instrument channels drawn nowhere measure for the loop and what its
//     protection judges of them, at most five columns, inside the column of
//     the function that reads those lines.
// One row is one line; a row holds several values only where the model
// pairs them (a group's states, a program, a reading and the flag it
// measures only under). No reading appears twice. It is compiled for the
// Plant's mode and the readings that measure nothing as it is opened (as a
// detail's lead values are) into plain data (faceplate-live.ts), which reads
// live without the Plant's model.

/** At most this many value columns in a loop table, in priority order. */
export const FACEPLATE_LOOP_COLUMNS = 5

/** Something a source names that the faceplate cannot show, and why: a state or leaf the Plant does not publish. */
export interface FaceplateWithheld {
  readonly reference: string
  readonly source: FaceplateSource
  readonly reason: 'not published' | 'not in the Plant'
}

/** The components that get a faceplate: the Plant's energy ends, sources first, then sinks (energyEnds). */
export const faceplateEnds = (plant: CompiledProcessPlant): ReadonlyArray<number> => [...new Set(energyEnds(plant.graph).map(end => end.component.index))]

// A signal belongs to the node that owns its path and to the equipment it is
// bound to, as a detail's lead values count it (overview-key-values.ts).
const equipmentOf = (binding: ProcessSignalBinding): ReadonlyArray<string> => [
  String(binding.path).split('.')[0]!,
  ...(binding.equipmentId === undefined ? [] : [String(binding.equipmentId)]),
]

/** The instrument system a reading belongs to: its bound equipment, else the node that owns it. */
const systemOf = (binding: ProcessSignalBinding): string => binding.equipmentId === undefined ? String(binding.path).split('.')[0]! : String(binding.equipmentId)

/** What an operator display may show: a value read as measured (readsAsMeasured), never one only the simulator computes. */
const readable = (binding: ProcessSignalBinding | undefined): boolean =>
  binding !== undefined && readsAsMeasured(binding) && binding.simulatorOnly !== true

/** The connections a discipline's readings travel by: an electrical reading belongs with a port that carries power, a hydraulic or thermal one with a port fluid flows through. */
const carriedBy: Readonly<Record<string, string>> = { electrical: 'electricalPower', hydraulic: 'fluidFlow', thermal: 'fluidFlow' }

/** A port named as its kind names it: "steamInlet" reads "Steam inlet". */
const portTitle = (port: string): string => {
  const words = port.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

const shortName = (plant: CompiledProcessPlant, component: number): string =>
  plant.graph.components[component]!.metadata?.presentation?.shortLabel ?? plant.graph.components[component]!.label

const tripEffects = (rule: ProcessPlantIcRule) => rule.effects.flatMap(effect => effect.type === 'trip.enter' ? [effect] : [])

/** The rules annunciating a trip in a first-out group, in rule order. */
const groupMembers = (plant: CompiledProcessPlant, group: string): ReadonlyArray<ProcessPlantIcRule> => plant.automation.rules
  .filter(rule => rule.enabled && tripEffects(rule).some(effect => effect.annunciator?.firstOutGroup === group))

/**
 * The first-out groups that command a component: every rule annunciating in
 * the group writes one of its commands. A group whose rules all belong to
 * another such group is that group's cause, already listed there (safety
 * injection trips the reactor, and is a reactor trip's cause).
 */
const commandingGroups = (plant: CompiledProcessPlant, component: number): ReadonlyArray<string> => {
  const actions = automaticActions(plant)
  const commands = (rule: ProcessPlantIcRule): boolean => actions.get(rule.id)?.writes.some(write => write.component === component) === true
  const candidates = plant.automation.firstOutGroups.flatMap(group => {
    const members = groupMembers(plant, group.id)
    return members.length > 0 && members.every(commands) ? [{ id: group.id, members: new Set(members.map(rule => rule.id)) }] : []
  })
  return candidates
    .filter(candidate => !candidates.some(other => other !== candidate && other.members.size > candidate.members.size && [...candidate.members].every(id => other.members.has(id))))
    .map(candidate => candidate.id)
}

/** The writes every rule of a group makes: what the group does, as opposed to what some of its rules do besides. */
const commonWrites = (plant: CompiledProcessPlant, members: ReadonlyArray<ProcessPlantIcRule>): AutomaticAction | null => {
  const actions = members.map(rule => automaticActions(plant).get(rule.id)!)
  const [first, ...rest] = actions
  if (first === undefined) return null
  return { rule: first.rule, writes: first.writes.filter(write => rest.every(action => action.writes.some(other => other.binding.path === write.binding.path))) }
}

/** The states that show what a first-out group did: those of the commands every rule of it writes (a reactor trip's breakers, a turbine trip's stop valve). */
export const groupStates = (plant: CompiledProcessPlant, group: string): ReadonlyArray<VariablePath> => {
  const common = commonWrites(plant, groupMembers(plant, group))
  return common === null ? [] : actionStates(plant, common).map(state => state.path)
}

/**
 * The states that say an energy end's protection stopped it: those of the
 * commands every rule of the first group commanding it writes (the reactor
 * trip breakers, the turbine stop valve); none for an end no group commands.
 */
export const stopStates = (plant: CompiledProcessPlant, end: number): ReadonlyArray<VariablePath> => {
  const groups = commandingGroups(plant, end)
  return groups.length === 0 ? [] : groupStates(plant, groups[0]!)
}

const writesOf = (action: AutomaticAction | null | undefined): ReadonlyArray<FaceplateWrite> =>
  (action?.writes ?? []).map(write => ({ path: String(write.binding.path), value: write.value }))

/** An I&C condition with its signals resolved to paths. */
const resolved = (plant: CompiledProcessPlant, condition: ProcessPlantIcCondition): FaceplateCondition => {
  if (condition.type === 'comparison') return { type: 'comparison', path: String(resolveProcessPlantSignalBinding(plant.graph, condition.signal).path), operator: condition.operator, value: condition.value }
  if (condition.type === 'not') return { type: 'not', condition: resolved(plant, condition.condition) }
  if (condition.type === 'vote') return { type: 'vote', required: condition.required, conditions: condition.conditions.map(child => resolved(plant, child)) }
  return { type: condition.type, conditions: condition.conditions.map(child => resolved(plant, child)) }
}

/** A signal a safety function names, as a path; one the Plant lacks keeps its name, which reads as nothing (unknown). */
const referencePath = (plant: CompiledProcessPlant, reference: ProcessPlantSignalReference): string =>
  String(findProcessPlantSignalBinding(plant.graph, reference)?.path ?? reference.path ?? reference.tagId)

/** A safety function's condition with its signals resolved to paths. */
const resolvedCriterion = (plant: CompiledProcessPlant, condition: ProcessPlantIcSafetyFunctionCondition): FaceplateCondition => {
  if (condition.type === 'comparison') return { type: 'comparison', path: referencePath(plant, condition.signal), operator: condition.operator, value: condition.value }
  if (condition.type === 'total') return { type: 'total', paths: condition.signals.map(signal => referencePath(plant, signal)), operator: condition.operator, value: condition.value }
  if (condition.type === 'difference') return { type: 'difference', path: referencePath(plant, condition.signal), minus: referencePath(plant, condition.minus), operator: condition.operator, value: condition.value }
  return { type: condition.type, conditions: condition.conditions.map(child => resolvedCriterion(plant, child)) }
}

/** Every path a resolved condition reads. */
const conditionPaths = (condition: FaceplateCondition): ReadonlyArray<string> =>
  condition.type === 'comparison' ? [condition.path] : condition.type === 'total' ? condition.paths : condition.type === 'difference' ? [condition.path, condition.minus]
    : condition.type === 'not' ? conditionPaths(condition.condition) : condition.conditions.flatMap(conditionPaths)

/**
 * A rule as a faceplate reads it (ic/thresholds.ts reads its limits alike):
 * of the conditions it requires together, one that holds at the Plant's
 * declared operating point only arms it (power above P-9 for a reactor trip
 * on turbine trip); the others set it off. A condition not combined so sets
 * it off alone. Titled by its trip in `group` (as the alarm list writes it),
 * else by its own first.
 */
const faceplateRule = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule, nominal: (path: VariablePath) => unknown, group: string | undefined): FaceplateRule => {
  const title = tripEffects(rule).find(effect => group === undefined || effect.annunciator?.firstOutGroup === group)?.title ?? rule.label ?? rule.id
  const modes = rule.modes === undefined ? {} : { modes: [...rule.modes] }
  const condition = resolved(plant, rule.condition)
  if (condition.type !== 'all') return { id: rule.id, title, ...modes, triggers: [condition], gates: [] }
  const read = (path: string) => nominal(path as VariablePath)
  const arming = condition.conditions.filter(child => holdsAt(child, read) === true)
  const triggers = condition.conditions.filter(child => !arming.includes(child))
  return triggers.length === 0 ? { id: rule.id, title, ...modes, triggers: condition.conditions, gates: [] } : { id: rule.id, title, ...modes, triggers, gates: arming }
}

/** Whether a resolved I&C condition holds on the values read. */
const holdsAt = (condition: FaceplateCondition, read: (path: string) => unknown): boolean | null => {
  if (condition.type === 'comparison') {
    const value = read(condition.path)
    if (condition.operator === '==') return value === condition.value
    if (condition.operator === '!=') return value !== condition.value
    if (typeof value !== 'number' || typeof condition.value !== 'number') return null
    return condition.operator === '<' ? value < condition.value : condition.operator === '<=' ? value <= condition.value : condition.operator === '>' ? value > condition.value : value >= condition.value
  }
  if (condition.type === 'not') {
    const inner = holdsAt(condition.condition, read)
    return inner === null ? null : !inner
  }
  if (condition.type === 'total' || condition.type === 'difference') return null
  const answers = condition.conditions.map(child => holdsAt(child, read))
  if (condition.type === 'vote') return answers.filter(answer => answer === true).length >= condition.required
  if (condition.type === 'any') return answers.includes(true) ? true : answers.includes(null) ? null : false
  return answers.includes(false) ? false : answers.includes(null) ? null : true
}

/** The signals a safety function's condition compares. */
const safetyFunctionReferences = (condition: ProcessPlantIcSafetyFunctionCondition): ReadonlyArray<ProcessPlantSignalReference> =>
  condition.type === 'all' || condition.type === 'any' ? condition.conditions.flatMap(safetyFunctionReferences)
    : condition.type === 'comparison' ? [condition.signal] : condition.type === 'total' ? condition.signals : [condition.signal, condition.minus]

/** A status tree's leaves, in the order it asks (yes before no). */
const treeReferences = (node: ProcessPlantIcStatusTreeNode): ReadonlyArray<ProcessPlantSignalReference> =>
  'question' in node ? [...safetyFunctionReferences(node.condition), ...treeReferences(node.yes), ...treeReferences(node.no)] : []

/** The first comparison a status tree asks of one signal. */
const treeCriterion = (plant: CompiledProcessPlant, node: ProcessPlantIcStatusTreeNode, path: VariablePath): Pick<FaceplateCriterion, 'operator' | 'value'> | undefined => {
  if (!('question' in node)) return undefined
  const own = (condition: ProcessPlantIcSafetyFunctionCondition): ReadonlyArray<Pick<FaceplateCriterion, 'operator' | 'value'>> =>
    condition.type === 'all' || condition.type === 'any' ? condition.conditions.flatMap(own)
      : condition.type === 'comparison' && findProcessPlantSignalBinding(plant.graph, condition.signal)?.path === path ? [{ operator: condition.operator, value: condition.value }] : []
  return own(node.condition)[0] ?? treeCriterion(plant, node.yes, path) ?? treeCriterion(plant, node.no, path)
}

type Attached = { readonly link: CompiledProcessLink; readonly far: number; readonly farPort: string }

/** The links on one port of a component, with the component and port at their other end. */
const attachedAt = (plant: CompiledProcessPlant, component: number, portName: string): ReadonlyArray<Attached> => {
  const graph = plant.graph
  return [
    ...(graph.outgoingLinksByComponent[component] ?? []).map(index => graph.links[index]!).filter(link => String(link.fromPortName) === portName)
      .map(link => ({ link, far: link.toComponentIndex, farPort: String(link.toPortName) })),
    ...(graph.incomingLinksByComponent[component] ?? []).map(index => graph.links[index]!).filter(link => String(link.toPortName) === portName)
      .map(link => ({ link, far: link.fromComponentIndex, farPort: String(link.fromPortName) })),
  ]
}

/**
 * The components a port's line reaches away from the end, up to the first
 * header (drawn as a bar), a junction where the line branches, or where its
 * service ends, within a mimic's reach; with each, the other equipment that
 * joins it where the line lands (the turbine bypass into the condenser's
 * steam inlet, the grid onto the transformer the generator feeds).
 */
const circuitReach = (plant: CompiledProcessPlant, end: number, port: string): ReadonlyArray<number> => {
  const graph = plant.graph
  const reached: number[] = []
  const add = (component: number) => { if (component !== end && !reached.includes(component)) reached.push(component) }
  for (const start of attachedAt(plant, end, port)) {
    let step = start
    for (let depth = 0; depth < MIMIC_REACH_LINKS; depth += 1) {
      const component = graph.components[step.far]!
      add(component.index)
      for (const joining of attachedAt(plant, component.index, step.farPort)) if (joining.far !== end && joining.link.index !== step.link.index) add(joining.far)
      if (presentationFor(component).element === 'bar') break
      const onward = Object.keys(component.ports).filter(name => name !== step.farPort)
        .flatMap(name => attachedAt(plant, component.index, name)).filter(next => linkCarrier(next.link) === linkCarrier(step.link) && next.far !== end)
      if (onward.length !== 1) break
      step = onward[0]!
    }
  }
  return reached
}

/** A valve's controller as its kind declares it (junction-component-definitions.ts): the value it measures and the set point it holds it to. */
const declaredController = z.object({ measuredPath: z.string().min(1), setpoint: z.number().finite() }).passthrough()

/**
 * A valve a controller positions (the turbine bypass, holding the main steam
 * header's pressure): the flow through it, its position, and what its
 * controller holds, its only mode modelled. Null for equipment with no such
 * controller or no position.
 */
const controlledValve = (plant: CompiledProcessPlant, index: number): { readonly flow: VariablePath; readonly position: VariablePath; readonly held: FaceplateHeld } | null => {
  const graph = plant.graph
  const component = graph.components[index]!
  const parameters = component.parameters as Readonly<Record<string, unknown>> | undefined
  const position = component.semantics.aspects.find(aspect => aspect.aspect === 'position' && aspect.state !== undefined)?.state?.path
  if (parameters?.controller === undefined || position === undefined) return null
  const controller = declaredController.parse(parameters.controller)
  const measured = graph.signalBindingByPath.get(controller.measuredPath as VariablePath)
  if (measured === undefined) throw new Error(`component ${component.id} controller measures ${controller.measuredPath}, which the Plant does not have`)
  // The flow it passes: the published flow of the line leaving it.
  const flow = (graph.outgoingLinksByComponent[index] ?? []).map(link => graph.links[link]!).filter(link => link.kind === 'fluidFlow')
    .flatMap(link => link.variables.map(variable => variable.path).filter(path => String(path).endsWith('.flowKgPerS') && graph.signalBindingByPath.get(path)?.published === true))[0]
  if (flow === undefined) return null
  return { flow, position, held: { name: shortName(plant, index), quantity: measured.quantity, setpoint: displayValue(controller.setpoint, measured.unit), unit: unitLabel(measured.unit) } }
}

/**
 * Where the circuit feeding an end's inlet sends its flow besides the end
 * (HMI review of run 26: "where does the steam go?" read only the safety
 * valve): every line of the inlet's service that leaves the circuit, into
 * equipment the service goes on from no further (the condenser the steam
 * dumps feed, the atmosphere a relief valve vents to), up- or downstream of
 * the inlet; the lines through a valve a controller positions first, then in
 * the order the circuit reaches them from the inlet. Each is named by the
 * first equipment of its branch, after the last point where the circuit
 * divides (the turbine bypass at the header, each steam generator's relief
 * valve at its generator, the safety valve), never by where it ends, and read
 * by the published flow on its branch nearest where it leaves; null where the
 * branch publishes none.
 */
const circuitOutlets = (plant: CompiledProcessPlant, end: number, port: string): { readonly service: string; readonly outlets: ReadonlyArray<{ readonly first: number; readonly path: VariablePath | null }> } | null => {
  const graph = plant.graph
  const inlets = attachedAt(plant, end, port).filter(entry => entry.link.kind === 'fluidFlow' && entry.link.toComponentIndex === end)
  if (inlets.length === 0) return null
  const service = linkCarrier(inlets[0]!.link)
  const ofService = (indexes: ReadonlyArray<number> | undefined): ReadonlyArray<CompiledProcessLink> =>
    (indexes ?? []).map(index => graph.links[index]!).filter(link => link.kind === 'fluidFlow' && linkCarrier(link) === service)
  const into = (component: number) => ofService(graph.incomingLinksByComponent[component])
  const outOf = (component: number) => ofService(graph.outgoingLinksByComponent[component])
  // The circuit breadth first from the inlet, never through the end or past where the service ends.
  const reached = new Set([end, ...inlets.map(entry => entry.link.fromComponentIndex)])
  const walked = new Set(inlets.map(entry => entry.link.index))
  const leaving: CompiledProcessLink[] = []
  let frontier = inlets.map(entry => entry.link.fromComponentIndex)
  while (frontier.length > 0) {
    const next: number[] = []
    for (const component of frontier) {
      if (outOf(component).length === 0) continue
      for (const link of [...into(component), ...outOf(component)]) {
        if (walked.has(link.index)) continue
        walked.add(link.index)
        if (link.toComponentIndex !== end && outOf(link.toComponentIndex).length === 0) leaving.push(link)
        for (const far of [link.fromComponentIndex, link.toComponentIndex]) {
          if (reached.has(far)) continue
          reached.add(far)
          next.push(far)
        }
      }
    }
    frontier = next
  }
  const outlets = leaving.map(link => {
    // Up the line it leaves by, through equipment in series, to where the circuit divides.
    const branch = [link]
    for (let at = link.fromComponentIndex; at !== end && into(at).length === 1 && outOf(at).length === 1 && !branch.includes(into(at)[0]!);) {
      branch.unshift(into(at)[0]!)
      at = into(at)[0]!.fromComponentIndex
    }
    const flows = branch.flatMap(entry => entry.variables.map(variable => variable.path).filter(path => String(path).endsWith('.flowKgPerS') && readable(graph.signalBindingByPath.get(path))))
    return { first: branch[0]!.toComponentIndex, path: flows.at(-1) ?? null }
  })
  const controlled = (component: number): boolean => declaredController.safeParse((graph.components[component]!.parameters as Readonly<Record<string, unknown>> | undefined)?.controller).success
  return { service, outlets: [...outlets.filter(outlet => controlled(outlet.first)), ...outlets.filter(outlet => !controlled(outlet.first))] }
}

/**
 * Parallel equipment of the loops named once with its loops ("ARV A/B/C/D"),
 * where each one's name is the one name and its loop; other names as they are.
 */
const loopNames = (plant: CompiledProcessPlant, components: ReadonlyArray<number>): ReadonlyArray<string> => {
  const graph = plant.graph
  const names: string[] = []
  const grouped = new Map<string, string[]>()
  for (const index of components) {
    const component = graph.components[index]!
    const loop = component.metadata?.loopId
    const name = shortName(plant, index)
    if (loop === undefined || !name.endsWith(` ${loop}`)) {
      names.push(name)
      continue
    }
    const base = name.slice(0, -loop.length - 1)
    if (!grouped.has(base)) {
      grouped.set(base, [])
      names.push(base)
    }
    grouped.get(base)!.push(loop)
  }
  return names.map(name => grouped.has(name) ? `${name} ${grouped.get(name)!.join('/')}` : name)
}

type Column = { readonly heads: FaceplateHead[]; readonly rows: FaceplateRowSpec[]; readonly rules: FaceplateRowSpec[]; readonly causeFirst: boolean }

/** The last of `among` that comes before position `at` of `order`. */
const lastBefore = <T,>(among: ReadonlyArray<T>, at: number, order: ReadonlyArray<T>): T | undefined =>
  [...among].reverse().find(item => order.indexOf(item) < at)

const lastIndex = <T,>(items: ReadonlyArray<T>, test: (item: T) => boolean): number => {
  for (let at = items.length - 1; at >= 0; at -= 1) if (test(items[at]!)) return at
  return -1
}

/**
 * The faceplate of one energy end, compiled for the Plant as it is now (its
 * mode, as a detail's lead values are chosen), with what its sources name
 * but cannot show. `nominal` reads what each signal reads at the Plant's
 * declared operating point. Null for a component that is no energy end.
 */
export const compileFaceplate = (
  plant: CompiledProcessPlant,
  end: number,
  now: PlantNow,
  nominal: (path: VariablePath) => unknown,
): { readonly faceplate: CompiledFaceplate; readonly withheld: ReadonlyArray<FaceplateWithheld> } | null => {
  if (!faceplateEnds(plant).includes(end)) return null
  const graph = plant.graph
  const component = graph.components[end]!
  const bindingOf = (path: VariablePath) => graph.signalBindingByPath.get(path)
  const own = graph.signalBindings.filter(binding => binding.owner.type === 'component' && binding.owner.componentIndex === end)
  const ids = new Set(own.flatMap(equipmentOf))
  const onEnd = (binding: ProcessSignalBinding): boolean => equipmentOf(binding).some(key => ids.has(key))
  const qualified = graph.components.flatMap(candidate => candidate.semantics.meaningfulWhile)
  const flagOf = new Map(qualified.flatMap(entry => entry.variables.map(variable => [variable, entry.flag] as const)))
  const flagged = new Map(qualified.map(entry => [entry.flag, entry.variables] as const))
  const permissives = new Set(graph.components.flatMap(candidate => candidate.semantics.permissives))
  const programOf = new Map(graph.components.flatMap(candidate => candidate.semantics.programs).map(program => [program.reading, program] as const))
  const placed = new Set<VariablePath>()
  const withheld = new Map<string, FaceplateWithheld>()
  const withhold = (entry: FaceplateWithheld) => { if (!withheld.has(entry.reference)) withheld.set(entry.reference, entry) }
  const columns: Column[] = []
  const column = (heads: FaceplateHead[], causeFirst = true): Column => ({ heads, rows: [], rules: [], causeFirst })
  // Each reading a safety function's tree asks, with the criterion it asks it by: its reference once the end has stopped.
  const criteriaOf = (path: VariablePath): ReadonlyArray<FaceplateCriterion> => plant.automation.safetyFunctions.flatMap(safetyFunction => {
    const criterion = treeCriterion(plant, safetyFunction.tree, path)
    return criterion === undefined ? [] : [{ path: String(path), safetyFunction: safetyFunction.id, ...criterion }]
  }).slice(0, 1)

  // The row a signal takes, once per faceplate: a reading the Plant's control holds to a program with its program
  // and deviation; a reading that measures only while a flag holds with that flag and its other readings, so it
  // never stands alone when it measures nothing; a permissive never (it gates protection, it is no reading).
  const valuesRow = (path: VariablePath, source: FaceplateSource): FaceplateRowSpec | null => {
    const binding = bindingOf(path)
    if (binding !== undefined && !binding.published && !isDemand(binding)) withhold({ reference: binding.tagId ?? String(path), source, reason: 'not published' })
    if (!readable(binding) || placed.has(path) || permissives.has(path)) return null
    const flag = flagOf.get(path) ?? (flagged.has(path) ? path : undefined)
    const program = programOf.get(path)
    // A flag's row carries the instruments it qualifies (tagged readings), not a boundary input it qualifies too.
    const paths = flag !== undefined && readable(bindingOf(flag))
      ? [flag, ...flagged.get(flag)!.filter(variable => variable === path || bindingOf(variable)?.tagId !== undefined)]
      : [path, ...(program === undefined ? [] : [program.program, ...(program.deviation === undefined ? [] : [program.deviation])])]
    const shown = paths.filter(variable => readable(bindingOf(variable)) && !placed.has(variable))
    for (const variable of shown) placed.add(variable)
    return {
      kind: 'values',
      source,
      paths: shown.map(String),
      ...(flag !== undefined && shown[0] === flag ? { flag: String(flag) } : {}),
      criteria: shown.flatMap(criteriaOf),
    }
  }
  const push = (into: Column, row: FaceplateRowSpec | null) => { if (row !== null) into.rows.push(row) }
  const systemsIn = (into: Column): ReadonlyArray<string> => into.rows.flatMap(row => row.kind === 'values' ? row.paths.flatMap(path => {
    const binding = bindingOf(path as VariablePath)
    return binding === undefined ? [] : [systemOf(binding)]
  }) : [])

  // (1) Protection: per commanding group, the states of what it commands, then (first group) the end's shutdown
  // readings, states before readings; its rules and consequences go first or last as the banner decides.
  const groups = commandingGroups(plant, end)
  const actions = automaticActions(plant)
  const judgedBy = new Map<string, ReadonlySet<VariablePath>>()
  const declaredGroups = new Map(plant.automation.firstOutGroups.map(group => [group.id, group]))
  for (const group of groups) {
    const declared = declaredGroups.get(group)!
    const banner = declared.reactorTrip
    const members = groupMembers(plant, group)
    const into = column([{ kind: 'group', group, title: declared.shortLabel }], !banner)
    into.rules.push({
      kind: 'rules',
      group,
      banner,
      does: writesOf(commonWrites(plant, members)),
      rules: members.map(rule => ({
        ...faceplateRule(plant, rule, nominal, group),
        lifecycle: processPlantIcLifecycleIdFor('trip', rule.id, tripEffects(rule).find(effect => effect.annunciator?.firstOutGroup === group)!.id),
      })),
    })
    const moved = groupStates(plant, group)
    const memberIds = new Set(members.map(rule => rule.id))
    for (const action of actions.values()) {
      if (memberIds.has(action.rule.id) || !conditionBindings(plant, action.rule.condition).some(binding => moved.includes(binding.path))) continue
      into.rules.push({ kind: 'consequence', rule: faceplateRule(plant, action.rule, nominal, firstOutGroupOf(plant, action.rule)?.id), action: actionOf(plant, action.rule), writes: writesOf(action) })
    }
    const states = moved.filter(path => {
      const binding = bindingOf(path)
      if (binding !== undefined && !binding.published) withhold({ reference: binding.tagId ?? String(path), source: 'protection', reason: 'not published' })
      return readable(binding) && !placed.has(path)
    })
    for (const path of states) placed.add(path)
    if (states.length > 0) into.rows.push({ kind: 'values', source: 'protection', paths: states.map(String), criteria: [] })
    judgedBy.set(group, new Set(members.flatMap(rule => conditionBindings(plant, rule.condition).map(binding => binding.path))))
    columns.push(into)
  }
  // What says the end has stopped, states first, under the protection the trip banner leads with (what E-0
  // verifies the trip by); each with the readings of its system that read the same quantity, on one row after it
  // (the rod banks after the rods' average steps). An end whose protection no banner states reads them as its own.
  const protection = columns[0]
  const stopped = component.semantics.shutdownReadings
  // Where its system's equipment reads the same quantity one by one (the rod banks), they stand in its place as a
  // strip, a bar each: one quantity, one row (the banks' steps, not the model's average rod beside them).
  const strip = (path: VariablePath): FaceplateRowSpec | null => {
    const binding = bindingOf(path)
    const alike = binding === undefined ? [] : graph.signalBindings.filter(other => other.tagId !== undefined && other.path !== path && onEnd(other) && readable(other)
      && systemOf(other) === systemOf(binding) && other.quantity === binding.quantity && other.unit === binding.unit && !flagOf.has(other.path) && !placed.has(other.path) && !stopped.includes(other.path))
    if (alike.length === 0) return null
    for (const other of [binding!, ...alike]) placed.add(other.path)
    return { kind: 'values', source: 'protection', paths: alike.map(other => String(other.path)), criteria: [], strip: true }
  }
  if (protection !== undefined && !protection.causeFirst) {
    const isState = (path: VariablePath) => bindingOf(path)?.quantity === 'boolean'
    for (const path of [...stopped.filter(isState), ...stopped.filter(path => !isState(path))]) push(protection, strip(path) ?? valuesRow(path, 'protection'))
  }

  // (2) Critical safety functions judging a reading of the end's equipment: every leaf of the tree under the chip.
  const functionColumns = new Map<string, { readonly column: Column; readonly leaves: ReadonlySet<VariablePath> }>()
  for (const safetyFunction of plant.automation.safetyFunctions) {
    const references = [...treeReferences(safetyFunction.tree), ...safetyFunction.checks.flatMap(check => safetyFunctionReferences(check.condition))]
    const judgesEnd = references.some(reference => {
      const binding = findProcessPlantSignalBinding(graph, reference)
      return binding !== undefined && onEnd(binding)
    })
    if (!judgesEnd) continue
    for (const reference of references) {
      if (findProcessPlantSignalBinding(graph, reference) === undefined) withhold({ reference: reference.tagId ?? String(reference.path), source: 'safetyFunction', reason: 'not in the Plant' })
    }
    const leaves = [...new Set(treeReferences(safetyFunction.tree).flatMap(reference => {
      const binding = findProcessPlantSignalBinding(graph, reference)
      return binding === undefined ? [] : [binding.path]
    }))]
    const sharedGroup = groups.find(group => leaves.some(path => judgedBy.get(group)!.has(path)))
    const sharedFunction = [...functionColumns.values()].find(entry => leaves.some(path => entry.leaves.has(path)))
    const into = sharedGroup !== undefined ? columns[groups.indexOf(sharedGroup)]! : sharedFunction?.column ?? column([])
    if (sharedGroup === undefined && sharedFunction === undefined) columns.push(into)
    into.heads.push({ kind: 'safetyFunction', id: safetyFunction.id, title: safetyFunction.shortLabel })
    functionColumns.set(safetyFunction.id, { column: into, leaves: new Set(leaves) })
    for (const path of leaves) push(into, valuesRow(path, 'safetyFunction'))
    if (safetyFunction.checks.length > 0) {
      into.rows.push({
        kind: 'checks',
        safetyFunction: safetyFunction.id,
        title: safetyFunction.shortLabel,
        checks: safetyFunction.checks.map(check => ({ label: check.label, ...(check.when === undefined ? {} : { when: resolvedCriterion(plant, check.when) }), condition: resolvedCriterion(plant, check.condition) })),
      })
    }
  }

  // (3) Port circuits, for an end no safety function judges, each titled by its port.
  const circuits: Array<{ readonly column: Column; readonly carrier: string; readonly reached: ReadonlyArray<number> }> = []
  if (functionColumns.size === 0) {
    // Where the circuit feeding each inlet sends its flow besides the end, in one row at the foot of the inlet's
    // column, each outlet named by its branch's first equipment; its flows claimed before any other row (a steam
    // dump's flow is where the steam goes; the dump's own row reads its position and what it holds).
    const outletRows = new Map<string, FaceplateRowSpec>()
    for (const port of Object.keys(component.ports)) {
      const found = circuitOutlets(plant, end, port)
      if (found === null || found.outlets.length === 0) continue
      const measured = found.outlets.filter((outlet): outlet is { readonly first: number; readonly path: VariablePath } => outlet.path !== null && !placed.has(outlet.path))
      for (const outlet of measured) placed.add(outlet.path)
      const unmeasured = found.outlets.filter(outlet => outlet.path === null).map(outlet => outlet.first)
      outletRows.set(port, {
        kind: 'flows',
        from: portTitle(found.service),
        branches: measured.map(outlet => ({ path: String(outlet.path), destination: shortName(plant, outlet.first) })),
        ...(unmeasured.length === 0 ? {} : { unmeasured: loopNames(plant, unmeasured) }),
      })
    }
    for (const port of Object.keys(component.ports)) {
      const reached = circuitReach(plant, end, port)
      if (reached.length === 0) continue
      const into = column([{ kind: 'circuit', port, title: portTitle(port), equipment: reached.map(index => shortName(plant, index)) }])
      for (const index of reached) {
        const along = graph.components[index]!
        // A valve its controller positions: the flow through it first, where no outlet row reads it, then its position, and what it holds.
        const controlled = controlledValve(plant, index)
        if (controlled !== null && readable(bindingOf(controlled.position)) && !placed.has(controlled.position)) {
          const flow = readable(bindingOf(controlled.flow)) && !placed.has(controlled.flow) ? [controlled.flow] : []
          for (const path of [...flow, controlled.position]) placed.add(path)
          into.rows.push({ kind: 'values', source: 'circuit', paths: [...flow, controlled.position].map(String), criteria: [], held: controlled.held })
        }
        for (const aspect of along.semantics.aspects) {
          if (aspect.state !== undefined && (aspect.aspect === 'position' || aspect.aspect === 'running' || aspect.aspect === 'energized')) push(into, valuesRow(aspect.state.path, 'circuit'))
        }
        for (const path of along.semantics.keyValues) push(into, valuesRow(path, 'circuit'))
        for (const binding of graph.signalBindings) {
          if (binding.owner.type === 'component' && binding.owner.componentIndex === index && binding.tagId !== undefined) push(into, valuesRow(binding.path, 'circuit'))
        }
      }
      const outlets = outletRows.get(port)
      if (outlets !== undefined) into.rows.push(outlets)
      circuits.push({ column: into, carrier: attachedAt(plant, end, port)[0]!.link.kind, reached })
    }
  }

  // (4) Programs: what the end's control holds to a program, each on one row.
  const programColumn = column([{ kind: 'programs', title: 'Control' }])
  for (const program of component.semantics.programs) push(programColumn, valuesRow(program.reading, 'program'))

  // (5) The end's other instruments, then its lead values: beside the readings of their own instrument system
  // (after its shutdown readings where there are some), else in the port column of their discipline, else under
  // the end. Of a system whose stop the end's shutdown readings verify, those readings stand for it.
  const ownColumn = column([{ kind: 'equipment', title: component.label }])
  const verified = new Set(component.semantics.shutdownReadings.flatMap(path => {
    const binding = bindingOf(path)
    return binding === undefined ? [] : [systemOf(binding)]
  }))
  const besideItsSystem = (path: VariablePath, source: FaceplateSource) => {
    const binding = bindingOf(path)
    if (binding === undefined) return
    const row = valuesRow(path, source)
    if (row === null) return
    const system = systemOf(binding)
    // The end's own readings join the port circuit of their discipline (its electrical output with the generator
    // breaker), others the column holding their instrument system.
    const byDiscipline = onEnd(binding) ? circuits.find(entry => carriedBy[binding.discipline] === entry.carrier)?.column : undefined
    const home = byDiscipline
      ?? [...columns, ...circuits.map(entry => entry.column), programColumn].find(candidate => systemsIn(candidate).includes(system))
      ?? circuits.find(entry => carriedBy[binding.discipline] === entry.carrier)?.column
      ?? ownColumn
    const sameSystem = (candidate: FaceplateRowSpec) => candidate.kind === 'values' && candidate.paths.some(variable => {
      const other = bindingOf(variable as VariablePath)
      return other !== undefined && systemOf(other) === system
    })
    // After the last shutdown reading of its system (IR beside the intermediate-range startup rate), else after the last of its system.
    // In a port column the end's own readings lead, before what its line reaches.
    const stopping = lastIndex(home.rows, candidate => sameSystem(candidate) && candidate.kind === 'values' && candidate.source === 'protection')
    const after = stopping >= 0 ? stopping : lastIndex(home.rows, sameSystem)
    home.rows.splice(after >= 0 ? after + 1 : home === byDiscipline ? 0 : home.rows.length, 0, row)
  }
  if (protection === undefined || protection.causeFirst) for (const path of stopped) besideItsSystem(path, 'equipment')
  for (const binding of graph.signalBindings) {
    if (binding.tagId !== undefined && onEnd(binding) && !verified.has(systemOf(binding))) besideItsSystem(binding.path, 'equipment')
  }
  for (const path of equipmentKeyValues(plant, [end], now)) besideItsSystem(path, 'lead')

  // (6) One table by loop, inside the column of the function that reads the end's loop lines (else the protection's).
  const table = loopTable(plant, end, groups.flatMap(group => [...judgedBy.get(group)!]), placed)
  if (table !== null) {
    const lines = new Set(table.columns.filter(entry => entry.source === 'circuit').flatMap(entry => entry.cells.flat()))
    const reader = plant.automation.safetyFunctions.find(safetyFunction => functionColumns.has(safetyFunction.id)
      && [...treeReferences(safetyFunction.tree), ...safetyFunction.checks.flatMap(check => safetyFunctionReferences(check.condition))]
        .some(reference => lines.has(referencePath(plant, reference))))
    const host = reader === undefined ? protection : functionColumns.get(reader.id)!.column
    host?.rows.push({ kind: 'loops', ...table })
  }

  // Protection and safety functions first, then the end itself, its port circuits, and what its control holds.
  // In a column: its readings, then its checks, then its loop table; the rules before them or after as the banner decides.
  const ordered = (rows: ReadonlyArray<FaceplateRowSpec>) => [
    ...rows.filter(row => row.kind !== 'checks' && row.kind !== 'loops'),
    ...rows.filter(row => row.kind === 'checks'),
    ...rows.filter(row => row.kind === 'loops'),
  ]
  const finished = (entry: Column): FaceplateColumnSpec => ({ heads: entry.heads, rows: entry.causeFirst ? [...entry.rules, ...ordered(entry.rows)] : [...ordered(entry.rows), ...entry.rules] })
  const shown = [...columns, ownColumn, ...circuits.map(entry => entry.column), programColumn].filter(entry => entry.rows.length + entry.rules.length > 0).map(finished)
  const stoppedWhen = groups.length === 0 ? [] : writesOf(commonWrites(plant, groupMembers(plant, groups[0]!)))
  const read = shown.flatMap(entry => entry.rows).flatMap((row): ReadonlyArray<string> => {
    if (row.kind === 'values') return row.paths
    if (row.kind === 'flows') return row.branches.map(branch => branch.path)
    if (row.kind === 'loops') return row.columns.flatMap(entry => [...entry.cells.flat(), ...(entry.qualifiers ?? []).map(qualifier => qualifier.flag)])
    if (row.kind === 'checks') return row.checks.flatMap(check => [...(check.when === undefined ? [] : conditionPaths(check.when)), ...conditionPaths(check.condition)])
    const rules = row.kind === 'rules' ? row.rules : [row.rule]
    return [...(row.kind === 'rules' ? row.does : row.writes).map(write => write.path), ...rules.flatMap(rule => [...rule.triggers, ...rule.gates].flatMap(conditionPaths))]
  })
  // Only what the Plant has: a leaf it lacks reads as nothing, and is never asked of it.
  const paths = [...new Set([...read, ...stoppedWhen.map(write => write.path)])].filter(path => graph.signalBindingByPath.has(path as VariablePath))
  return { faceplate: { end: String(component.id), columns: shown, stoppedWhen, paths }, withheld: [...withheld.values()] }
}

/**
 * The end's loops in one table: what its own lines of each loop read (a
 * core's hot and cold legs, within a mimic's reach along the loop), what the
 * instrument channels drawn nowhere measure for the loop (a channel's
 * delta-T; not a quantity the lines already read, nor what it computes for
 * its protection) and, last, what the end's protection judges of them in one
 * column (the overtemperature and overpower margins), at most
 * FACEPLATE_LOOP_COLUMNS columns. Null where the end has no loop lines and
 * no such channels.
 */
const loopTable = (plant: CompiledProcessPlant, end: number, judged: ReadonlyArray<VariablePath>, placed: Set<VariablePath>): { readonly loops: ReadonlyArray<string>; readonly columns: ReadonlyArray<FaceplateLoopColumn> } | null => {
  const graph = plant.graph
  const tagged = (binding: ProcessSignalBinding | undefined): binding is ProcessSignalBinding => binding !== undefined && binding.tagId !== undefined && readable(binding) && !placed.has(binding.path)
  const component = graph.components[end]!
  // The end's own lines by loop: per port, the nearest tagged readings along the loop's line (through the loop's
  // equipment in series: a cold leg's RTD before its pump), a column per port direction and reading.
  const lines = new Map<string, Map<string, VariablePath>>()
  const readingsOf = (link: CompiledProcessLink) => link.variables.flatMap(variable => {
    const binding = graph.signalBindingByPath.get(variable.path)
    return tagged(binding) ? [binding] : []
  })
  for (const [name, port] of Object.entries(component.ports)) {
    for (const { link: first } of attachedAt(plant, end, name)) {
      const loop = first.metadata?.loopId
      if (loop === undefined) continue
      const leaving = first.fromComponentIndex === end
      const carriers = new Set([linkCarrier(first)])
      let frontier: ReadonlyArray<CompiledProcessLink> = [first]
      for (let depth = 0; depth < MIMIC_REACH_LINKS && frontier.length > 0; depth += 1) {
        const found = frontier.flatMap(readingsOf)
        if (found.length > 0) {
          for (const binding of found) {
            const key = `${port.direction}|${String(binding.path).slice(String(binding.path).indexOf('.') + 1)}`
            const cells = lines.get(key) ?? new Map<string, VariablePath>()
            if (!cells.has(loop)) cells.set(loop, binding.path)
            lines.set(key, cells)
          }
          break
        }
        // On along the line through the loop's own equipment only (not a charging or injection line into it).
        frontier = frontier.flatMap(link => {
          const through = graph.components[leaving ? link.toComponentIndex : link.fromComponentIndex]!
          return through.metadata?.loopId !== loop ? [] : leaving ? nextLinks(graph, link, carriers) : previousLinks(graph, link, carriers)
        })
      }
    }
  }
  const judgedSet = new Set(judged)
  const channels = graph.components.filter(candidate => candidate.metadata?.loopId !== undefined && presentationFor(candidate).element === 'not-drawn'
    && graph.signalBindings.some(binding => binding.owner.type === 'component' && binding.owner.componentIndex === candidate.index && judgedSet.has(binding.path)))
  const loops = [...new Set([...[...lines.values()].flatMap(cells => [...cells.keys()]), ...channels.map(channel => channel.metadata!.loopId!)])].sort()
  if (loops.length === 0) return null
  const lineQuantities = new Set([...lines.values()].flatMap(cells => [...cells.values()].map(path => graph.signalBindingByPath.get(path)!.quantity)))
  const channelOf = (loop: string) => channels.find(channel => channel.metadata!.loopId === loop)
  const channelReadings = channels.length === 0 ? [] : graph.signalBindings
    .filter(binding => binding.owner.type === 'component' && binding.owner.componentIndex === channels[0]!.index && tagged(binding))
    .map(binding => ({ local: String(binding.path).slice(String(channels[0]!.id).length + 1), binding }))
  const cellsOf = (local: string): ReadonlyArray<ReadonlyArray<string>> => loops.map(loop => {
    const channel = channelOf(loop)
    const path = channel === undefined ? undefined : `${channel.id}.${local}` as VariablePath
    return path !== undefined && tagged(graph.signalBindingByPath.get(path)) ? [String(path)] : []
  })
  // A channel's flag qualifies its readings and is no column; a reading measured only while it holds (delta-T
  // power with forced flow) shares the cell of the measurement declared before it, shown only while the flag holds.
  const qualifiedBy = new Map(channels[0]?.semantics.meaningfulWhile.flatMap(entry => entry.variables.map(variable => [String(variable).slice(String(channels[0]!.id).length + 1), String(entry.flag).slice(String(channels[0]!.id).length + 1)] as const)) ?? [])
  const flags = new Set(qualifiedBy.values())
  const measured = channelReadings.filter(entry => !judgedSet.has(entry.binding.path) && entry.binding.discipline !== 'control' && !lineQuantities.has(entry.binding.quantity) && !flags.has(entry.local))
  const own = measured.filter(entry => !qualifiedBy.has(entry.local))
  const sharing = (entry: (typeof measured)[number]) => measured.filter(other => qualifiedBy.has(other.local) && lastBefore(own, measured.indexOf(other), measured) === entry)
  const flagOfCell = (local: string) => loops.map(loop => {
    const channel = channelOf(loop)
    return channel === undefined ? undefined : `${channel.id}.${local}`
  })
  const protectionJudges = channelReadings.filter(entry => judgedSet.has(entry.binding.path))
  const judgingRules = plant.automation.rules.filter(rule => rule.enabled && conditionBindings(plant, rule.condition).some(binding => protectionJudges.some(entry => String(binding.path).endsWith(`.${entry.local}`))))
  const columns: ReadonlyArray<FaceplateLoopColumn> = [
    ...[...lines.values()].map(cells => ({ cells: loops.map(loop => cells.has(loop) ? [String(cells.get(loop)!)] : []), source: 'circuit' as const, judgedIn: [] })),
    ...own.map(entry => {
      const joined = sharing(entry)
      const cells = loops.map((_, at) => [...cellsOf(entry.local)[at]!, ...joined.flatMap(other => cellsOf(other.local)[at]!)])
      const qualifiers = joined.flatMap(other => cellsOf(other.local).flatMap((cell, at) => cell.map(path => ({ path, flag: flagOfCell(qualifiedBy.get(other.local)!)[at]! }))))
      return { cells, source: 'channel' as const, judgedIn: [], ...(joined.length === 0 ? {} : { qualifiers }) }
    }),
    ...(protectionJudges.length === 0 ? [] : [{
      cells: loops.map((_, at) => protectionJudges.flatMap(entry => cellsOf(entry.local)[at]!)),
      source: 'channel' as const,
      judgedIn: judgingRules.map(rule => rule.modes === undefined ? null : [...rule.modes]),
    }]),
  ].filter(entry => entry.cells.some(cell => cell.length > 0)).slice(0, FACEPLATE_LOOP_COLUMNS)
  for (const entry of columns) for (const path of entry.cells.flat()) placed.add(path as VariablePath)
  return columns.length === 0 ? null : { loops, columns }
}
