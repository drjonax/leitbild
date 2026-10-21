import { recordingSeriesIdFor, type SimulationRunId } from '../../../core/model/index.ts'
import { appendPoint, HOLD_GAP_MS, type TrendPoint } from './plant-card-sparkline.ts'
import type { PlantCardEnergy } from './plant-card.ts'

/**
 * The energy lines on a Plant's card: each rate's last ten minutes of Run
 * time. A line begins with what the Run's historian recorded, read once when
 * the card opens on the unit, and continues with the readings the Plant's
 * projection brings. Where the historian holds nothing in the window (the
 * rate is not recorded, nothing is recorded yet, or the history cannot be
 * read) there is no line: one begun when the card opened would read as ten
 * steady minutes.
 */

/** The Run time an energy line spans. */
export const PLANT_CARD_TREND_MS = 10 * 60_000

export type PlantCardHistory = (
  runId: SimulationRunId,
  seriesId: string,
  window: { readonly from: number; readonly to: number },
) => Promise<ReadonlyArray<TrendPoint>>

export type PlantCardLine =
  | { readonly kind: 'reading' }
  | { readonly kind: 'line'; readonly points: ReadonlyArray<TrendPoint> }
  /** Why it has no line, for its tooltip. */
  | { readonly kind: 'none'; readonly reason: string }

export interface PlantCardTrends {
  /** The card shows this unit's readings now: a new unit or Run reads its history, the same one extends its lines. */
  readonly show: (unit: {
    readonly runId: SimulationRunId | null
    readonly objectId: string
    readonly energy: ReadonlyArray<PlantCardEnergy>
  }) => void
  /** Each energy path's line, as it stands. */
  readonly lines: () => ReadonlyMap<string, PlantCardLine>
  readonly subscribe: (listener: () => void) => () => void
  /** The card closed: what is still being read is dropped. */
  readonly close: () => void
}

interface Reading {
  readonly kind: 'reading'
  /** Readings the projection brought while the history was read. */
  readonly since: ReadonlyArray<TrendPoint>
}

type Line = Reading | Exclude<PlantCardLine, { readonly kind: 'reading' }>

const extended = (points: ReadonlyArray<TrendPoint>, point: TrendPoint): ReadonlyArray<TrendPoint> =>
  appendPoint(points, point, point.t - PLANT_CARD_TREND_MS)

export const createPlantCardTrends = (config: { readonly history: PlantCardHistory }): PlantCardTrends => {
  const listeners = new Set<() => void>()
  // The Run and unit shown, as one key; undefined before the first and after close.
  let shown: string | undefined
  // Each history read answers only the unit it was asked for.
  let generation = 0
  let lines = new Map<string, Line>()

  const changed = (): void => {
    for (const listener of listeners) listener()
  }

  const set = (path: string, line: Line): void => {
    lines = new Map(lines).set(path, line)
  }

  const read = (runId: SimulationRunId, objectId: string, energy: ReadonlyArray<PlantCardEnergy>): void => {
    const asked = ++generation
    lines = new Map()
    for (const reading of energy) {
      if (reading.point === null) {
        set(reading.path, { kind: 'none', reason: 'It reads no number now, so its history was not read' })
        continue
      }
      const now = reading.point.t
      set(reading.path, { kind: 'reading', since: [reading.point] })
      // From one hold before the window, so the value held at its start is known.
      config.history(runId, recordingSeriesIdFor(objectId, reading.path), { from: now - PLANT_CARD_TREND_MS - HOLD_GAP_MS, to: now })
        .then(recorded => {
          if (asked !== generation) return
          const line = lines.get(reading.path)
          const since = line?.kind === 'reading' ? line.since : []
          if (recorded.length === 0) {
            set(reading.path, { kind: 'none', reason: 'The Run\'s historian holds none of its readings from the last 10 min' })
          } else {
            const last = recorded.at(-1)!.t
            set(reading.path, { kind: 'line', points: since.filter(point => point.t > last).reduce(extended, recorded) })
          }
          changed()
        }, (error: unknown) => {
          if (asked !== generation) return
          set(reading.path, { kind: 'none', reason: `Its history could not be read: ${error instanceof Error ? error.message : String(error)}` })
          changed()
        })
    }
  }

  return {
    show: ({ runId, objectId, energy }) => {
      const unit = `${runId ?? ''}\u0000${objectId}`
      // Run time that goes back (a restarted Run) begins the lines again from its history.
      const wentBack = energy.some(reading => {
        const line = lines.get(reading.path)
        const last = line?.kind === 'line' ? line.points.at(-1) : line?.kind === 'reading' ? line.since.at(-1) : undefined
        return reading.point !== null && last !== undefined && reading.point.t < last.t
      })
      if (unit !== shown || wentBack) {
        shown = unit
        if (runId === null) {
          generation += 1
          lines = new Map(energy.map(reading => [reading.path, { kind: 'none', reason: 'No Run is joined' }]))
        } else {
          read(runId, objectId, energy)
        }
        changed()
        return
      }
      let grew = false
      for (const reading of energy) {
        const line = lines.get(reading.path)
        const point = reading.point
        if (point === null || line === undefined || line.kind === 'none') continue
        const points = line.kind === 'line' ? line.points : line.since
        if (points.length > 0 && point.t <= points.at(-1)!.t) continue
        set(reading.path, line.kind === 'line' ? { kind: 'line', points: extended(points, point) } : { kind: 'reading', since: [...points, point] })
        grew = true
      }
      if (grew) changed()
    },
    lines: () => new Map([...lines].map(([path, line]) => [path, line.kind === 'reading' ? { kind: 'reading' } : line])),
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: () => {
      generation += 1
      shown = undefined
      lines = new Map()
      listeners.clear()
    },
  }
}
