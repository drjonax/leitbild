import type { CompiledProcessLink, ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import { energyEnds, linkCarrier, nextLinks, previousLinks } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule, ProcessPlantIcSafetyFunctionCondition, ProcessPlantIcStatusTreeNode } from '../runtime/index.ts'
import type { SafetyFunctionEvaluation } from '../safety-functions.ts'
import { findProcessPlantSignalBinding, resolveProcessPlantSignalBinding, type ProcessPlantSignalReference } from '../signals.ts'
import { actionStates, actsIn, armed, automaticActions, branchFlows, conditionBindings, type AutomaticAction } from './actuations.ts'
import { actionOf, firstOutGroupOf } from './ic-thresholds.ts'
import { presentationFor } from './mimic/presentation.ts'
import { MIMIC_REACH_LINKS } from './mimic/scope.ts'
import { equipmentKeyValues, notMeaningfulNow, type PlantNow } from './overview-key-values.ts'

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
// measures only under). No reading appears twice. The layout depends on the
// Plant's mode and on which readings measure nothing (as a detail's lead
// values do); which rules are active, what they decide on and which checks
// apply are read live.

/** Where a row comes from (the numbered sources above). */
export type FaceplateSource = 'protection' | 'safetyFunction' | 'circuit' | 'program' | 'equipment' | 'channel' | 'lead'

/** What heads a column: a first-out group, a critical safety function's chip, a port circuit by its port, the end itself, or its programs. */
export type FaceplateHead =
  | { readonly kind: 'group'; readonly group: string }
  | { readonly kind: 'safetyFunction'; readonly id: string }
  /** `title` names the port as its kind does ("Steam inlet"); `components` are the equipment its line reaches, for the column's sub-line. */
  | { readonly kind: 'circuit'; readonly port: string; readonly title: string; readonly components: ReadonlyArray<number> }
  | { readonly kind: 'equipment'; readonly component: number }
  | { readonly kind: 'programs' }

/** A rule's condition split as it acts: what sets it off, and what only arms it (holding at the Plant's operating point). */
export interface FaceplateRuleTerms {
  readonly triggers: ReadonlyArray<ProcessPlantIcCondition>
  readonly gates: ReadonlyArray<ProcessPlantIcCondition>
}

/** Parallel loops, one row each: what the end's own lines read, what channels measure, what protection judges. */
export interface FaceplateLoopTable {
  readonly loops: ReadonlyArray<string>
  /** Each column's values per loop (a cell may hold two, as two margins one protection judges); `judgedBy` the rules that judge them. */
  readonly columns: ReadonlyArray<{ readonly cells: ReadonlyArray<ReadonlyArray<VariablePath>>; readonly source: FaceplateSource; readonly judgedBy: ReadonlyArray<string> }>
}

export type FaceplateRowSpec =
  /** A first-out group's rules; `banner` where the trip banner leads with the group's first out. */
  | { readonly kind: 'rules'; readonly group: string; readonly banner: boolean; readonly rules: ReadonlyArray<{ readonly id: string; readonly terms: FaceplateRuleTerms }> }
  /** A rule of another group that acts on a state the column's group moves; shown only while it can act. */
  | { readonly kind: 'consequence'; readonly rule: string; readonly terms: FaceplateRuleTerms }
  /** Values on one line; with `flag`, the first, the rest shown only while it reads true. */
  | { readonly kind: 'values'; readonly source: FaceplateSource; readonly paths: ReadonlyArray<VariablePath>; readonly flag?: VariablePath }
  /** A safety function's checks; each shown only while it applies. */
  | { readonly kind: 'checks'; readonly safetyFunction: string; readonly labels: ReadonlyArray<string> }
  /** What a header sends to each destination. */
  | { readonly kind: 'flows'; readonly header: number; readonly branches: ReadonlyArray<{ readonly path: VariablePath; readonly destination: number }> }
  | { readonly kind: 'loops'; readonly table: FaceplateLoopTable }

export interface FaceplateColumnSpec {
  readonly heads: ReadonlyArray<FaceplateHead>
  readonly rows: ReadonlyArray<FaceplateRowSpec>
}

/** Something a source names that the faceplate cannot show, and why: a state or leaf the Plant does not publish. */
export interface FaceplateWithheld {
  readonly reference: string
  readonly source: FaceplateSource
  readonly reason: 'not published' | 'not in the Plant'
}

export interface FaceplateLayout {
  readonly end: number
  readonly columns: ReadonlyArray<FaceplateColumnSpec>
  readonly withheld: ReadonlyArray<FaceplateWithheld>
}

