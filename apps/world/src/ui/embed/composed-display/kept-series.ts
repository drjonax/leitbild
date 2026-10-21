import { HOLD_GAP_MS, type TrendPoint } from '../../../packs/process-plant/displays/trend-reading.ts'

/** One recorded series a display shows, as one sample found it. */
export interface ShownSeries {
  readonly seriesId: string
  /** The widest window a pen draws it over. */
  readonly horizonMs: number
  /** How far before now its first read starts: a sparkline's one hold gap before its window, so the value held at the window's start is known. */
  readonly leadMs: number
  /** Its value in the sample, where the sample carried a number. */
  readonly value: number | undefined
}

export interface ReadWindow {
  readonly from: number
  readonly to: number
}

export type ReadSeries = (seriesId: string, window: ReadWindow) => Promise<ReadonlyArray<TrendPoint>>

/** A read that failed: its series and why. */
export interface ReadFailure {
  readonly seriesId: string
  readonly message: string
}

export interface KeptView {
  readonly points: ReadonlyArray<TrendPoint>
  /** A read of its window found nothing recorded: it is drawn from the live samples only. */
  readonly missing: boolean
  /** Why its last read failed, until a read lands. */
  readonly error: string | undefined
}

interface Kept {
  points: ReadonlyArray<TrendPoint>
  /** The Run time span every recorded point of which is kept; null until a read lands. */
  covered: { readonly from: number; readonly through: number } | null
  /** The Run times of the first and last live sample taken one after another, without a miss, that showed it. */
  liveFrom: number
  liveTo: number
  horizonMs: number
  leadMs: number
  missing: boolean
  /** A failed read is tried again once its live samples start again (a miss, or shown again) or a display opens with it. */
  error: { readonly message: string; readonly liveFrom: number } | null
  reading: boolean
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The points from `start` on, oldest first; the same array where none is older. */
const since = (points: ReadonlyArray<TrendPoint>, start: number): ReadonlyArray<TrendPoint> => {
  if (points.length === 0 || points[0]!.t >= start) return points
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (points[middle]!.t < start) low = middle + 1
    else high = middle
  }
  return points.slice(low)
}

/**
 * The history a display session keeps of each recorded series it shows,
 * across the displays it shows: opening another display, Back, or a frame
 * shown again reads only what the Run recorded since the newest point kept,
 * never the whole window again.
 *
 * Live samples taken one after another extend a series as the Run's record
 * would, as they always did between reads; a missed sample (a slow World, a
 * hidden or suspended frame) or a series no longer shown ends that run, and
 * what the Run recorded from there to the next sample is read. A series
 * keeps the widest window it was shown in plus one hold gap, and is dropped
 * once its newest point leaves that window, so what is kept stays bounded.
 */
