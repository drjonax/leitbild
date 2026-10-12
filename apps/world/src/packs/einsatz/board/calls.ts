import type { GeoJsonPoint } from '../../../core/model/index.ts'
import type { EinsatzCommandId, einsatzQueryIds } from '../capabilities.ts'
import type { Recommendation } from '../recommendation-schema.ts'
import type { BoardRecords, BoardTask, BoardUnit } from './records.ts'
import { loadShareOf, type BoardRules } from './rules.ts'
import { joinUnits, loadText, word } from './text.ts'
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
  /** "Send A3 + A5 → C-12", in the configuration's words. */
  readonly text: string
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
  const parts = [
    ...(plain.length > 0 ? [`${word(rules, 'send')} ${joinUnits(plain.map(unit => unit.label))}`] : []),
    ...diverted.map(unit => `${plain.length > 0 ? 'divert' : 'Divert'} ${unit.label} from ${divertFromText(unit.divertFrom!)}`),
  ]
  return {
    capabilityId: boardCommandIds.send,
    input: {
      units: units.map(unit => unit.unitId),
      to: { taskId: task.id },
      ...(diverted.length === 0 ? {} : { divert: diverted.map(unit => ({ unitId: unit.unitId, fromTaskId: unit.divertFrom!.taskId })) }),
    },
    text: `${parts.join(' + ')} → ${task.label}`,
    origin,
    taskId: task.id,
    unitIds: units.map(unit => unit.unitId),
  }
}

/** Where a send takes a unit, as `world.einsatz.unit.send` names it: a task, a receiving site or a point (a move). */
export type SendTarget = { readonly taskId: string } | { readonly siteId: string } | { readonly point: GeoJsonPoint }

const targetLabel = (records: BoardRecords, target: SendTarget): string => {
  const label = 'taskId' in target ? records.tasks.get(target.taskId)?.label : 'siteId' in target ? records.units.get(target.siteId)?.label : 'the map point'
  if (label === undefined) throw new Error('A map target outside the picture')
  return label
}

/** A unit sent by a map click: to a task, a site or a point. A committed unit is released from its task in the same send. */
export const sendFromMap = (rules: BoardRules, records: BoardRecords, unit: BoardUnit, target: SendTarget): CallDraft => {
  const divert = unit.taskId === undefined ? undefined : [{ unitId: unit.id, fromTaskId: unit.taskId }]
  const verb = 'taskId' in target ? (divert === undefined ? word(rules, 'send') : 'Divert') : 'Move'
  return {
    capabilityId: boardCommandIds.send,
    input: { units: [unit.id], to: target, ...(divert === undefined ? {} : { divert }) },
    text: `${verb} ${unit.label} → ${targetLabel(records, target)}`,
    origin: 'map',
    ...('taskId' in target ? { taskId: target.taskId } : {}),
    unitIds: [unit.id],
  }
}

/** Recall a unit: always naming the task it leaves, so a unit re-tasked meanwhile is refused rather than pulled off its new task. */
export const recallCall = (unit: BoardUnit): CallDraft => ({
  capabilityId: boardCommandIds.recall,
  input: { unitId: unit.id, ...(unit.taskId === undefined ? {} : { fromTaskId: unit.taskId }) },
  text: `Recall ${unit.label}`,
  origin: 'unit-board',
  unitIds: [unit.id],
})

export const holdCall = (rules: BoardRules, unit: BoardUnit): CallDraft => ({
  capabilityId: boardCommandIds.hold,
  input: { unitId: unit.id },
  text: `${word(rules, 'hold')} ${unit.label}`,
  origin: 'unit-board',
  unitIds: [unit.id],
})

export const closeCall = (task: BoardTask, origin: CallOrigin): CallDraft => ({
  capabilityId: boardCommandIds.taskClose,
  input: { taskId: task.id },
  text: `Close ${task.label}`,
  origin,
  taskId: task.id,
  unitIds: [],
})

/** What closing a task drops: its load not yet picked up. */
export const closeDropText = (rules: BoardRules, task: BoardTask): string | null =>
  total(task.loads) === 0 ? null : `${task.label} · ${loadText(rules, task.loads)} dropped`
