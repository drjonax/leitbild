import { z } from 'zod'
import { actorIdSchema, packIdSchema, objectIdSchema, type ActorId, type PackId, type ObjectId } from './ids.ts'
import { geoJsonGeometrySchema, geoJsonLineStringSchema, geoJsonPointSchema, metersSchema, type GeoJsonGeometry, type GeoJsonLineString, type GeoJsonPoint, type Meters } from './geo.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'
import { provenanceSchema, type Provenance } from './provenance.ts'
import { telemetryStateSchema, type TelemetryState } from './telemetry.ts'
import { alertStateSchema, type AlertState } from './alerts.ts'
import { objectContextSchema, type ObjectContext } from './context.ts'
import { objectAudienceSchema, type ObjectAudience } from './audience.ts'

export const objectKindSchema = z.enum(['mobile_entity', 'incident', 'facility', 'zone', 'patient', 'observation'])
export type ObjectKind = z.infer<typeof objectKindSchema>

export const objectLifecycleSchema = z.enum(['active', 'inactive', 'resolved', 'removed'])
export type ObjectLifecycle = z.infer<typeof objectLifecycleSchema>

export interface PositionFix {
  readonly point: GeoJsonPoint
  readonly headingDeg?: number
  readonly speedMps?: number
  readonly accuracyM?: Meters
  readonly observedAt: IsoTimestamp
  readonly staleAfterMs?: number
  /** The Run's simulation time of the fix, stamped by its Pack; `observedAt` is wall time. */
  readonly simAt?: IsoTimestamp
}

export interface RouteGeometry {
  readonly planned?: GeoJsonLineString
  readonly etaSeconds?: number
  readonly progress?: RouteProgress
  readonly impacts?: ReadonlyArray<RouteImpact>
  readonly source: 'simulator' | 'operator' | 'ai' | 'import'
}

export interface RouteProgress {
  readonly segmentIndex: number
  readonly remainingDistanceM?: Meters
  readonly advancedDistanceM?: Meters
  readonly updatedAt: IsoTimestamp
}

export interface RouteImpact {
  readonly source: { readonly kind: 'object' | 'runtime'; readonly id: string }
  readonly label: string
  readonly severity: 'low' | 'moderate' | 'high' | 'blocked'
  readonly speedFactor?: number
  readonly delaySeconds?: number
  readonly updatedAt: IsoTimestamp
}

export interface SpatialUncertainty {
  readonly kind: 'radius'
  readonly radiusM: Meters
  readonly confidence?: number
}

export interface SpatialReferenceFrame {
  readonly kind: 'wgs84'
}

export interface SpatialState {
  readonly position?: PositionFix
  readonly geometry?: GeoJsonGeometry
  readonly route?: RouteGeometry
  readonly uncertainty?: SpatialUncertainty
  readonly frame: SpatialReferenceFrame
}

export interface OperationalState {
  readonly status: string
  readonly priority?: 'low' | 'normal' | 'high' | 'critical'
  readonly intent?: string
  readonly mode: 'simulated' | 'live' | 'replay'
}

export interface TaskingState {
  readonly currentTaskId?: ObjectId
  readonly assignedBy?: ActorId
  readonly assignedAt?: IsoTimestamp
}

export interface OwnershipState {
  readonly ownerActorId: ActorId
  readonly lockMode: 'soft' | 'hard'
}

export interface CommunicationState {
  readonly state: 'connected' | 'degraded' | 'lost' | 'unknown'
  readonly lastContactAt?: IsoTimestamp
}

export interface ObjectTimestamps {
  /** Observation/acceptance wall time. Physical sample time belongs to Pack data. */
  readonly createdAt: IsoTimestamp
  /** Observation/acceptance wall time, consistent across all Packs. */
  readonly updatedAt: IsoTimestamp
}