/** At most this many value columns in a loop table, in priority order. */
export const FACEPLATE_LOOP_COLUMNS = 5

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

/** What an operator display may show: published, not a demand, not a value only the simulator computes. */
const readable = (binding: ProcessSignalBinding | undefined): boolean =>
  binding !== undefined && binding.published && !binding.writable && binding.simulatorOnly !== true

/** The connections a discipline's readings travel by: an electrical reading belongs with a port that carries power, a hydraulic or thermal one with a port fluid flows through. */
const carriedBy: Readonly<Record<string, string>> = { electrical: 'electricalPower', hydraulic: 'fluidFlow', thermal: 'fluidFlow' }

/** A port named as its kind names it: "steamInlet" reads "Steam inlet". */
const portTitle = (port: string): string => {
  const words = port.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

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

const compare = (left: unknown, operator: string, right: number | boolean): boolean | null => {
  if (operator === '==') return left === right
  if (operator === '!=') return left !== right
  if (typeof left !== 'number' || typeof right !== 'number') return null
  return operator === '<' ? left < right : operator === '<=' ? left <= right : operator === '>' ? left > right : left >= right
}

/** Whether a condition holds on the given values; null where a value it needs is not a number or state. */
const holds = (plant: CompiledProcessPlant, condition: ProcessPlantIcCondition, read: (path: VariablePath) => unknown): boolean | null => {
  if (condition.type === 'comparison') return compare(read(resolveProcessPlantSignalBinding(plant.graph, condition.signal).path), condition.operator, condition.value)
  if (condition.type === 'not') {
    const inner = holds(plant, condition.condition, read)
    return inner === null ? null : !inner
  }
  const answers = condition.conditions.map(child => holds(plant, child, read))
  if (condition.type === 'vote') return answers.filter(answer => answer === true).length >= condition.required ? true : answers.some(answer => answer === null) ? null : false
  if (condition.type === 'any') return answers.includes(true) ? true : answers.includes(null) ? null : false
  return answers.includes(false) ? false : answers.includes(null) ? null : true
}

/**
 * A rule's condition as it acts (ic-thresholds.ts reads its limits alike):
 * of the conditions it requires together, one that holds at the Plant's
 * declared operating point only arms it (power above P-9 for a reactor trip
 * on turbine trip); the others set it off. A condition not combined so sets
 * it off alone.
 */
export const ruleTerms = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule, nominal: (path: VariablePath) => unknown): FaceplateRuleTerms => {
  if (rule.condition.type !== 'all') return { triggers: [rule.condition], gates: [] }
  const arming = rule.condition.conditions.filter(child => holds(plant, child, nominal) === true)
  const triggers = rule.condition.conditions.filter(child => !arming.includes(child))
  return triggers.length === 0 ? { triggers: rule.condition.conditions, gates: [] } : { triggers, gates: arming }
}

/** The signals a safety function's condition compares. */
const safetyFunctionReferences = (condition: ProcessPlantIcSafetyFunctionCondition): ReadonlyArray<ProcessPlantSignalReference> =>
  condition.type === 'all' || condition.type === 'any' ? condition.conditions.flatMap(safetyFunctionReferences)
    : condition.type === 'comparison' ? [condition.signal] : condition.type === 'total' ? condition.signals : [condition.signal, condition.minus]

/** A status tree's leaves, in the order it asks (yes before no). */
const treeReferences = (node: ProcessPlantIcStatusTreeNode): ReadonlyArray<ProcessPlantSignalReference> =>
  'question' in node ? [...safetyFunctionReferences(node.condition), ...treeReferences(node.yes), ...treeReferences(node.no)] : []

