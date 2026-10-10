import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { gridOperatingPointOverridesSchema, type GridDefinition, type GridOperatingPointOverrides } from './config.ts'
import {
  catalogEntriesById,
  electricGridDefinitionCatalog,
  type GridDefinitionCatalog,
  type GridModelCatalogEntry,
} from './definition-refs.ts'
import type {
  CompiledGridDefinition,
  CompiledGridModelIndex,
  GridAssetIndexEntry,
  GridAutomationDefinition,
  GridModelDefinition,
  GridOperatingPointDefinition,
} from './grid-model.ts'
import { addGridModelAssets, parseGridModelAddition } from './model-additions.ts'
import { buildNorwayTransmissionModelV1 } from './models/norway-transmission-v1.ts'
import {
  gridOperatingPointPerAssetFields,
  gridOperatingPointStateIssues,
  type GridOperatingPointTargets,
} from './schemas/grid-operating-point.ts'

// The Grid definition loader. Only the runtime connect path and scenario expansion import it,
// dynamically, so World startup neither reads model data nor compiles a model. Each model is
// read, validated, indexed and digested once per id on first use; a malformed model or
// addition fails that use with an error naming its file and JSON path.

const failModel = (model: GridModelDefinition, message: string): never => {
  throw new Error(`Grid Model ${model.id}: ${message}`)
}

const requireFinite = (model: GridModelDefinition, value: number, subject: string, minimum?: number): void => {
  if (!Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    failModel(model, `${subject} must be finite${minimum === undefined ? '' : ` and at least ${minimum}`}`)
  }
}

const addGrouped = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

const readonlyGroups = <T>(map: Map<string, T[]>): ReadonlyMap<string, ReadonlyArray<T>> =>
  new Map([...map].map(([key, values]) => [key, Object.freeze(values.slice())]))

