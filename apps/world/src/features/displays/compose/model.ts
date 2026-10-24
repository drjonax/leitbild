/**
 * A vignette as it travels and as it is drawn (architecture A5, A6). The
 * state is the resolved spec only: what each view reads, by ref or object
 * id, and the rows it was allotted; the routes derive every read from it and
 * read only that, as the caller. The view is compiled from declarations and
 * the sample from observation reads, so the renderer adds no number, limit,
 * colour or coordinate. Rows are units of the renderer's grid.
 */
import { z } from 'zod'
import type { AlertRow } from '../alerts/rows.ts'
import { observableRefSchema, type AlertSeverity, type Priority } from '../../../core/model/alerts.ts'
import { objectIdSchema } from '../../../core/model/ids.ts'
import type { ObservationDeclaration } from '../../../core/observation/capabilities.ts'
import type { Observable, Observation } from '../../../core/observation/model.ts'
import { distanceBandSchema } from '../../../core/observation/spec.ts'
import type { TopologyGraph, TopologyNode } from '../../../core/observation/topology.ts'
import type { TopologyLayout } from '../topology/layout.ts'

/** The most rows a vignette takes, its frame included (960 px). */
export const VIGNETTE_MAX_ROWS = 40
export const FRAME_ROWS = 2

const rows = z.number().int().min(1).max(VIGNETTE_MAX_ROWS)
const nodeIds = z.array(z.string().min(1).max(200)).min(1).max(16).optional()
const horizons = { '2m': 120_000, '10m': 600_000, '30m': 1_800_000 } as const
export const horizonMs = (horizon: keyof typeof horizons): number => horizons[horizon]

export const collectionSchema = z.object({
  packId: z.string().min(1).max(128), categoryId: z.string().min(1).max(128), group: z.string().min(1).max(128).optional(), status: z.array(z.string().min(1).max(80)).min(1).max(6).optional(),
  near: objectIdSchema.optional(), within: distanceBandSchema.optional(), closed: z.boolean(),
}).strict()

/** Units compared or trended together: a live collection, re-resolved each sample, or at most twelve named units. */
export const unitSetSchema = z.union([collectionSchema, z.object({ objectIds: z.array(objectIdSchema).min(1).max(12) }).strict()])
export type UnitSet = z.output<typeof unitSetSchema>
/** A quantity matched on each unit: its local ref (after `objectId#`), the same on every unit of one model, and its column's words. */
export const setSignalSchema = z.object({ ref: z.string().min(1).max(200), label: z.string().min(1).max(80) }).strict()
export type SetSignal = z.output<typeof setSignalSchema>

/**
 * A lead request: the values an object, or one of its elements, leads with as its Pack judges each sample (the Pack's
 * mode-aware lead read; an element's declared lead, its stop's first while it has been stopped). Never resolved refs:
 * each sample reads it again into the view's reserved rows, so a change of lead set never moves the layout.
 */
export const leadRequestSchema = z.object({ objectId: objectIdSchema, element: z.string().min(1).max(200).optional() }).strict()
export type LeadRequest = z.output<typeof leadRequestSchema>

