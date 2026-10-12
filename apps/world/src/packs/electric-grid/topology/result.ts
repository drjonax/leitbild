import type { LonLat } from './geometry.ts'
import type { ExternalArea, TopologyKeyMode } from './input.ts'
import type { TopologyLedgerEntry } from './ledger.ts'
import type { TopologyOptions } from './options.ts'

// Output shapes map 1:1 onto Grid Model v2 buses/branches/hvdc links (contract-grid-model-v2):
// the model build adds price areas, electrical parameters and ratings.

export type TopologyProvenance = {
  readonly sources: ReadonlyArray<string>
  readonly method: 'mapped' | 'inferred' | 'curated'
  readonly confidence: 'high' | 'medium' | 'low'
  readonly note: string | null
}

export type TopologyBus = {
  readonly id: string
  readonly label: string
  readonly kind: 'substation' | 'plant-terminal' | 'junction' | 'boundary'
  readonly stationId: string | null                 // groups the voltage levels of one station
  readonly stationFeatureIds: ReadonlyArray<string> // all station features unified into the station
  readonly stationRoles: ReadonlyArray<string>      // OSM substation=* roles (converter, traction, …)
  readonly vertexKey: string | null                 // junction node key
  readonly mergedBusIds: ReadonlyArray<string>      // buses joined into this one by a zero-impedance merge
  readonly mergedJunctionLocations: ReadonlyArray<LonLat> // tee vertices among them, where line ends now meet this bus
  readonly nominalKv: number
  readonly location: LonLat
  readonly externalArea: ExternalArea | null
  readonly provenance: TopologyProvenance
}

/** The free way end where an interconnector's mapped route leaves the source extract: its vertex key and location. */
export type TopologyForeignEnd = { readonly key: string; readonly location: LonLat }

export type TopologyCircuitsSource = 'route-relation' | 'circuits-tag' | 'voltage-list' | 'cables-tag' | 'inferred' | 'transformer-count'

export type TopologyBranch = {
  readonly id: string
  readonly label: string
  readonly kind: 'ac_line' | 'cable' | 'transformer'
  readonly fromBusId: string
  readonly toBusId: string
  readonly nominalKv: number                        // transformer: high side
  readonly lowKv: number | null                     // transformer: low side
  readonly lengthKm: number | null                  // corridor length (null for transformers)
  readonly cableLengthKm: number | null
  readonly circuits: number
  readonly circuitsSource: TopologyCircuitsSource
  readonly voltageSource: 'mapped' | 'inherited'
  readonly ratingMva: number | null                 // transformer nameplate total, where every unit is mapped
  readonly osmWayIds: ReadonlyArray<string>
  readonly sourceFeatureIds: ReadonlyArray<string>
  readonly osmTransformerIds: ReadonlyArray<string>
  readonly names: ReadonlyArray<string>
  readonly parallelSpanGroups: number               // phase-split/parallel span groups merged into the corridor
  readonly interconnectorId: string | null
  readonly foreignEnd: TopologyForeignEnd | null    // an interconnector tie: where its mapped route leaves the source extract abroad
  readonly provenance: TopologyProvenance
}

export type TopologyHvdcLink = {
  readonly id: string
  readonly label: string
  readonly fromBusId: string                        // Norwegian converter AC bus
  readonly toBusId: string                          // boundary bus
  readonly converterStationId: string
  readonly dcVoltagesKv: ReadonlyArray<number>
  readonly lengthKm: number
  readonly osmWayIds: ReadonlyArray<string>
  readonly sourceFeatureIds: ReadonlyArray<string>
  readonly foreignEnd: TopologyForeignEnd           // where its mapped route leaves the source extract abroad
  readonly provenance: TopologyProvenance
}

export type TopologyBoundary = {
  readonly busId: string
  readonly externalArea: ExternalArea
  readonly kind: 'ac' | 'hvdc'
  readonly nominalKv: number
  readonly interconnectorIds: ReadonlyArray<string>
}

export type TopologySummary = {
  readonly buses: Readonly<Record<TopologyBus['kind'], number>>
  readonly branches: Readonly<Record<TopologyBranch['kind'], number>>
  readonly hvdcLinks: number
  readonly boundaries: number
  readonly levelsKv: ReadonlyArray<number>          // AC levels of Norwegian buses
  readonly ledger: Readonly<Record<string, number>>
}

export type TopologyResult = {
  readonly sourceId: string
  readonly interconnectorSourceId: string
  readonly curationSourceId: string
  readonly keyMode: TopologyKeyMode
  readonly options: TopologyOptions
  readonly buses: ReadonlyArray<TopologyBus>
  readonly branches: ReadonlyArray<TopologyBranch>
  readonly hvdcLinks: ReadonlyArray<TopologyHvdcLink>
  readonly boundaries: ReadonlyArray<TopologyBoundary>
  readonly ledger: ReadonlyArray<TopologyLedgerEntry>
  readonly summary: TopologySummary
}