export const compileGridModelIndex = (model: GridModelDefinition): CompiledGridModelIndex => {
  requireFinite(model, model.nominalFrequencyHz, 'nominal frequency', 1)
  if (model.buses.length === 0) failModel(model, 'must contain at least one bus')
  const assets: GridAssetIndexEntry[] = []
  const assetById = new Map<string, GridAssetIndexEntry>()
  const register = (entry: GridAssetIndexEntry): void => {
    if (assetById.has(entry.id)) failModel(model, `duplicate Grid Asset id ${entry.id}`)
    if (entry.id.trim().length === 0 || entry.label.trim().length === 0) failModel(model, 'asset ids and labels must be non-empty')
    assets.push(entry)
    assetById.set(entry.id, entry)
  }
  const busById = new Map(model.buses.map(bus => [bus.id, bus]))
  if (busById.size !== model.buses.length) failModel(model, 'contains duplicate bus ids')
  const branchesByBus = new Map<string, typeof model.branches[number][]>()
  const generatorsByBus = new Map<string, typeof model.generators[number][]>()
  const loadsByBus = new Map<string, typeof model.loads[number][]>()
  const storageByBus = new Map<string, typeof model.storage[number][]>()
  for (const bus of model.buses) {
    requireFinite(model, bus.nominalKv, `${bus.id} nominalKv`, 0.001)
    requireFinite(model, bus.location[0], `${bus.id} longitude`)
    requireFinite(model, bus.location[1], `${bus.id} latitude`)
    if (Math.abs(bus.location[0]) > 180 || Math.abs(bus.location[1]) > 90) failModel(model, `${bus.id} has an invalid location`)
    register({ id: bus.id, label: bus.label, kind: 'bus', definition: bus })
  }
  const requireBus = (busId: string, subject: string): void => {
    if (!busById.has(busId)) failModel(model, `${subject} references unknown bus ${busId}`)
  }
  for (const branch of model.branches) {
    requireBus(branch.fromBusId, branch.id)
    requireBus(branch.toBusId, branch.id)
    if (branch.fromBusId === branch.toBusId) failModel(model, `${branch.id} connects a bus to itself`)
    requireFinite(model, branch.nominalKv, `${branch.id} nominalKv`, 0.001)
    requireFinite(model, branch.ratingMw, `${branch.id} ratingMw`, 0.001)
    requireFinite(model, branch.emergencyRatingMw, `${branch.id} emergencyRatingMw`, branch.ratingMw)
    requireFinite(model, branch.reactancePu, `${branch.id} reactancePu`, 0.000001)
    requireFinite(model, branch.resistancePu, `${branch.id} resistancePu`, 0)
    addGrouped(branchesByBus, branch.fromBusId, branch)
    addGrouped(branchesByBus, branch.toBusId, branch)
    register({ id: branch.id, label: branch.label, kind: 'branch', definition: branch })
  }
  for (const generator of model.generators) {
    requireBus(generator.busId, generator.id)
    requireFinite(model, generator.capacityMw, `${generator.id} capacityMw`, 0.001)
    requireFinite(model, generator.availableMw, `${generator.id} availableMw`, 0)
    requireFinite(model, generator.reserveMw, `${generator.id} reserveMw`, 0)
    requireFinite(model, generator.rampRateMwPerMinute, `${generator.id} rampRateMwPerMinute`, 0)
    requireFinite(model, generator.inertiaSeconds, `${generator.id} inertiaSeconds`, 0)
    requireFinite(model, generator.location[0], `${generator.id} longitude`)
    requireFinite(model, generator.location[1], `${generator.id} latitude`)
    if (Math.abs(generator.location[0]) > 180 || Math.abs(generator.location[1]) > 90) failModel(model, `${generator.id} has an invalid location`)
    if (generator.availableMw > generator.capacityMw) failModel(model, `${generator.id} availableMw exceeds capacityMw`)
    if (generator.reserveMw > generator.availableMw) failModel(model, `${generator.id} reserveMw exceeds availableMw`)
    addGrouped(generatorsByBus, generator.busId, generator)
    register({ id: generator.id, label: generator.label, kind: 'generator', definition: generator })
  }
  for (const load of model.loads) {
    requireBus(load.busId, load.id)
    requireFinite(model, load.demandMw, `${load.id} demandMw`, 0)
    requireFinite(model, load.criticalMw, `${load.id} criticalMw`, 0)
    requireFinite(model, load.reactiveDemandMvar, `${load.id} reactiveDemandMvar`, 0)
    requireFinite(model, load.location[0], `${load.id} longitude`)
    requireFinite(model, load.location[1], `${load.id} latitude`)
    if (Math.abs(load.location[0]) > 180 || Math.abs(load.location[1]) > 90) failModel(model, `${load.id} has an invalid location`)
    if (load.criticalMw > load.demandMw) failModel(model, `${load.id} criticalMw exceeds demandMw`)
    addGrouped(loadsByBus, load.busId, load)
    register({ id: load.id, label: load.label, kind: 'load', definition: load })
  }
  for (const item of model.storage) {
    requireBus(item.busId, item.id)
    requireFinite(model, item.capacityMwh, `${item.id} capacityMwh`, 0.001)
    requireFinite(model, item.maxChargeMw, `${item.id} maxChargeMw`, 0)
    requireFinite(model, item.maxDischargeMw, `${item.id} maxDischargeMw`, 0)
    requireFinite(model, item.location[0], `${item.id} longitude`)
    requireFinite(model, item.location[1], `${item.id} latitude`)
    if (Math.abs(item.location[0]) > 180 || Math.abs(item.location[1]) > 90) failModel(model, `${item.id} has an invalid location`)
    addGrouped(storageByBus, item.busId, item)
    register({ id: item.id, label: item.label, kind: 'storage', definition: item })
  }
  const connectionPointIds = new Set<string>()
  for (const point of model.connectionPoints) {
    if (connectionPointIds.has(point.id)) failModel(model, `duplicate connection point id ${point.id}`)
    connectionPointIds.add(point.id)
    requireBus(point.busId, point.id)
    requireFinite(model, point.nominalKv, `${point.id} nominalKv`, 0.001)
    requireFinite(model, point.maximumExportMw, `${point.id} maximumExportMw`, 0)
    requireFinite(model, point.maximumImportMw, `${point.id} maximumImportMw`, 0)
  }
  const staticComponentByBus = new Map<string, string>()
  for (const bus of model.buses) {
    if (staticComponentByBus.has(bus.id)) continue
    const componentId = bus.id
    const queue = [bus.id]
    staticComponentByBus.set(bus.id, componentId)
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const branch of branchesByBus.get(current) ?? []) {
        const next = branch.fromBusId === current ? branch.toBusId : branch.fromBusId
        if (staticComponentByBus.has(next)) continue
        staticComponentByBus.set(next, componentId)
        queue.push(next)
      }
    }
  }
  return {
    assets: Object.freeze(assets),
    assetById,
    busById,
    branchesByBus: readonlyGroups(branchesByBus),
    generatorsByBus: readonlyGroups(generatorsByBus),
    loadsByBus: readonlyGroups(loadsByBus),
    storageByBus: readonlyGroups(storageByBus),
    staticComponentByBus,
    diagnostics: {
      assetCount: assets.length,
      topologyComponentCount: new Set(staticComponentByBus.values()).size,
      isolatedBusCount: model.buses.filter(bus => (branchesByBus.get(bus.id)?.length ?? 0) === 0).length,
    },
  }
}

