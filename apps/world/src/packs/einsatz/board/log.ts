import type { actionVerbs } from '../engine/model.ts'
import { chainStepBy, isStandingOrderBy, undoCause } from '../ids.ts'
import type { BoardLastAction, BoardRecords, BoardTask, BoardUnit } from './records.ts'
import type { BoardRules } from './rules.ts'
import { classCode, unitWord } from './text.ts'
import type { HeaderAlert, LogEntry } from './types.ts'

/**
 * The event log and header alerts, derived only from records in the
 * viewer's picture: each record's last order and the alerts it raises. They
 * never read command events, so they show nothing outside the picture.
 */

/** What a change between two snapshots adds to the log, and whether it calls for the new-work tone. */
export interface LogChange {
  readonly entries: ReadonlyArray<LogEntry>
  /** Tasks that appeared since the previous snapshot. */
  readonly newTasks: ReadonlyArray<string>
  /** Tasks with new work: new ones, and those that raised an alert such as work returned. */
  readonly newWork: ReadonlyArray<string>
}

/** Every order the engine writes into `lastAction`: a verb it adds fails the World check until the log words it. */
type ActionVerb = (typeof actionVerbs)[number]

/** A unit, a task or, for an engagement, the side's track: what the order names, by label, when the picture holds it. */
const labelOf = (records: BoardRecords, id: string | undefined): string | undefined =>
  id === undefined ? undefined : records.units.get(id)?.label ?? records.tasks.get(id)?.label ?? records.tracks.get(id)?.label

/**
 * "sent to C-12 · from C-9", in neutral mechanism words; a target outside the
 * picture is not named. An undone send reads "recalled (undo)", an undone
 * queued step "step removed: H1 (undo)", with no other cause. The engine
 * starting a queued step carries on a person's order, and is not called a
 * standing order.
 */
const actionText = (rules: BoardRules, records: BoardRecords, record: BoardUnit | BoardTask, action: BoardLastAction, before: BoardUnit | BoardTask): string => {
  const target = labelOf(records, action.target)
  const to = target === undefined ? '' : ` ${target}`
  if (action.verb === 'remove' && action.cause === undoCause) {
    const wasActive = before.type === 'unit' && before.orders.some(step => step.id === action.stepId && step.state === 'active')
    return `${record.label}: ${wasActive ? 'recalled' : `step removed:${to}`} (undo)`
  }
  const verbs: Readonly<Record<ActionVerb, string>> = {
    create: 'created',
    send: `sent to${to}`,
    divert: `diverted to${to}`,
    move: target === undefined ? 'moving to a point' : `moving to${to}`,
    deliver: `delivering to${to}`,
    recall: 'recalled',
    hold: record.type === 'unit' ? unitWord(rules, record, 'hold') : 'held',
    release: `released from${to}`,
    adjust: 'adjusted',
    set: record.type === 'unit' && record.accepting !== undefined ? (record.accepting ? 'accepting' : 'not accepting') : 'set',
    close: 'closed',
    engage: target === undefined ? 'engaging a target' : `engaging${to}`,
    queue: target === undefined ? 'queued a move' : `queued${to}`,
    remove: target === undefined ? 'step removed' : `step removed:${to}`,
    resume: 'resumed',
    clear: 'chain cleared',
  }
  const known = (verb: string): verb is ActionVerb => Object.hasOwn(verbs, verb)
  if (!known(action.verb)) throw new Error(`Unknown Einsatz order ${action.verb}`)
  const verb = verbs[action.verb]
  const by = isStandingOrderBy(action.by) && action.by !== chainStepBy ? ' · standing order' : ''
  const cause = action.cause === undefined || action.verb === 'release' ? '' : ` · ${action.cause}`
  return `${record.label}: ${verb}${cause}${by}`
}

const sameAction = (a: BoardLastAction | undefined, b: BoardLastAction | undefined): boolean =>
  a?.verb === b?.verb && a?.target === b?.target && a?.atMs === b?.atMs && a?.by === b?.by && a?.cause === b?.cause

const records = (all: BoardRecords): ReadonlyArray<BoardUnit | BoardTask> => [...all.units.values(), ...all.tasks.values()]

/** The log entries a new snapshot adds over the previous one, oldest first. */
export const logChange = (rules: BoardRules, previous: BoardRecords, next: BoardRecords): LogChange => {
  const entries: LogEntry[] = []
  const newTasks: string[] = []
  const newWork = new Set<string>()
  for (const record of records(next)) {
    const before = record.type === 'unit' ? previous.units.get(record.id) : previous.tasks.get(record.id)
    if (before === undefined) {
      if (record.type === 'task') {
        newTasks.push(record.id)
        newWork.add(record.id)
        entries.push({ atMs: record.createdAtMs, recordId: record.id, text: `${record.label}: new · ${rules.templateOf(record).label} · ${classCode(rules, record.rank)}` })
      } else entries.push({ atMs: record.lastAction?.atMs ?? record.phaseSinceMs, recordId: record.id, text: `${record.label}: new · ${rules.typeOf(record).label}` })
      continue
    }
    if (record.lastAction !== undefined && !sameAction(before.lastAction, record.lastAction)) {
      entries.push({ atMs: record.lastAction.atMs, recordId: record.id, text: actionText(rules, next, record, record.lastAction, before) })
    }
    for (const alert of record.alerts) {
      const standing = before.alerts.find(entry => entry.code === alert.code)
      if (standing !== undefined && standing.message === alert.message && standing.sinceMs === alert.sinceMs) continue
      if (record.type === 'task') newWork.add(record.id)
      entries.push({ atMs: alert.sinceMs, recordId: record.id, text: `${record.label}: ${alert.message}` })
    }
  }
  return { entries: entries.sort((a, b) => a.atMs - b.atMs), newTasks, newWork: [...newWork] }
}

/** Every standing alert on a record in the picture, newest first. */
export const recordAlerts = (all: BoardRecords): HeaderAlert[] => records(all)
  .filter(record => record.type === 'unit' || record.closedAtMs === undefined)
  .flatMap(record => record.alerts.map(alert => ({ recordId: record.id, label: record.label, code: alert.code, message: alert.message, sinceMs: alert.sinceMs })))
  .sort((a, b) => b.sinceMs - a.sinceMs || (a.recordId < b.recordId ? -1 : 1))
