import { packDescriptorSchema,type PackDescriptor } from '@leitbild/contracts'
import type { Component } from 'svelte'
import { z } from 'zod'
import type { DatasetConfig,DatasetId } from '../../reference-data/types.ts'
import type { RoutingAdapter } from '../../routing/protocol.ts'
import type { GeoJsonPoint,GeoJsonPolygon,InteractionHandler,IsoTimestamp,MapLayerId,ObjectId,OperationalObject,ProcedureTag,RecordingProfileDescriptor } from '../model/index.ts'
import { geoJsonPointSchema,geoJsonPolygonSchema,isoTimestampSchema } from '../model/index.ts'
import { geoJsonGeometrySchema, type GeoJsonGeometry } from '../model/geo.ts'
import type { PackMapAppearance,PackMapLegend,PackMapLegendSwatch,PackReferenceDatasetStyle } from './reference-style.ts'

export type WorldPackDescriptor = PackDescriptor & { readonly description: string }
export const packDataChangedSchema = z.object({ packId: z.string().min(1), revision: z.number().int().nonnegative() }).strict()

/** Builder a pack declares to contribute a reference dataset. The CLI reads `id`
 * for filtering and listing; `build` runs only when the pipeline actually
 * builds the dataset (so env reads happen at the right moment). */
export interface PackReferenceDatasetBuilder {
  readonly id: DatasetId
  readonly build: (env: Record<string, string | undefined>) => DatasetConfig
}

/** Rail-side layer-group toggle contributed by a pack (ADR 0023). */
export interface PackMapLayerGroup {
  /** Stable id used in storage keys and command payloads. */
  readonly id: string
  /** Operator-facing label rendered in the rail. */
  readonly label: string
  /** Initial visibility. The rail and persistent storage may override. */
  readonly defaultVisible: boolean
  /** MapLibre layer-id glob. `*` matches one ':'-separated segment. */
  readonly layerIdPattern: string
  /** Key drawn beside the toggle in the layers panel. */
  readonly swatch?: PackMapLegendSwatch
}

export interface PackObjectCategory {
  readonly id: string
  readonly label: string
  readonly emptyLabel: string
  readonly matches: (object: OperationalObject) => boolean
}

export interface PackObjectPresentation {
  readonly categoryId: string
  readonly icon: string
  readonly color: string
  readonly summary: string
  readonly fields: ReadonlyArray<PackObjectField>
  readonly status?: PackObjectStatusPresentation
  readonly muted?: boolean
  readonly mapIconVisible?: boolean
  readonly mapLineVisible?: boolean
  readonly mapIconSizePx?: number
  readonly noteworthyUpdates?: boolean
}

export interface PackObjectField {
  readonly key: string
  readonly label: string
  readonly value: string
}

export type PackObjectStatusTone = 'ready' | 'working' | 'error' | 'idle'

export interface PackObjectStatusIndicator {
  readonly shape: 'dot' | 'arrow'
  readonly direction?: 'left' | 'right' | 'up' | 'down'
  readonly pulse?: boolean
  readonly innerTone?: PackObjectStatusTone
}

export interface PackObjectStatusPresentation {
  readonly tone: PackObjectStatusTone
  readonly label: string
  readonly indicator: PackObjectStatusIndicator
}

export interface PackCreateObjectType {
  readonly id: string
  readonly label: string
  readonly categoryId: string
  readonly icon: string
  readonly color: string
  readonly placementKind?: 'point' | 'route' | 'polygon'
  readonly parameters?: ReadonlyArray<PackCreateObjectParameter>
}

export type PackCreateObjectParameter =
  | {
      readonly key: string
      readonly label: string
      readonly kind: 'text'
      readonly defaultValue: string
    }
  | {
      readonly key: string
      readonly label: string
      readonly kind: 'number'
      readonly defaultValue: number
      readonly min?: number
      readonly max?: number
      readonly step?: number
    }
  | {
      readonly key: string
      readonly label: string
      readonly kind: 'select'
      readonly defaultValue: string
      readonly options: ReadonlyArray<{
        readonly value: string
        readonly label: string
      }>
    }