/** A status tree's comparisons of one signal, in the order it asks. */
const treeComparisons = (plant: CompiledProcessPlant, node: ProcessPlantIcStatusTreeNode, path: VariablePath): ReadonlyArray<{ readonly operator: string; readonly value: number | boolean }> => {
  if (!('question' in node)) return []
  const own = (condition: ProcessPlantIcSafetyFunctionCondition): ReadonlyArray<{ readonly operator: string; readonly value: number | boolean }> =>
    condition.type === 'all' || condition.type === 'any' ? condition.conditions.flatMap(own)
      : condition.type === 'comparison' && findProcessPlantSignalBinding(plant.graph, condition.signal)?.path === path ? [{ operator: condition.operator, value: condition.value }] : []
  return [...own(node.condition), ...treeComparisons(plant, node.yes, path), ...treeComparisons(plant, node.no, path)]
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

type Column = { readonly heads: FaceplateHead[]; readonly rows: FaceplateRowSpec[]; readonly rules: FaceplateRowSpec[]; readonly causeFirst: boolean }

const lastIndex = <T,>(items: ReadonlyArray<T>, test: (item: T) => boolean): number => {
  for (let at = items.length - 1; at >= 0; at -= 1) if (test(items[at]!)) return at
  return -1
}

/**
 * How a faceplate of one energy end is laid out for the Plant as it is now
 * (its mode, and which readings measure nothing): its columns and their rows,
 * and what its sources name but cannot show. `nominal` reads what each signal
 * reads at the Plant's declared operating point. Null for a component that is
 * no energy end.
 */
export const faceplateLayout = (
  plant: CompiledProcessPlant,
  end: number,
  now: PlantNow,
  nominal: (path: VariablePath) => unknown,
): FaceplateLayout | null => {
  if (!faceplateEnds(plant).includes(end)) return null
  const graph = plant.graph
  const component = graph.components[end]!
  const bindingOf = (path: VariablePath) => graph.signalBindingByPath.get(path)
  const own = graph.signalBindings.filter(binding => binding.owner.type === 'component' && binding.owner.componentIndex === end)
  const ids = new Set(own.flatMap(equipmentOf))
  const onEnd = (binding: ProcessSignalBinding): boolean => equipmentOf(binding).some(key => ids.has(key))
  const silent = notMeaningfulNow(plant, now)
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

  // The row a signal takes, once per faceplate: a reading the Plant's control holds to a program with its program
  // and deviation; a reading that measures only while a flag holds with that flag and its other readings, so it
  // never stands alone when it measures nothing; a permissive never (it gates protection, it is no reading).
  const valuesRow = (path: VariablePath, source: FaceplateSource): FaceplateRowSpec | null => {
    const binding = bindingOf(path)
    if (binding !== undefined && !binding.published && !binding.writable) withhold({ reference: binding.tagId ?? String(path), source, reason: 'not published' })
    if (!readable(binding) || placed.has(path) || permissives.has(path)) return null
    const flag = flagOf.get(path) ?? (flagged.has(path) ? path : undefined)
    if (flag !== undefined && readable(bindingOf(flag))) {
      const paths = [flag, ...flagged.get(flag)!.filter(variable => readable(bindingOf(variable)))].filter(variable => !placed.has(variable))
      for (const variable of paths) placed.add(variable)
      return { kind: 'values', source, paths, flag }
    }
    const program = programOf.get(path)
    const paths = [path, ...(program === undefined ? [] : [program.program, ...(program.deviation === undefined ? [] : [program.deviation])])]
      .filter(variable => readable(bindingOf(variable)) && !placed.has(variable))
    for (const variable of paths) placed.add(variable)
    return { kind: 'values', source, paths }
  }
  const push = (into: Column, row: FaceplateRowSpec | null) => { if (row !== null) into.rows.push(row) }
  const systemsIn = (into: Column): ReadonlyArray<string> => into.rows.flatMap(row => row.kind === 'values' ? row.paths.flatMap(path => {
    const binding = bindingOf(path)
    return binding === undefined ? [] : [systemOf(binding)]
  }) : [])

  // (1) Protection: per commanding group, the states of what it commands, then (first group) the end's shutdown
  // readings, states before readings; its rules and consequences go first or last as the banner decides.
  const groups = commandingGroups(plant, end)
  const actions = automaticActions(plant)
  const judgedBy = new Map<string, ReadonlySet<VariablePath>>()
  const declaredGroups = new Map(plant.automation.firstOutGroups.map(group => [group.id, group]))
  for (const group of groups) {
    const banner = declaredGroups.get(group)?.reactorTrip === true
    const members = groupMembers(plant, group)
    const into = column([{ kind: 'group', group }], !banner)
    into.rules.push({ kind: 'rules', group, banner, rules: members.map(rule => ({ id: rule.id, terms: ruleTerms(plant, rule, nominal) })) })
    const moved = groupStates(plant, group)
    const memberIds = new Set(members.map(rule => rule.id))
    for (const action of actions.values()) {
      if (memberIds.has(action.rule.id)) continue
      if (conditionBindings(plant, action.rule.condition).some(binding => moved.includes(binding.path))) into.rules.push({ kind: 'consequence', rule: action.rule.id, terms: ruleTerms(plant, action.rule, nominal) })
    }
    const states = moved.filter(path => {
      const binding = bindingOf(path)
      if (binding !== undefined && !binding.published) withhold({ reference: binding.tagId ?? String(path), source: 'protection', reason: 'not published' })
      return readable(binding) && !placed.has(path)
    })
    for (const path of states) placed.add(path)
    if (states.length > 0) into.rows.push({ kind: 'values', source: 'protection', paths: states })
    judgedBy.set(group, new Set(members.flatMap(rule => conditionBindings(plant, rule.condition).map(binding => binding.path))))
    columns.push(into)
  }
  const protection = columns[0]
  if (protection !== undefined) {
    const stopped = component.semantics.shutdownReadings
    const isState = (path: VariablePath) => bindingOf(path)?.quantity === 'boolean'
    for (const path of [...stopped.filter(isState), ...stopped.filter(path => !isState(path))]) push(protection, valuesRow(path, 'protection'))
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
    into.heads.push({ kind: 'safetyFunction', id: safetyFunction.id })
    functionColumns.set(safetyFunction.id, { column: into, leaves: new Set(leaves) })
    for (const path of leaves) push(into, valuesRow(path, 'safetyFunction'))
    if (safetyFunction.checks.length > 0) into.rows.push({ kind: 'checks', safetyFunction: safetyFunction.id, labels: safetyFunction.checks.map(check => check.label) })
  }

  // (3) Port circuits, for an end no safety function judges, each titled by its port.
  const circuits: Array<{ readonly column: Column; readonly carrier: string }> = []
  if (functionColumns.size === 0) {
    for (const port of Object.keys(component.ports)) {
      const reached = circuitReach(plant, end, port)
      if (reached.length === 0) continue
      const into = column([{ kind: 'circuit', port, title: portTitle(port), components: reached }])
      for (const index of reached) {
        const along = graph.components[index]!
        for (const aspect of along.semantics.aspects) {
          if (aspect.state !== undefined && (aspect.aspect === 'position' || aspect.aspect === 'running' || aspect.aspect === 'energized')) push(into, valuesRow(aspect.state.path, 'circuit'))
        }
        for (const path of along.semantics.keyValues) push(into, valuesRow(path, 'circuit'))
        for (const binding of graph.signalBindings) {
          if (binding.owner.type === 'component' && binding.owner.componentIndex === index && binding.tagId !== undefined) push(into, valuesRow(binding.path, 'circuit'))
        }
        const branches = presentationFor(along).element === 'bar'
          ? branchFlows(plant, index, MIMIC_REACH_LINKS).filter(branch => readable(bindingOf(branch.path)) && !placed.has(branch.path))
          : []
        for (const branch of branches) placed.add(branch.path)
        if (branches.length > 0) into.rows.push({ kind: 'flows', header: index, branches })
      }
      circuits.push({ column: into, carrier: linkCarrier(attachedAt(plant, end, port)[0]!.link) === 'electricalPower' ? 'electricalPower' : attachedAt(plant, end, port)[0]!.link.kind })
    }
  }

  // (4) Programs: what the end's control holds to a program, each on one row.
  const programColumn = column([{ kind: 'programs' }])
  for (const program of component.semantics.programs) push(programColumn, valuesRow(program.reading, 'program'))

  // (5) The end's other instruments, then its lead values: beside the readings of their own instrument system
  // (after its shutdown readings where there are some), else in the port column of their discipline, else under
  // the end. Of a system whose stop the end's shutdown readings verify, those readings stand for it.
  const ownColumn = column([{ kind: 'equipment', component: end }])
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
    const home = [...columns, ...circuits.map(entry => entry.column), programColumn].find(candidate => systemsIn(candidate).includes(system))
      ?? circuits.find(entry => carriedBy[binding.discipline] === entry.carrier)?.column
      ?? ownColumn
    const sameSystem = (candidate: FaceplateRowSpec) => candidate.kind === 'values' && candidate.paths.some(variable => {
      const other = bindingOf(variable)
      return other !== undefined && systemOf(other) === system
    })
    // After the last shutdown reading of its system (IR beside the intermediate-range startup rate), else after the last of its system.
    const stopping = lastIndex(home.rows, candidate => sameSystem(candidate) && candidate.kind === 'values' && candidate.source === 'protection')
    const after = stopping >= 0 ? stopping : lastIndex(home.rows, sameSystem)
    home.rows.splice(after < 0 ? home.rows.length : after + 1, 0, row)
  }
  for (const binding of graph.signalBindings) {
    if (binding.tagId !== undefined && onEnd(binding) && !verified.has(systemOf(binding))) besideItsSystem(binding.path, 'equipment')
  }
  for (const path of equipmentKeyValues(plant, [end], now)) besideItsSystem(path, 'lead')

  // (6) One table by loop, inside the column of the function that reads the end's loop lines (else the protection's).
  const table = loopTable(plant, end, groups.flatMap(group => [...judgedBy.get(group)!]), placed)
  if (table !== null) {
    const lines = new Set(table.columns.filter(entry => entry.source === 'circuit').flatMap(entry => entry.cells.flat()))
    const reader = plant.automation.safetyFunctions.find(safetyFunction => functionColumns.has(safetyFunction.id) && [...treeReferences(safetyFunction.tree), ...safetyFunction.checks.flatMap(check => safetyFunctionReferences(check.condition))]
      .some(reference => {
        const binding = findProcessPlantSignalBinding(graph, reference)
        return binding !== undefined && lines.has(binding.path)
      }))
    const host = reader === undefined ? protection : functionColumns.get(reader.id)!.column
    host?.rows.push({ kind: 'loops', table })
  }

  // Protection and safety functions first, then the end itself, its port circuits, and what its control holds.
  const finished = (entry: Column): FaceplateColumnSpec => ({ heads: entry.heads, rows: entry.causeFirst ? [...entry.rules, ...entry.rows] : [...entry.rows, ...entry.rules] })
  return {
    end,
    columns: [...columns, ownColumn, ...circuits.map(entry => entry.column), programColumn].filter(entry => entry.rows.length + entry.rules.length > 0).map(finished),
    withheld: [...withheld.values()],
  }
}

