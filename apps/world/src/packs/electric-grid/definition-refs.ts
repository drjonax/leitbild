import type {
  GridConnectionPointDefinition,
  GridModelFidelity,
  GridOperatingPointDefinition,
} from './grid-model.ts'

// The one Electric Grid Definition catalog. Authoring, scenario expansion, recording estimates
// and the catalog query read it without loading or compiling a model: it does no filesystem
// access. The loader in definitions.ts checks on first load that each model matches its entry.

export const norwayGridModelRef = 'electric-grid.norway.transmission'
export const haldenFourUnitGridModelRef = 'electric-grid.halden.four-unit'
export const norwayNormalOperatingPointRef = 'electric-grid.norway.normal'
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
}

/** Where the loader finds a model's data. Additions name a file in models/ and one base model. */
export type GridModelSource =
  | { readonly kind: 'norway-source-data-v1' }
  | { readonly kind: 'addition-v1'; readonly baseModelRef: string; readonly file: string }

export interface GridModelCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly nominalFrequencyHz: number
  readonly fidelity: GridModelFidelity
  readonly source: GridModelSource
  readonly assetCounts: GridModelAssetCounts
  readonly connectionPoints: ReadonlyArray<GridConnectionPointDefinition>
}

export interface GridOperatingPointCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly compatibleModelRefs: ReadonlyArray<string>
  readonly values: Omit<GridOperatingPointDefinition, 'id' | 'title'>
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
  readonly operatingPoints: ReadonlyArray<GridOperatingPointCatalogEntry>
  readonly automations: ReadonlyArray<GridAutomationCatalogEntry>
}

const transmissionFidelity: GridModelFidelity = {
  powerFlow: 'dc',
  voltage: 'not-modelled',
  frequency: 'island-swing',
  recommendedMaximumBusCount: 1_000,
}

const haldenUnitBay = (unit: number): GridConnectionPointDefinition => ({
  id: `unit-${unit}-420kv`,
  label: `Halden unit ${unit} 420 kV bay`,
  busId: 'bus:halden-pwr-switchyard-420',
  nominalKv: 420,
  maximumExportMw: 100,
  maximumImportMw: 1100,
})

export const electricGridDefinitionCatalog: GridDefinitionCatalog = {
  models: [{
    id: norwayGridModelRef,
    title: 'Norway transmission grid',
    description: 'Source-derived Norwegian transmission topology with major generation and aggregate demand zones.',
    nominalFrequencyHz: 50,
    fidelity: transmissionFidelity,
    source: { kind: 'norway-source-data-v1' },
    assetCounts: { bus: 255, branch: 300, generator: 70, load: 22, storage: 1, connectionPoint: 0 },
    connectionPoints: [],
  }, {
    id: haldenFourUnitGridModelRef,
    title: 'Halden four-unit transmission connection',
    description: 'Norway transmission topology with a dedicated 420 kV Halden switchyard and four independently connectable unit bays, coupled through the two real 420 kV ties Hasle–Borgvik and Halden–Skogssäter to a synchronous equivalent of the rest of the Nordic area behind SE3.',
    nominalFrequencyHz: 50,
    fidelity: transmissionFidelity,
    source: { kind: 'addition-v1', baseModelRef: norwayGridModelRef, file: 'halden.grid-model.json' },
    assetCounts: { bus: 257, branch: 308, generator: 70, load: 22, storage: 1, connectionPoint: 4 },
    connectionPoints: [1, 2, 3, 4].map(haldenUnitBay),
  }],
  operatingPoints: [{
    id: norwayNormalOperatingPointRef,
    title: 'Normal winter weekday',
    description: 'Winter weekday demand, available generation, and initial storage charge.',
    compatibleModelRefs: [norwayGridModelRef, haldenFourUnitGridModelRef],
    values: { loadScale: 1.03, generationAvailabilityScale: 1, storageStateOfCharge: 0.58 },
  }],
  // Frequency-control presets; titles and descriptions must match the preset files (the loader checks).
  automations: [{
    id: nordicFrequencyAutomationRef,
    title: 'Nordic frequency control 2025',
    description: 'Nordic synchronous-area frequency control: FCR-N, FCR-D, aFRR and mFRR with synchronous-area volumes, NC ER LFDD from 48.8 Hz to 48.0 Hz, and NC RfG generator frequency protection.',
    compatibleModelRefs: [norwayGridModelRef, haldenFourUnitGridModelRef],
    source: { kind: 'frequency-preset', file: 'nordic-2025.json' },
  }, {
    id: manualBalancingTrainingAutomationRef,
    title: 'Manual balancing training',
    description: 'Nordic FCR-N and FCR-D contain frequency, but no aFRR or mFRR restores it: an operator or Agent must re-dispatch units to bring frequency back to 50 Hz. FCR volumes scale with the island.',
    compatibleModelRefs: [norwayGridModelRef, haldenFourUnitGridModelRef],
    source: { kind: 'frequency-preset', file: 'manual-balancing-training.json' },
  }, {
    id: islandedOperationAutomationRef,
    title: 'Islanded operation',
    description: "An island separated from the Nordic synchronous area: Nordic FCR, LFDD and protection settings with reserves dimensioned from the island's own demand and largest unit, island aFRR able to replace the largest unit, and Nordic FFR from storage.",
    compatibleModelRefs: [norwayGridModelRef, haldenFourUnitGridModelRef],
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
