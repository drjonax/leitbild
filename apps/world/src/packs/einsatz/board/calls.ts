import type { GeoJsonPoint } from '../../../core/model/index.ts'
import type { EinsatzCommandId, einsatzQueryIds } from '../capabilities.ts'
import type { Recommendation } from '../recommendation-schema.ts'
import { stepIdOf, type Step, type StepTarget } from '../steps.ts'
import type { BoardRecords, BoardTask, BoardUnit } from './records.ts'
import { hasLoad, loadShareOf, type BoardRules } from './rules.ts'
import { boardWords, joinUnits, loadText, word } from './text.ts'
import { divertFromText } from './work-list.ts'

/**
 * The Capability calls the Board makes, each with the words that describe it.
 * What the commit element shows is built from the same call it sends, so
 * what is shown is exactly what commits.
 */

/**
 * The Einsatz Capability ids the Board calls. The Capabilities module pulls
 * in the engine, so the Board names the ids itself; their types tie them to
 * the Capabilities, and a renamed id fails to compile.
 */
export const boardCommandIds = {
  send: 'world.einsatz.unit.send',
  recall: 'world.einsatz.unit.recall',
  hold: 'world.einsatz.unit.hold',
  queue: 'world.einsatz.unit.queue',
  stepRemove: 'world.einsatz.unit.step.remove',
  resume: 'world.einsatz.unit.resume',
  clear: 'world.einsatz.unit.clear',
  taskClose: 'world.einsatz.task.close',
} as const satisfies Readonly<Record<string, EinsatzCommandId>>
export const boardQueryIds = {
  recommend: 'world.einsatz.recommend',
  configuration: 'world.einsatz.configuration',
} as const satisfies Readonly<Record<string, typeof einsatzQueryIds[keyof typeof einsatzQueryIds]>>

export type CallOrigin = 'work-list' | 'unit-board' | 'map'

export interface CallDraft {
  readonly capabilityId: EinsatzCommandId
  readonly input: unknown
  /** "Send A3 + A5 → C-12", in the configuration's words; a divert names the task it leaves: "Divert A3 from C-9 (P3) → C-12". */
  readonly text: string
  /** The same call without the task a divert leaves, for a confirmation that names that task once in its detail. */
  readonly short: string
  readonly origin: CallOrigin
  /** The task the call sends units to or closes. */
  readonly taskId?: string
  readonly unitIds: ReadonlyArray<string>
}

/** Identifies a call by what it asks for, not by its words or ETA. */
export const callKey = (call: CallDraft): string => JSON.stringify([call.capabilityId, call.input])

type Candidate = Recommendation['proposal']['units'][number]

const total = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((sum, count) => sum + count, 0)

/** The task a release takes a unit from, as the recommendation or the unit's record names it. */
export interface ReleasedFrom {
  readonly taskId: string
  readonly label: string
  readonly code: string
}

/**
 * What a unit's release takes from the task it leaves: "C-9 (P3) · 1 pallet
 * returns to the queue", the unit's share of the waiting load as the engine
 * allocates it; or "C-9 (P3) loses U2" when it carries none of it.
 */
export const releaseText = (rules: BoardRules, records: BoardRecords, unit: { readonly id: string; readonly label: string }, from: ReleasedFrom): string => {
  const task = records.tasks.get(from.taskId)
  const share = task === undefined ? {} : loadShareOf(rules, records, task, unit.id)
  const named = `${from.label} (${from.code})`
  return total(share) === 0 ? `${named} loses ${unit.label}` : `${named} · ${loadText(rules, share)} ${total(share) === 1 ? 'returns' : 'return'} to the queue`
}

/** A send of recommended units to a task; diverted units name the task each leaves. */
export const sendToTask = (rules: BoardRules, task: BoardTask, units: ReadonlyArray<Candidate>, origin: CallOrigin): CallDraft => {
  const plain = units.filter(unit => unit.divertFrom === undefined)
  const diverted = units.filter(unit => unit.divertFrom !== undefined)
  const parts = (from: boolean) => [
    ...(plain.length > 0 ? [`${word(rules, 'send')} ${joinUnits(plain.map(unit => unit.label))}`] : []),
    ...diverted.map(unit => `${plain.length > 0 ? 'divert' : 'Divert'} ${unit.label}${from ? ` from ${divertFromText(unit.divertFrom!)}` : ''}`),
  ]
  return {
    capabilityId: boardCommandIds.send,
    input: {
      units: units.map(unit => unit.unitId),
      to: { taskId: task.id },
      ...(diverted.length === 0 ? {} : { divert: diverted.map(unit => ({ unitId: unit.unitId, fromTaskId: unit.divertFrom!.taskId })) }),
    },
    text: `${parts(true).join(' + ')} → ${task.label}`,
    short: `${parts(false).join(' + ')} → ${task.label}`,
    origin,
    taskId: task.id,
    unitIds: units.map(unit => unit.unitId),
  }
}

