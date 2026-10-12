import type { IsoTimestamp, SimulationClockState } from '../core/model/index.ts'
import { simulationTimeAt } from './simulation-clock.ts'
import type { RunExecutionState } from './types.ts'

/**
 * The clock an execution read gives the view. At maximum pace the Run clock
 * moves in exact slices that publish no clock event each, so the view holds
 * each read's time, paused, until the next read; when a maximum-pace execution
 * stops, the Run publishes the clock it stopped at. At realtime pace the Run's
 * clock events alone carry the view's clock.
 */
export const executionClockReading = (
  execution: Pick<RunExecutionState, 'pace' | 'currentSimulationTime' | 'updatedAt'>,
): SimulationClockState | undefined =>
  execution.pace === 'maximum'
    ? { currentTime: execution.currentSimulationTime as IsoTimestamp, paused: true, updatedAt: execution.updatedAt as IsoTimestamp }
    : undefined

/**
 * The World view's clock: the Run's simulated time of day, which is the
 * scenario's start time plus the Run time. It reads the one Run clock the view
 * already holds; between clock updates it advances with wall time while the
 * Run plays and stands still while it is paused. Like every simulation clock
 * surface, the Host's Run controls included, it shows labelled UTC.
 */
export interface WorldClockView {
  /** e.g. "14:32:05 UTC" */
  readonly time: string
  /** The Run is paused, not merely stepping at maximum pace. */
  readonly paused: boolean
  /** The simulated date and time, e.g. "2026-09-03 14:32:05 UTC", for a tooltip. */
  readonly dateTime: string
}

export interface WorldClockInput {
  readonly clock: SimulationClockState | undefined
  /**
   * The Run's last execution read, if any. While it plays at maximum pace the
   * view holds a paused clock reading that steps with each read; that Run is
   * not paused.
   */
  readonly execution: Pick<RunExecutionState, 'playback' | 'pace'> | null
}

export const worldClockView = (input: WorldClockInput, wallTimeMs: number): WorldClockView | null => {
  const at = simulationTimeAt(input.clock, wallTimeMs)
  if (input.clock === undefined || at === undefined) return null
  const time = `${at.slice(11, 19)} UTC`
  return {
    time,
    paused: input.clock.paused && !(input.execution?.playback === 'playing' && input.execution.pace === 'maximum'),
    dateTime: `${at.slice(0, 10)} ${time}`,
  }
}
