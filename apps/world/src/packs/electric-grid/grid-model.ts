import type { GridAutomation } from './schemas/grid-automation.ts'

export type GridAssetKind = 'bus' | 'branch' | 'generator' | 'load' | 'storage'
export type GridBranchKind = 'ac_line' | 'cable' | 'transformer' | 'hvdc_link' | 'switch'
export type GridGenerationKind = 'hydro' | 'wind' | 'solar' | 'thermal' | 'nuclear' | 'battery' | 'import'
export type GridLoadKind = 'residential' | 'commercial' | 'hospital' | 'airport' | 'industry' | 'data_center' | 'ev_charging' | 'process_plant'
export type GridAssetLocation = readonly [number, number]

/** Where a value comes from and how it was obtained; a note is given for inferred and curated values. */
export interface GridAssetProvenance {
  readonly sources: ReadonlyArray<string>
  readonly method: 'mapped' | 'registry' | 'measured' | 'inferred' | 'curated'
  readonly confidence: 'high' | 'medium' | 'low'
  readonly note?: string | undefined
}

export interface GridModelFidelity {
  readonly powerFlow: 'dc'
  /** The DC model computes no voltage; live buses report nominal voltage marked dc-nominal. */
  readonly voltage: 'not-modelled'
  /** One swing equation per synchronous island. */
  readonly frequency: 'island-swing'
  readonly recommendedMaximumBusCount: number
}

export interface GridModelSourceBuild {
  readonly id: string
  readonly generatedAt: string
}

export interface GridBusDefinition {
  readonly id: string
  readonly label: string
  readonly nominalKv: number
  readonly location: GridAssetLocation
  readonly sourceId?: string
  readonly sourceFeatureId?: string
  readonly provenance?: GridAssetProvenance | undefined
}

export interface GridBranchDefinition {
  readonly id: string
  readonly label: string
  readonly kind: GridBranchKind
  readonly fromBusId: string
  readonly toBusId: string
  readonly nominalKv: number
  readonly ratingMw: number
  readonly emergencyRatingMw: number
  /** How long the branch may carry its emergency rating; absent in v1 Models, where the Automation's branch protection gives it. */
  readonly emergencyDurationSeconds?: number | undefined
  readonly reactancePu: number
  readonly resistancePu: number
  readonly weatherExposure: 'low' | 'medium' | 'high'
  readonly sourceId?: string
  readonly sourceFeatureId?: string
  readonly provenance?: GridAssetProvenance | undefined
}

export type GridExternalArea = 'SE1' | 'SE2' | 'SE3' | 'SE4' | 'FI' | 'DK1' | 'NL' | 'DE' | 'GB'

/**
 * A neighbouring system behind boundary buses. A synchronous system shares frequency with the
 * Norwegian island that holds its boundary bus and joins that island's swing equation; an
 * asynchronous one only terminates HVDC links.
 */
export interface GridExternalSystemDefinition {
  readonly id: string
  readonly label: string
  readonly area: GridExternalArea | 'nordic-remainder'
  readonly synchronous: boolean
  readonly boundaryBusIds: ReadonlyArray<string>
  /** Kinetic energy E_k in GWs; required when synchronous. */
  readonly inertiaGws?: number | undefined
  /** Demand that provides load self-regulation; required when synchronous. */
  readonly loadMw?: number | undefined
  /** FCR-N strength held by the system (MW/Hz); FCR-N is fully activated at the Automation's deviation. */
  readonly fcrNMwPerHz?: number | undefined
  readonly fcrDUpMw?: number | undefined
  readonly fcrDDownMw?: number | undefined
  readonly afrrUpMw?: number | undefined
  readonly afrrDownMw?: number | undefined
  readonly provenance: GridAssetProvenance
}

/** A point-to-point HVDC link: two converter injections with a set-point, ramp limit and converter losses; never an AC branch. */
export interface GridHvdcLinkDefinition {
  readonly id: string
  readonly label: string
  /** Norwegian converter AC bus. */
  readonly fromBusId: string
  /** Boundary bus of an external system, or another Norwegian bus. */
  readonly toBusId: string
  readonly ratingMw: number
  /** Losses of both converters and the cable as a percentage of the sent power. */
  readonly lossPercent: number
  readonly rampMwPerMinute: number
  readonly osmWayIds: ReadonlyArray<string>
  readonly provenance: GridAssetProvenance
}

export interface GridGeneratorDefinition {
  readonly id: string
  readonly label: string
  readonly kind: GridGenerationKind
  readonly busId: string
  readonly location: GridAssetLocation
  readonly capacityMw: number
  readonly availableMw: number
  readonly reserveMw: number
  readonly rampRateMwPerMinute: number
  readonly inertiaSeconds: number
  readonly annualProductionGwh?: number
  readonly operator?: string
  readonly priceArea?: string
  readonly sourceId?: string
  readonly sourceFeatureId?: string
}

