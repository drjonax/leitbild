import type { LonLat, TopologyStationGeometry } from './geometry.ts'
import type { TopologyLedgerEntry } from './ledger.ts'

// Source-neutral input of the topology compiler. Adapters turn a sidecar into these features;
// the compiler never reads source tags. Vertex keys identify electrical nodes: two vertices with
// the same key are the same node (OSM node id, or a rounded coordinate for sources without ids).

export type TopologySystem = 'ac50' | 'hvdc' | 'traction'
export type TopologyLifecycle = 'operational' | 'construction' | 'proposed' | 'disused' | 'abandoned'
export type TopologyKeyMode = 'osm-node' | 'coordinate'
export type ExternalArea = 'SE1' | 'SE2' | 'SE3' | 'FI' | 'DK1' | 'NL' | 'DE' | 'GB'

export type TopologyLevelInput = {
  readonly voltageKv: number | null      // null: the way carries a circuit whose voltage is not mapped
  readonly system: TopologySystem
  readonly circuits: number | null       // circuits at this level on this way; null when not mapped
  readonly circuitsSource: 'circuits-tag' | 'voltage-list' | null   // a per-circuit voltage list counts circuits
}

export type TopologyLineInput = {
  readonly kind: 'line' | 'cable'
  readonly featureId: string
  readonly osmWayIds: ReadonlyArray<string>
  readonly name: string | null
  readonly operator: string | null
  readonly lifecycle: TopologyLifecycle
  readonly levels: ReadonlyArray<TopologyLevelInput>
  readonly cables: number | null         // conductor count of the way (single-level ways only)
  readonly coordinates: ReadonlyArray<LonLat>
  readonly vertexKeys: ReadonlyArray<string>
  readonly terminalVertexIndices: ReadonlyArray<number>   // way ends and portal nodes
}

export type TopologyBusbarInput = {
  readonly kind: 'busbar'
  readonly featureId: string
  readonly osmWayIds: ReadonlyArray<string>
  readonly lifecycle: TopologyLifecycle
  readonly coordinates: ReadonlyArray<LonLat>
  readonly vertexKeys: ReadonlyArray<string>
}

export type TopologyStationInput = {
  readonly kind: 'substation' | 'plant'
  readonly featureId: string
  readonly name: string | null
  readonly operator: string | null
  readonly role: string | null                       // OSM substation=* or plant:source
  readonly lifecycle: TopologyLifecycle
  readonly voltagesKv: ReadonlyArray<number>         // tagged levels; empty when untagged
  readonly systems: ReadonlyArray<TopologySystem>    // tagged systems; empty when untagged
  readonly memberFeatureIds: ReadonlyArray<string>   // members of a site/substation relation
  readonly geometry: TopologyStationGeometry | null   // null: a site relation that only groups its members
}

export type TopologyTransformerInput = {
  readonly kind: 'transformer'
  readonly featureId: string
  readonly lifecycle: TopologyLifecycle
  readonly location: LonLat
  readonly voltagesKv: ReadonlyArray<number>         // windings, any order
  readonly ratingMva: number | null
}

export type TopologyRouteInput = {
  readonly kind: 'route'
  readonly featureId: string                          // relation/<id> of a route=power circuit
  readonly lifecycle: TopologyLifecycle
  readonly voltagesKv: ReadonlyArray<number>
  readonly osmWayIds: ReadonlyArray<string>
}

export type TopologyInputFeature =
  | TopologyLineInput
  | TopologyBusbarInput
  | TopologyStationInput
  | TopologyTransformerInput
  | TopologyRouteInput

export type TopologyInput = {
  readonly sourceId: string
  readonly keyMode: TopologyKeyMode
  readonly features: ReadonlyArray<TopologyInputFeature>
  readonly adapterLedger: ReadonlyArray<TopologyLedgerEntry>
}

// One cross-border link. The compiler finds it in the source geometry through its listed ways and
// verifies it: the mapped route must start at the listed Norwegian station and leave the extract
// (a free way end abroad or at a landfall), never end at another station.
export type TopologyInterconnector = {
  readonly id: string                                // ac:<slug> or hvdc:<slug>
  readonly label: string
  readonly kind: 'ac' | 'hvdc'
  readonly externalArea: ExternalArea
  readonly voltageKv: number                         // AC level, or the highest DC pole voltage
  readonly norwegianStationId: string                // station feature id (AC terminal or HVDC converter)
  readonly osmWayIds: ReadonlyArray<string>
  readonly sources: ReadonlyArray<string>
}

export type TopologyInterconnectorTable = {
  readonly sourceId: string
  readonly interconnectors: ReadonlyArray<TopologyInterconnector>
}
