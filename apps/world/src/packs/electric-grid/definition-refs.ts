import type { GridConnectionPointDefinition, GridModelFidelity } from './grid-model.ts'

// The one Electric Grid Definition catalog. Authoring, scenario expansion, recording estimates
// and the catalog query read it without loading or compiling a model: it does no filesystem
// access. The loader in definitions.ts checks on first load that each model matches its entry.

export const norwayGridModelRef = 'electric-grid.norway.transmission'
export const haldenFourUnitGridModelRef = 'electric-grid.halden.four-unit'
export const norwayWinterPeakOperatingPointRef = 'electric-grid.norway.winter-weekday-peak'
export const norwaySummerLowOperatingPointRef = 'electric-grid.norway.summer-night-low'
export const norwayLoadProfilesRef = 'electric-grid.norway.load-profiles'
/** Nordic synchronous-area frequency control: the default Automation. */
export const nordicFrequencyAutomationRef = 'electric-grid.frequency.nordic-2025'
export const manualBalancingTrainingAutomationRef = 'electric-grid.frequency.manual-balancing-training'
export const islandedOperationAutomationRef = 'electric-grid.frequency.islanded-operation'

export interface GridModelAssetCounts {
  readonly bus: number
  readonly branch: number
  readonly generator: number
  readonly load: number
  readonly storage: number
  readonly connectionPoint: number
  /** Buses (of `bus`) that are HVDC terminals: boundary buses of asynchronous external systems, in no island and without bus series. */
  readonly hvdcTerminal: number
}

/**
 * Where the loader finds a model's data, all in models/: a Grid Model v2 file with its geometry
 * artifact, or a Model Addition v2 file composed onto one base Grid Model.
 */
export type GridModelSource =
  | { readonly kind: 'grid-model'; readonly file: string; readonly geometryFile: string }
  | { readonly kind: 'grid-model-addition'; readonly baseModelRef: string; readonly file: string }

export interface GridModelCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly nominalFrequencyHz: number
  readonly fidelity: GridModelFidelity
  readonly source: GridModelSource
  /**
   * The Grid Load Profiles its loads follow over the day: built for the base Grid Model, whose
   * reference hour they share. An addition's loads are Grid Model v2 loads of the same kinds and
   * price areas and follow the same profiles.
   */
  readonly loadProfilesRef: string
  readonly assetCounts: GridModelAssetCounts
  readonly connectionPoints: ReadonlyArray<GridConnectionPointDefinition>
}

/** A Grid Load Profiles file in models/, built for one base Grid Model; its id and modelId must match the entry (the loader checks). */
export interface GridLoadProfilesCatalogEntry {
  readonly id: string
  readonly modelRef: string
  readonly source: { readonly kind: 'load-profiles'; readonly file: string }
}

/** An Operating Point v2 file in models/; its id and title must match the entry (the loader checks). */
export interface GridOperatingPointCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly compatibleModelRefs: ReadonlyArray<string>
  readonly source: { readonly kind: 'operating-point'; readonly file: string }
}

/** Where the loader finds an Automation: a frequency-control preset file in automations/. */
export interface GridAutomationSource {
  readonly kind: 'frequency-preset'
  readonly file: string
}

export interface GridAutomationCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly compatibleModelRefs: ReadonlyArray<string>
  readonly source: GridAutomationSource
}

export interface GridDefinitionCatalog {
  readonly models: ReadonlyArray<GridModelCatalogEntry>
  readonly loadProfiles: ReadonlyArray<GridLoadProfilesCatalogEntry>
  readonly operatingPoints: ReadonlyArray<GridOperatingPointCatalogEntry>
  readonly automations: ReadonlyArray<GridAutomationCatalogEntry>
}

const transmissionFidelity: GridModelFidelity = {
  powerFlow: 'ac-fdlf-or-dc',
  voltage: 'ac-fdlf',
  frequency: 'island-swing',
  recommendedMaximumBusCount: 10_000,
}

const haldenUnitBay = (unit: number): GridConnectionPointDefinition => ({
  id: `unit-${unit}-420kv`,
  label: `Halden unit ${unit} 420 kV bay`,
  busId: 'bus:curated-halden-pwr-switchyard@420',
  nominalKv: 420,
  maximumExportMw: 100,
  maximumImportMw: 1100,
})

const norwayModels = [norwayGridModelRef, haldenFourUnitGridModelRef]

