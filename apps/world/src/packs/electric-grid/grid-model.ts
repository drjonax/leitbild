export type GridAssetKind = 'bus' | 'branch' | 'generator' | 'load' | 'storage'
export type GridBranchKind = 'ac_line' | 'cable' | 'transformer' | 'hvdc_link' | 'switch'
export type GridGenerationKind = 'hydro' | 'wind' | 'solar' | 'thermal' | 'nuclear' | 'battery' | 'import'
export type GridLoadKind = 'residential' | 'commercial' | 'hospital' | 'airport' | 'industry' | 'data_center' | 'ev_charging' | 'process_plant'
export type GridAssetLocation = readonly [number, number]

export interface GridModelFidelity {
  readonly powerFlow: 'dc'
  readonly voltage: 'approximate'
  readonly frequency: 'aggregate-dynamic'
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
  readonly reactancePu: number
  readonly resistancePu: number
  readonly weatherExposure: 'low' | 'medium' | 'high'
  readonly sourceId?: string
  readonly sourceFeatureId?: string
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
  readonly diagnostics: GridModelDiagnostics
}

export interface GridAutomationDefinition {
  readonly id: string
  readonly title: string
  readonly loadProfiles: boolean
  readonly storageFrequencyResponse: boolean
  readonly underFrequencyLoadShedding: boolean
  readonly primaryFrequencyResponseMwPerHz: number
  /** Largest frequency difference (Hz) between two energised islands at which close-branch may join them. */
  readonly synchroCheckHz: number
}

export interface CompiledGridDefinition {
  readonly gridId: string
  readonly model: GridModelDefinition
  readonly index: CompiledGridModelIndex
  readonly operatingPoint: GridOperatingPointDefinition
  readonly automation: GridAutomationDefinition
  readonly definitionDigest: string
}
