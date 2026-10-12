import type { CompiledProcessLink, ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import { energyEnds, linkCarrier } from '../graph/index.ts'
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
// in columns by function, one line per row. Only the energy sources and
// sinks the model declares get one. Every row comes from a bounded source,
// read from declared semantics and I&C, never from names:
// (1) protection: the first-out groups whose rules all command the end, as
//     rule rows; the rules elsewhere that act on what those groups move, as
//     consequence rows; the states of what every rule of a group commands;
//     the readings that say the end has stopped;
// (2) critical safety functions: the leaves of their trees and checks that
//     read the end's equipment, and their checks while they apply; a
//     function that shares a reading with an earlier column joins it under
//     its own chip;
// (3) port circuits, only for an end no safety function judges: each port's
//     line up to the first header or junction, and what joins it there;
// (4) programs: the readings the Plant's control holds to a program;
// (5) the end's remaining instruments, and the detail's lead values the
//     sources above left out, each beside the readings of its own instrument
//     system;
// (6) instrument channels drawn nowhere whose readings its protection
//     judges, loop by loop, as one table.
// No reading appears twice. The layout depends on the Plant's mode and on
// which readings measure nothing (as a detail's lead values do); which rules
// are active, what they decide on and which checks apply are read live.

/** Where a row comes from (the numbered sources above). */
export type FaceplateSource = 'protection' | 'safetyFunction' | 'circuit' | 'program' | 'equipment' | 'channel' | 'lead'

/** What heads a column: a first-out group, a critical safety function's chip, a port circuit, the end itself, or its programs. */
export type FaceplateHead =
  | { readonly kind: 'group'; readonly group: string }
  | { readonly kind: 'safetyFunction'; readonly id: string }
  | { readonly kind: 'circuit'; readonly port: string; readonly components: ReadonlyArray<number> }
  | { readonly kind: 'equipment'; readonly component: number }
  | { readonly kind: 'programs' }

/** A rule's condition split as it acts: what sets it off, and what only arms it (holding at the Plant's operating point). */
export interface FaceplateRuleTerms {
  readonly triggers: ReadonlyArray<ProcessPlantIcCondition>
  readonly gates: ReadonlyArray<ProcessPlantIcCondition>
}

export type FaceplateRowSpec =
  /** The rules of a first-out group, each with its terms; read live as active rows and a count of those armed. */
  | { readonly kind: 'rules'; readonly group: string; readonly rules: ReadonlyArray<{ readonly id: string; readonly terms: FaceplateRuleTerms }> }
  /** A rule of another group that acts on a state the column's group moves; shown only while it can act. */
  | { readonly kind: 'consequence'; readonly rule: string; readonly terms: FaceplateRuleTerms }
  /** One signal, as a reading or a state by its quantity; `instead` is the reading it stands for while that measures nothing. */
  | { readonly kind: 'value'; readonly path: VariablePath; readonly source: FaceplateSource; readonly instead?: VariablePath }
  /** A safety function's checks; each shown only while it applies. */
  | { readonly kind: 'checks'; readonly safetyFunction: string; readonly labels: ReadonlyArray<string> }
  /** What a header sends to each destination. */
  | { readonly kind: 'flows'; readonly header: number; readonly branches: ReadonlyArray<{ readonly path: VariablePath; readonly destination: number }> }

export interface FaceplateColumnSpec {
  readonly heads: ReadonlyArray<FaceplateHead>
  readonly rows: ReadonlyArray<FaceplateRowSpec>
}

/** Parallel instrument channels, one row per loop, one column per reading they share. */
export interface FaceplateLoopTable {
  readonly loops: ReadonlyArray<{ readonly loop: string; readonly component: number }>
  readonly columns: ReadonlyArray<{ readonly variable: string; readonly paths: ReadonlyArray<VariablePath | null> }>
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
  readonly loops: FaceplateLoopTable | null
  readonly withheld: ReadonlyArray<FaceplateWithheld>
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

/** What an operator display may show: published, not a demand, not a value only the simulator computes. */
const readable = (binding: ProcessSignalBinding | undefined): boolean =>
  binding !== undefined && binding.published && !binding.writable && binding.simulatorOnly !== true

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

const comparisonLeaves = (condition: ProcessPlantIcCondition): ReadonlyArray<Extract<ProcessPlantIcCondition, { type: 'comparison' }>> =>
  condition.type === 'comparison' ? [condition] : condition.type === 'not' ? comparisonLeaves(condition.condition) : condition.conditions.flatMap(comparisonLeaves)

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

/**
 * The critical safety functions' leaves: every signal a tree's questions and
 * its checks compare, in the order the tree asks (yes before no), each
 * function's own; and each check's leaves apart.
 */
const safetyFunctionReferences = (condition: ProcessPlantIcSafetyFunctionCondition): ReadonlyArray<ProcessPlantSignalReference> =>
  condition.type === 'all' || condition.type === 'any' ? condition.conditions.flatMap(safetyFunctionReferences)
    : condition.type === 'comparison' ? [condition.signal] : condition.type === 'total' ? condition.signals : [condition.signal, condition.minus]
const treeReferences = (node: ProcessPlantIcStatusTreeNode): ReadonlyArray<ProcessPlantSignalReference> =>
  'question' in node ? [...safetyFunctionReferences(node.condition), ...treeReferences(node.yes), ...treeReferences(node.no)] : []

/**
 * The components a port's line reaches away from the end, up to the first
 * header (drawn as a bar), a junction where the line branches, or where its
 * service ends, within a mimic's reach; with each, the other equipment that
 * joins it where the line lands (the turbine bypass into the condenser's
 * steam inlet, the grid onto the transformer the generator feeds).
 */
const circuitReach = (plant: CompiledProcessPlant, end: number, port: string): ReadonlyArray<number> => {
  const graph = plant.graph
  const attached = (component: number, portName: string): ReadonlyArray<{ readonly link: CompiledProcessLink; readonly far: number; readonly farPort: string }> => [
    ...(graph.outgoingLinksByComponent[component] ?? []).map(index => graph.links[index]!).filter(link => String(link.fromPortName) === portName)
      .map(link => ({ link, far: link.toComponentIndex, farPort: String(link.toPortName) })),
    ...(graph.incomingLinksByComponent[component] ?? []).map(index => graph.links[index]!).filter(link => String(link.toPortName) === portName)
      .map(link => ({ link, far: link.fromComponentIndex, farPort: String(link.fromPortName) })),
  ]
  const reached: number[] = []
  const add = (component: number) => { if (component !== end && !reached.includes(component)) reached.push(component) }
  for (const start of attached(end, port)) {
    let step = start
    for (let depth = 0; depth < MIMIC_REACH_LINKS; depth += 1) {
      const component = graph.components[step.far]!
      add(component.index)
      for (const joining of attached(component.index, step.farPort)) if (joining.far !== end && joining.link.index !== step.link.index) add(joining.far)
      if (presentationFor(component).element === 'bar') break
      const onward = Object.keys(component.ports).filter(name => name !== step.farPort)
        .flatMap(name => attached(component.index, name)).filter(next => linkCarrier(next.link) === linkCarrier(step.link) && next.far !== end)
      if (onward.length !== 1) break
      step = onward[0]!
    }
  }
  return reached
}

/**
 * How a faceplate of one energy end is laid out for the Plant as it is now
 * (its mode, and which readings measure nothing): its columns and their rows,
 * the loop table, and what its sources name but cannot show. `nominal` reads
 * what each signal reads at the Plant's declared operating point. Null for a
 * component that is no energy source or sink.
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
  const own = graph.signalBindings.filter(binding => binding.owner.type === 'component' && binding.owner.componentIndex === end)
  const ids = new Set(own.flatMap(equipmentOf))
  const onEnd = (binding: ProcessSignalBinding): boolean => equipmentOf(binding).some(key => ids.has(key))
  const silent = notMeaningfulNow(plant, now)
  const flagOf = new Map(graph.components.flatMap(candidate => candidate.semantics.meaningfulWhile).flatMap(qualified => qualified.variables.map(variable => [variable, qualified.flag] as const)))
  // Permissives qualify protection and meaning flags qualify readings; neither is a reading of its own.
  const qualifiers = new Set(graph.components.flatMap(candidate => [...candidate.semantics.permissives, ...candidate.semantics.meaningfulWhile.map(qualified => qualified.flag)]))
  const placed = new Set<VariablePath>()
  const withheld = new Map<string, FaceplateWithheld>()
  const withhold = (entry: FaceplateWithheld) => { if (!withheld.has(entry.reference)) withheld.set(entry.reference, entry) }
  type Column = { heads: FaceplateHead[]; rows: FaceplateRowSpec[] }
  const columns: Column[] = []

  // A value row, once per faceplate; a reading that measures nothing now stands as the flag that says so.
  const valueRow = (path: VariablePath, source: FaceplateSource, asQualifier = false): FaceplateRowSpec | null => {
    const binding = graph.signalBindingByPath.get(path)
    if (!readable(binding)) {
      if (binding !== undefined && !binding.published) withhold({ reference: binding.tagId ?? String(path), source, reason: 'not published' })
      return null
    }
    if (!asQualifier && qualifiers.has(path)) return null
    const flag = silent.has(path) ? flagOf.get(path) : undefined
    const shown = flag !== undefined && readable(graph.signalBindingByPath.get(flag)) ? flag : path
    if (placed.has(shown) || placed.has(path)) return null
    placed.add(shown)
    placed.add(path)
    return shown === path ? { kind: 'value', path, source } : { kind: 'value', path: shown, source, instead: path }
  }
  const push = (rows: FaceplateRowSpec[], row: FaceplateRowSpec | null) => { if (row !== null) rows.push(row) }

  // (1) Protection: per commanding group, its rule rows, its consequences, the states of what it commands.
  const groups = commandingGroups(plant, end)
  const actions = automaticActions(plant)
  const judgedBy = new Map<string, ReadonlySet<VariablePath>>()
  for (const group of groups) {
    const members = groupMembers(plant, group)
    const rows: FaceplateRowSpec[] = [{ kind: 'rules', group, rules: members.map(rule => ({ id: rule.id, terms: ruleTerms(plant, rule, nominal) })) }]
    const common = commonWrites(plant, members)
    const moved = common === null ? [] : actionStates(plant, common).map(state => state.path)
    const memberIds = new Set(members.map(rule => rule.id))
    for (const action of actions.values()) {
      if (memberIds.has(action.rule.id)) continue
      if (conditionBindings(plant, action.rule.condition).some(binding => moved.includes(binding.path))) rows.push({ kind: 'consequence', rule: action.rule.id, terms: ruleTerms(plant, action.rule, nominal) })
    }
    for (const path of moved) push(rows, valueRow(path, 'protection', true))
    judgedBy.set(group, new Set(members.flatMap(rule => conditionBindings(plant, rule.condition).map(binding => binding.path))))
    columns.push({ heads: [{ kind: 'group', group }], rows })
  }
  // What says the end has stopped, under the protection that stops it.
  const protection = columns[0]
  for (const path of component.semantics.shutdownReadings) {
    if (protection === undefined) break
    push(protection.rows, valueRow(path, 'protection'))
  }

  // (2) Critical safety functions: leaves on the end's equipment, in a column of their own or one they share a reading with.
  const functionColumns = new Map<string, { readonly column: Column; readonly leaves: ReadonlySet<VariablePath> }>()
  for (const safetyFunction of plant.automation.safetyFunctions) {
    const references = [...treeReferences(safetyFunction.tree), ...safetyFunction.checks.flatMap(check => safetyFunctionReferences(check.condition))]
    const leaves = [...new Set(references.flatMap(reference => {
      const binding = findProcessPlantSignalBinding(graph, reference)
      return binding !== undefined && onEnd(binding) ? [binding.path] : []
    }))]
    if (leaves.length === 0) continue
    // A leaf the Plant does not have, in a function that judges the end, is named as missing.
    for (const reference of references) {
      if (findProcessPlantSignalBinding(graph, reference) === undefined) withhold({ reference: reference.tagId ?? String(reference.path), source: 'safetyFunction', reason: 'not in the Plant' })
    }
    const sharedGroup = groups.find(group => leaves.some(path => judgedBy.get(group)!.has(path)))
    const sharedFunction = [...functionColumns.values()].find(entry => leaves.some(path => entry.leaves.has(path)))
    const column = sharedGroup !== undefined ? columns[groups.indexOf(sharedGroup)]! : sharedFunction?.column ?? { heads: [], rows: [] }
    if (sharedGroup === undefined && sharedFunction === undefined) columns.push(column)
    column.heads.push({ kind: 'safetyFunction', id: safetyFunction.id })
    functionColumns.set(safetyFunction.id, { column, leaves: new Set(leaves) })
    for (const path of leaves) push(column.rows, valueRow(path, 'safetyFunction', true))
    // Its checks are its own criteria beside its colour (natural circulation with no coolant pump running): they stand under its chip.
    if (safetyFunction.checks.length > 0) column.rows.push({ kind: 'checks', safetyFunction: safetyFunction.id, labels: safetyFunction.checks.map(check => check.label) })
  }

  // (3) Port circuits, for an end no safety function judges.
  const circuits: Column[] = []
  if (functionColumns.size === 0) {
    for (const port of Object.keys(component.ports)) {
      const reached = circuitReach(plant, end, port)
      if (reached.length === 0) continue
      const rows: FaceplateRowSpec[] = []
      for (const index of reached) {
        const along = graph.components[index]!
        for (const aspect of along.semantics.aspects) {
          if (aspect.state !== undefined && (aspect.aspect === 'position' || aspect.aspect === 'running' || aspect.aspect === 'energized')) push(rows, valueRow(aspect.state.path, 'circuit'))
        }
        for (const path of along.semantics.keyValues) push(rows, valueRow(path, 'circuit'))
        for (const binding of graph.signalBindings) {
          if (binding.owner.type === 'component' && binding.owner.componentIndex === index && binding.tagId !== undefined && readable(binding)) push(rows, valueRow(binding.path, 'circuit'))
        }
        const branches = presentationFor(along).element === 'bar'
          ? branchFlows(plant, index, MIMIC_REACH_LINKS).filter(branch => readable(graph.signalBindingByPath.get(branch.path)) && !placed.has(branch.path))
          : []
        for (const branch of branches) placed.add(branch.path)
        if (branches.length > 0) rows.push({ kind: 'flows', header: index, branches })
      }
      if (rows.length > 0) circuits.push({ heads: [{ kind: 'circuit', port, components: reached }], rows })
    }
  }

  // (4) Programs: each reading the Plant's control holds to a program, the program, and how far it stands from it.
  const programColumn: Column = { heads: [{ kind: 'programs' }], rows: [] }
  for (const program of component.semantics.programs) {
    for (const path of [program.reading, program.program, ...(program.deviation === undefined ? [] : [program.deviation])]) push(programColumn.rows, valueRow(path, 'program'))
  }

  // (5) The end's other instruments and its lead values, beside the readings of their own instrument system, or under the end.
  const ownColumn: Column = { heads: [{ kind: 'equipment', component: end }], rows: [] }
  const besideItsSystem = (path: VariablePath, source: FaceplateSource) => {
    const binding = graph.signalBindingByPath.get(path)
    if (binding === undefined) return
    const system = systemOf(binding)
    const home = [...columns, ...circuits, programColumn].find(column => column.rows.some(row => {
      if (row.kind !== 'value') return false
      const shown = graph.signalBindingByPath.get(row.instead ?? row.path)
      return shown !== undefined && systemOf(shown) === system
    })) ?? ownColumn
    push(home.rows, valueRow(path, source))
  }
  for (const binding of graph.signalBindings) if (binding.tagId !== undefined && onEnd(binding) && readable(binding)) besideItsSystem(binding.path, 'equipment')
  for (const path of equipmentKeyValues(plant, [end], now)) besideItsSystem(path, 'lead')

  // (6) Instrument channels drawn nowhere whose readings the end's protection judges, as one table by loop.
  const judged = new Set(groups.flatMap(group => [...judgedBy.get(group)!]))
  const channels = graph.components.filter(candidate => candidate.metadata?.loopId !== undefined && presentationFor(candidate).element === 'not-drawn'
    && graph.signalBindings.some(binding => binding.owner.type === 'component' && binding.owner.componentIndex === candidate.index && judged.has(binding.path)))
    .sort((left, right) => left.metadata!.loopId!.localeCompare(right.metadata!.loopId!))
  const local = (path: VariablePath, owner: string): string => String(path).slice(owner.length + 1)
  const loops = channels.length === 0 ? null : (() => {
    const first = channels[0]!
    const readings = graph.signalBindings.filter(binding => binding.owner.type === 'component' && binding.owner.componentIndex === first.index && binding.tagId !== undefined && readable(binding))
    const ranked = [...new Set([
      ...first.semantics.keyValues,
      ...readings.filter(binding => judged.has(binding.path)).map(binding => binding.path),
      ...readings.map(binding => binding.path),
    ])].map(path => local(path, String(first.id)))
    const columnsOf = ranked.map(variable => ({
      variable,
      paths: channels.map(channel => {
        const path = `${channel.id}.${variable}` as VariablePath
        return readable(graph.signalBindingByPath.get(path)) && !placed.has(path) ? path : null
      }),
    })).filter(column => column.paths.some(path => path !== null))
    for (const column of columnsOf) for (const path of column.paths) if (path !== null) placed.add(path)
    return { loops: channels.map(channel => ({ loop: channel.metadata!.loopId!, component: channel.index })), columns: columnsOf }
  })()

  // Protection and safety functions first, then the end itself, its port circuits, and what its control holds.
  return {
    end,
    columns: [...columns, ownColumn, ...circuits, programColumn].filter(column => column.rows.length > 0),
    loops,
    withheld: [...withheld.values()],
  }
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

/** A faceplate row as it reads now. */
export type FaceplateRow =
  /** An active rule of the column's group, by its trip's title in that group; first out marked. */
  | { readonly kind: 'rule'; readonly rule: string; readonly title: string; readonly firstOut: boolean; readonly sinceMs: number | null; readonly deciding: ReadonlyArray<FaceplateComparison> }
  /** Active rules beyond those listed. */
  | { readonly kind: 'acting'; readonly count: number }
  /** Rules of the group not active that act in the mode with what arms them holding, while what the group does can still be done. */
  | { readonly kind: 'armed'; readonly count: number }
  /** A rule elsewhere acting on what the group moved: armed, or idle with what it waits for. */
  | { readonly kind: 'consequence'; readonly rule: string; readonly title: string; readonly action: string; readonly status: 'armed' | 'idle'; readonly deciding: ReadonlyArray<FaceplateComparison> }
  | { readonly kind: 'value'; readonly path: VariablePath; readonly source: FaceplateSource; readonly instead?: VariablePath }
  | { readonly kind: 'check'; readonly safetyFunction: string; readonly label: string; readonly met: 'yes' | 'no' | 'unknown' }
  | { readonly kind: 'flows'; readonly header: number; readonly branches: ReadonlyArray<{ readonly path: VariablePath; readonly destination: number }> }

export interface FaceplateColumn {
  readonly heads: ReadonlyArray<FaceplateHead>
  readonly rows: ReadonlyArray<FaceplateRow>
}

export interface Faceplate {
  readonly end: number
  readonly columns: ReadonlyArray<FaceplateColumn>
  readonly loops: FaceplateLoopTable | null
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

/**
 * A faceplate as it reads now: each group's active rules by name, first out
 * first, each with what set it off and still holds inline, then the count of
 * those armed; each consequence only while it can still act; checks only while
 * they apply.
 */
export const faceplateNow = (plant: CompiledProcessPlant, layout: FaceplateLayout, live: FaceplateLive): Faceplate => {
  const actions = automaticActions(plant)
  const ruleById = new Map(plant.automation.rules.map(rule => [rule.id, rule]))
  const gatesHold = (terms: FaceplateRuleTerms): boolean => terms.gates.every(gate => holds(plant, gate, live.read) === true)
  const canAct = (rule: ProcessPlantIcRule): boolean => {
    const action = actions.get(rule.id)
    return actsIn(rule, live.mode) && (action === undefined || armed(action, live.read))
  }
  const rowsOf = (spec: FaceplateRowSpec): ReadonlyArray<FaceplateRow> => {
    if (spec.kind === 'rules') {
      const first = live.firstOut.get(spec.group)
      const active = spec.rules.filter(entry => live.active.has(entry.id))
        .sort((left, right) => Number(right.id === first) - Number(left.id === first) || live.active.get(left.id)! - live.active.get(right.id)!)
      const listed = active.slice(0, FACEPLATE_ACTIVE_RULE_ROWS).map((entry): FaceplateRow => {
        return {
          kind: 'rule',
          rule: entry.id,
          title: titleIn(ruleById.get(entry.id)!, spec.group),
          firstOut: entry.id === first,
          sinceMs: live.active.get(entry.id) ?? null,
          // A latched rule whose cause has cleared names none: its title says what acted.
          deciding: entry.terms.triggers.flatMap(trigger => holding(plant, trigger, live.read)),
        }
      })
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
      return (evaluation?.checks ?? []).filter(check => spec.labels.includes(check.label))
        .map(check => ({ kind: 'check', safetyFunction: spec.safetyFunction, label: check.label, met: check.met }))
    }
    return [spec]
  }
  return {
    end: layout.end,
    columns: layout.columns.map(column => ({ heads: column.heads, rows: column.rows.flatMap(rowsOf) })),
    loops: layout.loops,
  }
}