export const createKeptSeries = (read: ReadSeries) => {
  const kept = new Map<string, Kept>()
  // The Run times of the last two samples taken: a series' live run carries on only from the sample just before.
  let lastAt: number | undefined
  let previousAt: number | undefined
  // What was recorded before the Run's clock went backwards belongs to its earlier timeline: no read reaches before it.
  let resetAt = Number.NEGATIVE_INFINITY
  // A read that lands after a reset belongs to the earlier timeline and is dropped.
  let generation = 0

  const observe = (series: ShownSeries, at: number, missed: boolean): Kept => {
    const entry = kept.get(series.seriesId)
    if (entry === undefined) {
      const created: Kept = {
        points: series.value === undefined ? [] : [{ t: at, v: series.value }],
        covered: null, liveFrom: at, liveTo: at, horizonMs: series.horizonMs, leadMs: series.leadMs, missing: false, error: null, reading: false,
      }
      kept.set(series.seriesId, created)
      return created
    }
    entry.horizonMs = Math.max(entry.horizonMs, series.horizonMs)
    entry.leadMs = Math.max(entry.leadMs, series.leadMs)
    // A sample taken again (the one a display opened or was drawn again with) adds nothing.
    if (at <= entry.liveTo) return entry
    if (missed || entry.liveTo !== previousAt) entry.liveFrom = at
    entry.liveTo = at
    if (series.value !== undefined) entry.points = [...entry.points.filter(point => point.t < at), { t: at, v: series.value }]
    if (entry.covered !== null && entry.covered.through >= entry.liveFrom) entry.covered = { from: entry.covered.from, through: at }
    return entry
  }

  const trim = (at: number): void => {
    for (const [seriesId, entry] of kept) {
      const start = at - entry.horizonMs - HOLD_GAP_MS
      if (Math.max(entry.liveTo, entry.covered?.through ?? Number.NEGATIVE_INFINITY) < start) {
        kept.delete(seriesId)
        continue
      }
      entry.points = since(entry.points, start)
      if (entry.covered !== null && entry.covered.from < start) entry.covered = entry.covered.through < start ? null : { from: start, through: entry.covered.through }
    }
  }

  /** What a series still needs read up to `at`: from the newest record it keeps where that reaches its window, else its whole window; null where it keeps it all. */
  const windowOf = (entry: Kept, at: number): ReadWindow | null => {
    const start = Math.max(at - entry.leadMs, resetAt)
    const covered = entry.covered
    const reaches = covered !== null && covered.from <= start && covered.through >= start
    if (reaches && covered.through >= entry.liveFrom) return null
    return { from: reaches ? covered.through : start, to: at }
  }

  const merge = (entry: Kept, window: ReadWindow, read: ReadonlyArray<TrendPoint>): void => {
    const points = read.filter(point => point.t >= window.from && point.t <= window.to)
    const newest = points.at(-1)?.t
    // What the Run recorded replaces what the live samples left in the span it read; live samples newer than its newest record stay.
    if (newest !== undefined) entry.points = [...entry.points.filter(point => point.t < window.from), ...points, ...entry.points.filter(point => point.t > newest)]
    const covered = entry.covered
    const extending = covered !== null && covered.from <= window.from && covered.through >= window.from
    const through = extending ? Math.max(covered.through, window.to) : window.to
    entry.covered = { from: extending ? covered.from : window.from, through: through >= entry.liveFrom ? Math.max(through, entry.liveTo) : through }
    // A window with nothing recorded draws from the live samples only; a gap with nothing recorded says nothing about the window.
    if (points.length > 0) entry.missing = false
    else if (!extending) entry.missing = true
    entry.error = null
  }

  const readInto = async (seriesId: string, entry: Kept, window: ReadWindow): Promise<ReadFailure | null> => {
    entry.reading = true
    const readFor = generation
    const liveFrom = entry.liveFrom
    const current = (): boolean => readFor === generation && kept.get(seriesId) === entry
    try {
      const points = await read(seriesId, window)
      if (current()) merge(entry, window, points)
      return null
    } catch (error) {
      if (!current()) return null
      const message = messageOf(error)
      entry.error = { message, liveFrom }
      return { seriesId, message }
    } finally {
      entry.reading = false
    }
  }

  return {
    /**
     * Takes one sample of the series a display shows, at Run time `at`, and
     * starts a read for each whose kept record does not reach its live
     * samples. `missed`: samples were missed before this one, so it starts
     * every live run again. `retry`: a series whose read failed in this live
     * run is read again (a display opens with it). Each read resolves once it
     * landed, to its failure or null, and never rejects.
     */
    take: (at: number, shown: ReadonlyArray<ShownSeries>, options: { readonly missed: boolean; readonly retry: boolean }): ReadonlyArray<Promise<ReadFailure | null>> => {
      if (at !== lastAt) {
        previousAt = lastAt
        lastAt = at
      }
      for (const series of shown) observe(series, at, options.missed)
      trim(at)
      return shown.flatMap(series => {
        const entry = kept.get(series.seriesId)!
        if (entry.reading || (!options.retry && entry.error !== null && entry.error.liveFrom === entry.liveFrom)) return []
        const window = windowOf(entry, at)
        if (window === null) return []
        // Just after a reset nothing can have been recorded yet: its record starts here.
        if (window.from >= window.to) {
          entry.covered = { from: window.from, through: entry.liveTo }
          return []
        }
        return [readInto(series.seriesId, entry, window)]
      })
    },
    /** The Run's clock went backwards: nothing kept belongs to its timeline any more. */
    reset: (at: number): void => {
      kept.clear()
      generation += 1
      resetAt = at
      lastAt = undefined
      previousAt = undefined
    },
    /** What is kept of a series from `start` on (or all of it); undefined where no display showed it. */
    view: (seriesId: string, start: number | undefined): KeptView | undefined => {
      const entry = kept.get(seriesId)
      if (entry === undefined) return undefined
      return { points: start === undefined ? entry.points : since(entry.points, start), missing: entry.missing, error: entry.error?.message }
    },
  }
}
