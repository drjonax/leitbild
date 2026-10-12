import { MISMATCH_FRACTION } from '../../../../packs/process-plant/displays/mimic/evaluate.ts'
import type { MimicRow } from '../../../../packs/process-plant/displays/mimic/rows.ts'
import type { TrendPoint } from '../../../../packs/process-plant/displays/trend-reading.ts'
import { stepPath } from '../trend-geometry.ts'

// What a drawing's vessels show of their readings over the last minutes
// (MimicItemTrend), from the history its display keeps. Each is drawn as the
// Run recorded it: held values held, broken where nothing was recorded, and
// starting where its history starts; the window is always the whole width.

/**
 * A tank's fill trace (MimicItemTrend `fill`): its level over the window as
 * a line on its fill's own scale, across the cell OpenBridge draws the fill
 * in, so its right end meets the fill. A steady level is a flat line on the
 * fill's surface.
 */
export const fillTracePath = (
  points: ReadonlyArray<TrendPoint>,
  now: number,
  windowMs: number,
  cell: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  max: number,
): string => {
  const start = now - windowMs
  const readings = points.filter(point => Number.isFinite(point.v) && point.t <= now)
  return stepPath(readings, t => cell.x + ((t - start) / windowMs) * cell.width, v => cell.y + (1 - Math.min(1, Math.max(0, v / max))) * cell.height, { start, end: now })
}

/**
 * Where a tank marks the program its level is held to (a pressurizer's
 * level program): only while its level, in percent, stands off it by more
 * than a command may stand off what follows it (MISMATCH_FRACTION of the
 * span); null otherwise, or where either is not known. The actual level
 * first, the reference only on a mismatch.
 */
export const programMark = (level: number | null, program: number | null): number | null =>
  level === null || program === null || Math.abs(level - program) <= MISMATCH_FRACTION * 100 ? null : program

/**
 * Which reading a heat exchanger's level strip draws (MimicItemTrend
 * `strip`): the one its level row reads now, the wider instrument while the
 * row reads it (WR), else its own.
 */
export const stripReading = (row: MimicRow | undefined, readsWider: boolean): string | null =>
  row?.kind !== 'value' ? null : readsWider && row.wider !== undefined ? row.wider.path : row.path