export const electricGridDefinitionCatalog: GridDefinitionCatalog = {
  // Titles, descriptions, asset counts and connection points must match the model files (the loader checks).
  models: [{
    id: norwayGridModelRef,
    title: 'Norway transmission grid',
    description: 'Source-derived ≥132 kV Norwegian transmission network: OpenStreetMap topology (osm:pbf-power:no@2026-10-08), NVE hydropower and wind registries, Elhub metered demand at 2026-01-12T08:00:00+01:00 Europe/Oslo, curated interconnectors and major sites. Electrical values are inferred by documented rules (see the ledger).',
    nominalFrequencyHz: 50,
    fidelity: transmissionFidelity,
    source: { kind: 'grid-model', file: 'norway-transmission.grid-model.json', geometryFile: 'norway-transmission.geometry.json' },
    loadProfilesRef: norwayLoadProfilesRef,
    assetCounts: { bus: 999, branch: 1243, generator: 852, load: 3130, storage: 0, connectionPoint: 0, hvdcTerminal: 4 },
    connectionPoints: [],
  }, {
    id: haldenFourUnitGridModelRef,
    title: 'Halden four-unit transmission connection',
    description: 'Norway transmission grid with a dedicated 420 kV Halden switchyard, three circuits each to Hasle and Tegneby, and four independently connectable unit bays.',
    nominalFrequencyHz: 50,
    fidelity: transmissionFidelity,
    source: { kind: 'grid-model-addition', baseModelRef: norwayGridModelRef, file: 'halden-four-unit.grid-model-addition.json' },
    loadProfilesRef: norwayLoadProfilesRef,
    assetCounts: { bus: 1000, branch: 1249, generator: 852, load: 3130, storage: 0, connectionPoint: 4, hvdcTerminal: 4 },
    connectionPoints: [1, 2, 3, 4].map(haldenUnitBay),
  }],
  loadProfiles: [{
    id: norwayLoadProfilesRef,
    modelRef: norwayGridModelRef,
    source: { kind: 'load-profiles', file: 'norway-load-profiles.json' },
  }],
  operatingPoints: [{
    id: norwayWinterPeakOperatingPointRef,
    title: 'Winter weekday peak',
    description: 'Elhub-metered demand of the winter weekday reference hour with registry-based unit commitment and the Nordic remainder at winter-peak inertia.',
    compatibleModelRefs: norwayModels,
    source: { kind: 'operating-point', file: 'norway-winter-weekday-peak.operating-point.json' },
  }, {
    id: norwaySummerLowOperatingPointRef,
    title: 'Summer night low',
    description: 'Elhub-metered demand of the summer night low hour with registry-based unit commitment and the Nordic remainder at summer-low inertia.',
    compatibleModelRefs: norwayModels,
    source: { kind: 'operating-point', file: 'norway-summer-night-low.operating-point.json' },
  }],
  // Frequency-control presets; titles and descriptions must match the preset files (the loader checks).
  automations: [{
    id: nordicFrequencyAutomationRef,
    title: 'Nordic frequency control 2025',
    description: 'Nordic synchronous-area frequency control: FCR-N, FCR-D, aFRR and mFRR with synchronous-area volumes, NC ER LFDD from 48.8 Hz to 48.0 Hz, and NC RfG generator frequency protection.',
    compatibleModelRefs: norwayModels,
    source: { kind: 'frequency-preset', file: 'nordic-2025.json' },
  }, {
    id: manualBalancingTrainingAutomationRef,
    title: 'Manual balancing training',
    description: 'Nordic FCR-N and FCR-D contain frequency, but no aFRR or mFRR restores it: an operator or Agent must re-dispatch units to bring frequency back to 50 Hz. FCR volumes scale with the island.',
    compatibleModelRefs: norwayModels,
    source: { kind: 'frequency-preset', file: 'manual-balancing-training.json' },
  }, {
    id: islandedOperationAutomationRef,
    title: 'Islanded operation',
    description: "An island separated from the Nordic synchronous area: Nordic FCR, LFDD and protection settings with reserves dimensioned from the island's own demand and largest unit, island aFRR able to replace the largest unit, and Nordic FFR from storage.",
    compatibleModelRefs: norwayModels,
    source: { kind: 'frequency-preset', file: 'islanded-operation.json' },
  }],
}

/** Indexes catalog entries by id; a duplicate id or an unknown lookup fails explicitly. */
export const catalogEntriesById = <Entry extends { readonly id: string }>(entries: ReadonlyArray<Entry>, kind: string): (id: string) => Entry => {
  const byId = new Map<string, Entry>()
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error(`duplicate ${kind} in the Grid catalog: ${entry.id}`)
    byId.set(entry.id, entry)
  }
  return id => {
    const entry = byId.get(id)
    if (entry === undefined) throw new Error(`unknown ${kind}: ${id}`)
    return entry
  }
}

export const gridModelCatalogEntry = catalogEntriesById(electricGridDefinitionCatalog.models, 'Grid Model')
