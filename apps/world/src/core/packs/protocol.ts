import { packDescriptorSchema,type PackDescriptor } from '@leitbild/contracts'
import type { Component } from 'svelte'
import { z } from 'zod'
import type { DatasetConfig,DatasetId } from '../../reference-data/types.ts'
import type { RoutingAdapter } from '../../routing/protocol.ts'
import type { GeoJsonPoint,GeoJsonPolygon,InteractionHandler,IsoTimestamp,MapLayerId,ObjectId,OperationalObject,ProcedureTag,RecordingProfileDescriptor,RunViewer,ScenarioRole,ScenarioSide,SimulationRunId } from '../model/index.ts'
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
  /**
   * Opt-out: the control rail gets no section for this category unless a
   * Scenario's Starting View names one. A Pack whose own panel lists these
   * objects declares it, so they are not listed twice.
   */
  readonly rail?: false
  /** The closed list of status words this category's objects show (reserved; supplied with P2's presentation fields). */
  readonly statusWords?: ReadonlyArray<string>
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
  /**
   * Opt-in short text drawn natively beneath the object's map icon, such as a
   * callsign and phase code. Without it the map draws no label.
   */
  readonly mapLabel?: string
  /**
   * A few short lines that stand for an object that has a card of its own,
   * such as its status and what it is doing now: the map's hover preview
   * shows them beneath its label instead of every field, as a preview of the
   * card's first lines. The rail row's tooltip keeps every field, with the
   * context other Packs add (the weather at the object). Without them the
   * hover lists the fields.
   */
  readonly glance?: ReadonlyArray<string>
  /** Reserved (supplied in P2): sorts, never colours. */
  readonly urgency?: { readonly order: number; readonly word: string }
  /** Reserved (supplied in P2): objects this one relates to, both ways. */
  readonly related?: ReadonlyArray<{ readonly objectId: ObjectId; readonly role: string }>
  /** Reserved (supplied in P2): since when the status word holds. */
  readonly since?: { readonly at: IsoTimestamp; readonly clock: 'simulation' | 'wall' }
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
  /**
   * In a role Run, the roles this screen shows (the role dialog's See boxes;
   * every held role is shown); absent in open mode. The World view passes
   * it to every presentation hook it calls with this context: `presentObject`,
   * `contextualFields`, `mapFeatures` and `mapFeatureQueries`. A per-tab
   * display filter no server reads: a Pack may hide its own objects of roles
   * not shown, in every layer it draws, and a Pack that ignores it is
   * unaffected. Visibility between sides stays the Run's, per side.
   */
  readonly seenRoleIds?: ReadonlyArray<string>
  /**
   * The object the map selects, for the `mapFeatures` of a Pack that
   * declares `mapFeaturesFollowSelection` (the map feature loader passes it;
   * absent while nothing is selected). Such a Pack may draw what belongs to
   * the selected object more strongly, such as its planned path; selection
   * is this tab's alone. No other Pack's hooks and no `mapFeatureQueries`
   * receive it.
   */
  readonly selectedObjectId?: string
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
  /** A line drawn dashed, for what is planned rather than under way; solid when absent. */
  readonly lineDashed?: boolean
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
    lineDashed: z.boolean().optional(),
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
  /**
   * Every feature's state; the renderer applies only the values that changed. Each changed value
   * makes MapLibre re-evaluate the feature's state-dependent paint in every tile that holds it, so a
   * value carries only the resolution its paint draws: a band index where paint steps on a reading,
   * the exact reading staying with the hover card.
   */
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
  /** The screen's role view in a role Run, from the role set its connection holds; absent in open mode. */
  readonly viewer?: RunViewer
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
  /** The Scenario's declared sides, for a Pack whose items belong to one; empty when it declares none. */
  readonly sides: ReadonlyArray<ScenarioSide>
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
    /** As PackScenarioExpansionContext.sides. */
    sides: ReadonlyArray<ScenarioSide>,
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
  /** One line (≤ 200 characters) the Run context shows fenced as this Pack's guidance. */
  readonly guidance?: string
}

/**
 * Data only: which objects declare observations and the ids of this Pack's
 * system-audience query Capabilities (core/observation/capabilities.ts) that
 * declare, read and draw them. World reads them as the caller, lazily.
 */
