import type { Layer } from '@deck.gl/core'
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { GeoJsonLineString, GeoJsonPoint, GeoJsonPolygon, OperationalObject } from '../../core/model/index.ts'
import type { PackMapFeature, PackObjectPresentation, PackObjectStatusTone } from '../../core/packs/protocol.ts'
import type { MapPerformanceDiagnosticsSnapshot } from './map-performance-diagnostics.ts'
import type { SymbolAtlas } from './symbol-kit.ts'
import type { CameraInteraction } from '../map/map-camera.ts'

export type RenderPhase =
  | 'base'
  | 'reference'
  | 'operational-static'
  | 'operational-dynamic'
  | 'ui-overlay'

export type RenderFamily =
  | 'base-map'
  | 'reference-layers'
  | 'operational-points'
  | 'operational-paths'
  | 'operational-areas'
  | 'placement'
  | 'diagnostics'

export type ColorRgba = readonly [number, number, number, number]
export type Position2 = readonly [number, number]
export type Position3 = readonly [number, number, number]

export type MapFocusTarget =
  | { readonly kind: 'point'; readonly center: Position2 }
  | { readonly kind: 'bounds'; readonly bounds: readonly [Position2, Position2] }

export interface MapFocusRequest {
  readonly revision: number
  readonly target: MapFocusTarget
}

export interface OperationalPointFeature {
  readonly id: string
  readonly object: OperationalObject
  readonly position: Position3
  readonly symbolId: string
  readonly symbolAtlas: SymbolAtlas
  /** The Pack's opt-in map label; null draws none. */
  readonly label: string | null
  readonly color: ColorRgba
  readonly statusTone: PackObjectStatusTone
  readonly selected: boolean
  readonly highlighted: boolean
  readonly hasNewInfo: boolean
  readonly muted: boolean
  readonly sizePx: number
  readonly rotationDeg: number
  readonly priority: number
  readonly signature: string
}

export interface OperationalPathFeature {
  readonly id: string
  readonly kind: 'route' | 'object-line'
  readonly path: ReadonlyArray<Position2>
  readonly color: ColorRgba
  readonly casingColor: ColorRgba
  readonly widthPx: number
  readonly selected: boolean
  readonly priority: number
  readonly signature: string
}

export interface OperationalSymbolFeature {
  readonly layerId: string
  readonly id: string
  readonly position: Position3
  readonly symbolId: string
  readonly symbolAtlas: SymbolAtlas
  readonly color: ColorRgba
  readonly opacity: number
  readonly sizePx: number
  readonly summary: string
  readonly signature: string
}

export interface MapAssignmentHandleFeature {
  readonly id: string
  readonly controllerId: string
  readonly position: Position3
}

export interface MapAssignmentInteraction {
  readonly revision: number
  readonly active: boolean
  readonly anchor: Position3 | null
  readonly pointer: Position3 | null
  readonly handles: ReadonlyArray<MapAssignmentHandleFeature>
}

export interface OperationalRenderInput {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
  readonly highlightedObjectIds: ReadonlyArray<string>
  /** Objects the screen sees but may not order (`targeting.mutedOnMap`): drawn muted. */
  readonly mutedObjectIds?: ReadonlyArray<string>
  readonly hiddenObjectCategoryIds: ReadonlyArray<string>
  readonly placementPoints: ReadonlyArray<GeoJsonPoint>
  readonly packFeatures: ReadonlyArray<PackMapFeature>
  readonly hasNewInfo: (object: OperationalObject) => boolean
  readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
}

export interface OperationalRenderSnapshot {
  readonly points: ReadonlyArray<OperationalPointFeature>
  readonly paths: ReadonlyArray<OperationalPathFeature>
  readonly areaSymbols: ReadonlyArray<OperationalSymbolFeature>
  readonly placementPoints: ReadonlyArray<Position3>
  readonly revisions: {
    readonly points: number
    readonly paths: number
    readonly areaSymbols: number
    readonly placement: number
  }
}

export interface MapRuntimeLayers {
  readonly deckLayers: ReadonlyArray<Layer>
}

export interface MapRuntimeDiagnosticPhaseReport {
  readonly phase: RenderPhase | 'runtime'
  readonly status: 'running' | 'ready' | 'failed'
  readonly message: string
  readonly details?: ReadonlyArray<MapRuntimeDiagnosticDetail>
  readonly error?: MapRuntimeError
}

export interface MapRuntimeError {
  readonly phase: RenderPhase | 'runtime'
  readonly message: string
  readonly sourceId?: string
  readonly recoverable: boolean
}

export interface MapRuntimeDiagnosticDetail {
  readonly label: string
  readonly value: string
}

export interface MapRuntimeDiagnostic {
  readonly phase: RenderPhase | 'runtime'
  readonly status: 'pending' | 'running' | 'ready' | 'failed'
  readonly message: string
  readonly startedAtMs: number
  readonly completedAtMs?: number
  readonly details: ReadonlyArray<MapRuntimeDiagnosticDetail>
}

export interface MapRuntimeDiagnosticsSnapshot {
  readonly phases: ReadonlyArray<MapRuntimeDiagnostic>
  readonly latestError?: MapRuntimeError
  readonly performance?: MapPerformanceDiagnosticsSnapshot
}

/** Takes over a MapLibre `error` event when it returns true; the claimant then reports any failure. */
export type MapErrorClaim = (event: unknown) => boolean

export interface MapRuntimeHandle {
  readonly map: MapLibreMap
  /** Lets a component that owns an error's cause handle it before the runtime warns or fails; returns the release. */
  readonly claimErrors: (claim: MapErrorClaim) => () => void
  readonly updateLayers: (layers: MapRuntimeLayers) => void
  readonly reportDiagnosticPhase: (report: MapRuntimeDiagnosticPhaseReport) => void
  readonly setDiagnosticDetails: (
    phase: RenderPhase | 'runtime',
    details: ReadonlyArray<MapRuntimeDiagnosticDetail>,
  ) => void
  readonly setStyleUrl: (styleUrl: string) => Promise<void>
  readonly resize: () => void
  readonly setCameraInteraction: (interaction: CameraInteraction) => void
  /** How far around a press the map picks operational objects, in px (`map/map-pointer.ts`, `pickingRadiusFor`). */
  readonly setPickingRadius: (radiusPx: number) => void
  /**
   * Every object of the named layers under a screen point, within the
   * current picking radius, top first, as the deck overlay picks them; at most
   * `depth`. A point on the map's canvas, in CSS px from its top left.
   */
  readonly pickObjectsAt: (screen: { readonly x: number; readonly y: number }, layerIds: ReadonlyArray<string>, depth: number) => ReadonlyArray<{ readonly object?: unknown }>
  readonly diagnostics: () => MapRuntimeDiagnosticsSnapshot
  readonly destroy: () => void
}

export interface MapFeatureProjectionContext {
  readonly selectedControllerId: string | null
  readonly highlightedObjectIds: ReadonlySet<string>
  readonly mutedObjectIds: ReadonlySet<string>
  readonly hiddenObjectCategoryIds: ReadonlySet<string>
  readonly hasNewInfo: (object: OperationalObject) => boolean
  readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
}

export const lineStringPositions = (geometry: GeoJsonLineString): ReadonlyArray<Position2> =>
  geometry.coordinates.map(coordinate => [coordinate[0], coordinate[1]] as const)

export const pointPosition = (point: GeoJsonPoint): Position3 =>
  [point.coordinates[0], point.coordinates[1], 0]
