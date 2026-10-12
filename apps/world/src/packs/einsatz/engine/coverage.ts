import type { UnitType } from '../config-schema.ts'
import { classRankOf, isLowerClass, templateOf, unitTypeOf, type Catalog, type EngineState, type TaskCoverage, type TaskRecord, type UnitRecord } from './model.ts'
import { committedPhases, conditionReasons, divertablePhases, hasLoad, isDestroyed, linksToTask, meetsRequirement, providesFor } from './rules.ts'
import { byId, countOf, countsOf, total, type Counts } from './values.ts'

/** What a role can serve on a task's side: the services its commandable units provide and the load classes they carry. */
export interface RoleView {
  readonly provides: ReadonlySet<string>
  readonly carries: ReadonlySet<string>
}

export const roleViewOf = (catalog: Catalog, units: Iterable<UnitRecord>): RoleView => {
  const types = [...units].map(unit => unitTypeOf(catalog, unit))
  return {
    provides: new Set(types.flatMap(type => type.components.service?.provides ?? [])),
    carries: new Set(types.flatMap(type => type.components.carry?.classes ?? [])),
  }
}

/** The role view of an actor on a task: its commandable units of the task's side that are not destroyed. */
export const roleViewFor = (state: EngineState, commandable: (unit: UnitRecord) => boolean, task: TaskRecord): RoleView =>
  roleViewOf(state.catalog, [...state.units.values()].filter(unit => commandable(unit) && linksToTask(unit, task) && !isDestroyed(unit)))

/** Units committed to a task and counted towards it: on its side, not destroyed, ordered by id. */
export const assignedTo = (units: Iterable<UnitRecord>, task: TaskRecord): UnitRecord[] =>
  [...units].filter(unit => unit.taskId === task.id && committedPhases.includes(unit.phase) && !isDestroyed(unit) && linksToTask(unit, task)).sort(byId)

/** Units counted as if sent to the task now: on their way. */
export const asAssigned = (units: ReadonlyArray<UnitRecord>, task: Pick<TaskRecord, 'id'>): UnitRecord[] =>
  units.map(unit => ({ ...unit, taskId: task.id, phase: 'en-route' as const }))

const carries = (type: UnitType, classId: string): boolean => type.components.carry?.classes.includes(classId) === true

const freeCapacity = (type: UnitType, unit: UnitRecord): number => {
  const carry = type.components.carry
  return carry === undefined ? 0 : Math.max(0, carry.capacity - total(unit.load))
}

/**
 * Which waiting load each assigned unit's free carry capacity takes, most
 * urgent class first. Within a class, units carrying fewer classes take load
 * first, keeping a unit that could carry something else for it; ties go by
 * unit id. Coverage reports this allocation and pickup follows it, so load
 * shown as covered is the load its unit picks up.
 */
export const loadAllocation = (catalog: Catalog, task: Pick<TaskRecord, 'loads'>, assigned: ReadonlyArray<UnitRecord>): ReadonlyMap<string, Counts> => {
  const carriers = assigned
    .map(unit => ({ unit, type: unitTypeOf(catalog, unit) }))
    .filter(({ type }) => type.components.carry !== undefined)
    .sort((a, b) => a.type.components.carry!.classes.length - b.type.components.carry!.classes.length || byId(a.unit, b.unit))
  const room = new Map(carriers.map(({ unit, type }) => [unit.id, freeCapacity(type, unit)]))
  const shares = new Map<string, Array<readonly [string, number]>>(carriers.map(({ unit }) => [unit.id, []]))
  for (const classId of catalog.classIds) {
    let waiting = countOf(task.loads, classId)
    for (const { unit, type } of carriers) {
      if (!carries(type, classId)) continue
      const share = Math.min(room.get(unit.id)!, waiting)
      if (share <= 0) continue
      room.set(unit.id, room.get(unit.id)! - share)
      shares.get(unit.id)!.push([classId, share])
      waiting -= share
    }
  }
  return new Map([...shares].map(([id, entries]) => [id, countsOf(entries)]))
}

