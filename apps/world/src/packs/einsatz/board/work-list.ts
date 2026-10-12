import type { Eta, Recommendation } from '../recommendation-schema.ts'
import type { BoardRecords, BoardTask, BoardUnit } from './records.ts'
import { assignedUnits, isFree, type BoardRules, type RoleView } from './rules.ts'
import { classCode, clockText, etaText, joinUnits, namedOnce, reasonText, word } from './text.ts'
import type { WorkRow } from './types.ts'

/**
 * The work list: the viewer's queue of open tasks. Unserved rows come first
 * by need, then age; served rows follow by rank, then age. Coverage, rank and
 * need come from the records the engine wrote; recommendations add the best
 * proposal, a divert or why no unit can come.
 */

export interface WorkEntry {
  readonly task: BoardTask
  readonly view: RoleView
  /** Undefined when the task is served for the viewer's units. */
  readonly need: string | undefined
}

const byId = (a: BoardTask, b: BoardTask): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0

export const workEntries = (rules: BoardRules, records: BoardRecords): ReadonlyArray<WorkEntry> => {
  const entries = [...records.tasks.values()]
    .filter(task => task.closedAtMs === undefined && rules.queues(task))
    .map(task => {
      const view = rules.roleView(records, task)
      return { task, view, need: rules.needFor(task, view) }
    })
  const key = (entry: WorkEntry): number => rules.classRank(entry.need ?? entry.task.rank)
  return entries.sort((a, b) =>
    Number(a.need === undefined) - Number(b.need === undefined)
    || key(a) - key(b)
    || a.task.createdAtMs - b.task.createdAtMs
    || byId(a.task, b.task))
}

export const isUnserved = (entry: WorkEntry): boolean => entry.need !== undefined

/**
 * What a recommendation for the task depends on besides positions: its rank,
 * load and coverage, and the units of its side that could ever count towards
 * it (a type providing a required service or carrying a waiting load class),
 * each with its property values and, when the viewer commands it, how it
 * stands for dispatch. Other units, and motion, never change it.
 */
export const recommendationKey = (rules: BoardRules, records: BoardRecords, task: BoardTask): string => {
  const requires = rules.templateOf(task).requires
  const waiting = Object.keys(task.loads).filter(classId => (task.loads[classId] ?? 0) > 0)
  const counts = (unit: BoardUnit): boolean => {
    const components = rules.typeOf(unit).components
    return requires.some(requirement => components.service?.provides.includes(requirement.provides) === true)
      || waiting.some(classId => components.carry?.classes.includes(classId) === true)
  }
  return JSON.stringify([
    task.rank,
    task.loads,
    task.coverage,
    [...records.units.values()]
      .filter(unit => unit.side === task.side && counts(unit))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      // An uncommanded unit counts only towards whether the task could ever be served; any unit holding the task queued is its "next".
      .map(unit => [unit.id, rules.commands(unit) ? rules.dispatchClass(records, unit) : unit.integrity === 'destroyed' ? 'destroyed' : 'uncommanded', unit.properties, chainKey(unit, task)]),
  ])
}

/**
 * What a recommendation reads of a unit's job chain: how many steps it
 * holds (a candidate says so, for "Do now" or "Add to end") and where it
 * holds the task queued (the answer's `next`).
 */
const chainKey = (unit: BoardUnit, task: BoardTask): ReadonlyArray<unknown> => [
  unit.orders.length,
  unit.paused === true,
  unit.orders.flatMap((step, index) => step.state === 'queued' && 'taskId' in step.target && step.target.taskId === task.id ? [`${step.id}@${index}`] : []),
]

/** "A3 next, 2 steps ahead": the units holding the task queued in their job chains, as the recommendation names them. */
export const nextText = (answer: Recommendation): string | null => answer.next.length === 0 ? null : answer.next
  .map(entry => entry.stepsAhead === 0 ? `${entry.label} next` : `${entry.label} next, ${entry.stepsAhead} ${entry.stepsAhead === 1 ? 'step' : 'steps'} ahead`)
  .join(' · ')

/** The services the task still needs from the viewer's units, in configuration words: "2 more guards". */
export const serviceRemainderFor = (rules: BoardRules, task: BoardTask, view: RoleView): string[] => {
  const requirements = rules.templateOf(task).requires
  return task.coverage.requirements.flatMap((entry, index) => {
    const missing = entry.count - Math.min(entry.count, entry.enRoute + entry.onTask + entry.completed)
    const label = requirements[index]!.label
    return view.provides.has(entry.provides) && missing > 0 ? [`${missing} more ${missing === 1 ? label.one : label.other}`] : []
  })
}

