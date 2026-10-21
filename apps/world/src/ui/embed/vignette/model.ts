// What the vignette renderer reads from World's display routes (architecture
// A6: compileVignette and sampleVignette). STAND-IN, kept equal to p2-core's
// features/displays/compose/model.ts until A2 merges; then this file goes.
// The view is compiled once when a vignette opens; samples follow every
// second. Both come from declarations and observation reads only: the
// renderer adds no number, limit or colour. Every section keeps to the rows
// the composer allotted it (VIGNETTE_ROW_PX each), so a frame of fixed height
// shows it whole.
import type { AlertState, Priority } from '../../../core/model/alerts.ts'
import type { Observable, Observation } from '../../../core/observation/model.ts'
import type { TopologyGraph, TopologyNode } from '../../../core/observation/topology.ts'
import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
import type { TopologyLayout } from '../../../features/displays/topology/layout.ts'

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
  /** Objects as a table: the core slots present, rows in the sample (sorted and capped by the composer). */
  | { readonly kind: 'entity'; readonly rows: number; readonly columns: ReadonlyArray<EntityColumn>; readonly near?: { readonly label: string } }
  /** One object's core slots and telemetry, each on a row. */
  | { readonly kind: 'slots'; readonly rows: number; readonly objectId: string; readonly slots: ReadonlyArray<{ readonly key: string; readonly label: string; readonly unit: string }> }
  | { readonly kind: 'map'; readonly rows: number }
  | {
    readonly kind: 'topology'; readonly rows: number; readonly family: TopologyGraph['family']
    /** In grid units (one grid unit is one row); stops are nodes `s<n>` with edges `s<n>.edge`. */
    readonly layout: TopologyLayout
    readonly nodes: ReadonlyArray<{ readonly id: string; readonly class: TopologyNode['class'] | 'stop'; readonly label: string; readonly shortLabel?: string; readonly bindings: ReadonlyArray<TopologyBinding> }>
    readonly edges: ReadonlyArray<{ readonly id: string; readonly mediumKind: TopologyGraph['media'][number]['kind']; readonly bindings: ReadonlyArray<TopologyBinding> }>
    readonly groups: ReadonlyArray<{ readonly id: string; readonly label: string }>
    readonly attribution?: string
  }

/** A binding with its observable's declared unit, so a drawing writes the reading as the card does. */
export type TopologyBinding = TopologyNode['bindings'][number] & { readonly unit: string }

export type EntityColumn = 'status' | 'urgency' | 'alert' | 'eta' | 'distance' | 'age'

type Stamp = { readonly at: string; readonly clock: 'simulation' | 'wall' }

export interface EntityRow {
  readonly objectId: string
  readonly label: string
  readonly closed?: true
  readonly status?: { readonly word: string; readonly since?: Stamp }
  readonly urgency?: string
  readonly alert?: { readonly priority: Priority | null; readonly severity: AlertState['severity']; readonly message: string }
  readonly etaS?: number
  readonly distanceM?: number
  readonly ageS?: number
}

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
  /** By section index: an entity section's rows and how many more there are. */
  readonly entities?: Readonly<Record<number, { readonly rows: ReadonlyArray<EntityRow>; readonly more: number }>>
  /** By object id: a slots section's values. */
  readonly slots?: Readonly<Record<string, Readonly<Record<string, { readonly value: number | string | boolean | null; readonly since?: Stamp }>>>>
  /** By section index: what a map section frames ([west, south], [east, north]; null where nothing has a position). */
  readonly maps?: Readonly<Record<number, {
    readonly positioned: number; readonly missing: number; readonly within?: string; readonly around?: string
    readonly bounds: readonly [readonly [number, number], readonly [number, number]] | null
  }>>
}