const loadCoverage = (catalog: Catalog, task: Pick<TaskRecord, 'loads'>, assigned: ReadonlyArray<UnitRecord>): TaskCoverage['loads'] => {
  const shares = [...loadAllocation(catalog, task, assigned).values()]
  return catalog.classIds.filter(classId => countOf(task.loads, classId) > 0).map(classId => ({
    classId,
    waiting: countOf(task.loads, classId),
    covered: shares.reduce((sum, share) => sum + countOf(share, classId), 0),
  }))
}

/**
 * Coverage of a task by the given assigned units: per requirement, the
 * units meeting it on their way, on task and finished; per waiting load
 * class, how much free carry capacity covers it.
 */
export const coverageOf = (catalog: Catalog, task: Pick<TaskRecord, 'id' | 'template' | 'served' | 'loads'>, assigned: ReadonlyArray<UnitRecord>): TaskCoverage => ({
  requirements: templateOf(catalog, task).requires.map(requirement => {
    const meeting = assigned.filter(unit => meetsRequirement(catalog, unit, requirement))
    return {
      provides: requirement.provides,
      count: requirement.count,
      enRoute: meeting.filter(unit => unit.phase !== 'on-task').length,
      onTask: meeting.filter(unit => unit.phase === 'on-task').length,
      completed: countOf(task.served, requirement.provides),
    }
  }),
  loads: loadCoverage(catalog, task, assigned),
})

/**
 * Rank, the divert protection and the row's code: the higher of the
 * template's floor and the most urgent class among loads not yet picked up,
 * covered or not; with neither, the least urgent class. Adding load or
 * coverage never lowers it.
 */
export const rankOf = (catalog: Catalog, task: Pick<TaskRecord, 'template' | 'loads' | 'id'>): string => {
  const template = catalog.templates.get(task.template)
  if (template === undefined) throw new Error(`${task.id}: task template ${task.template} is not declared`)
  const waiting = catalog.classIds.find(id => countOf(task.loads, id) > 0)
  const candidates = [template.priorityClass, waiting].filter((id): id is string => id !== undefined)
  const [first, ...rest] = candidates
  if (first === undefined) {
    const lowest = catalog.classIds.at(-1)
    if (lowest === undefined) throw new Error(`${task.id}: no load class is declared, so the task has no rank`)
    return lowest
  }
  return rest.reduce((best, id) => classRankOf(catalog, id) < classRankOf(catalog, best) ? id : best, first)
}

/** A report has nothing to serve: no requirements and never any load. It closes only when closed explicitly. */
export const isReport = (catalog: Catalog, task: TaskRecord): boolean =>
  templateOf(catalog, task).requires.length === 0 && total(task.loads) === 0 && total(task.pickedUp) === 0

/** Done: every requirement has completed on task and all load is picked up. */
export const isDone = (catalog: Catalog, task: TaskRecord, coverage: TaskCoverage): boolean =>
  !isReport(catalog, task) && coverage.requirements.every(entry => entry.completed >= entry.count) && total(task.loads) === 0

const short = (entry: TaskCoverage['requirements'][number]): boolean => entry.enRoute + entry.onTask + entry.completed < entry.count

/**
 * Need for a role, the sort key of an unserved row: the most urgent load
 * class still uncovered that the role's units can carry; otherwise the rank
 * when a requirement the role can provide is still short, or when the task
 * is an open report. Undefined means the task is served for this role.
 */
export const needFor = (catalog: Catalog, task: TaskRecord, coverage: TaskCoverage, view: RoleView): string | undefined => {
  if (task.closedAtMs !== undefined) return undefined
  const uncovered = coverage.loads.find(entry => entry.covered < entry.waiting && view.carries.has(entry.classId))
  if (uncovered !== undefined) return uncovered.classId
  const requirementShort = coverage.requirements.some(entry => view.provides.has(entry.provides) && short(entry))
  return requirementShort || isReport(catalog, task) ? task.rank : undefined
}

