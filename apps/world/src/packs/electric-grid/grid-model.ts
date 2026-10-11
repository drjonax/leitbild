import type { GridAutomation } from './schemas/grid-automation.ts'

export type GridAssetKind = 'bus' | 'branch' | 'generator' | 'load' | 'storage'
export type GridBranchKind = 'ac_line' | 'cable' | 'transformer'
export type GridGenerationKind = 'hydro' | 'wind' | 'solar' | 'thermal' | 'nuclear'
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
  /** Active power flows and every island's balance from the DC solve. */
  readonly powerFlow: 'dc'
  /**
   * Bus voltages, reactive power and branch losses from a fast-decoupled AC load flow of every
   * energised island after each DC solve; an island whose load flow does not converge publishes no voltage.
   */
  readonly voltage: 'ac-fdlf'
  /** One swing equation per synchronous island. */
  readonly frequency: 'island-swing'
  readonly recommendedMaximumBusCount: number
}

export interface GridModelSourceBuild {
  readonly id: string
  /** Newest input snapshot of the build; the build records no wall-clock time. */
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

/** A π-model branch; impedances are per unit on the Model's sBaseMva for all circuits in parallel. */
export interface GridBranchDefinition {
  readonly id: string
  readonly label: string
  readonly kind: GridBranchKind
  readonly fromBusId: string
  readonly toBusId: string
  /** Transformer: high-side kV. */
  readonly nominalKv: number
  /** Lines and cables only. */
  readonly lengthKm?: number | undefined
  readonly circuits: number
  /** Continuous rating of all circuits together. */
  readonly ratingMw: number
  readonly emergencyRatingMw: number
  /** How long the emergency rating may be carried. */
  readonly emergencyDurationSeconds: number
  readonly reactancePu: number
  readonly resistancePu: number
  /** Total line charging B of the branch, split equally between its ends. */
  readonly chargingSusceptancePu: number
  /** Off-nominal turns ratio at the from end; present for transformers only. */
  readonly tapRatio?: number | undefined
  readonly sourceId?: string
  readonly sourceFeatureId?: string
  readonly provenance?: GridAssetProvenance | undefined
}

/** A fixed or switchable bus shunt; its reactive power scales with the square of the bus voltage. */
export interface GridShuntDefinition {
  readonly id: string
  readonly busId: string
  /** At 1 pu: negative for a reactor (absorbs), positive for a capacitor. */
  readonly mvarAtNominalVoltage: number
  readonly switchable: boolean
  readonly provenance: GridAssetProvenance
}

export type GridExternalArea = 'SE1' | 'SE2' | 'SE3' | 'SE4' | 'FI' | 'DK1' | 'NL' | 'DE' | 'GB'

/**
 * A neighbouring system behind boundary buses. A synchronous system shares frequency with every
 * Norwegian component holding one of its boundary buses: they form one synchronous island with it
 * and it joins that island's swing equation. An asynchronous one only terminates HVDC links.
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
  /**
   * Required when synchronous: the share of the system's exchange with Norway (schedule and
   * response) entering at each of its areas, and that area's boundary buses. Within an area the
   * buses share by the rating of their closed ties.
   */
  readonly areaParticipation?: ReadonlyArray<{ readonly area: GridExternalArea; readonly share: number; readonly boundaryBusIds: ReadonlyArray<string> }> | undefined
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

/** Lifecycle state a generator starts in, from the Operating Point. */
export type GridGeneratorInitialState = 'online' | 'offline' | 'tripped'

export interface GridGeneratorDefinition {
  readonly id: string
  readonly label: string
  readonly kind: GridGenerationKind
  readonly busId: string
  readonly location: GridAssetLocation
  readonly capacityMw: number
  readonly ratedMva: number
  /** Rated power factor: the reactive limit is ratedMva·√(1 − powerFactor²). */
  readonly powerFactor: number
  /** Bus voltage the unit holds while it controls voltage. */
  readonly voltageSetpointPu: number
  /** H on ratedMva; 0 for converter-connected units. */
  readonly inertiaSeconds: number
  /** Synchronous machines hold island voltage and frequency; converter-connected units follow them. */
  readonly synchronous: boolean
  readonly minimumStableMw: number
  readonly blackStartCapable: boolean
  readonly rampRateMwPerMinute: number
  /** Availability at the Operating Point. */
  readonly availableMw: number
  readonly initialState: GridGeneratorInitialState
  /**
   * Set-point at the Operating Point for a unit that starts online (MW): the starting dispatch keeps
   * this pattern and shares only the island's remaining imbalance; null when the unit has none of
   * its own (offline, or online without a target), so it shares the residual by its range.
   */
  readonly initialTargetMw: number | null
  readonly annualProductionGwh?: number
  readonly priceArea?: string
  readonly sourceId?: string
  readonly sourceFeatureId?: string
  readonly provenance?: GridAssetProvenance | undefined
}

export interface GridLoadDefinition {
  readonly id: string
  readonly label: string
  readonly kind: GridLoadKind
  readonly busId: string
  readonly location: GridAssetLocation
  /** Demand at the Operating Point before its load scale (MW). */
  readonly demandMw: number
  /** Demand that neither manual nor automatic shedding disconnects. */
  readonly criticalMw: number
  /** Reactive demand is P·tan(acos powerFactor), lagging. */
  readonly powerFactor: number
  readonly priority: 'critical' | 'high' | 'normal' | 'low'
  /** Contractually or technically curtailable demand; 0 when unknown (the provenance says so). */
  readonly interruptibleMw: number
  readonly sourceId?: string
  readonly sourceFeatureId?: string
  readonly provenance?: GridAssetProvenance | undefined
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
  /** Base power of the per-unit impedances. */
  readonly sBaseMva: number
  readonly fidelity: GridModelFidelity
  readonly sourceBuild: GridModelSourceBuild
  readonly sourceIds: ReadonlyArray<string>
  readonly buses: ReadonlyArray<GridBusDefinition>
  readonly branches: ReadonlyArray<GridBranchDefinition>
  readonly shunts: ReadonlyArray<GridShuntDefinition>
  readonly generators: ReadonlyArray<GridGeneratorDefinition>
  readonly loads: ReadonlyArray<GridLoadDefinition>
  readonly storage: ReadonlyArray<GridStorageDefinition>
  readonly connectionPoints: ReadonlyArray<GridConnectionPointDefinition>
  readonly externalSystems: ReadonlyArray<GridExternalSystemDefinition>
  readonly hvdcLinks: ReadonlyArray<GridHvdcLinkDefinition>
}

/** The Operating Point values the runtime applies when a Grid starts; generator states and availability are in the Model's generators. */
export interface GridOperatingPointDefinition {
  readonly id: string
  readonly title: string
  /** Multiplies every load's demandMw. */
  readonly loadScale: number
  /** Multiplies every generator's availableMw (1 leaves it as the Operating Point sets it). */
  readonly generationAvailabilityScale: number
  /** Initial charge of every storage asset; null when the Operating Point gives none (a Model with storage then fails to start). */
  readonly storageStateOfCharge: number | null
  /** Initial HVDC set-points (MW, positive from the link's fromBusId), one per link. */
  readonly hvdcSetpoints: ReadonlyArray<{ readonly linkId: string; readonly setpointMw: number }>
  /** Scheduled export of each synchronous external system's exchange (MW, positive from Norway), one per system. */
  readonly externalExchanges: ReadonlyArray<{ readonly systemId: string; readonly scheduledExportMw: number }>
  /** Initial switching state and available fraction of the rating of each branch, one per branch in model order. */
  readonly branchStates: ReadonlyArray<{ readonly branchId: string; readonly state: 'closed' | 'open'; readonly availability: number }>
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
  readonly shuntsByBus: ReadonlyMap<string, ReadonlyArray<GridShuntDefinition>>
  readonly staticComponentByBus: ReadonlyMap<string, string>
  /** The Model's external systems and HVDC links, empty when it declares none. */
  readonly externalSystems: ReadonlyArray<GridExternalSystemDefinition>
  readonly hvdcLinks: ReadonlyArray<GridHvdcLinkDefinition>
  /** The synchronous external system (at most one) by each of its boundary buses. */
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