/**
 * Where a send or a queued step takes a unit, as `world.einsatz.unit.send`
 * and `unit.queue` name it: a task, a site (a unit that does not move), a
 * point (a move), or one of its side's tracks (an engagement).
 */
export type SendTarget = { readonly taskId: string } | { readonly siteId: string } | { readonly point: GeoJsonPoint } | { readonly trackId: string }

const targetLabel = (records: BoardRecords, target: SendTarget): string => {
  const label = 'taskId' in target ? records.tasks.get(target.taskId)?.label
    : 'siteId' in target ? records.units.get(target.siteId)?.label
    : 'trackId' in target ? records.tracks.get(target.trackId)?.label
    : 'the map point'
  if (label === undefined) throw new Error('A map target outside the picture')
  return label
}

/**
 * The label of what a step leads to, in the screen's picture: a task, a
 * site, the side's track, or a map point. A target the picture no longer
 * holds is named by its id; the engine skips such a step when it comes up.
 */
export const stepTargetLabel = (records: BoardRecords, target: StepTarget): string => {
  if ('point' in target) return boardWords.mapPoint
  const id = 'taskId' in target ? target.taskId : 'siteId' in target ? target.siteId : target.trackId
  return records.tasks.get(id)?.label ?? records.units.get(id)?.label ?? records.tracks.get(id)?.label ?? id
}

/** A step as a unit's chain shows it: what it does and where, "C-1", "deliver to H1", "to a map point", "engage T-3". */
export const stepText = (records: BoardRecords, step: Step): string => {
  const label = stepTargetLabel(records, step.target)
  switch (step.kind) {
    case 'serve': return label
    case 'deliver': return `deliver to ${label}`
    case 'move': return `to ${label}`
    case 'engage': return `engage ${label}`
  }
}

/** A unit sent by a map click: to a task, a site, a point or a track it engages. A committed unit is released from its task in the same send. */
export const sendFromMap = (rules: BoardRules, records: BoardRecords, unit: BoardUnit, target: SendTarget): CallDraft => {
  const divert = unit.taskId === undefined ? undefined : [{ unitId: unit.id, fromTaskId: unit.taskId }]
  const verb = 'taskId' in target ? (divert === undefined ? word(rules, 'send') : 'Divert') : 'trackId' in target ? boardWords.engage : word(rules, 'move')
  const text = `${verb} ${unit.label} → ${targetLabel(records, target)}`
  return {
    capabilityId: boardCommandIds.send,
    input: { units: [unit.id], to: target, ...(divert === undefined ? {} : { divert }) },
    text,
    short: text,
    origin: 'map',
    ...('taskId' in target ? { taskId: target.taskId } : {}),
    unitIds: [unit.id],
  }
}

/** Add a target to the end of a unit's job chain; a unit holding no step and not paused starts it at once, exactly as a send. */
export const queueCall = (records: BoardRecords, unit: BoardUnit, target: SendTarget): CallDraft => {
  const text = `${boardWords.addToEnd}: ${unit.label} → ${targetLabel(records, target)}`
  return {
    capabilityId: boardCommandIds.queue,
    input: { unitId: unit.id, to: target },
    text,
    short: text,
    origin: 'map',
    ...('taskId' in target ? { taskId: target.taskId } : {}),
    unitIds: [unit.id],
  }
}

/**
 * A step as the object of a verb: "C-1", "delivery to H1", "move to a map
 * point", "engagement of T-3", so "Remove move to a map point · U2" never
 * reads as a direction.
 */
export const stepNoun = (records: BoardRecords, step: Step): string => {
  const label = stepTargetLabel(records, step.target)
  switch (step.kind) {
    case 'serve': return label
    case 'deliver': return `delivery to ${label}`
    case 'move': return `move to ${label}`
    case 'engage': return `engagement of ${label}`
  }
}

/**
 * Remove one step from a unit's chain: a queued one leaves, the active one is
 * released as a recall releases it. An undo removes the step the unit's last
 * order created and puts things back quietly: the engine raises no release
 * alert for it.
 */