export interface PackCommandRequest {
  readonly kind: string
  readonly targetObjectIds: ReadonlyArray<ObjectId>
  readonly payload: unknown
}

export type PackCreationGeometry =
  | {
      readonly kind: 'point'
      readonly point: GeoJsonPoint
    }
  | {
      readonly kind: 'route'
      readonly from: GeoJsonPoint
      readonly to: GeoJsonPoint
    }
  | {
      readonly kind: 'polygon'
      readonly polygon: GeoJsonPolygon
    }

export type PackObjectPresentationTier = 'summary' | 'map' | 'detail'

export interface PackObjectPresentationContext {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly objectsForPack?: (packId: string) => ReadonlyArray<OperationalObject>
  readonly currentTime?: IsoTimestamp
  readonly map?: PackMapRenderContext
  readonly tier?: PackObjectPresentationTier
}

export interface PackMapRenderContext {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
}

export interface PackMapFeature {
  readonly layerId?: string
  readonly id: string
  readonly categoryId: string
  readonly geometry: GeoJsonGeometry
  readonly selection?: { readonly panelId: string; readonly itemId: string }
  readonly anchorPoint?: GeoJsonPoint
  readonly symbol?: PackMapFeatureSymbol
  readonly color: string
  readonly summary: string
  readonly opacity?: number
  readonly lineColor?: string
  readonly lineOpacity?: number
  readonly lineWidth?: number
  readonly sortKey?: number
}

export interface PackMapFeatureSymbol {
  readonly icon: string
  readonly tone?: PackObjectStatusTone
  readonly opacity?: number
  readonly size?: number
}

export const packMapFeatureSchema = z
  .object({
    layerId: z.string().min(1).optional(),
    id: z.string().min(1),
    categoryId: z.string().min(1),
    geometry: geoJsonGeometrySchema,
    selection: z.object({ panelId: z.string().min(1), itemId: z.string().min(1) }).strict().optional(),
    anchorPoint: geoJsonPointSchema.optional(),
    symbol: z.object({
    icon: z.string().min(1),
    tone: z.enum(['ready', 'working', 'error', 'idle']).optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
    size: z.number().finite().positive().optional(),
  }).strict().optional(),
    color: z.string().min(1),
    summary: z.string(),
    opacity: z.number().finite().min(0).max(1).optional(),
    lineColor: z.string().min(1).optional(),
    lineOpacity: z.number().finite().min(0).max(1).optional(),
    lineWidth: z.number().finite().nonnegative().optional(),
    sortKey: z.number().finite().optional(),
  })
  .strict()

export interface PackMapFeatureQuery {
  readonly capabilityId: string
  readonly input: unknown
}

export type PackMapFeatureSelection = NonNullable<PackMapFeature['selection']>

/** Values a live map layer sets as MapLibre feature-state; paint reads them with ['feature-state', key]. */
export type PackLiveFeatureState = Readonly<Record<string, number | boolean>>

export interface PackLiveMapFeature {
  /** Unique non-negative integer within its source; the renderer promotes it to the feature id. */
  readonly fid: number
  readonly geometry: GeoJsonGeometry
  readonly properties: Readonly<Record<string, string | number | boolean>>
}

export interface PackLiveMapHoverCard {
  readonly title: string
  readonly fields: ReadonlyArray<PackObjectField>
}

/** One validated state result, mapped onto the features of the geometry it aligns with. */
export interface PackLiveMapState {
  readonly revision: number
  /** Every feature's state; the renderer applies only the values that changed. */
  readonly featureStates: ReadonlyMap<number, PackLiveFeatureState>
  /** A small label set rebuilt with each state, because text cannot read feature-state. */
  readonly labels: ReadonlyArray<PackLiveMapFeature>
  readonly hoverCard: (fid: number) => PackLiveMapHoverCard | null
}

/** Static features of one source object, fetched once per key. */
export interface PackLiveMapGeometry {
  readonly key: string
  readonly features: ReadonlyArray<PackLiveMapFeature>
  readonly selectionFor: (fid: number) => PackMapFeatureSelection | null
  readonly fidForSelection: (selection: PackMapFeatureSelection) => number | null
  /** Validates a state result for this geometry; a state for another geometry key is an error. */
  readonly presentState: (result: unknown) => PackLiveMapState
}