/** What the task still needs from the viewer's units, in configuration words: "2 more guards", "P3×1". */
export const remainderFor = (rules: BoardRules, task: BoardTask, view: RoleView): string[] => [
  ...serviceRemainderFor(rules, task, view),
  ...task.coverage.loads.flatMap(entry => {
    const missing = entry.waiting - entry.covered
    return view.carries.has(entry.classId) && missing > 0 ? [`${classCode(rules, entry.classId)}×${missing}`] : []
  }),
]

const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

/** "1 en route · 1 on task · needs 2 more guards", then what other roles' units do there, read-only. */
export const coverageText = (rules: BoardRules, records: BoardRecords, entry: WorkEntry): string => {
  const { task, view } = entry
  const assigned = assignedUnits(records, task)
  const travelling = assigned.filter(unit => unit.phase !== 'on-task').length
  const onTask = assigned.length - travelling
  const remainder = remainderFor(rules, task, view)
  const requirements = rules.templateOf(task).requires
  const others = task.coverage.requirements.flatMap((coverage, index) => {
    if (view.provides.has(coverage.provides)) return []
    const label = requirements[index]!.label
    const busy = coverage.enRoute + coverage.onTask
    return [`${label.other}: ${busy > 0 ? `${busy} ${lower(word(rules, 'en-route'))}` : coverage.completed >= coverage.count ? 'done' : 'none yet'}`]
  })
  return [
    ...(travelling > 0 ? [`${travelling} ${lower(word(rules, 'en-route'))}`] : []),
    ...(onTask > 0 ? [`${onTask} ${lower(word(rules, 'on-task'))}`] : []),
    ...(remainder.length > 0 ? [`needs ${remainder.join(', ')}`] : []),
    ...others,
  ].join(' · ')
}

/** "needs P3×1" on an unserved row whose most urgent uncovered load sits below its rank. */
export const needText = (rules: BoardRules, entry: WorkEntry): string | null => {
  if (entry.need === undefined || entry.need === entry.task.rank) return null
  const load = entry.task.coverage.loads.find(coverage => coverage.classId === entry.need)
  const missing = load === undefined ? 0 : load.waiting - load.covered
  return `needs ${classCode(rules, entry.need)}×${missing}`
}

/** What a row and its commit element say when the recommendation could not be had. */
export const noRecommendationText = (failure: string): string => `No recommendation: ${reasonText(failure)}`

export const ageText = (task: BoardTask, nowMs: number): string => clockText((nowMs - task.createdAtMs) / 1_000)

/** Seconds until the last unit of a set arrives; a set with an unavailable ETA, or no units, never arrives. */
export const completeSeconds = (units: ReadonlyArray<{ readonly eta: Eta }>): number =>
  units.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...units.map(unit => unit.eta.kind === 'unavailable' ? Number.POSITIVE_INFINITY : unit.eta.seconds))

const latestEta = (units: Recommendation['proposal']['units']): Eta =>
  units.reduce((latest, unit) => completeSeconds([unit]) > completeSeconds([{ eta: latest }]) ? unit.eta : latest, units[0]!.eta)

/** The proposal and its complete arrival: "A3 + A5 ≈4:20". */
export const proposalText = (answer: Recommendation): string | null => {
  const units = answer.proposal.units
  return units.length === 0 ? null : `${joinUnits(units.map(unit => unit.label))} ${etaText(latestEta(units))}`
}

export const divertFromText = (from: NonNullable<Recommendation['alternatives'][number]['divertFrom']>): string => `${from.label} (${from.rank.code})`

/**
 * Whether a unit the recommendation lists as not eligible could ever count:
 * it is in the picture, not destroyed, and its type moves. A destroyed unit,
 * or one that cannot move, never will.
 */
export const couldBecomeEligible = (rules: BoardRules, records: BoardRecords) => (unitId: string): boolean => {
  const unit = records.units.get(unitId)
  return unit !== undefined && unit.integrity !== 'destroyed' && rules.typeOf(unit).components.mobility !== undefined
}

/**
 * "No unit can serve: needs …" only when no unit of the task's side could
 * ever serve what the proposal leaves: none provides it, and no unit listed
 * as not eligible could become eligible (`couldServe`: a property short of
 * a condition, which a change can fix, but not a destroyed unit or one that
 * cannot move). Null otherwise.
 */
