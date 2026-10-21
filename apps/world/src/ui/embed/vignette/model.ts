// What the vignette renderer reads from World's display routes (architecture
// A6: compileVignette and sampleVignette). STAND-IN, kept equal to p2-core's
// features/displays/compose/model.ts until A2 merges; then this file goes.
// The view is compiled once when a vignette opens; samples follow every
// second. Both come from declarations and observation reads only: the
// renderer adds no number, limit or colour. Every section keeps to the rows
// the composer allotted it (VIGNETTE_ROW_PX each), so a frame of fixed height
// shows it whole.
import type { Observable, Observation } from '../../../core/observation/model.ts'
import type { AlertRow } from '../../../features/displays/alerts/rows.ts'

/** A declared element an observable is measured on. */
export interface VignetteElement {
  readonly id: string
  readonly class: string
  readonly label: string
  readonly shortLabel?: string
  readonly group?: string
}

/** A declared observable as a vignette names it: its label qualified with its object's ("<object> · <observable>", R25). */
export type VignetteValue = Pick<Observable, 'ref' | 'quantity' | 'unit' | 'valueType' | 'states' | 'thresholds' | 'series'> & {
  readonly label: string
  readonly element?: VignetteElement
}

export type VignetteSection =
  | { readonly kind: 'values'; readonly rows: number; readonly values: ReadonlyArray<VignetteValue> }
  /** Parallel values (one class and quantity on elements in different groups), grouped by the composer: a column per quantity, a line per element. */
  | {
    readonly kind: 'grouped'; readonly rows: number
    readonly quantities: ReadonlyArray<{ readonly label: string; readonly unit: string }>
    readonly lines: ReadonlyArray<{ readonly element: VignetteElement; readonly values: ReadonlyArray<VignetteValue | null> }>
  }
  /** Pens drawn together share a strip; at most four strips. */
  | { readonly kind: 'trend'; readonly rows: number; readonly horizonMs: number; readonly strips: ReadonlyArray<ReadonlyArray<VignetteValue>> }
  | { readonly kind: 'alerts'; readonly rows: number; readonly objectIds: ReadonlyArray<string> | 'run' }

export interface VignetteView {
  readonly title: string
  /** Set where the Assistant composed the vignette; absent for a World default. */
  readonly by?: 'assistant'
  readonly sections: ReadonlyArray<VignetteSection>
}

/** A recorded point: Run time in epoch ms and the value then. */
export interface SeriesPoint {
  readonly t: number
  readonly v: number
}

export interface VignetteSample {
  /** The Run's time the sample was read at, and whether its clock is paused. */
  readonly at: { readonly at: string; readonly clock: 'simulation'; readonly paused: boolean }
  readonly observations: ReadonlyArray<Observation>
  /** The alert rows of every alerts section's objects, in any order. */
  readonly alerts: ReadonlyArray<AlertRow>
  /** Only when history was asked for: each trend pen's recorded points from then until the sample, by series id. */
  readonly series?: Readonly<Record<string, ReadonlyArray<SeriesPoint>>>
}