/**
 * The end's loops in one table: what its own lines of each loop read (a
 * core's hot and cold legs, within a mimic's reach along the loop), what the instrument channels drawn nowhere
 * measure for the loop (a channel's delta-T; not a quantity the lines
 * already read, nor what it computes for its protection) and, last, what
 * the end's protection judges of them in one column (the overtemperature and
 * overpower margins), at most FACEPLATE_LOOP_COLUMNS columns. Null where the
 * end has no loop lines and no such channels.
 */
const loopTable = (plant: CompiledProcessPlant, end: number, judged: ReadonlyArray<VariablePath>, placed: Set<VariablePath>): FaceplateLoopTable | null => {
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
  const cellsOf = (local: string) => loops.map(loop => {
    const channel = channelOf(loop)
    const path = channel === undefined ? undefined : `${channel.id}.${local}` as VariablePath
    return path !== undefined && tagged(graph.signalBindingByPath.get(path)) ? [path] : []
  })
  const measured = channelReadings.filter(entry => !judgedSet.has(entry.binding.path) && entry.binding.discipline !== 'control' && !lineQuantities.has(entry.binding.quantity))
  const protectionJudges = channelReadings.filter(entry => judgedSet.has(entry.binding.path))
  const judgingRules = plant.automation.rules.filter(rule => rule.enabled && conditionBindings(plant, rule.condition).some(binding => protectionJudges.some(entry => String(binding.path).endsWith(`.${entry.local}`))))
  const columns = [
    ...[...lines.values()].map(cells => ({ cells: loops.map(loop => cells.has(loop) ? [cells.get(loop)!] : []), source: 'circuit' as const, judgedBy: [] as ReadonlyArray<string> })),
    ...measured.map(entry => ({ cells: cellsOf(entry.local), source: 'channel' as const, judgedBy: [] as ReadonlyArray<string> })),
    ...(protectionJudges.length === 0 ? [] : [{
      cells: loops.map((_, at) => protectionJudges.flatMap(entry => cellsOf(entry.local)[at]!)),
      source: 'channel' as const,
      judgedBy: judgingRules.map(rule => rule.id),
    }]),
  ].filter(entry => entry.cells.some(cell => cell.length > 0)).slice(0, FACEPLATE_LOOP_COLUMNS)
  for (const entry of columns) for (const path of entry.cells.flat()) placed.add(path)
  return columns.length === 0 ? null : { loops, columns }
}