export const unservableText = (answer: Recommendation, couldServe: (unitId: string) => boolean): string | null =>
  answer.servable || answer.ineligible.some(entry => couldServe(entry.unitId)) ? null : `No unit can serve: needs ${answer.proposal.remainder.join(', ')}`

/** "No eligible unit · Unit 2 · Payload 300 kg · needs ≥ 500 kg": one unit not eligible, named once; one that could become eligible first, a free one before a busy one. */
const ineligibleText = (answer: Recommendation, isFree: (unitId: string) => boolean, couldServe: (unitId: string) => boolean): string | null => {
  const entry = answer.ineligible.find(item => couldServe(item.unitId) && isFree(item.unitId)) ?? answer.ineligible.find(item => couldServe(item.unitId)) ?? answer.ineligible[0]
  return entry === undefined ? null : `No eligible unit · ${namedOnce(entry.label, entry.reasons[0]!)}`
}

/**
 * A divert proposal, or why no unit comes, kept apart: a free unit that is
 * not eligible (with its reason), units that could come but are busy, no
 * unit that could ever serve, or units that could become eligible. Nothing
 * while no unit is proposed but one holds the task queued in its job chain:
 * the row's "next" names it.
 */
export const statusText = (answer: Recommendation, isFree: (unitId: string) => boolean, couldServe: (unitId: string) => boolean): string | null => {
  const divert = answer.proposal.units.find(unit => unit.divertFrom !== undefined)
  if (divert !== undefined) return `Divert ${divert.label} from ${divertFromText(divert.divertFrom!)} · ${etaText(divert.eta)}`
  const busy = answer.committed.length > 0 ? `${answer.committed.length} busy` : null
  // A unit holds the task queued: its "next" says who comes, and no line beside it says that none can.
  if (answer.proposal.units.length === 0 && answer.next.length > 0) return null
  if (answer.proposal.units.length === 0 && answer.need !== null) {
    const freeIneligible = answer.ineligible.some(item => isFree(item.unitId) && couldServe(item.unitId))
    if (freeIneligible) return [ineligibleText(answer, isFree, couldServe), busy].filter(part => part !== null).join(' · ')
    if (busy !== null) return `No free unit · ${busy}`
    const unservable = unservableText(answer, couldServe)
    if (unservable !== null) return unservable
    const ineligible = ineligibleText(answer, isFree, couldServe)
    if (ineligible !== null) return ineligible
    // The side could serve it, yet none of the viewer's units is free, busy or not eligible: those that could are on this call already, or another role commands them.
    return 'No free unit'
  }
  const unservable = unservableText(answer, couldServe)
  if (unservable !== null) return unservable
  if (!answer.proposal.covers && answer.proposal.remainder.length > 0) return `still needs ${answer.proposal.remainder.join(', ')}`
  return null
}

/** Whether a unit in the picture is free; one outside it is not. */
export const isFreeIn = (records: BoardRecords, unitId: string): boolean => {
  const unit = records.units.get(unitId)
  return unit !== undefined && isFree(unit)
}

export const workRow = (rules: BoardRules, records: BoardRecords, entry: WorkEntry, context: {
  readonly answer: Recommendation | undefined
  /** Why the last ask for a recommendation failed, while no answer stands. */
  readonly failure: string | undefined
  readonly nowMs: number
  readonly fresh: boolean
  readonly selected: boolean
}): WorkRow => {
  const { task } = entry
  const template = rules.templateOf(task)
  return {
    id: task.id,
    label: task.label,
    noun: template.label,
    icon: template.icon,
    code: classCode(rules, task.rank),
    needText: needText(rules, entry),
    served: !isUnserved(entry),
    ageText: ageText(task, context.nowMs),
    coverageText: coverageText(rules, records, entry),
    etaText: context.answer === undefined ? null : proposalText(context.answer),
    nextText: context.answer === undefined ? null : nextText(context.answer),
    statusText: context.answer !== undefined ? statusText(context.answer, unitId => isFreeIn(records, unitId), couldBecomeEligible(rules, records)) : context.failure === undefined ? null : noRecommendationText(context.failure),
    alerts: task.alerts.map(alert => alert.message),
    closeLabel: word(rules, 'close'),
    fresh: context.fresh,
    selected: context.selected,
  }
}
