import { capabilityRejection } from '../../simulation/capability-rejection.ts'
import type { Eta, Recommendation } from './recommendation-schema.ts'
import { assignedTo, contributionOf, countedFor, coverageOf, isDivertCandidate, residualNeed, roleViewFor, type RoleView } from './engine/coverage.ts'
import { committedText, loadedText } from './engine/intent-support.ts'
import { templateOf, unitTypeOf, type EngineState, type TaskCoverage, type TaskRecord, type UnitRecord } from './engine/model.ts'
import { conditionReasons, divertablePhases, hasLoad, isDestroyed, isFree, linksToTask, providesFor } from './engine/rules.ts'
import { byId, countOf } from './engine/values.ts'
import { classCode, unitWord } from './engine/wording.ts'
import { etaSeconds, etasTo, type TablePort } from './eta.ts'
import { refusal } from './refusal.ts'
import { commandsUnit, inPicture, taskAuthority, type EinsatzViewer } from './viewer.ts'

/**
 * Recommendations for a task. It reads one engine state, the snapshot it is
 * given, outside the engine's queue, and changes nothing. Coverage, need and
 * the divert rule are the engine's own, so what is proposed is what a send
 * of it commits.
 *
 * - Proposal: the smallest set of free units that serves the task for the
 *   caller's units, by fit then ETA; failing that, the free units' best
 *   partial set completed by the fewest divert candidates; failing that, the
 *   best partial set of free units and divert candidates, with the remainder.
 * - Fit is how much of the task a unit fills. Units filling the same
 *   requirements and load classes with the same free capacity fill alike, so
 *   the search picks among them by ETA, nearest first.
 * - Only a unit's active step counts: a unit holding the task queued behind
 *   other work is named under `next`, never as covering it; `nextRemainder`
 *   says what the task would still need were those whose next job it is on
 *   their way. A free unit may
 *   hold steps (a move, an engagement, a paused chain); each candidate says
 *   how many, so the caller can ask whether to do it now or add it to the end.
 */

/** The most combinations a search may judge before it refuses as too large to answer. */
const searchBudget = 20_000

interface Candidate {
  readonly unit: UnitRecord
  readonly eta: Eta
}

/** How far each requirement is filled, up to its count, then the load covered per class: what a unit's fit is judged on. */
const fillOf = (coverage: TaskCoverage): number[] => [
  ...coverage.requirements.map(entry => Math.min(entry.count, entry.enRoute + entry.onTask + entry.completed)),
  ...coverage.loads.map(entry => entry.covered),
]
const fillWith = (state: EngineState, task: TaskRecord, units: ReadonlyArray<UnitRecord>): number[] =>
  fillOf(coverageOf(state.catalog, task, countedFor(state, task, units)))
const sameFill = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => a.every((value, index) => value === b[index])
const sum = (values: ReadonlyArray<number>): number => values.reduce((total, value) => total + value, 0)

/** A unit's fit on its own: how much it adds to the task as assigned now. */
const gainOf = (state: EngineState, task: TaskRecord, unit: UnitRecord): number =>
  sum(fillWith(state, task, [unit])) - sum(fillWith(state, task, []))

/** Units that fill a task alike: the same requirements met, the same load classes and the same free capacity. */
const fillSignature = (state: EngineState, task: TaskRecord, unit: UnitRecord): string => {
  const type = unitTypeOf(state.catalog, unit)
  const carry = type.components.carry
  const freeCapacity = carry === undefined ? 0 : carry.capacity - sum(Object.values(unit.load))
  const meets = templateOf(state.catalog, task).requires.map(requirement => providesFor(type, requirement) && conditionReasons(state.catalog, unit, requirement).length === 0)
  return JSON.stringify([meets, carry === undefined ? [] : [...carry.classes].sort(), freeCapacity])
}

/** Better first: the earlier complete arrival, then the earlier arrivals overall, then unit ids. */
const compareSets = (a: ReadonlyArray<Candidate>, b: ReadonlyArray<Candidate>): number => {
  const latest = (set: ReadonlyArray<Candidate>) => Math.max(0, ...set.map(entry => etaSeconds(entry.eta)))
  const total = (set: ReadonlyArray<Candidate>) => sum(set.map(entry => Math.min(etaSeconds(entry.eta), Number.MAX_VALUE)))
  const ids = (set: ReadonlyArray<Candidate>) => set.map(entry => entry.unit.id).sort().join(' ')
  return latest(a) - latest(b) || total(a) - total(b) || (ids(a) < ids(b) ? -1 : ids(a) > ids(b) ? 1 : 0)
}