export const resolvedViewSchema = z.discriminatedUnion('kind', [
  /** Named values (`refs`) first, then what a lead request leads with now, in the `rows` it reserves. */
  z.object({ kind: z.literal('values'), refs: z.array(observableRefSchema).min(1).max(16).optional(), lead: leadRequestSchema.optional(), rows }).strict()
    .refine(view => view.refs !== undefined || view.lead !== undefined, { message: 'a values view names refs or a lead request' }),
  z.object({ kind: z.literal('trend'), refs: z.array(observableRefSchema).min(1).max(12), horizon: z.enum(['2m', '10m', '30m']), rows }).strict(),
  /**
   * The objects' alerts, or only those on these elements or observables; `lead`: those first, then the objects' lead
   * alerts (leadsObject). `set`: the alerts of a collection's members (`of`) as they are each sample.
   */
  z.object({
    kind: z.literal('alerts'), objectIds: z.union([z.literal('run'), z.literal('set'), z.array(objectIdSchema).min(1).max(48)]), of: collectionSchema.optional(),
    elements: z.array(z.string().min(1).max(200)).min(1).max(8).optional(), refs: z.array(observableRefSchema).min(1).max(8).optional(), lead: z.literal(true).optional(), rows,
  }).strict().refine(view => (view.objectIds === 'set') === (view.of !== undefined), { message: 'a set alerts view names its collection, and only it does' }),
  /** One row per member from its Pack's member columns, worst first, under an aggregate header. */
  z.object({ kind: z.literal('fleet'), of: collectionSchema, rows }).strict(),
  /** Rows are units, columns these quantities; beyond its rows, the units at caution or above and the outliers, then a band row. */
  z.object({ kind: z.literal('compare'), of: unitSetSchema, signals: z.array(setSignalSchema).min(1).max(8), rows }).strict(),
  /** A strip per quantity: a pen per unit up to four, else a min–median–max band and at most three named units. */
  z.object({ kind: z.literal('set-trend'), of: unitSetSchema, signals: z.array(setSignalSchema).min(1).max(4), horizon: z.enum(['2m', '10m', '30m']), rows }).strict(),
  /** An entity-floor object's core slots. */
  z.object({ kind: z.literal('slots'), objectId: objectIdSchema, rows }).strict(),
  /** A table of these objects, or of a live collection's members. */
  z.object({ kind: z.literal('entity'), objectIds: z.array(objectIdSchema).min(1).max(48), rows }).strict(),
  z.object({ kind: z.literal('collection'), of: collectionSchema, rows }).strict(),
  z.object({
    kind: z.literal('topology'), objectId: objectIdSchema,
    /** `overview`: the object's declared overview; otherwise a scope by ends or around. */
    request: z.object({ overview: z.literal(true).optional(), from: nodeIds, to: nodeIds, around: nodeIds, media: nodeIds, groups: nodeIds, reach: z.number().int().min(1).max(4).optional() }).strict(),
    rows,
  }).strict(),
  /** These objects, or a collection's members, or every object within `within` of `around`. */
  z.object({
    kind: z.literal('map'), objectIds: z.array(objectIdSchema).min(1).max(48).optional(), of: collectionSchema.optional(),
    around: objectIdSchema.optional(), within: distanceBandSchema.optional(), rows,
  }).strict(),
])
export type ResolvedView = z.output<typeof resolvedViewSchema>
export type Collection = z.output<typeof collectionSchema>

export const vignetteStateSchema = z.object({
  title: z.string().min(1).max(80),
  /** The Assistant composed it; absent for a World default. */
  by: z.literal('assistant').optional(),
  /** When it was composed: a frozen card's time. */
  at: z.object({ at: z.string().datetime({ offset: true }), clock: z.enum(['simulation', 'wall']) }).strict(),
  /** A whole object's own states (safety-function statuses, an operating mode) in declared order: one row of chips under the title. */
  chips: z.array(observableRefSchema).min(1).max(8).optional(),
  /** A drawing taller than the stack leaves stands beside a column of the other views (a window frame, Q20). */
  beside: z.literal(true).optional(),
  views: z.array(resolvedViewSchema).min(1).max(4),
}).strict()
export type VignetteState = z.output<typeof vignetteStateSchema>

/** A declared element an observable is measured on, as a vignette names it: never what it leads with. */
export type VignetteElement = Omit<ObservationDeclaration['elements'][number], 'lead' | 'stopped'>

/** A declared observable as a vignette names it: its label qualified with its object's ("<object> · <observable>", R25). */
export type VignetteValue = Pick<Observable, 'ref' | 'quantity' | 'unit' | 'valueType' | 'states' | 'thresholds' | 'series' | 'decades'> & {
  readonly label: string
  readonly element?: VignetteElement
}

type Stamp = { readonly at: string; readonly clock: 'simulation' | 'wall' }

/** The core slots an entity table shows beside each object's label, in this order (when any row has one). */
export const ENTITY_COLUMNS = ['status', 'urgency', 'alert', 'eta', 'distance', 'age'] as const
export type EntityColumn = (typeof ENTITY_COLUMNS)[number]
/** `alert` is its worst; its `severity` only words a priority not declared, never colours. Distance is to the collection's `near`; age is the position fix's. */
export interface EntityRow {
  readonly objectId: string; readonly label: string; readonly closed?: true; readonly status?: { readonly word: string; readonly since?: Stamp }; readonly urgency?: string
  readonly alert?: { readonly priority: Priority | null; readonly severity: AlertSeverity; readonly message: string }; readonly etaS?: number; readonly distanceM?: number; readonly ageS?: number
}

/** One core slot or telemetry signal of an entity-floor object: World's word for it and its unit code ('' for words). */
export interface SlotDeclaration { readonly key: string; readonly label: string; readonly unit: string }

/** A binding the caller reads, with its observable's declared quantity, unit, states (a state marked `active` reads as on) and decades, so a drawing writes the reading as the card does. */
export type TopologyBinding = TopologyNode['bindings'][number] & Pick<Observable, 'quantity' | 'unit' | 'states' | 'decades'>
export interface TopologyNodeView extends Pick<TopologyNode, 'id' | 'label' | 'shortLabel' | 'element'> {
  /** A stop's label names its far ends (at most 24 characters). */
  readonly class: TopologyNode['class'] | 'stop'
  readonly bindings: ReadonlyArray<TopologyBinding>
}