export interface PackObservationContribution {
  /** Presentation categories whose objects declare observations. */
  readonly categories: ReadonlyArray<string>
  readonly declarations: string
  readonly read: string
  readonly topology?: { readonly family: 'flow' | 'network'; readonly capability: string }
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
  /**
   * The Pack's `mapFeatures` draw the selected object differently: only they
   * receive `selectedObjectId`, and only while an active Pack declares this
   * does a selection change redraw Pack map features. A selection change
   * re-runs no Pack's `mapFeatureQueries`: the map feature loader keeps
   * their last results.
   */
  readonly mapFeaturesFollowSelection?: true
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
  /** Credits for licensed data this Pack's `mapFeatures` draw. */
  readonly mapFeatureAttribution?: string
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

/** What a map click names for the selected controller: an object, or a point on open ground. */
export type PackMapTarget =
  | { readonly kind: 'object'; readonly objectId: ObjectId }
  | { readonly kind: 'point'; readonly point: GeoJsonPoint }

/** One plain line previewing what a target click would do, in the Pack's words. */
export interface PackTargetPreview {
  /** The verb and target, e.g. "Send A3 to C-12", or why the order would be refused. */
  readonly text: string
  /** True when the line states a refusal. */
  readonly refused: boolean
}

/** Opt-in: a click on open map ground targets that point for the selected controller. */
export interface PackPointTargeting {
  readonly isTarget: (controller: OperationalObject, point: GeoJsonPoint, context: PackTargetContext) => boolean
  readonly buildSetTargetCommand: (controller: OperationalObject, point: GeoJsonPoint, context: PackTargetContext) => PackCommandRequest
}

export interface PackTargetingContribution {
  /** Whether this screen may select the object to give it map orders; `context.viewer` is its role view. */
  readonly isController: (object: OperationalObject, context: PackTargetContext) => boolean
  /**
   * Opt-in preview shown on the hovered target and used as the feedback line
   * of a generic send; null when the Pack has nothing to say for that target.
   * An open map-target panel's own preview, when it connects one, answers
   * instead for that panel's controllers.
   */
  readonly describeTarget?: (controller: OperationalObject, target: PackMapTarget, context: PackTargetContext) => PackTargetPreview | null
  readonly pointTargets?: PackPointTargeting
  /**
   * Opt-in: whether the screen sees the object but may not order it, e.g. a
   * unit another role commands; the map draws such an object muted.
   */
  readonly mutedOnMap?: (object: OperationalObject, context: PackTargetContext) => boolean
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
  /**
   * Opt-in: while this panel is open, every map target click for a controller
   * of the panel's own Pack goes to the `onMapTarget` it connects, and the
   * generic surface never sends one itself; other Packs' controllers keep
   * their generic targeting. The panel may also connect `previewMapTarget`,
   * which then answers the hover preview for its controllers.
   */
  readonly mapTargets?: true
  /**
   * Opt-in: while this panel is open, the World key router delivers keys to
   * the `onKey` it connects, whatever element inside the World has focus.
   */
  readonly keymap?: true
}

/** Map gestures a Pack switches off, never inferred; every other gesture stays on. */
export interface PackMapInteraction {
  readonly doubleClickZoom?: false
  /** Keyboard panning and zooming of the map canvas. */
  readonly keyboard?: false
  readonly boxZoom?: false
}

/** Start-state hints for the World surface; the operator may change the layout afterwards. */
export interface PackSurfaceLayout {
  readonly railCollapsed?: true
}

/**
 * What a Pack contributes to the embed bundle alone (panels drawn with OpenBridge): each Pack exports it from
 * packs/<pack>/ui/embed.ts and ui/embed/pack-embed-loader.ts loads it, so nothing the main app loads reaches it.
 */
export interface PackEmbedContribution {
  /** The panel a display's element pop-over shows for this Pack's elements (operation, resets); World places it, the Pack implements it. */
  readonly elementActions?: () => Promise<{ readonly default: Component<PackElementActionsProps> }>
}

/** What a Pack's element-actions panel is mounted with: the element a display's pop-over shows. */
export interface PackElementActionsProps {
  /** The Run its panel calls (controls, validation, writes, resets, proposals, signal reads). */
  readonly runId: SimulationRunId
  readonly objectId: ObjectId
  /** The declared element id (a topology node's `element`, or its id). */
  readonly elementId: string
}

export interface PackUiContribution {
  readonly surfacePanels: ReadonlyArray<PackSurfacePanelContribution>
  readonly settingsEditor?: () => Promise<{ readonly default: Component }>
  readonly mapInteraction?: PackMapInteraction
  readonly surfaceLayout?: PackSurfaceLayout
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
  /** The live process display a clicked tag opens around the equipment it is measured on; null where the Pack can name none. */
  readonly tagDisplay?: (scopeId: string, validation: PackProcedureTagValidation) => PackProcedureTagDisplay | null
}

/** An embedded view of the Pack's owning Module, opened over the procedure as it would be in a chat answer. */
export interface PackProcedureTagDisplay {
  readonly viewType: string
  readonly title: string
  readonly state: string
  /** The read-only query that draws the view for its inner size first: what cannot be drawn is refused with the Pack's reason, not opened empty. */
  readonly drawQuery: (size: { readonly width: number; readonly height: number }) => PackProcedureQuery
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

export interface PackProcedureTagValidation {
  readonly id: string
  readonly status: 'resolved' | 'resolved-with-warnings' | 'missing'
  readonly signal?: Record<string, unknown>
  /** The Pack's id for the equipment a resolved tag is measured on, where it names one. */
  readonly measuredOn?: string
  readonly warnings: ReadonlyArray<string>
}

export interface PackProcedureTagValidationResult {
  readonly tags: ReadonlyArray<PackProcedureTagValidation>
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

/** Role wording a role-aware Pack may supply: one plain line saying what a
 * role commands in this Pack's configuration, e.g. "commands 4 units". The
 * role bar's add menu shows it. */
export interface PackRoleContribution {
  readonly commandsLine: (roleId: string, packConfig: unknown) => string | null
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
  readonly roles?: PackRoleContribution
}

/** Complete server-side Pack definition. World Pack views are projections of
 * this contract, never partial World Packs with fabricated schemas. */
export interface WorldPack extends WorldPackView {
  readonly scenarioConfigSchema: z.ZodType
  /**
   * Opts this Pack into Runs whose Scenario declares roles; compiling a role
   * Run with any other Pack is refused (`role_run_pack_not_role_aware`).
   * A role-aware Pack accepts these obligations:
   * - its Capabilities are called only by a person holding a role, or by the
   *   Scenario timeline; AI callers are refused before they reach it;
   * - its UI calls the Run through the World-direct client, which carries the
   *   screen's role set, never through the Host broker, which carries none;
   * - its Run-scoped UI state belongs to one perspective and is discarded when
   *   the screen's role set changes;
   * - it needs no other Pack that calls the Run without a role.
   * In a Run that declares sides, readers holding a role receive their role's
   * view of the one projection: objects and events filtered by audience,
   * scenario state redacted, and runtime realtime messages limited to
   * `pack.data.changed`. Pack runtimes, interaction handlers, persistence and
   * the journal keep complete truth. A role-aware Pack therefore:
   * - writes an audience on every object it upserts;
   * - answers queries and refusals only within the stamped viewer's picture
   *   (`PackRuntimeQuery.viewer`, `PackCommandContext.viewer`), which core
   *   stamps from the caller's connection, never from input;
   * - keeps sided ids out of public objects;
   * - sets no `causedByCommandId` on an object or event whose audience is
   *   wider than the commanding side's view, since core sends a Pack's
   *   provenance as it is and a command id is that side's own;
   * - emits side-visible realtime messages only for public authoring changes.
   * Core refuses a Pack's emission whose object breaks the audience rules as
   * a whole, and reports it on that Pack Runtime's health, never to a caller.
   */
  readonly roleAware?: true
  /**
   * Checks this Pack's parsed Scenario configuration against the Scenario's
   * roles and sides (both empty when it declares none). Run when a Scenario
   * compiles; each issue is refused at its path within the configuration.
   */
  readonly validateScenarioConfig?: (config: unknown, context: PackScenarioConfigContext) => ReadonlyArray<PackScenarioConfigIssue>
  /**
   * Operator roles this role-aware Pack derives from its parsed Scenario
   * configuration, such as one role per group of units. When a Scenario
   * declares roles, compile adds them after the declared ones; a Scenario
   * without roles is open mode and gets none. Controller roles stay
   * declared: compile refuses a derived controller role
   * (`derived_role_not_operator`), an id that repeats a declared role or
   * another derived one (`duplicate_role`), and a role that breaks the role
   * schema or, after `validateScenarioConfig`, the rules of what a role sees
   * (`derived_role_invalid`), each at the Pack's configuration. Derived roles
   * then count as declared everywhere: `validateScenarioConfig` receives
   * them, a declared preset may bundle them, the role dialog lists them,
   * screens hold them and core stamps them on viewers.
   */
  readonly scenarioRoles?: (config: unknown, context: PackScenarioRolesContext) => ReadonlyArray<ScenarioRole>
  readonly authoring?: PackScenarioAuthoringContribution
  readonly recording?: PackRecordingContribution
  readonly knowledge?: PackKnowledgeContribution
  readonly referenceData?: PackReferenceDataContribution
  readonly scenario?: PackScenarioSupport
  readonly interactions?: PackInteractionContribution
  readonly observation?: PackObservationContribution
}

/** What a Pack derives its roles against: the Scenario's sides, empty when it declares none. */
export interface PackScenarioRolesContext {
  readonly sides: ReadonlyArray<ScenarioSide>
}

/** The declarations a Pack's configuration is checked against. */
export interface PackScenarioConfigContext {
  /** The declared roles, then the roles every active Pack derives (`WorldPack.scenarioRoles`). */
  readonly roles: ReadonlyArray<ScenarioRole>
  readonly sides: ReadonlyArray<ScenarioSide>
}

export interface PackScenarioConfigIssue {
  /** Within the Pack's configuration. */
  readonly path: ReadonlyArray<string | number>
  readonly message: string
  /** A refusal code callers can tell apart, when the issue has one. */
  readonly code?: string
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
