// A set trend's pens as trend strip pens: each member the sample names, read
// as its quantity's declaration on the set's model says (its limits shared by
// the strip), its label the unit's then the quantity's.
import type { SetColumn, SetPen, VignetteValue } from '../../../features/displays/compose/model.ts'

export const setPenValues = (column: SetColumn, pens: ReadonlyArray<SetPen>): ReadonlyArray<VignetteValue> => {
  const declared = column.observable
  if (declared?.intervalMs === undefined) return []
  const { quantity, unit, valueType, thresholds, states, decades, intervalMs } = declared
  return pens.map(pen => ({
    ref: pen.ref, label: `${pen.label} · ${column.label}`.slice(0, 80), quantity, unit, valueType, thresholds,
    ...(states === undefined ? {} : { states }), ...(decades === true ? { decades } : {}), series: { seriesId: pen.seriesId, intervalMs },
  }))
}

/** The plot rows each strip of a set trend takes: its share of the section's rows, the axis row aside. */
export const setStripRows = (rows: number, strips: number): number => Math.max(3, Math.floor((rows - 1) / Math.max(1, strips)))