const byEta = (a: Candidate, b: Candidate): number => etaSeconds(a.eta) - etaSeconds(b.eta) || byId(a.unit, b.unit)

/**
 * The smallest set of candidates that, beside `base`, serves the task for the
 * caller's units, by fit then ETA. Candidates are grouped by how they fill
 * the task and taken nearest first within a group; sizes are tried from the
 * smallest up.
 */
const smallestCover = (state: EngineState, task: TaskRecord, view: RoleView, base: ReadonlyArray<Candidate>, candidates: ReadonlyArray<Candidate>): ReadonlyArray<Candidate> | undefined => {
  const grouped = new Map<string, Candidate[]>()
  for (const entry of [...candidates].sort(byEta)) {
    const signature = fillSignature(state, task, entry.unit)
    grouped.set(signature, [...grouped.get(signature) ?? [], entry])
  }
  const groups = [...grouped.values()]
  let judged = 0
  const serves = (set: ReadonlyArray<Candidate>): boolean => {
    judged += 1
    if (judged > searchBudget) throw capabilityRejection('capability_work_limit', `${task.label} has too many unit combinations to recommend; send units directly`)
    return residualNeed(state, task, view, [...base, ...set].map(entry => entry.unit)) === undefined
  }
  // Coverage only grows as units are added, so when all of them together do not serve, no subset does.
  if (!serves(candidates)) return undefined
  for (let size = 0; size <= candidates.length; size++) {
    let best: ReadonlyArray<Candidate> | undefined
    const choose = (group: number, left: number, chosen: ReadonlyArray<Candidate>): void => {
      if (group === groups.length) {
        if (left === 0 && serves(chosen) && (best === undefined || compareSets(chosen, best) < 0)) best = chosen
        return
      }
      const members = groups[group]!
      for (let count = Math.min(left, members.length); count >= 0; count--) choose(group + 1, left - count, [...chosen, ...members.slice(0, count)])
    }
    choose(0, size, [])
    if (best !== undefined) return best
  }
  return undefined
}

/**
 * Drops members that add nothing beside the rest, latest arrival first, so a
 * partial set fills as much as all of them with as few units as it can.
 * Members of `keep` stay.
 */
const pruned = (state: EngineState, task: TaskRecord, set: ReadonlyArray<Candidate>, keep: ReadonlySet<string> = new Set()): ReadonlyArray<Candidate> => {
  let current = [...set]
  const full = fillWith(state, task, current.map(entry => entry.unit))
  for (const entry of [...set].sort(byEta).reverse()) {
    if (keep.has(entry.unit.id)) continue
    const without = current.filter(other => other !== entry)
    if (sameFill(fillWith(state, task, without.map(other => other.unit)), full)) current = without
  }
  return current.sort(byEta)
}

/** What the task still needs from the caller's units after the proposal, in configuration words. */
const remainderOf = (state: EngineState, task: TaskRecord, view: RoleView, proposal: ReadonlyArray<UnitRecord>): string[] => {
  const coverage = coverageOf(state.catalog, task, countedFor(state, task, proposal))
  const requirements = templateOf(state.catalog, task).requires
  return [
    ...coverage.requirements.flatMap((entry, index) => {
      const missing = entry.count - Math.min(entry.count, entry.enRoute + entry.onTask + entry.completed)
      const label = requirements[index]!.label
      return view.provides.has(entry.provides) && missing > 0 ? [`${missing} more ${missing === 1 ? label.one : label.other}`] : []
    }),
    ...coverage.loads.flatMap(entry => {
      const missing = entry.waiting - entry.covered
      return view.carries.has(entry.classId) && missing > 0 ? [`${classCode(state.catalog, entry.classId)}×${missing}`] : []
    }),
  ]
}

/**
 * Whether any unit on the task's side, busy or not, could ever fill what the
 * task still needs after the proposal: a non-destroyed unit providing each
 * short requirement and meeting its conditions, and a carrier for each
 * uncovered load class.
 */