export interface PackLiveMapLayerSpec {
  /** One lowercase segment; published as `live:<layer id>:<object>:<spec id>`. */
  readonly id: string
  readonly source: 'features' | 'labels'
  readonly type: 'line' | 'circle' | 'symbol'
  readonly minzoom?: number
  readonly filter?: ReadonlyArray<unknown>
  readonly layout?: Readonly<Record<string, unknown>>
  /** Dynamic values come from feature-state only. */
  readonly paint: Readonly<Record<string, unknown>>
  /** Hover cards and selection read features of this layer. */
  readonly interactive?: boolean
}

export interface PackLiveMapImage {
  /** `<layer id>:<name>`, referenced by `icon-image`. */
  readonly id: string
  readonly svg: string
}

/** Recolours reference datasets as muted context while the live layer is shown. */
export interface PackLiveMapReferenceContext {
  readonly datasetIds: ReadonlyArray<string>
  readonly color: (color: string, appearance: PackMapAppearance) => string
}

/**
 * A Pack-owned live map layer: geometry fetched once per geometry key and compact state
 * fetched when a source object's revision changes, both through the Pack's own query
 * Capabilities, and applied to native MapLibre layers as feature-state.
 */
export interface PackLiveMapLayer {
  /** One lowercase segment, unique across active Packs. */
  readonly id: string
  /** The Pack layer group (pattern `live:<id>:*:*`) that shows and hides this layer. */
  readonly layerGroupId: string
  /** Objects this layer draws, one instance each; their revision gates state fetches. */
  readonly sourceObjects: (objects: ReadonlyArray<OperationalObject>) => ReadonlyArray<OperationalObject>
  readonly geometryQuery: (object: OperationalObject) => PackMapFeatureQuery
  readonly stateQuery: (object: OperationalObject) => PackMapFeatureQuery
  readonly loadGeometry: (result: unknown) => PackLiveMapGeometry
  /** The geometry key a state result aligns with; the renderer refetches geometry when it differs. */
  readonly stateGeometryKey: (result: unknown) => string
  /**
   * Layers in paint order, bottom first. The feature source has a 32 px tile buffer, so a line's
   * half-width and an along-line symbol's half-size must stay below 32 px.
   */
  readonly layersFor: (appearance: PackMapAppearance) => ReadonlyArray<PackLiveMapLayerSpec>
  readonly imagesFor?: (appearance: PackMapAppearance) => ReadonlyArray<PackLiveMapImage>
  readonly referenceContext?: PackLiveMapReferenceContext
  /** Credits for the data this layer draws, shown in the map's attribution control. */
  readonly attribution: string
}

export interface PackObjectCreationContext {
  readonly objects: ReadonlyArray<OperationalObject>
}

export interface PackTargetContext {
  readonly objects: ReadonlyArray<OperationalObject>
}

export type PackRuntimeClock = 'simulation' | 'live' | 'none'

export interface PackRuntime {
  readonly id: string
  readonly version: string
  readonly label: string
  readonly kind: 'local' | 'remote' | 'replay'
  readonly clock: PackRuntimeClock
}

export interface PackWikiRef {
  readonly name: string
  readonly url: string
}

export interface PackScenarioItemSpec {
  readonly pack: string
  readonly type: string
  readonly id: string
  readonly label: string
  readonly [key: string]: unknown
}

export interface PackScenarioItemContribution {
  readonly objects: ReadonlyArray<OperationalObject>
}

export type PackScenarioAuthoringControl =
  | { readonly kind: 'text' }
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly step?: number }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'select'; readonly options: ReadonlyArray<{ readonly value: string; readonly label: string; readonly compatibleWith?: { readonly path: ReadonlyArray<string | number>; readonly values: ReadonlyArray<string> } }>; readonly extendFromConfig?: { readonly path: ReadonlyArray<string | number>; readonly valueKey: string; readonly labelKey: string } }
  | { readonly kind: 'reference'; readonly itemTypes?: ReadonlyArray<string> }
  | { readonly kind: 'string-list' }