export interface GridLoadDefinition {
  readonly id: string
  readonly label: string
  readonly kind: GridLoadKind
  readonly busId: string
  readonly location: GridAssetLocation
  readonly demandMw: number
  readonly criticalMw: number
  readonly reactiveDemandMvar: number
  readonly priority: 'critical' | 'high' | 'normal' | 'low'
  readonly controllable: boolean
  readonly sourceId?: string
  readonly sourceFeatureId?: string
}

export interface GridStorageDefinition {
  readonly id: string
  readonly label: string
  readonly busId: string
  readonly location: GridAssetLocation
  readonly capacityMwh: number
  readonly maxChargeMw: number
  readonly maxDischargeMw: number
  readonly sourceId?: string
  readonly sourceFeatureId?: string
}

export interface GridConnectionPointDefinition {
  readonly id: string
  readonly label: string
  readonly busId: string
  readonly nominalKv: number
  /** Maximum power leaving the Grid through this point. */
  readonly maximumExportMw: number
  /** Maximum power entering the Grid through this point. */
  readonly maximumImportMw: number
}

export interface GridModelDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly nominalFrequencyHz: number
  readonly fidelity: GridModelFidelity
  readonly sourceBuild: GridModelSourceBuild
  readonly sourceIds: ReadonlyArray<string>
  readonly buses: ReadonlyArray<GridBusDefinition>
  readonly branches: ReadonlyArray<GridBranchDefinition>
  readonly generators: ReadonlyArray<GridGeneratorDefinition>
  readonly loads: ReadonlyArray<GridLoadDefinition>
  readonly storage: ReadonlyArray<GridStorageDefinition>
  readonly connectionPoints: ReadonlyArray<GridConnectionPointDefinition>
  /** Absent means the Model has none. */
  readonly externalSystems?: ReadonlyArray<GridExternalSystemDefinition>
  readonly hvdcLinks?: ReadonlyArray<GridHvdcLinkDefinition>
}

export interface GridOperatingPointDefinition {
  readonly id: string
  readonly title: string
  readonly loadScale: number
  readonly generationAvailabilityScale: number
  readonly storageStateOfCharge: number
}

export type GridAssetDefinition = GridBusDefinition | GridBranchDefinition | GridGeneratorDefinition | GridLoadDefinition | GridStorageDefinition

export type GridAssetIndexEntry =
  | { readonly id: string; readonly label: string; readonly kind: 'bus'; readonly definition: GridBusDefinition }
  | { readonly id: string; readonly label: string; readonly kind: 'branch'; readonly definition: GridBranchDefinition }
  | { readonly id: string; readonly label: string; readonly kind: 'generator'; readonly definition: GridGeneratorDefinition }
  | { readonly id: string; readonly label: string; readonly kind: 'load'; readonly definition: GridLoadDefinition }
  | { readonly id: string; readonly label: string; readonly kind: 'storage'; readonly definition: GridStorageDefinition }

export interface GridModelDiagnostics {
  readonly assetCount: number
  readonly topologyComponentCount: number
  readonly isolatedBusCount: number
}

export interface CompiledGridModelIndex {
  readonly assets: ReadonlyArray<GridAssetIndexEntry>
  readonly assetById: ReadonlyMap<string, GridAssetIndexEntry>
  readonly busById: ReadonlyMap<string, GridBusDefinition>
  readonly branchesByBus: ReadonlyMap<string, ReadonlyArray<GridBranchDefinition>>
  readonly generatorsByBus: ReadonlyMap<string, ReadonlyArray<GridGeneratorDefinition>>
  readonly loadsByBus: ReadonlyMap<string, ReadonlyArray<GridLoadDefinition>>
  readonly storageByBus: ReadonlyMap<string, ReadonlyArray<GridStorageDefinition>>
  readonly staticComponentByBus: ReadonlyMap<string, string>
  /** The Model's external systems and HVDC links, empty when it declares none. */
  readonly externalSystems: ReadonlyArray<GridExternalSystemDefinition>
  readonly hvdcLinks: ReadonlyArray<GridHvdcLinkDefinition>
  /** Synchronous external systems by their (single) boundary bus. */
  readonly synchronousExternalByBus: ReadonlyMap<string, GridExternalSystemDefinition>
  /** Boundary buses of asynchronous external systems: HVDC terminals outside the modelled AC network. */
  readonly asynchronousBoundaryBusIds: ReadonlySet<string>
  readonly diagnostics: GridModelDiagnostics
}

export interface CompiledGridDefinition {
  readonly gridId: string
  readonly model: GridModelDefinition
  readonly index: CompiledGridModelIndex
  readonly operatingPoint: GridOperatingPointDefinition
  readonly automation: GridAutomation
  readonly definitionDigest: string
}
