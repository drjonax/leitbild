// Minimal, model-version-independent graph that the grid audit measures.
// Adapters build it from a Grid Model (v1 today, v2 later) plus optional reference geometry.
// Fields the source model cannot supply are absent, and the audit reports the dependent
// checks as not measurable instead of guessing.

export type LonLat = readonly [lon: number, lat: number]

export type AuditBusKind = 'substation' | 'junction' | 'boundary' | 'plant-terminal' | 'connection-point'
export type AuditBranchKind = 'ac_line' | 'cable' | 'transformer'
export type AuditGeneratorFamily = 'hydro' | 'wind' | 'solar' | 'thermal' | 'nuclear'
/** Distributed loads are area aggregates (municipality, zone); site loads are point consumers. */
export type AuditLoadFamily = 'distributed' | 'site'

/** Footprint of the OSM feature a bus stands for: polygon rings, or a point with a capture radius. */
export type AuditFootprint =
  | { readonly kind: 'polygon'; readonly polygons: ReadonlyArray<ReadonlyArray<ReadonlyArray<LonLat>>> }
  | { readonly kind: 'point'; readonly location: LonLat }

export interface AuditBus {
  readonly id: string
  readonly label: string
  readonly kind: AuditBusKind
  readonly nominalKv: number
  readonly location: LonLat
  /** OSM id of the station feature, `<node|way|relation>/<number>`; groups voltage levels of one station. */
  readonly substationId?: string
  readonly priceArea?: string
  readonly externalArea?: string
  readonly curationIds: ReadonlyArray<string>
  readonly footprint?: AuditFootprint
}

export interface AuditBranch {
  readonly id: string
  readonly label: string
  readonly kind: AuditBranchKind
  readonly fromBusId: string
  readonly toBusId: string
  readonly nominalKv: number
  readonly lengthKm?: number
  readonly circuits: number
  /** Source way identity; empty when the model does not carry it. */
  readonly osmWayIds: ReadonlyArray<string>
  readonly curationIds: ReadonlyArray<string>
  /** Geometric line ends paired to the from/to terminals, when reference geometry is available. */
  readonly ends?: { readonly from: LonLat; readonly to: LonLat }
  /** Mapped line geometry (one or more polylines), when reference geometry is available. */
  readonly geometry?: ReadonlyArray<ReadonlyArray<LonLat>>
}

export interface AuditHvdcLink {
  readonly id: string
  readonly label: string
  readonly fromBusId: string
  readonly toBusId: string
  readonly ratingMw?: number
  readonly osmWayIds: ReadonlyArray<string>
  readonly curationIds: ReadonlyArray<string>
}

export interface AuditGenerator {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly family: AuditGeneratorFamily
  readonly busId: string
  readonly capacityMw: number
  readonly priceArea?: string
  readonly attachmentKm: number
}

export interface AuditLoad {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly family: AuditLoadFamily
  readonly busId: string
  readonly demandMw: number
  readonly priceArea?: string
  readonly attachmentKm: number
}

export interface AuditGraph {
  readonly modelId: string
  readonly modelKind: 'grid-model-v1' | 'grid-model-v2'
  /**
   * True when each station voltage level is its own bus (v2). False when a station is one bus at
   * its highest voltage with every line attached (v1); voltage levels are then read from branches.
   */
  readonly busPerVoltageLevel: boolean
  /** ISO hour the model's demand describes; absent when the model does not declare one. */
  readonly referenceHour?: string
  readonly buses: ReadonlyArray<AuditBus>
  readonly branches: ReadonlyArray<AuditBranch>
  readonly hvdcLinks: ReadonlyArray<AuditHvdcLink>
  readonly generators: ReadonlyArray<AuditGenerator>
  readonly loads: ReadonlyArray<AuditLoad>
}

export const osmIdPattern = /^(node|way|relation)\/[1-9][0-9]*$/