export interface PackScenarioAuthoringField {
  readonly path: ReadonlyArray<string | number>
  readonly label: string
  /** Optional operational meaning when the label and schema are not sufficient. */
  readonly description?: string
  readonly control: PackScenarioAuthoringControl
}

/** One-level repeated records, not a recursive form language. */
export interface PackScenarioAuthoringCollection {
  readonly path: ReadonlyArray<string | number>
  readonly label: string
  readonly defaultItem: Readonly<Record<string, unknown>>
  readonly fields: ReadonlyArray<PackScenarioAuthoringField>
  readonly maxItems: number
  /** Sparse, ordered keyframes inherit missing values from preceding records. */
  readonly keyframes?: { readonly timePath: ReadonlyArray<string | number>; readonly increment: number }
}
export interface PackScenarioAuthoringItemType {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly idPrefix: string
  readonly defaultItem: Readonly<Record<string, unknown>>
  readonly placement?: {
    readonly kind: 'point'
    readonly path: ReadonlyArray<string | number>
    readonly orReference?: ReadonlyArray<string | number>
  }
  readonly fields: ReadonlyArray<PackScenarioAuthoringField>
  readonly collections?: ReadonlyArray<PackScenarioAuthoringCollection>
}

export interface PackScenarioAuthoringContribution {
  readonly configFields?: ReadonlyArray<PackScenarioAuthoringField>
  readonly itemTypes: ReadonlyArray<PackScenarioAuthoringItemType>
}


export interface PackScenarioExpansionContext {
  readonly at: IsoTimestamp
  readonly objects: ReadonlyArray<OperationalObject>
  readonly objectById: (id: ObjectId) => OperationalObject | undefined
  readonly routing: RoutingAdapter
  readonly packConfigs: Record<string, unknown>
}


export interface PackScenarioSupport {
  /** Startup dependencies on other authored objects, independent of item order. */
  readonly referencedObjects?: (spec: PackScenarioItemSpec) => ReadonlyArray<string>
  /** Static authored footprint. No runtime connection or physical advancement. */
  readonly previewGeometry?: (object: OperationalObject) => import('../model/geo.ts').GeoJsonGeometry | undefined
  readonly validateInitialObjects?: (
    objects: ReadonlyArray<OperationalObject>,
    config: unknown,
    at: IsoTimestamp,
  ) => void
  readonly itemSchemas: Readonly<Record<string, z.ZodType>>
  readonly expandItem: (
    spec: PackScenarioItemSpec,
    context: PackScenarioExpansionContext,
  ) => PackScenarioItemContribution | Promise<PackScenarioItemContribution>
}

export interface PackRuntimeContribution {
  readonly runtimes: ReadonlyArray<PackRuntime>
  readonly defaultRuntimeId: string
}

export interface PackRecordingContribution {
  readonly profiles: ReadonlyArray<RecordingProfileDescriptor>
  /** Initial series only; dynamic assets/optional observations may change this count. */
  readonly estimateSeries?: (objects: ReadonlyArray<OperationalObject>, profileId: string) => number
}

export interface PackKnowledgeContribution {
  readonly wikiRefs: ReadonlyArray<PackWikiRef>
}

export interface PackReferenceDataContribution {
  readonly builders: ReadonlyArray<PackReferenceDatasetBuilder>
  readonly datasetIds: ReadonlyArray<DatasetId>
}

