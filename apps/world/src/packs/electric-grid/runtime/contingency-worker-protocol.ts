import type { ContingencySnapshot, ScreeningRecords } from './contingency-snapshot.ts'

/** One chunk of a screening: the kernel screens positions [start, end) of the snapshot into the records. */
export interface ContingencyTask {
  readonly id: number
  readonly snapshot: ContingencySnapshot
  readonly records: ScreeningRecords
  readonly start: number
  readonly end: number
}

export type ContingencyTaskReply =
  | { readonly id: number; readonly ok: true }
  | { readonly id: number; readonly ok: false; readonly message: string }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSharedInt32 = (value: unknown): value is Int32Array => value instanceof Int32Array && value.buffer instanceof SharedArrayBuffer

/** The id of a task message; a message without one cannot be answered and is a protocol fault. */
export const contingencyTaskId = (value: unknown): number => {
  if (!isRecord(value) || !Number.isSafeInteger(value.id)) throw new Error('N-1 worker task has no integer id')
  return value.id as number
}

/** A task as the worker receives it; anything else is a protocol fault named in the error. */
export const parseContingencyTask = (value: unknown): ContingencyTask => {
  const id = contingencyTaskId(value)
  const task = value as Readonly<Record<string, unknown>>
  if (!Number.isSafeInteger(task.start) || !Number.isSafeInteger(task.end)) throw new Error(`N-1 worker task ${id} has no integer range`)
  if (!isRecord(task.snapshot) || !isRecord(task.snapshot.contingencies) || !isRecord(task.records) || !isSharedInt32(task.records.integers)) {
    throw new Error(`N-1 worker task ${id} carries no shared snapshot and records`)
  }
  return value as ContingencyTask
}

/** A worker's reply as the pool receives it, or null when the message is no reply. */
export const parseContingencyTaskReply = (value: unknown): ContingencyTaskReply | null => {
  if (!isRecord(value) || !Number.isSafeInteger(value.id)) return null
  if (value.ok === true) return { id: value.id as number, ok: true }
  if (value.ok === false && typeof value.message === 'string') return { id: value.id as number, ok: false, message: value.message }
  return null
}