/** One comparison a row is decided on, as it reads now. */
export interface FaceplateComparison {
  readonly path: VariablePath
  readonly operator: '<' | '<=' | '>' | '>=' | '==' | '!='
  readonly value: number | boolean
  readonly holds: boolean | null
  /** Where it is one channel of a vote: how many of how many must hold, and how many do now. */
  readonly vote?: { readonly required: number; readonly of: number; readonly holding: number }
}

/** A safety function's criterion a reading is judged against, as its reference once the end has stopped. */
export interface FaceplateCriterion {
  readonly path: VariablePath
  readonly safetyFunction: string
  readonly operator: string
  readonly value: number | boolean
}

/** A faceplate row as it reads now. */
export type FaceplateRow =
  /** An active rule of the column's group, by its trip's title in that group; first out marked. */
  | { readonly kind: 'rule'; readonly rule: string; readonly title: string; readonly firstOut: boolean; readonly sinceMs: number | null; readonly deciding: ReadonlyArray<FaceplateComparison> }
  /** Active rules not listed by name. */
  | { readonly kind: 'acting'; readonly count: number }
  /** Rules of the group not active that act in the mode with what arms them holding, while what the group does can still be done. */
  | { readonly kind: 'armed'; readonly count: number }
  /** A rule elsewhere acting on what the group moved: armed, or idle with what it waits for. */
  | { readonly kind: 'consequence'; readonly rule: string; readonly title: string; readonly action: string; readonly status: 'armed' | 'idle'; readonly deciding: ReadonlyArray<FaceplateComparison> }
  /** Values on one line, those that measure something now; `criteria` where a safety function's criterion is their reference. */
  | { readonly kind: 'values'; readonly source: FaceplateSource; readonly paths: ReadonlyArray<VariablePath>; readonly criteria: ReadonlyArray<FaceplateCriterion> }
  /** A failing check by name: neutral, not an alarm. */
  | { readonly kind: 'check'; readonly safetyFunction: string; readonly label: string; readonly met: 'no' | 'unknown' }
  /** Checks met, folded: their common name, how many of those that apply. */
  | { readonly kind: 'checks'; readonly safetyFunction: string; readonly label: string; readonly met: number; readonly of: number }
  | { readonly kind: 'flows'; readonly header: number; readonly branches: ReadonlyArray<{ readonly path: VariablePath; readonly destination: number }> }
  /** The loop table; an `idle` column is drawn faint with no margin (its rules do not act in the mode). */
  | { readonly kind: 'loops'; readonly loops: ReadonlyArray<string>; readonly columns: ReadonlyArray<{ readonly cells: ReadonlyArray<ReadonlyArray<VariablePath>>; readonly idle: boolean }> }