export type VignetteSection =
  /** `lead`: the index of the state's view whose lead request it shows; its values now are the sample's `leads[lead]`. */
  | { readonly kind: 'values'; readonly rows: number; readonly values: ReadonlyArray<VignetteValue>; readonly lead?: number }
  /** Parallel values: one line per element, one column per quantity. */
  | { readonly kind: 'grouped'; readonly rows: number; readonly quantities: ReadonlyArray<{ readonly label: string; readonly unit: string }>; readonly lines: ReadonlyArray<{ readonly element: VignetteElement; readonly values: ReadonlyArray<VignetteValue | null> }> }
  /** Pens drawn together share a strip: at most four strips of at most four pens. */
  | { readonly kind: 'trend'; readonly rows: number; readonly horizonMs: number; readonly strips: ReadonlyArray<ReadonlyArray<VignetteValue>> }
  /** `set`: its objects are the sample's `sets[section].members`, as the set is now. */
  | { readonly kind: 'alerts'; readonly rows: number; readonly objectIds: ReadonlyArray<string> | 'run' | 'set'; readonly elements?: ReadonlyArray<string>; readonly refs?: ReadonlyArray<string>; readonly lead?: true }
  /** A row per member under an aggregate header; its rows are the sample's `sets[section]`. `group`: the group the set keeps. */
  | { readonly kind: 'fleet'; readonly rows: number; readonly label: string; readonly group?: { readonly label: string; readonly value: string }; readonly columns: ReadonlyArray<FleetColumn> }
  /** Rows are units, a column per quantity; its rows and band are the sample's `sets[section]`. */
  | { readonly kind: 'compare'; readonly rows: number; readonly label: string; readonly columns: ReadonlyArray<SetColumn> }
  /** A strip per quantity across a set; its pens and bands are the sample's `sets[section]`. */
  | { readonly kind: 'set-trend'; readonly rows: number; readonly label: string; readonly horizonMs: number; readonly strips: ReadonlyArray<SetColumn> }
  /** Its values are the sample's `slots[objectId]`. */
  | { readonly kind: 'slots'; readonly rows: number; readonly objectId: string; readonly slots: ReadonlyArray<SlotDeclaration> }
  /** Its rows are the sample's `entities[section]`. */
  | { readonly kind: 'entity'; readonly rows: number; readonly columns: ReadonlyArray<EntityColumn>; readonly near?: { readonly label: string } }
  /**
   * Layout ids: a graph node's or edge's id (a flow edge drawn in segments adds `.n`), a stop `s<n>` and its edge
   * `s<n>.edge`; every drawn node, stops included, is in `nodes`.
   */
  | {
    /** `packId` is the object's Pack: the pop-over loads that Pack's element actions. */
    readonly kind: 'topology'; readonly rows: number; readonly objectId: string; readonly packId: string; readonly family: 'flow' | 'network'; readonly layout: TopologyLayout
    readonly nodes: ReadonlyArray<TopologyNodeView>
    readonly edges: ReadonlyArray<{ readonly id: string; readonly mediumKind: TopologyGraph['media'][number]['kind']; readonly bindings: ReadonlyArray<TopologyBinding> }>
    readonly attribution?: string
  }
  /** Its counts are the sample's `maps[section]`. */
  | { readonly kind: 'map'; readonly rows: number }

/**
 * `chips`: the object's own states, one row under the title. `beside` (window vignettes only): the first flow topology
 * section stands on the left at its own width, every other section in a column to its right; rows count as the taller.
 */
export interface VignetteView {
  readonly title: string; readonly by?: 'assistant'; readonly chips?: ReadonlyArray<VignetteValue>; readonly beside?: true; readonly sections: ReadonlyArray<VignetteSection>
}

/** A recorded point: Run time in epoch ms and the value then. */
export interface SeriesPoint { readonly t: number; readonly v: number }
/** A series' recorded points, Run time ascending, and how long a reader holds each until the next: the Historian's hold (historian/policy.ts recordedHoldMs). */
export interface RecordedSeries { readonly holdMs: number; readonly points: ReadonlyArray<SeriesPoint> }