/** Reads one model data file; errors name the file, not the server path. */
export type GridModelFileReader = (file: string) => unknown

export const gridModelFileReader = (directory: URL): GridModelFileReader => file => {
  const text = readFileSync(fileURLToPath(new URL(file, directory)), 'utf8')
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

interface CompiledModelEntry {
  readonly model: GridModelDefinition
  readonly index: CompiledGridModelIndex
  readonly targets: GridOperatingPointTargets
  readonly digest: string
}

/** What Operating Point overrides may address in a v1 model. */
const operatingPointTargetsFor = (model: GridModelDefinition): GridOperatingPointTargets => ({
  generators: new Map(model.generators.map(generator => [generator.id, { capacityMw: generator.capacityMw }])),
  branches: new Set(model.branches.map(branch => branch.id)),
  // v1 models carry HVDC as AC branches, have no external systems, and give loads no price area.
  hvdcLinks: new Map(),
  externalSystems: new Map(),
  loadPriceAreas: new Set(),
})

const overridesPath = ['operatingPoint', 'overrides'] as const

/** Overrides the current runtime cannot apply yet are rejected, never silently ignored. */
const unappliedOverrideFields = (overrides: GridOperatingPointOverrides): ReadonlyArray<string> => [
  ...gridOperatingPointPerAssetFields.filter(field => overrides[field] !== undefined && overrides[field].length > 0),
  ...(overrides.priceAreaDemandScale !== undefined && Object.keys(overrides.priceAreaDemandScale).length > 0 ? ['priceAreaDemandScale'] : []),
]

/** Validates overrides against the compiled model; issue paths are relative to the Grid definition. */
const resolveOverrides = (definition: GridDefinition, targets: GridOperatingPointTargets): GridOperatingPointOverrides => {
  const overrides = gridOperatingPointOverridesSchema.parse(definition.operatingPoint.overrides ?? {})
  const issues = gridOperatingPointStateIssues(overrides, targets)
  if (issues.length > 0) {
    throw new z.ZodError(issues.map(issue => ({ code: 'custom' as const, path: [...overridesPath, ...issue.path], message: issue.message })))
  }
  const unapplied = unappliedOverrideFields(overrides)
  if (unapplied.length > 0) {
    throw new z.ZodError(unapplied.map(field => ({
      code: 'custom' as const,
      path: [...overridesPath, field],
      message: `valid for ${definition.model.ref}, but the current Grid runtime does not apply ${field} yet`,
    })))
  }
  return overrides
}

export interface GridDefinitionCompiler {
  readonly compileModel: (ref: string) => CompiledModelEntry
  readonly compile: (definition: GridDefinition) => CompiledGridDefinition
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const requireCatalogMatch = (entry: GridModelCatalogEntry, model: GridModelDefinition): void => {
  const loaded = {
    title: model.title,
    description: model.description,
    nominalFrequencyHz: model.nominalFrequencyHz,
    fidelity: model.fidelity,
    assetCounts: {
      bus: model.buses.length,
      branch: model.branches.length,
      generator: model.generators.length,
      load: model.loads.length,
      storage: model.storage.length,
      connectionPoint: model.connectionPoints.length,
    },
    connectionPoints: model.connectionPoints,
  }
  for (const [field, value] of Object.entries(loaded)) {
    if (JSON.stringify(value) !== JSON.stringify(entry[field as keyof typeof loaded])) {
      throw new Error(`Grid Model ${entry.id}: catalog ${field} ${JSON.stringify(entry[field as keyof typeof loaded])} does not describe the loaded model (${JSON.stringify(value)})`)
    }
  }
}

export const createGridDefinitionCompiler = (config: {
  readonly catalog: GridDefinitionCatalog
  readonly readModelFile: GridModelFileReader
}): GridDefinitionCompiler => {
  const modelEntry = catalogEntriesById(config.catalog.models, 'Grid Model')
  const operatingPointEntry = catalogEntriesById(config.catalog.operatingPoints, 'Grid Operating Point')
  const automationEntry = catalogEntriesById(config.catalog.automations, 'Grid Automation')
  const compiledModels = new Map<string, CompiledModelEntry>()

  const loadModel = (entry: GridModelCatalogEntry): GridModelDefinition => {
    if (entry.source.kind === 'norway-source-data-v1') return buildNorwayTransmissionModelV1(entry)
    const { baseModelRef, file } = entry.source
    if (modelEntry(baseModelRef).source.kind !== 'norway-source-data-v1') {
      throw new Error(`Grid Model ${entry.id}: base ${baseModelRef} is itself a Model Addition; additions compose onto a base Grid Model only`)
    }
    const addition = parseGridModelAddition(config.readModelFile(file), file)
    if (addition.id !== entry.id) throw new Error(`${file}: $.id ${addition.id} must be the catalog id ${entry.id}`)
    if (addition.baseModelRef !== baseModelRef) throw new Error(`${file}: $.baseModelRef ${addition.baseModelRef} must be the catalog base ${baseModelRef}`)
    return addGridModelAssets(compileModel(baseModelRef).model, addition, file)
  }

  const compileModel = (ref: string): CompiledModelEntry => {
    const cached = compiledModels.get(ref)
    if (cached !== undefined) return cached
    const entry = modelEntry(ref)
    const model = loadModel(entry)
    requireCatalogMatch(entry, model)
    const compiled = { model, index: compileGridModelIndex(model), targets: operatingPointTargetsFor(model), digest: sha256(JSON.stringify(model)) }
    compiledModels.set(ref, compiled)
    return compiled
  }

  const compile = (definition: GridDefinition): CompiledGridDefinition => {
    const compiledModel = compileModel(definition.model.ref)
    const operatingPoint = operatingPointEntry(definition.operatingPoint.ref)
    const automation = automationEntry(definition.automation.ref)
    if (!operatingPoint.compatibleModelRefs.includes(definition.model.ref)) {
      throw new Error(`Grid Operating Point ${definition.operatingPoint.ref} is not compatible with Model ${definition.model.ref}`)
    }
    if (!automation.compatibleModelRefs.includes(definition.model.ref)) {
      throw new Error(`Grid Automation ${definition.automation.ref} is not compatible with Model ${definition.model.ref}`)
    }
    const overrides = resolveOverrides(definition, compiledModel.targets)
    const resolvedOperatingPoint: GridOperatingPointDefinition = {
      id: operatingPoint.id,
      title: operatingPoint.title,
      loadScale: overrides.loadScale ?? operatingPoint.values.loadScale,
      generationAvailabilityScale: overrides.generationAvailabilityScale ?? operatingPoint.values.generationAvailabilityScale,
      storageStateOfCharge: overrides.storageStateOfCharge ?? operatingPoint.values.storageStateOfCharge,
    }
    const resolvedAutomation: GridAutomationDefinition = {
      id: automation.id,
      title: automation.title,
      loadProfiles: automation.values.loadProfiles,
      storageFrequencyResponse: automation.values.storageFrequencyResponse,
      underFrequencyLoadShedding: automation.values.underFrequencyLoadShedding,
      primaryFrequencyResponseMwPerHz: automation.values.primaryFrequencyResponseMwPerHz,
    }
    const definitionDigest = createHash('sha256')
      .update(compiledModel.digest)
      .update(JSON.stringify(resolvedOperatingPoint))
      .update(JSON.stringify(resolvedAutomation))
      .digest('hex')
    return {
      gridId: definition.id,
      model: compiledModel.model,
      index: compiledModel.index,
      operatingPoint: resolvedOperatingPoint,
      automation: resolvedAutomation,
      definitionDigest,
    }
  }

  return { compileModel, compile }
}

const builtinCompiler = createGridDefinitionCompiler({
  catalog: electricGridDefinitionCatalog,
  readModelFile: gridModelFileReader(new URL('./models/', import.meta.url)),
})

export const compileGridDefinition = (definition: GridDefinition): CompiledGridDefinition => builtinCompiler.compile(definition)