export interface FaceplateColumn {
  readonly heads: ReadonlyArray<FaceplateHead>
  readonly rows: ReadonlyArray<FaceplateRow>
}

export interface Faceplate {
  readonly end: number
  readonly columns: ReadonlyArray<FaceplateColumn>
}

/** What a faceplate reads live: values, the mode, the active rules (since when), each first-out group's first out, and the safety functions judged now. */
export interface FaceplateLive {
  readonly mode: string | null
  readonly read: (path: VariablePath) => unknown
  readonly active: ReadonlyMap<string, number>
  readonly firstOut: ReadonlyMap<string, string>
  readonly safetyFunctions: ReadonlyArray<SafetyFunctionEvaluation>
}

/** Active rules a group lists by name before it counts the rest. */
export const FACEPLATE_ACTIVE_RULE_ROWS = 4

/** The lines a column takes: one per row, a loop table its head and a line per loop; the column's own head not counted. */
export const faceplateLines = (column: FaceplateColumn): number =>
  column.rows.reduce((lines, row) => lines + (row.kind === 'loops' ? 1 + row.loops.length : 1), 0)

const negated = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' } as const

/** How far a comparison is from holding, relative to its limit: negative once it holds; for a state, −1 or 1. */
const distance = (comparison: FaceplateComparison, read: (path: VariablePath) => unknown): number => {
  const value = read(comparison.path)
  if (comparison.holds === null) return Number.POSITIVE_INFINITY
  if (typeof value !== 'number' || typeof comparison.value !== 'number') return comparison.holds ? -1 : 1
  const scale = Math.max(Math.abs(comparison.value), 1)
  const below = comparison.operator === '<' || comparison.operator === '<='
  return comparison.operator === '==' || comparison.operator === '!=' ? (comparison.holds ? -1 : 1) : (below ? value - comparison.value : comparison.value - value) / scale
}

/**
 * The comparisons a condition is decided on now: a comparison itself; of
 * alternatives, the one that holds or else the nearest; of conditions
 * required together, those that do not hold (all where they all do); of a
 * vote, its nearest channel with the count.
 */