export const stepRemoveCall = (records: BoardRecords, unit: { readonly id: string; readonly label: string }, step: Step, mode: 'remove' | 'undo' = 'remove'): CallDraft => {
  const text = `${mode === 'undo' ? boardWords.undo : boardWords.removeStep} ${stepNoun(records, step)} · ${unit.label}`
  return {
    capabilityId: boardCommandIds.stepRemove,
    input: { unitId: unit.id, stepId: step.id, ...(mode === 'undo' ? { undo: true } : {}) },
    text,
    short: text,
    origin: 'unit-board',
    unitIds: [unit.id],
  }
}

/** Resume a paused unit, or clear its whole chain. */
export const chainVerbCall = (unit: BoardUnit, verb: 'resume' | 'clear'): CallDraft => {
  const text = `${verb === 'resume' ? boardWords.resume : boardWords.clear} ${unit.label}`
  return {
    capabilityId: verb === 'resume' ? boardCommandIds.resume : boardCommandIds.clear,
    input: { unitId: unit.id },
    text,
    short: text,
    origin: 'unit-board',
    unitIds: [unit.id],
  }
}

/** Recall a unit from the task it is on: naming it, so a unit re-tasked meanwhile is refused rather than pulled off its new task. */
const recallFrom = (rules: BoardRules, unit: { readonly id: string; readonly label: string }, fromTaskId: string | undefined): CallDraft => {
  const text = `${word(rules, 'recall')} ${unit.label}`
  return {
    capabilityId: boardCommandIds.recall,
    input: { unitId: unit.id, ...(fromTaskId === undefined ? {} : { fromTaskId }) },
    text,
    short: text,
    origin: 'unit-board',
    unitIds: [unit.id],
  }
}

/** Recall a unit: always naming the task it leaves, so a unit re-tasked meanwhile is refused rather than pulled off its new task. */
export const recallCall = (rules: BoardRules, unit: BoardUnit): CallDraft => recallFrom(rules, unit, unit.taskId)

/** A unit's step serial as the Board knew it when a call left: the step the call creates is the next one. */
export interface UndoMark {
  readonly unitId: string
  readonly serial: number
}

/** The marks a send or a queue leaves for its Undo, one per unit it names. */
export const undoMarks = (records: BoardRecords, call: CallDraft): ReadonlyArray<UndoMark> => call.unitIds.map(unitId => {
  const unit = records.units.get(unitId)
  if (unit === undefined) throw new Error(`The Board sent ${unitId}, which is not in its picture`)
  return { unitId, serial: unit.stepSerial ?? 0 }
})

/** The step an accepted send or queue created on each unit, by the id the unit's last order names. */
export interface CreatedStep {
  readonly unit: BoardUnit
  readonly step: Step
}

/**
 * What an accepted send or queue created, once the Run shows it: for each
 * unit exactly one new step since the call left, the one its last order
 * names in `lastAction.stepId`, still in its chain. 'pending' while the Run
 * shows no new step yet; 'gone' when another order came between, or the step
 * is already done, so Undo would remove something else or nothing.
 */
export const createdSteps = (records: BoardRecords, marks: ReadonlyArray<UndoMark>): ReadonlyArray<CreatedStep> | 'pending' | 'gone' => {
  const created: CreatedStep[] = []
  for (const mark of marks) {
    const unit = records.units.get(mark.unitId)
    if (unit === undefined) return 'gone'
    const serial = unit.stepSerial ?? 0
    if (serial === mark.serial) return 'pending'
    const stepId = stepIdOf(mark.serial + 1)
    const step = unit.orders.find(entry => entry.id === stepId)
    if (serial !== mark.serial + 1 || unit.lastAction?.stepId !== stepId || step === undefined) return 'gone'
    created.push({ unit, step })
  }
  return created
}

/** Pause a unit in place, the Stop of its job chain. */
export const holdCall = (rules: BoardRules, unit: BoardUnit): CallDraft => {
  const text = `${word(rules, 'hold')} ${unit.label}`
  return {
    capabilityId: boardCommandIds.hold,
    input: { unitId: unit.id },
    text,
    short: text,
    origin: 'unit-board',
    unitIds: [unit.id],
  }
}

export const closeCall = (rules: BoardRules, task: BoardTask, origin: CallOrigin): CallDraft => {
  const text = `${word(rules, 'close')} ${task.label}`
  return {
    capabilityId: boardCommandIds.taskClose,
    input: { taskId: task.id },
    text,
    short: text,
    origin,
    taskId: task.id,
    unitIds: [],
  }
}

/** What closing a task drops: its load not yet picked up. The confirmation's text names the task. */
export const closeDropText = (rules: BoardRules, task: BoardTask): string | null =>
  total(task.loads) === 0 ? null : `${loadText(rules, task.loads)} dropped`