/** The units a task's coverage counts with a proposal: those assigned to it, and the proposal's as if sent now. */
export const countedFor = (state: EngineState, task: TaskRecord, proposal: ReadonlyArray<UnitRecord>): UnitRecord[] =>
  [...assignedTo(state.units.values(), task), ...asAssigned(proposal, task)]

/**
 * The residual need: the task's need for the role after the proposal's units
 * are counted on their way. With no proposal it is the need itself.
 */
export const residualNeed = (state: EngineState, task: TaskRecord, view: RoleView, proposal: ReadonlyArray<UnitRecord>): string | undefined =>
  needFor(state.catalog, task, coverageOf(state.catalog, task, countedFor(state, task, proposal)), view)

export interface Contribution {
  /** Counting the unit changes how far some requirement is filled, up to its count, or how much load of some class is covered. */
  readonly adds: boolean
  /** Why the unit fails the `where` of requirements whose service it provides. */
  readonly unmet: ReadonlyArray<string>
  /** Something the unit could serve is already covered without it. */
  readonly covered: boolean
}

/** How far each requirement is filled, up to its count, then the load covered per class. */
const filled = (coverage: TaskCoverage): number[] => [
  ...coverage.requirements.map(entry => Math.min(entry.count, entry.enRoute + entry.onTask + entry.completed)),
  ...coverage.loads.map(entry => entry.covered),
]

/**
 * What a unit contributes to a task beside `counted`: the assigned units and
 * the rest of a proposal, counted as on their way (`countedFor`); the unit
 * itself is set aside if listed. It adds only when counting it changes a
 * requirement or a covered load class, so the judgement never depends on the
 * order in which a proposal names its units.
 */
export const contributionOf = (catalog: Catalog, task: TaskRecord, counted: ReadonlyArray<UnitRecord>, unit: UnitRecord): Contribution => {
  const others = counted.filter(other => other.id !== unit.id)
  const without = coverageOf(catalog, task, others)
  const withUnit = filled(coverageOf(catalog, task, [...others, ...asAssigned([unit], task)]))
  const type = unitTypeOf(catalog, unit)
  const requirements = templateOf(catalog, task).requires.flatMap((requirement, index) => {
    if (!providesFor(type, requirement)) return []
    const reasons = conditionReasons(catalog, unit, requirement)
    return [{ reasons, open: reasons.length === 0 && short(without.requirements[index]!) }]
  })
  const loads = without.loads.filter(entry => carries(type, entry.classId) && freeCapacity(type, unit) > 0)
  const matched = requirements.filter(entry => entry.reasons.length === 0)
  return {
    adds: filled(without).some((value, index) => value !== withUnit[index]),
    unmet: requirements.flatMap(entry => entry.reasons),
    covered: matched.some(entry => !entry.open) || loads.some(entry => entry.covered >= entry.waiting),
  }
}

/**
 * A divert candidate for a task: a commandable, same-side, unloaded unit
 * still on its way (mobilizing or en route) to another task whose rank is
 * strictly lower than the residual need, and able to add to the task. A unit
 * on task, or heading to work of equal or higher priority, is never one.
 */
export const isDivertCandidate = (state: EngineState, input: {
  readonly unit: UnitRecord
  readonly task: TaskRecord
  /** The units the task counts with the proposal's free units, as for the residual need (`countedFor`). */
  readonly counted: ReadonlyArray<UnitRecord>
  readonly residual: string | undefined
  readonly commandable: (unit: UnitRecord) => boolean
}): boolean => {
  const { unit, task, residual } = input
  if (residual === undefined || unit.taskId === undefined || unit.taskId === task.id) return false
  if (!input.commandable(unit) || !linksToTask(unit, task) || hasLoad(unit) || isDestroyed(unit) || !divertablePhases.includes(unit.phase)) return false
  const from = state.tasks.get(unit.taskId)
  if (from === undefined) throw new Error(`${unit.id}: committed to missing task ${unit.taskId}`)
  return isLowerClass(state.catalog, from.rank, residual) && contributionOf(state.catalog, task, input.counted, unit).adds
}