const servableAfter = (state: EngineState, task: TaskRecord, proposal: ReadonlyArray<UnitRecord>): boolean => {
  const coverage = coverageOf(state.catalog, task, countedFor(state, task, proposal))
  const side = [...state.units.values()].filter(unit => linksToTask(unit, task) && !isDestroyed(unit))
  const requirements = templateOf(state.catalog, task).requires
  return coverage.requirements.every((entry, index) => entry.enRoute + entry.onTask + entry.completed >= entry.count
    || side.some(unit => providesFor(unitTypeOf(state.catalog, unit), requirements[index]!) && conditionReasons(state.catalog, unit, requirements[index]!).length === 0))
    && coverage.loads.every(entry => entry.covered >= entry.waiting
      || side.some(unit => unitTypeOf(state.catalog, unit).components.carry?.classes.includes(entry.classId) === true))
}

interface Survey {
  /** Free units that add to the task now. */
  readonly free: ReadonlyArray<UnitRecord>
  /** Busy units that would add to the task: committed elsewhere or carrying load. */
  readonly busy: ReadonlyArray<UnitRecord>
  readonly ineligible: Recommendation['ineligible']
}

/** The caller's units of the task's side that provide what it requires or carry what it holds, sorted into free, busy and ineligible. */
const survey = (state: EngineState, task: TaskRecord, commandable: (unit: UnitRecord) => boolean): Survey => {
  const assigned = assignedTo(state.units.values(), task)
  const requires = templateOf(state.catalog, task).requires
  const free: UnitRecord[] = []
  const busy: UnitRecord[] = []
  const ineligible: Array<Recommendation['ineligible'][number]> = []
  for (const unit of [...state.units.values()].sort(byId)) {
    if (!commandable(unit) || !linksToTask(unit, task) || unit.taskId === task.id) continue
    const type = unitTypeOf(state.catalog, unit)
    const relevant = requires.some(requirement => providesFor(type, requirement))
      || (type.components.carry?.classes.some(classId => countOf(task.loads, classId) > 0) ?? false)
    if (!relevant) continue
    const refuse = (reasons: ReadonlyArray<string>) => ineligible.push({ unitId: unit.id, label: unit.label, reasons: [...reasons] })
    if (isDestroyed(unit)) refuse([`${unit.label} is ${unitWord(state.catalog, unit, 'destroyed')}`])
    else if (type.components.mobility === undefined) refuse([`${unit.label} cannot move`])
    else {
      const contribution = contributionOf(state.catalog, task, assigned, unit)
      if (!contribution.adds) {
        if (contribution.unmet.length > 0) refuse(contribution.unmet)
      } else (isFree(unit) ? free : busy).push(unit)
    }
  }
  return { free, busy, ineligible }
}

const rejected = (reason: { readonly reason: string }, code: 'capability_target_not_found' | 'capability_input_rejected') => capabilityRejection(code, reason.reason)

/** Units in the viewer's picture with the task queued in their chain, by how many steps come first, then id. */
const queuedFor = (state: EngineState, viewer: EinsatzViewer, task: TaskRecord): Recommendation['next'] => [...state.units.values()]
  .filter(unit => inPicture(state.catalog, viewer, unit))
  .flatMap(unit => {
    const stepsAhead = unit.orders.findIndex(step => step.state === 'queued' && 'taskId' in step.target && step.target.taskId === task.id)
    return stepsAhead < 0 ? [] : [{ unitId: unit.id, label: unit.label, stepId: unit.orders[stepsAhead]!.id, stepsAhead }]
  })
  .sort((a, b) => a.stepsAhead - b.stepsAhead || (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0))

/**
 * What the task would still need from the caller's units were the units
 * holding it as their next job, queued behind at most the step they are
 * carrying out, on their way to it beside those assigned now: empty when
 * they would serve it.
 */
const nextRemainderOf = (state: EngineState, task: TaskRecord, view: RoleView, next: Recommendation['next']): string[] =>
  remainderOf(state, task, view, next.flatMap(entry => {
    const unit = state.units.get(entry.unitId)
    return unit !== undefined && unit.orders.slice(0, entry.stepsAhead).every(step => step.state === 'active') ? [unit] : []
  }))