export interface VignetteSample {
  readonly at: Stamp & { readonly paused: boolean }
  readonly observations: ReadonlyArray<Observation>
  /** The rows of every alerts section, in each section's order (alertsOf), then those of each drawn topology's object (its frames), each row once. */
  readonly alerts: ReadonlyArray<AlertRow>
  /** By section index: an entity section's rows, sorted and capped, and how many more there are. */
  readonly entities: Readonly<Record<number, { readonly rows: ReadonlyArray<EntityRow>; readonly more: number }>>
  /** By object id: each slot's value now. */
  readonly slots: Readonly<Record<string, Readonly<Record<string, { readonly value: number | string | boolean | null; readonly since?: Stamp }>>>>
  /** By section index: what a map section frames; "Show on map" frames the live map on `bounds` ([[west, south], [east, north]]). */
  readonly maps: Readonly<Record<number, {
    readonly positioned: number; readonly missing: number; readonly within?: string; readonly around?: string
    readonly bounds: readonly [readonly [number, number], readonly [number, number]] | null; readonly extentM: number | null
  }>>
  /** Only when history was asked for: each trend pen's record from then (and up to its hold before) until the sample, by series id. */
  readonly series?: Readonly<Record<string, RecordedSeries>>
  /** By the index of each values view holding a lead request: its values now, at most its rows (named ones first). */
  readonly leads?: Readonly<Record<number, ReadonlyArray<VignetteValue>>>
  /** By the index of each view of a set: the set as it is now. */
  readonly sets?: Readonly<Record<number, SetSample>>
}

/** A fleet column as a Pack declares it; `tally`: the aggregate header counts members by this word column. */
export interface FleetColumn { readonly key: string; readonly label: string; readonly unit: string; readonly tally?: true }
/** A quantity matched on each member: its words and how its numbers are written (no quantity where no member declares it now). */
export interface SetColumn { readonly label: string; readonly unit: string; readonly quantity?: Observable['quantity']; readonly decades?: true }
/** A member's worst alert: its priority and message (the alerts section ranks the rest). */
export interface MemberAlert { readonly priority: Priority | null; readonly message: string }
export interface FleetRow {
  readonly objectId: string; readonly label: string; readonly values: Readonly<Record<string, string | number | null>>
  readonly priority: Priority | null; readonly alert?: MemberAlert
}
/** Members by a tally column's word, leaving out its steady words; at most three named. */
export interface FleetTally { readonly column: string; readonly word: string; readonly count: number; readonly labels: ReadonlyArray<string> }
/** Across every member that reads it now, not only the rows shown; `minAt`, `maxAt`: the members at its ends. */
export interface SetBand { readonly min: number; readonly median: number; readonly max: number; readonly count: number; readonly minAt: string; readonly maxAt: string }
/** `refs`: each column's ref on this member, its value in the sample's observations; null where the member does not measure it. */
export interface CompareRow { readonly objectId: string; readonly label: string; readonly priority: Priority | null; readonly refs: ReadonlyArray<string | null> }
/**
 * A strip now: one pen per member up to four, else the band and at most three named members (those at caution or above
 * first, then the furthest from the median). `missing`: members that do not record it.
 */
export interface SetStrip { readonly pens: ReadonlyArray<SetPen>; readonly band: SetBand | null; readonly missing: ReadonlyArray<string> }
/** A member's pen: its ref, its member's label and its series (the sample's `series[seriesId]` when history was asked for). */
export interface SetPen { readonly ref: string; readonly label: string; readonly seriesId: string }
export interface BandPoint { readonly t: number; readonly min: number; readonly median: number; readonly max: number }
export type SetSample =
  /** `more`: members beyond the rows, `moreAtCaution` of them at caution or above. */
  | { readonly kind: 'fleet'; readonly members: number; readonly rows: ReadonlyArray<FleetRow>; readonly more: number; readonly moreAtCaution: number; readonly tallies: ReadonlyArray<FleetTally> }
  /** `band`: per column, where more members read it than the rows show; `missing`: per column, the members that do not measure it. */
  | { readonly kind: 'compare'; readonly members: number; readonly rows: ReadonlyArray<CompareRow>; readonly more: number; readonly band: ReadonlyArray<SetBand | null> | null; readonly missing: ReadonlyArray<ReadonlyArray<string>> }
  /** `history` only when history was asked for: each banded strip's band from then, by strip index. */
  | { readonly kind: 'set-trend'; readonly members: number; readonly strips: ReadonlyArray<SetStrip>; readonly history?: Readonly<Record<number, ReadonlyArray<BandPoint>>> }
  | { readonly kind: 'alerts'; readonly members: ReadonlyArray<string> }

export type ComposeIssueCode = 'unknown_name' | 'pack_is_not_an_object' | 'agent_access_restricted' | 'not_observed' | 'not_fitted'
export interface ComposeIssue {
  readonly path: string; readonly code: ComposeIssueCode; readonly message: string
  readonly didYouMean?: ReadonlyArray<{ readonly pack: string; readonly suggestions: ReadonlyArray<string> }>
}