const deciding = (plant: CompiledProcessPlant, condition: ProcessPlantIcCondition, read: (path: VariablePath) => unknown, invert = false): ReadonlyArray<FaceplateComparison> => {
  if (condition.type === 'comparison') {
    const path = resolveProcessPlantSignalBinding(plant.graph, condition.signal).path
    const operator = invert ? negated[condition.operator] : condition.operator
    return [{ path, operator, value: condition.value, holds: compare(read(path), operator, condition.value) }]
  }
  if (condition.type === 'not') return deciding(plant, condition.condition, read, !invert)
  const children = condition.conditions.map(child => deciding(plant, child, read, invert))
  const nearest = (candidates: ReadonlyArray<ReadonlyArray<FaceplateComparison>>) => [...candidates]
    .sort((left, right) => Math.min(...left.map(entry => distance(entry, read))) - Math.min(...right.map(entry => distance(entry, read))))[0] ?? []
  if (condition.type === 'vote' && !invert) {
    const holding = condition.conditions.filter(child => holds(plant, child, read) === true).length
    return nearest(children).slice(0, 1).map(entry => ({ ...entry, vote: { required: condition.required, of: condition.conditions.length, holding } }))
  }
  const alternatives = (condition.type === 'any') !== invert
  if (alternatives) return nearest(children)
  const open = children.filter(entries => entries.some(entry => entry.holds !== true))
  return (open.length === 0 ? children : open).flat()
}

/**
 * What holds now in a condition that set a rule off: each comparison that
 * holds, a vote by its first channel that holds with the count, so an active
 * row names its cause (the pumps stopped), not the branch it no longer needs.
 */
const holding = (plant: CompiledProcessPlant, condition: ProcessPlantIcCondition, read: (path: VariablePath) => unknown, invert = false): ReadonlyArray<FaceplateComparison> => {
  if (condition.type === 'comparison' || (condition.type === 'vote' && invert)) return deciding(plant, condition, read, invert).filter(entry => entry.holds === true)
  if (condition.type === 'not') return holding(plant, condition.condition, read, !invert)
  if (condition.type === 'vote') {
    const held = condition.conditions.filter(child => holds(plant, child, read) === true)
    return held.length === 0 ? [] : holding(plant, held[0]!, read).slice(0, 1).map(entry => ({ ...entry, vote: { required: condition.required, of: condition.conditions.length, holding: held.length } }))
  }
  const found = condition.conditions.flatMap(child => holding(plant, child, read, invert))
  return found.filter((entry, index) => found.findIndex(other => other.path === entry.path) === index)
}

/** A rule's trip as the alarm list writes it in a group, else its label. */
const titleIn = (rule: ProcessPlantIcRule, group: string | undefined): string =>
  tripEffects(rule).find(effect => group === undefined || effect.annunciator?.firstOutGroup === group)?.title ?? rule.label ?? rule.id

/** What checks that apply have in common in their names ("Natural circulation"), else the function's short label. */
const foldedName = (labels: ReadonlyArray<string>, fallback: string): string => {
  const heads = [...new Set(labels.map(label => label.includes(':') ? label.slice(0, label.indexOf(':')) : label))]
  return heads.length === 1 && labels.every(label => label.includes(':')) ? heads[0]! : fallback
}

/**
 * A faceplate as it reads now: a group's active rules by name, first out
 * first (not the banner group's first out), each with what set it off and
 * still holds, then the counts of others acting and of those armed; each
 * consequence only while it can still act; checks folded while they all
 * pass, a failing one by name; readings that measure nothing left out of
 * their row; once what the end's protection commands has acted, the
 * criterion its safety functions judge a reading by as its reference; loop
 * columns whose rules do not act in the mode idle.
 */