/**
 * The recommendation for a task as the viewer sees it: proposal,
 * alternatives, ineligible and busy units. A task outside the viewer's
 * picture is not in it; one outside its queue or closed is refused.
 */
export const recommend = async (input: {
  readonly state: EngineState
  readonly viewer: EinsatzViewer
  readonly taskId: string
  readonly routing: TablePort
}): Promise<Recommendation> => {
  const { state, viewer } = input
  const task = state.tasks.get(input.taskId)
  if (task === undefined) throw rejected({ reason: refusal('not_in_picture', 'Not in your picture') }, 'capability_target_not_found')
  const unauthorized = taskAuthority(state, viewer, task)
  if (unauthorized) throw rejected(unauthorized, unauthorized.reason.startsWith('not_in_picture') ? 'capability_target_not_found' : 'capability_input_rejected')
  if (task.closedAtMs !== undefined) throw rejected({ reason: refusal('task_closed', `${task.label} is closed`) }, 'capability_input_rejected')

  const commandable = (unit: UnitRecord): boolean => commandsUnit(state.catalog, viewer, unit)
  const view = roleViewFor(state, commandable, task)
  const units = survey(state, task, commandable)
  const divertable = units.busy.filter(unit => divertablePhases.includes(unit.phase) && !hasLoad(unit))
  const etas = await etasTo(state, [...units.free, ...divertable], task.point, input.routing)
  const candidate = (unit: UnitRecord): Candidate => ({ unit, eta: etas.get(unit.id)! })
  const free = units.free.map(candidate)

  const freeCover = smallestCover(state, task, view, [], free)
  const partial = freeCover ?? pruned(state, task, free)
  const residual = residualNeed(state, task, view, partial.map(entry => entry.unit))
  const counted = countedFor(state, task, partial.map(entry => entry.unit))
  const diverts = divertable
    .filter(unit => isDivertCandidate(state, { unit, task, counted, residual, commandable }))
    .map(candidate)
  const completion = freeCover === undefined ? smallestCover(state, task, view, partial, diverts) : undefined
  const proposal = freeCover ?? (completion === undefined
    ? pruned(state, task, [...partial, ...diverts], new Set(partial.map(entry => entry.unit.id)))
    : [...partial, ...completion])
  const proposed = proposal.map(entry => entry.unit)
  const inProposal = new Set(proposed.map(unit => unit.id))
  const divertIds = new Set(diverts.map(entry => entry.unit.id))

  const described = (entry: Candidate): Recommendation['alternatives'][number] => {
    const from = entry.unit.taskId === undefined ? undefined : state.tasks.get(entry.unit.taskId)
    return {
      unitId: entry.unit.id,
      label: entry.unit.label,
      eta: entry.eta,
      ...(from === undefined ? {} : { divertFrom: { taskId: from.id, label: from.label, rank: { id: from.rank, code: classCode(state.catalog, from.rank) } } }),
      ...(entry.unit.orders.length === 0 ? {} : { steps: entry.unit.orders.length }),
    }
  }
  const byFit = (entries: ReadonlyArray<Candidate>): Candidate[] => entries
    .filter(entry => !inProposal.has(entry.unit.id))
    .map(entry => ({ entry, gain: gainOf(state, task, entry.unit) }))
    .sort((a, b) => b.gain - a.gain || byEta(a.entry, b.entry))
    .map(({ entry }) => entry)
  const need = residualNeed(state, task, view, [])
  const next = queuedFor(state, viewer, task)

  return {
    taskId: task.id,
    rank: { id: task.rank, code: classCode(state.catalog, task.rank) },
    need: need === undefined ? null : { id: need, code: classCode(state.catalog, need) },
    proposal: {
      units: proposal.map(described),
      covers: residualNeed(state, task, view, proposed) === undefined,
      remainder: remainderOf(state, task, view, proposed),
    },
    alternatives: [...byFit(free), ...byFit(diverts)].map(described),
    ineligible: units.ineligible,
    committed: units.busy
      .filter(unit => !inProposal.has(unit.id) && !divertIds.has(unit.id))
      .map(unit => ({ unitId: unit.id, label: unit.label, reason: hasLoad(unit) ? loadedText(state, unit) : committedText(state, unit) })),
    servable: servableAfter(state, task, proposed),
    next,
    nextRemainder: nextRemainderOf(state, task, view, next),
  }
}