export interface PackContextualFieldQuery extends PackMapFeatureQuery {
  readonly toFields: (result: unknown) => ReadonlyArray<PackObjectField>
}
export interface PackPresentationContribution {
  readonly contextualFieldQueries?: (object: OperationalObject) => ReadonlyArray<PackContextualFieldQuery>
  readonly categories: ReadonlyArray<PackObjectCategory>
  readonly presentObject: (
    object: OperationalObject,
    context: PackObjectPresentationContext,
  ) => PackObjectPresentation
  readonly contextualFields?: (
    object: OperationalObject,
    context: PackObjectPresentationContext,
  ) => ReadonlyArray<PackObjectField>
  readonly mapFeatures?: (
    context: PackObjectPresentationContext,
  ) => ReadonlyArray<PackMapFeature>
  readonly mapFeatureLayers?: ReadonlyArray<MapLayerId>
  /**
   * Object pack ids whose object revisions can invalidate map-area features.
   * Defaults to the contributing pack id when omitted. Use ['*'] only for
   * genuinely cross-pack area features that depend on every object revision.
   */
  readonly mapFeatureSourcePackIds?: ReadonlyArray<string>
  readonly mapFeatureQueries?: (
    context: PackObjectPresentationContext,
  ) => ReadonlyArray<PackMapFeatureQuery>
  readonly mapLayerGroups?: ReadonlyArray<PackMapLayerGroup>
  /** One style for each dataset in this Pack's `referenceData.datasetIds`. */
  readonly referenceStyles?: ReadonlyArray<PackReferenceDatasetStyle>
  /** Keys the layers panel renders for this Pack's map encodings. */
  readonly mapLegends?: ReadonlyArray<PackMapLegend>
  readonly liveMapLayers?: ReadonlyArray<PackLiveMapLayer>
}

export interface PackCreationContribution {
  readonly createObjectTypes: ReadonlyArray<PackCreateObjectType>
  readonly defaultObjectLabel: (
    typeId: string,
    context: PackObjectCreationContext,
  ) => string
  readonly buildCreateObjectCommand: (
    typeId: string,
    label: string,
    geometry: PackCreationGeometry,
    parameters?: unknown,
  ) => PackCommandRequest
}

export interface PackTargetingContribution {
  readonly isController: (object: OperationalObject) => boolean
  readonly isTarget: (
    controller: OperationalObject,
    candidate: OperationalObject,
    context: PackTargetContext,
  ) => boolean
  readonly buildSetTargetCommand: (
    controller: OperationalObject,
    target: OperationalObject,
    context: PackTargetContext,
  ) => PackCommandRequest
  readonly buildCancelTargetCommand: (
    controller: OperationalObject,
    context: PackTargetContext,
  ) => PackCommandRequest
}

export type PackMapAssignmentMode = 'start' | 'append'

export interface PackMapAssignmentChoice {
  readonly id: string
  readonly label: string
  readonly summary: string
  readonly disabledReason?: string
}

export interface PackMapAssignmentTarget {
  readonly id: string
  readonly label: string
  readonly choices: ReadonlyArray<PackMapAssignmentChoice>
  readonly minimumChoices: number
  readonly maximumChoices: number
  readonly buildCommand: (choiceIds: ReadonlyArray<string>) => PackCommandRequest
}

export interface PackMapAssignmentHandle {
  readonly id: string
  readonly controllerId: ObjectId
  readonly point: GeoJsonPoint
}

/** Pack-owned assignment semantics exposed through generic map gestures. The
 * host renders pointers, lines, handles and choice UI, but never interprets
 * targets or builds domain commands. */
export interface PackMapAssignmentContribution {
  readonly canStart: (controller: OperationalObject, context: PackTargetContext) => boolean
  readonly anchorFor: (controller: OperationalObject, mode: PackMapAssignmentMode, context: PackTargetContext) => GeoJsonPoint
  readonly handles: (context: PackTargetContext) => ReadonlyArray<PackMapAssignmentHandle>
  readonly targetFor: (controller: OperationalObject, candidate: OperationalObject, mode: PackMapAssignmentMode, context: PackTargetContext) => PackMapAssignmentTarget | null
}

export interface PackInteractionContribution {
  readonly handlers: ReadonlyArray<InteractionHandler>
}

/** Browser-only panel contributed by a Pack. The host owns placement and lifecycle;
 * the Pack owns the lazily loaded panel implementation. */
export interface PackSurfacePanelContribution {
  readonly id: string
  readonly label: string
  readonly defaultOpen: boolean
  readonly load: () => Promise<{ readonly default: Component }>
}

export interface PackUiContribution {
  readonly surfacePanels: ReadonlyArray<PackSurfacePanelContribution>
  readonly settingsEditor?: () => Promise<{ readonly default: Component }>
}

/** Pack-owned inputs to shared procedure observation queries. The generic UI
 * discovers these operations through the target object's owning Pack. */
