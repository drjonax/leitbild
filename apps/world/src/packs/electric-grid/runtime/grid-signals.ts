import type { GridRuntimeInstance } from './instance.ts'

/**
 * A discrete Grid event for the Simulation Run journal: an alarm transition or a protection trip.
 * The runtime queues it; the adapter drains the queue after every advance or command and emits it
 * as an interaction signal.
 */
export interface GridRuntimeSignal {
  /** Signal type, for example electric-grid.alarm.raised. */
  readonly type: string
  readonly severity: 'info' | 'notice' | 'warning' | 'critical'
  /** Unique within the Grid: the signal id derives from it. */
  readonly key: string
  readonly payload: Readonly<Record<string, unknown>>
}

export const queueGridSignal = (grid: GridRuntimeInstance, signal: GridRuntimeSignal): void => {
  grid.signalQueue.push(signal)
}

/** Removes and returns the queued signals, oldest first. */
export const drainGridSignals = (grid: GridRuntimeInstance): ReadonlyArray<GridRuntimeSignal> => grid.signalQueue.splice(0)