export const faceplateNow = (plant: CompiledProcessPlant, layout: FaceplateLayout, live: FaceplateLive): Faceplate => {
  const actions = automaticActions(plant)
  const ruleById = new Map(plant.automation.rules.map(rule => [rule.id, rule]))
  const gatesHold = (terms: FaceplateRuleTerms): boolean => terms.gates.every(gate => holds(plant, gate, live.read) === true)
  const canAct = (rule: ProcessPlantIcRule): boolean => {
    const action = actions.get(rule.id)
    return actsIn(rule, live.mode) && (action === undefined || armed(action, live.read))
  }
  // The end has stopped once what its first protection group commands has all been done (breakers open, rods in).
  const firstGroup = layout.columns.flatMap(column => column.heads).find(head => head.kind === 'group')
  const done = firstGroup?.kind === 'group' ? commonWrites(plant, groupMembers(plant, firstGroup.group)) : null
  const stopped = done !== null && !armed(done, live.read)
  const rowsOf = (spec: FaceplateRowSpec, heads: ReadonlyArray<FaceplateHead>): ReadonlyArray<FaceplateRow> => {
    if (spec.kind === 'rules') {
      const first = live.firstOut.get(spec.group)
      const active = spec.rules.filter(entry => live.active.has(entry.id) && !(spec.banner && entry.id === first))
        .sort((left, right) => Number(right.id === first) - Number(left.id === first) || live.active.get(left.id)! - live.active.get(right.id)!)
      const listed = spec.banner ? [] : active.slice(0, FACEPLATE_ACTIVE_RULE_ROWS).map((entry): FaceplateRow => ({
        kind: 'rule',
        rule: entry.id,
        title: titleIn(ruleById.get(entry.id)!, spec.group),
        firstOut: entry.id === first,
        sinceMs: live.active.get(entry.id) ?? null,
        // A latched rule whose cause has cleared names none: its title says what acted.
        deciding: entry.terms.triggers.flatMap(trigger => holding(plant, trigger, live.read)),
      }))
      // Armed: what the group does can still be done (a reactor trip whose breakers are open guards nothing more,
      // whatever else its causes still start), and the rule acts in the mode with what arms it holding.
      const own = commonWrites(plant, groupMembers(plant, spec.group))
      const armedCount = own === null || !armed(own, live.read) ? 0
        : spec.rules.filter(entry => !live.active.has(entry.id) && actsIn(ruleById.get(entry.id)!, live.mode) && gatesHold(entry.terms)).length
      return [
        ...listed,
        ...(active.length > listed.length ? [{ kind: 'acting', count: active.length - listed.length } as const] : []),
        ...(armedCount > 0 ? [{ kind: 'armed', count: armedCount } as const] : []),
      ]
    }
    if (spec.kind === 'consequence') {
      const rule = ruleById.get(spec.rule)!
      if (live.active.has(rule.id) || !canAct(rule)) return []
      const open = spec.terms.gates.filter(gate => holds(plant, gate, live.read) !== true)
      return [{
        kind: 'consequence',
        rule: rule.id,
        title: titleIn(rule, firstOutGroupOf(plant, rule)?.id),
        action: actionOf(plant, rule),
        status: open.length === 0 ? 'armed' : 'idle',
        deciding: (open.length === 0 ? spec.terms.gates : open).flatMap(gate => deciding(plant, gate, live.read)),
      }]
    }
    if (spec.kind === 'checks') {
      const evaluation = live.safetyFunctions.find(candidate => candidate.id === spec.safetyFunction)
      const applying = (evaluation?.checks ?? []).filter(check => spec.labels.includes(check.label))
      if (applying.length === 0) return []
      const failing = applying.filter(check => check.met !== 'yes')
      const met = applying.length - failing.length
      return [
        ...failing.map((check): FaceplateRow => ({ kind: 'check', safetyFunction: spec.safetyFunction, label: check.label, met: check.met === 'no' ? 'no' : 'unknown' })),
        ...(met === 0 ? [] : [{ kind: 'checks', safetyFunction: spec.safetyFunction, label: foldedName(applying.map(check => check.label), evaluation!.shortLabel), met, of: applying.length } as const]),
      ]
    }
    if (spec.kind === 'values') {
      const paths = spec.flag !== undefined && live.read(spec.flag) !== true ? [spec.flag] : spec.paths
      const functions = heads.flatMap(head => head.kind === 'safetyFunction' ? [head.id] : [])
      const criteria = !stopped ? [] : paths.flatMap(path => functions.flatMap(id => {
        const declared = plant.automation.safetyFunctions.find(candidate => candidate.id === id)!
        const judged = live.safetyFunctions.find(candidate => candidate.id === id)
        if (judged === undefined || judged.status === 'not-monitored') return []
        // The comparison on the path the tree took, else the first it would ask.
        const taken = judged.path.flatMap(step => step.comparisons).find(comparison => comparison.reads.length === 1 && comparison.reads[0]!.path === String(path))
        const criterion = taken === undefined ? treeComparisons(plant, declared.tree, path)[0] : { operator: taken.operator, value: taken.threshold }
        return criterion === undefined ? [] : [{ path, safetyFunction: id, operator: criterion.operator, value: criterion.value }]
      }).slice(0, 1))
      return [{ kind: 'values', source: spec.source, paths, criteria }]
    }
    if (spec.kind === 'loops') {
      return [{
        kind: 'loops',
        loops: spec.table.loops,
        columns: spec.table.columns.map(entry => ({
          cells: entry.cells,
          idle: entry.judgedBy.length > 0 && !entry.judgedBy.some(id => actsIn(ruleById.get(id)!, live.mode)),
        })),
      }]
    }
    return [spec]
  }
  return {
    end: layout.end,
    columns: layout.columns.map(column => ({ heads: column.heads, rows: column.rows.flatMap(row => rowsOf(row, column.heads)) })),
  }
}
