import type {
  GridAutomationDefinition,
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
export const norwayStandardAutomationRef = 'electric-grid.norway.standard'

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

export interface GridAutomationCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly compatibleModelRefs: ReadonlyArray<string>
  readonly values: Omit<GridAutomationDefinition, 'id' | 'title'>
}

export interface GridDefinitionCatalog {
  readonly models: ReadonlyArray<GridModelCatalogEntry>
  readonly operatingPoints: ReadonlyArray<GridOperatingPointCatalogEntry>
  readonly automations: ReadonlyArray<GridAutomationCatalogEntry>
}

const transmissionFidelity: GridModelFidelity = {
  powerFlow: 'dc',
  voltage: 'approximate',
  frequency: 'aggregate-dynamic',
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
    description: 'Norway transmission topology with a dedicated 420 kV Halden switchyard and four independently connectable unit bays.',
    nominalFrequencyHz: 50,
    fidelity: transmissionFidelity,
    source: { kind: 'addition-v1', baseModelRef: norwayGridModelRef, file: 'halden.grid-model.json' },
    assetCounts: { bus: 256, branch: 306, generator: 70, load: 22, storage: 1, connectionPoint: 4 },
    connectionPoints: [1, 2, 3, 4].map(haldenUnitBay),
  }],
  operatingPoints: [{
    id: norwayNormalOperatingPointRef,
    title: 'Normal winter weekday',
    description: 'Winter weekday demand, available generation, and initial storage charge.',
    compatibleModelRefs: [norwayGridModelRef, haldenFourUnitGridModelRef],
    values: { loadScale: 1.03, generationAvailabilityScale: 1, storageStateOfCharge: 0.58 },
  }],
  automations: [{
    id: norwayStandardAutomationRef,
    title: 'Standard grid controls',
    description: 'Daily load profiles, actual generator primary response, storage response, and under-frequency load shedding.',
    compatibleModelRefs: [norwayGridModelRef, haldenFourUnitGridModelRef],
    values: { loadProfiles: true, storageFrequencyResponse: true, underFrequencyLoadShedding: true, primaryFrequencyResponseMwPerHz: 900 },
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
