import { priorityLevels, type AlertState, type Priority } from '../../../core/model/alerts.ts'
import type { ObjectId } from '../../../core/model/ids.ts'
import type { OperationalObject } from '../../../core/model/object.ts'
import type { IsoTimestamp } from '../../../core/model/time.ts'

// The alert read model (plan v3.1 §2.2, §2.7; architecture A6): pure over the
// core alert slot, so the main app, the server and later the embed read alerts
// alike. It imports no Pack. Words for objects come from presentation; a
// group's heading is its object's label, never a raw id (R21, R32: group
// words come in P2).

export type AlertRowState = 'active-unack' | 'active-ack' | 'returned-unack'

export interface AlertRow {
  /** objectId|alertId */
  readonly key: string
  readonly objectId: ObjectId
  readonly objectLabel: string
  readonly packId: string
  readonly categoryId: string
  readonly group: { readonly objectId: ObjectId; readonly subjectGroup?: string }
  /** Unmodified, facets included. */
  readonly alert: AlertState
  /** null: "priority not declared"; nothing derives one from `severity` (R1). */
  readonly priority: Priority | null
  readonly state: AlertRowState
  /** null where the record names no clock: "time unknown". */
  readonly raised: { readonly at: IsoTimestamp; readonly clock: 'simulation' | 'wall' } | null
}

export type AlertObject = Pick<OperationalObject, 'id' | 'packId' | 'lifecycle' | 'alerts'>

export interface AlertPresentation {
  readonly label: string
  readonly categoryId: string
}

/** Returned to normal and acknowledged is no longer an alert; a Pack removes such a record. */
const rowState = (alert: AlertState): AlertRowState | null =>
  alert.returned === true ? (alert.acknowledged ? null : 'returned-unack') : alert.acknowledged ? 'active-ack' : 'active-unack'

/** Every alert of the objects still open (resolved and removed objects are closed, V18), in Run object order, then each object's own order. */
export const alertRows = <T extends AlertObject>(objects: ReadonlyArray<T>, present: (object: T) => AlertPresentation): ReadonlyArray<AlertRow> =>
  objects.filter(object => object.alerts.length > 0 && object.lifecycle !== 'resolved' && object.lifecycle !== 'removed').flatMap(object => {
    const presented = present(object)
    return object.alerts.flatMap((alert): ReadonlyArray<AlertRow> => {
      const state = rowState(alert)
      if (state === null) return []
      const subjectGroup = alert.subject !== undefined && 'group' in alert.subject ? alert.subject.group : undefined
      return [{
        key: `${object.id}|${alert.id}`,
        objectId: object.id,
        objectLabel: presented.label,
        packId: object.packId,
        categoryId: presented.categoryId,
        group: subjectGroup === undefined ? { objectId: object.id } : { objectId: object.id, subjectGroup },
        alert,
        priority: alert.priority ?? null,
        state,
        raised: alert.clock === undefined ? null : { at: alert.raisedAt, clock: alert.clock },
      }]
    })
  })

export const groupKey = (row: AlertRow): string => row.group.subjectGroup === undefined ? row.group.objectId : `${row.group.objectId}|${row.group.subjectGroup}`

/** Undeclared lowest: no rule ranks an alert by its `severity` (R1). */
export const priorityRank = (priority: Priority | null): number => priority === null ? -1 : priorityLevels.indexOf(priority)

/** Simulation time in ms; a wall or absent clock cannot be placed on the Run's axis. */
export const simulationMs = (row: AlertRow): number | null => row.raised?.clock === 'simulation' ? Date.parse(row.raised.at) : null

/** Standing alarms and advisories never ask for attention (R43): they never count as unacknowledged nor hold a row. */
export const asksAttention = (row: AlertRow): boolean => row.alert.standing !== true && row.alert.advisory !== true

/** Worst first (R12): what asks no attention last, then by priority, then the latest raised, unknown times after known ones. */
export const worstFirst = (left: AlertRow, right: AlertRow): number =>
  Number(!asksAttention(left)) - Number(!asksAttention(right))
  || priorityRank(right.priority) - priorityRank(left.priority)
  || (simulationMs(right) ?? -Infinity) - (simulationMs(left) ?? -Infinity)
  || left.key.localeCompare(right.key)

export const stateWords = (row: AlertRow): string =>
  row.state === 'active-unack' ? 'unacknowledged'
    : row.state === 'returned-unack' ? 'returned · unacknowledged'
      : row.alert.acknowledgedBy === 'ai' ? 'acknowledged by Assistant'
        : row.alert.acknowledgedBy === 'system' ? 'acknowledged by system' : 'acknowledged'

export const raisedWords = (row: AlertRow, simulationTime: (at: IsoTimestamp) => string): string =>
  row.raised?.clock === 'simulation' ? simulationTime(row.raised.at) : 'time unknown'