export interface OperationalObject {
  readonly id: ObjectId
  readonly kind: ObjectKind
  readonly packId: PackId
  readonly label: string
  readonly lifecycle: ObjectLifecycle
  readonly revision: number
  readonly spatial: SpatialState
  readonly operational: OperationalState
  readonly telemetry?: TelemetryState
  readonly tasking?: TaskingState
  readonly alerts: ReadonlyArray<AlertState>
  readonly ownership?: OwnershipState
  readonly communication?: CommunicationState
  readonly provenance: Provenance
  readonly timestamps: ObjectTimestamps
  readonly packData?: unknown
  readonly context?: ObjectContext
  /** Whose picture holds the object in a Run that declares sides; see ObjectAudience. */
  readonly audience?: ObjectAudience
}

export const positionFixSchema = z.object({
  point: geoJsonPointSchema,
  headingDeg: z.number().finite().min(0).max(360).optional(),
  speedMps: z.number().finite().nonnegative().optional(),
  accuracyM: metersSchema.optional(),
  observedAt: isoTimestampSchema,
  staleAfterMs: z.number().finite().positive().optional(),
  simAt: isoTimestampSchema.optional(),
})

export const routeGeometrySchema = z.object({
  planned: geoJsonLineStringSchema.optional(),
  etaSeconds: z.number().finite().nonnegative().optional(),
  progress: z.object({
    segmentIndex: z.number().int().nonnegative(),
    remainingDistanceM: metersSchema.optional(),
    advancedDistanceM: metersSchema.optional(),
    updatedAt: isoTimestampSchema,
  }).optional(),
  impacts: z
    .array(
      z.object({
        source: z.object({ kind: z.enum(['object', 'runtime']), id: z.string().min(1) }).strict(),
        label: z.string().min(1),
        severity: z.enum(['low', 'moderate', 'high', 'blocked']),
        speedFactor: z.number().finite().min(0).max(1).optional(),
        delaySeconds: z.number().finite().nonnegative().optional(),
        updatedAt: isoTimestampSchema,
      }),
    )
    .optional(),
  source: z.enum(['simulator', 'operator', 'ai', 'import']),
})

export const spatialUncertaintySchema = z.object({
  kind: z.literal('radius'),
  radiusM: metersSchema,
  confidence: z.number().finite().min(0).max(1).optional(),
})

export const spatialStateSchema = z.object({
  position: positionFixSchema.optional(),
  geometry: geoJsonGeometrySchema.optional(),
  route: routeGeometrySchema.optional(),
  uncertainty: spatialUncertaintySchema.optional(),
  frame: z.object({ kind: z.literal('wgs84') }),
})

export const operationalStateSchema = z.object({
  status: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  intent: z.string().min(1).optional(),
  mode: z.enum(['simulated', 'live', 'replay']),
})

export const taskingStateSchema = z.object({
  currentTaskId: objectIdSchema.optional(),
  assignedBy: actorIdSchema.optional(),
  assignedAt: isoTimestampSchema.optional(),
})

export const ownershipStateSchema = z.object({
  ownerActorId: actorIdSchema,
  lockMode: z.enum(['soft', 'hard']),
})

export const communicationStateSchema = z.object({
  state: z.enum(['connected', 'degraded', 'lost', 'unknown']),
  lastContactAt: isoTimestampSchema.optional(),
})

export const objectTimestampsSchema = z.object({
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
})

export const operationalObjectSchema = z.object({
  id: objectIdSchema,
  kind: objectKindSchema,
  packId: packIdSchema,
  label: z.string().min(1),
  lifecycle: objectLifecycleSchema,
  revision: z.number().int().nonnegative(),
  spatial: spatialStateSchema,
  operational: operationalStateSchema,
  telemetry: telemetryStateSchema.optional(),
  tasking: taskingStateSchema.optional(),
  alerts: z.array(alertStateSchema),
  ownership: ownershipStateSchema.optional(),
  communication: communicationStateSchema.optional(),
  provenance: provenanceSchema,
  timestamps: objectTimestampsSchema,
  packData: z.unknown().optional(),
  context: objectContextSchema.optional(),
  audience: objectAudienceSchema.optional(),
})