export interface PackProcedureContribution {
  readonly scopeIdForObject: (object: OperationalObject) => string | null
  /** The declared Capability must return PackProcedureSignalReadResult. */
  readonly signalReadQuery: (scopeId: string, tag: ProcedureTag) => PackProcedureQuery
  /** The declared Capability must return PackProcedureTagValidationResult. */
  readonly tagValidationQuery: (scopeId: string, tags: ReadonlyArray<ProcedureTag>) => PackProcedureQuery
  /** The declared Capability must return PackProcedureAssessmentResult. */
  readonly assessmentsQuery: (scopeId: string, assessmentIds: ReadonlyArray<string>) => PackProcedureQuery
}

export interface PackProcedureQuery {
  readonly capabilityId: string
  readonly input: unknown
}

/** Shared wire observations, validated by the generic procedure client. Pack
 * Capabilities may add engineering evidence, but must retain these semantics. */
export interface PackProcedureSignalObservation {
  readonly signal: { readonly unit: string; readonly tagId?: string; readonly label?: string; readonly path?: string }
  readonly variable: { readonly value: number | boolean; readonly unit?: string; readonly path?: string }
  readonly quality?: { readonly status: string }
  readonly valueView?: {
    readonly status: 'native' | 'converted' | 'unavailable'
    readonly value: number | boolean
    readonly unit: string
    readonly requestedUnit: string
    readonly reason?: string
  }
  readonly comparison?: { readonly operator: string; readonly value: number | boolean; readonly matches?: boolean }
}

export interface PackProcedureSignalReadResult {
  readonly signals: ReadonlyArray<PackProcedureSignalObservation>
}

export interface PackProcedureTagValidationResult {
  readonly tags: ReadonlyArray<{
    readonly id: string
    readonly status: 'resolved' | 'resolved-with-warnings' | 'missing'
    readonly signal?: Record<string, unknown>
    readonly warnings: ReadonlyArray<string>
  }>
}

export interface PackProcedureAssessmentResult {
  readonly assessments: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly status: 'satisfied' | 'challenged' | 'unknown'
    readonly reason?: string
    readonly basis?: { readonly qualification: string }
    readonly signalsRead: ReadonlyArray<PackProcedureSignalObservation>
    readonly simTimeMs?: number
    readonly modelRef?: string
    readonly modelDigest?: string
  }>
}

/** The browser-safe projection of a World Pack. It contains only contributions
 * used by the generic World UI and may be loaded without runtime, compilation,
 * persistence, or build-time dependencies. */
export interface WorldPackView {
  readonly descriptor: WorldPackDescriptor
  readonly runtime?: PackRuntimeContribution
  readonly referenceData?: Pick<PackReferenceDataContribution, 'datasetIds'>
  readonly presentation: PackPresentationContribution
  readonly creation?: PackCreationContribution
  readonly targeting?: PackTargetingContribution
  readonly mapAssignment?: PackMapAssignmentContribution
  readonly ui?: PackUiContribution
  readonly procedures?: PackProcedureContribution
}

/** Complete server-side Pack definition. World Pack views are projections of
 * this contract, never partial World Packs with fabricated schemas. */
export interface WorldPack extends WorldPackView {
  readonly scenarioConfigSchema: z.ZodType
  readonly authoring?: PackScenarioAuthoringContribution
  readonly recording?: PackRecordingContribution
  readonly knowledge?: PackKnowledgeContribution
  readonly referenceData?: PackReferenceDataContribution
  readonly scenario?: PackScenarioSupport
  readonly interactions?: PackInteractionContribution
}

export const emptyPackScenarioConfigSchema = z.object({}).strict()

export const createWorldPackDescriptor = (config: {
  readonly id: string
  readonly version: string
  readonly name: string
  readonly description: string
  readonly contributions: ReadonlyArray<string>
}): WorldPackDescriptor => packDescriptorSchema.parse({
  schemaVersion: '1.0.0',
  id: config.id,
  moduleId: 'world',
  version: config.version,
  name: config.name,
  description: config.description,
  platformVersionRange: '^1.0.0',
  dependencies: [],
  contributions: config.contributions.map(kind => ({ kind })),
}) as WorldPackDescriptor
