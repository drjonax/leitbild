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
  packId: z.string().min(1).max(128), categoryId: z.string().min(1).max(128), status: z.array(z.string().min(1).max(80)).min(1).max(6).optional(),
  near: objectIdSchema.optional(), within: distanceBandSchema.optional(), closed: z.boolean(),
}).strict()

export const resolvedViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('values'), refs: z.array(observableRefSchema).min(1).max(16), rows }).strict(),
  z.object({ kind: z.literal('trend'), refs: z.array(observableRefSchema).min(1).max(12), horizon: z.enum(['2m', '10m', '30m']), rows }).strict(),
  /** The objects' alerts, or only those on these elements or observables. */
  z.object({
    kind: z.literal('alerts'), objectIds: z.union([z.literal('run'), z.array(objectIdSchema).min(1).max(48)]),
    elements: z.array(z.string().min(1).max(200)).min(1).max(8).optional(), refs: z.array(observableRefSchema).min(1).max(8).optional(), rows,
  }).strict(),
  /** An entity-floor object's core slots. */
  z.object({ kind: z.literal('slots'), objectId: objectIdSchema, rows }).strict(),
  /** A table of these objects, or of a live collection's members. */
  z.object({ kind: z.literal('entity'), objectIds: z.array(objectIdSchema).min(1).max(48), rows }).strict(),
  z.object({ kind: z.literal('collection'), of: collectionSchema, rows }).strict(),
  z.object({
    kind: z.literal('topology'), objectId: objectIdSchema,
    request: z.object({ from: nodeIds, to: nodeIds, around: nodeIds, media: nodeIds, groups: nodeIds, reach: z.number().int().min(1).max(4).optional() }).strict(),
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
  views: z.array(resolvedViewSchema).min(1).max(4),
}).strict()
export type VignetteState = z.output<typeof vignetteStateSchema>

/** A declared element an observable is measured on. */
export type VignetteElement = ObservationDeclaration['elements'][number]

/** A declared observable as a vignette names it: its label qualified with its object's ("<object> · <observable>", R25). */
export type VignetteValue = Pick<Observable, 'ref' | 'quantity' | 'unit' | 'valueType' | 'states' | 'thresholds' | 'series'> & {
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

/** A binding the caller reads, with its observable's declared quantity, unit and states (a state marked `active` reads as on), so a drawing writes the reading as the card does. */
export type TopologyBinding = TopologyNode['bindings'][number] & Pick<Observable, 'quantity' | 'unit' | 'states'>
export interface TopologyNodeView extends Pick<TopologyNode, 'id' | 'label' | 'shortLabel' | 'element'> {
  /** A stop's label names its far ends (at most 24 characters). */
  readonly class: TopologyNode['class'] | 'stop'
  readonly bindings: ReadonlyArray<TopologyBinding>
}

export type VignetteSection =
  | { readonly kind: 'values'; readonly rows: number; readonly values: ReadonlyArray<VignetteValue> }
  /** Parallel values: one line per element, one column per quantity. */
  | { readonly kind: 'grouped'; readonly rows: number; readonly quantities: ReadonlyArray<{ readonly label: string; readonly unit: string }>; readonly lines: ReadonlyArray<{ readonly element: VignetteElement; readonly values: ReadonlyArray<VignetteValue | null> }> }
  /** Pens drawn together share a strip: at most four strips of at most four pens. */
  | { readonly kind: 'trend'; readonly rows: number; readonly horizonMs: number; readonly strips: ReadonlyArray<ReadonlyArray<VignetteValue>> }
  | { readonly kind: 'alerts'; readonly rows: number; readonly objectIds: ReadonlyArray<string> | 'run'; readonly elements?: ReadonlyArray<string>; readonly refs?: ReadonlyArray<string> }
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

export interface VignetteView { readonly title: string; readonly by?: 'assistant'; readonly sections: ReadonlyArray<VignetteSection> }

/** A recorded point: Run time in epoch ms and the value then. */
export interface SeriesPoint { readonly t: number; readonly v: number }

export interface VignetteSample {
  readonly at: Stamp & { readonly paused: boolean }
  readonly observations: ReadonlyArray<Observation>
  /** The rows of every alerts section's objects, worst first. */
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
  /** Only when history was asked for: each trend pen's recorded points from then until the sample, by series id. */
  readonly series?: Readonly<Record<string, ReadonlyArray<SeriesPoint>>>
}

export type ComposeIssueCode = 'unknown_name' | 'pack_is_not_an_object' | 'agent_access_restricted' | 'not_observed' | 'not_fitted'
export interface ComposeIssue {
  readonly path: string; readonly code: ComposeIssueCode; readonly message: string
  readonly didYouMean?: ReadonlyArray<{ readonly pack: string; readonly suggestions: ReadonlyArray<string> }>
}
