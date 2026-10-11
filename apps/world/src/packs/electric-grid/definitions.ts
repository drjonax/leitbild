import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { gridOperatingPointOverridesSchema, type GridDefinition, type GridOperatingPointOverrides } from './config.ts'
import {
  catalogEntriesById,
  electricGridDefinitionCatalog,
  type GridAutomationCatalogEntry,
  type GridDefinitionCatalog,
  type GridModelCatalogEntry,
} from './definition-refs.ts'
import type {
  CompiledGridDefinition,
  CompiledGridModelIndex,
  GridAssetIndexEntry,
  GridExternalSystemDefinition,
  GridHvdcRampGroupDefinition,
  GridModelDefinition,
  GridOperatingPointDefinition,
} from './grid-model.ts'
import { compileGridModelV2, type GridOperatingPointDemand } from './models/compile-v2.ts'
import { localDayType, localHourOfDay, osloLocalMs } from './runtime/demand-profiles.ts'
import { gridAutomationSchema, type GridAutomation } from './schemas/grid-automation.ts'
import { validateGridLoadProfiles, type GridLoadProfiles } from './schemas/grid-load-profile.ts'
import { composeGridModel, validateGridModelAddition } from './schemas/grid-model-addition.ts'
import { validateGridModel, type GridModelV2 } from './schemas/grid-model.ts'
import {
  gridOperatingPointStateIssues,
  gridOperatingPointTargetsForModel,
  validateGridOperatingPoint,
  type GridOperatingPointTargets,
  type GridOperatingPointV2,
} from './schemas/grid-operating-point.ts'

// The Grid definition loader. Only the runtime connect path and scenario expansion import it,
// dynamically, so World startup neither reads model data nor compiles a model. Each Grid Model
// v2 (composed for an addition) and Operating Point is read and validated once on first use;
// each Model × Operating Point × overrides is mapped, indexed and digested once. Malformed data
// fails that use with an error naming its file and JSON path.

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
  requireFinite(model, model.sBaseMva, 'sBaseMva', Number.MIN_VALUE)
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
  const shuntsByBus = new Map<string, typeof model.shunts[number][]>()
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
    requireFinite(model, branch.emergencyDurationSeconds, `${branch.id} emergencyDurationSeconds`, Number.MIN_VALUE)
    requireFinite(model, branch.reactancePu, `${branch.id} reactancePu`, 0.000001)
    requireFinite(model, branch.resistancePu, `${branch.id} resistancePu`, 0)
    requireFinite(model, branch.chargingSusceptancePu, `${branch.id} chargingSusceptancePu`, 0)
    if (!Number.isInteger(branch.circuits) || branch.circuits < 1) failModel(model, `${branch.id} circuits must be a positive integer`)
    if ((branch.kind === 'transformer') !== (branch.tapRatio !== undefined)) failModel(model, `${branch.id}: a transformer and only a transformer has a tap ratio`)
    if (branch.tapRatio !== undefined) requireFinite(model, branch.tapRatio, `${branch.id} tapRatio`, Number.MIN_VALUE)
    addGrouped(branchesByBus, branch.fromBusId, branch)
    addGrouped(branchesByBus, branch.toBusId, branch)
    register({ id: branch.id, label: branch.label, kind: 'branch', definition: branch })
  }
  for (const generator of model.generators) {
    requireBus(generator.busId, generator.id)
    requireFinite(model, generator.capacityMw, `${generator.id} capacityMw`, 0.001)
    requireFinite(model, generator.availableMw, `${generator.id} availableMw`, 0)
    requireFinite(model, generator.ratedMva, `${generator.id} ratedMva`, generator.capacityMw)
    requireFinite(model, generator.powerFactor, `${generator.id} powerFactor`, Number.MIN_VALUE)
    if (generator.powerFactor > 1) failModel(model, `${generator.id} powerFactor must not exceed 1`)
    requireFinite(model, generator.voltageSetpointPu, `${generator.id} voltageSetpointPu`, Number.MIN_VALUE)
    requireFinite(model, generator.minimumStableMw, `${generator.id} minimumStableMw`, 0)
    if (generator.minimumStableMw > generator.capacityMw) failModel(model, `${generator.id} minimumStableMw exceeds capacityMw`)
    requireFinite(model, generator.rampRateMwPerMinute, `${generator.id} rampRateMwPerMinute`, 0)
    requireFinite(model, generator.inertiaSeconds, `${generator.id} inertiaSeconds`, 0)
    if (!generator.synchronous && generator.inertiaSeconds !== 0) failModel(model, `${generator.id} is converter-connected and has no synchronous inertia`)
    requireFinite(model, generator.location[0], `${generator.id} longitude`)
    requireFinite(model, generator.location[1], `${generator.id} latitude`)
    if (Math.abs(generator.location[0]) > 180 || Math.abs(generator.location[1]) > 90) failModel(model, `${generator.id} has an invalid location`)
    if (generator.availableMw > generator.capacityMw) failModel(model, `${generator.id} availableMw exceeds capacityMw`)
    addGrouped(generatorsByBus, generator.busId, generator)
    register({ id: generator.id, label: generator.label, kind: 'generator', definition: generator })
  }
  // A profile has 24 non-negative hour values per day type; a measured one is exactly 1 at its reference hour.
  const demandProfileIds = new Set<string>()
  for (const profile of model.demandProfiles) {
    if (demandProfileIds.has(profile.id)) failModel(model, `duplicate demand profile id ${profile.id}`)
    demandProfileIds.add(profile.id)
    for (const dayType of ['weekday', 'weekend'] as const) {
      if (profile[dayType].length !== 24) failModel(model, `${profile.id} ${dayType} must give 24 hour values, not ${profile[dayType].length}`)
      profile[dayType].forEach((value, hour) => requireFinite(model, value, `${profile.id} ${dayType} ${hour}:00`, 0))
    }
    if (profile.series !== null) {
      const localMs = osloLocalMs(Date.parse(profile.series.referenceHour))
      const value = profile[localDayType(localMs)][localHourOfDay(localMs)]
      if (value !== 1) failModel(model, `${profile.id} is ${value} at its reference hour ${profile.series.referenceHour}, not 1`)
    }
  }
  for (const load of model.loads) {
    requireBus(load.busId, load.id)
    if (!demandProfileIds.has(load.demandProfileId)) failModel(model, `${load.id} follows unknown demand profile ${load.demandProfileId}`)
    requireFinite(model, load.demandMw, `${load.id} demandMw`, 0)
    requireFinite(model, load.criticalMw, `${load.id} criticalMw`, 0)
    requireFinite(model, load.powerFactor, `${load.id} powerFactor`, Number.MIN_VALUE)
    if (load.powerFactor > 1) failModel(model, `${load.id} powerFactor must not exceed 1`)
    requireFinite(model, load.interruptibleMw, `${load.id} interruptibleMw`, 0)
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
  const shuntIds = new Set<string>()
  for (const shunt of model.shunts) {
    if (shuntIds.has(shunt.id) || assetById.has(shunt.id)) failModel(model, `duplicate shunt id ${shunt.id}`)
    shuntIds.add(shunt.id)
    requireBus(shunt.busId, shunt.id)
    requireFinite(model, shunt.mvarAtNominalVoltage, `${shunt.id} mvarAtNominalVoltage`)
    addGrouped(shuntsByBus, shunt.busId, shunt)
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
  const externalSystems = model.externalSystems
  const hvdcLinks = model.hvdcLinks
  const synchronousExternalByBus = new Map<string, GridExternalSystemDefinition>()
  const asynchronousBoundaryBusIds = new Set<string>()
  const boundaryOwner = new Map<string, string>()
  const externalIds = new Set<string>()
  for (const system of externalSystems) {
    if (externalIds.has(system.id) || assetById.has(system.id)) failModel(model, `duplicate external system id ${system.id}`)
    externalIds.add(system.id)
    if (system.boundaryBusIds.length === 0) failModel(model, `${system.id} has no boundary bus`)
    for (const busId of system.boundaryBusIds) {
      requireBus(busId, system.id)
      const owner = boundaryOwner.get(busId)
      if (owner !== undefined) failModel(model, `boundary bus ${busId} belongs to both ${owner} and ${system.id}`)
      boundaryOwner.set(busId, system.id)
      if ((generatorsByBus.get(busId)?.length ?? 0) > 0 || (loadsByBus.get(busId)?.length ?? 0) > 0 || (storageByBus.get(busId)?.length ?? 0) > 0) {
        failModel(model, `boundary bus ${busId} of ${system.id} carries Norwegian generation, load or storage`)
      }
    }
    if (system.synchronous) {
      // One synchronous equivalent: the Norwegian components it touches share its frequency, and
      // each closes its balance through the equivalent's boundary buses in it.
      const other = externalSystems.find(candidate => candidate.synchronous && candidate.id !== system.id)
      if (other !== undefined) failModel(model, `synchronous external systems ${system.id} and ${other.id}: the runtime models the synchronous neighbours as one equivalent`)
      requireFinite(model, system.inertiaGws ?? Number.NaN, `${system.id} inertiaGws`, Number.MIN_VALUE)
      requireFinite(model, system.loadMw ?? Number.NaN, `${system.id} loadMw`, 0)
      for (const field of ['fcrNMwPerHz', 'fcrDUpMw', 'fcrDDownMw', 'afrrUpMw', 'afrrDownMw'] as const) {
        requireFinite(model, system[field] ?? Number.NaN, `${system.id} ${field}`, 0)
      }
      // Every boundary bus belongs to exactly one participating area; the shares sum to 1.
      const participation = system.areaParticipation
      if (participation === undefined || participation.length === 0) failModel(model, `${system.id} is synchronous and needs its area participation`)
      const areaOfBus = new Map<string, string>()
      let shareSum = 0
      for (const entry of participation!) {
        requireFinite(model, entry.share, `${system.id} participation of ${entry.area}`, Number.MIN_VALUE)
        shareSum += entry.share
        if (entry.boundaryBusIds.length === 0) failModel(model, `${system.id} participation of ${entry.area} has no boundary bus`)
        for (const busId of entry.boundaryBusIds) {
          if (!system.boundaryBusIds.includes(busId)) failModel(model, `${system.id} participation of ${entry.area} names ${busId}, not one of its boundary buses`)
          if (areaOfBus.has(busId)) failModel(model, `${system.id}: boundary bus ${busId} lies in both ${areaOfBus.get(busId)} and ${entry.area}`)
          areaOfBus.set(busId, entry.area)
        }
      }
      for (const busId of system.boundaryBusIds) if (!areaOfBus.has(busId)) failModel(model, `${system.id}: boundary bus ${busId} lies in no participating area`)
      if (!(Math.abs(shareSum - 1) <= 1e-9)) failModel(model, `${system.id} area participation sums to ${shareSum}, not 1`)
      for (const busId of system.boundaryBusIds) synchronousExternalByBus.set(busId, system)
    } else {
      for (const field of ['inertiaGws', 'loadMw', 'fcrNMwPerHz', 'fcrDUpMw', 'fcrDDownMw', 'afrrUpMw', 'afrrDownMw', 'areaParticipation'] as const) {
        if (system[field] !== undefined) failModel(model, `${system.id} is asynchronous and cannot carry ${field}`)
      }
      // An HVDC terminal lies outside the modelled AC network and every island.
      for (const busId of system.boundaryBusIds) {
        if ((branchesByBus.get(busId)?.length ?? 0) > 0) failModel(model, `boundary bus ${busId} of asynchronous ${system.id} must not have AC branches`)
        if ((shuntsByBus.get(busId)?.length ?? 0) > 0) failModel(model, `boundary bus ${busId} of asynchronous ${system.id} must not carry a shunt`)
        const point = model.connectionPoints.find(candidate => candidate.busId === busId)
        if (point !== undefined) failModel(model, `boundary bus ${busId} of asynchronous ${system.id} must not carry connection point ${point.id}`)
        asynchronousBoundaryBusIds.add(busId)
      }
    }
  }
  // A bus is a boundary bus exactly when an external system owns it.
  for (const bus of model.buses) {
    if ((bus.kind === 'boundary') !== boundaryOwner.has(bus.id)) {
      failModel(model, bus.kind === 'boundary' ? `boundary bus ${bus.id} belongs to no external system` : `${bus.id} is a ${bus.kind} bus but ${boundaryOwner.get(bus.id)} uses it as a boundary bus`)
    }
  }
  const hvdcIds = new Set<string>()
  for (const link of hvdcLinks) {
    if (hvdcIds.has(link.id) || assetById.has(link.id) || externalIds.has(link.id)) failModel(model, `duplicate HVDC link id ${link.id}`)
    hvdcIds.add(link.id)
    requireBus(link.fromBusId, link.id)
    requireBus(link.toBusId, link.id)
    if (link.fromBusId === link.toBusId) failModel(model, `${link.id} connects a bus to itself`)
    if (asynchronousBoundaryBusIds.has(link.fromBusId)) failModel(model, `${link.id} must start at a Norwegian converter bus, not a boundary bus`)
    requireFinite(model, link.ratingMw, `${link.id} ratingMw`, Number.MIN_VALUE)
    requireFinite(model, link.lossPercent, `${link.id} lossPercent`, 0)
    if (link.lossPercent >= 100) failModel(model, `${link.id} lossPercent must be below 100`)
    requireFinite(model, link.rampMwPerMinute, `${link.id} rampMwPerMinute`, Number.MIN_VALUE)
  }
  const hvdcRampGroups = model.hvdcRampGroups
  const hvdcRampGroupOfLink = new Map<string, GridHvdcRampGroupDefinition>()
  const rampGroupIds = new Set<string>()
  for (const group of hvdcRampGroups) {
    if (rampGroupIds.has(group.id)) failModel(model, `duplicate HVDC ramp group id ${group.id}`)
    rampGroupIds.add(group.id)
    if (group.linkIds.length < 2) failModel(model, `HVDC ramp group ${group.id} needs at least two links`)
    requireFinite(model, group.rampMwPerMinute, `${group.id} rampMwPerMinute`, Number.MIN_VALUE)
    for (const linkId of group.linkIds) {
      if (!hvdcIds.has(linkId)) failModel(model, `HVDC ramp group ${group.id} names unknown HVDC link ${linkId}`)
      const owner = hvdcRampGroupOfLink.get(linkId)
      if (owner !== undefined) failModel(model, `HVDC link ${linkId} belongs to both ${owner.id} and ${group.id}; a link shares at most one ramp group`)
      hvdcRampGroupOfLink.set(linkId, group)
    }
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
    shuntsByBus: readonlyGroups(shuntsByBus),
    staticComponentByBus,
    externalSystems,
    hvdcLinks,
    hvdcRampGroups,
    hvdcRampGroupOfLink,
    synchronousExternalByBus,
    asynchronousBoundaryBusIds,
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
  readonly operatingPoint: GridOperatingPointDefinition
  readonly digest: string
}

const overridesPath = ['operatingPoint', 'overrides'] as const

/** Validates overrides against the selected v2 model; issue paths are relative to the Grid definition. */
const resolveOverrides = (definition: GridDefinition, targets: GridOperatingPointTargets): GridOperatingPointOverrides => {
  const overrides = gridOperatingPointOverridesSchema.parse(definition.operatingPoint.overrides ?? {})
  const issues = gridOperatingPointStateIssues(overrides, targets)
  if (issues.length > 0) {
    throw new z.ZodError(issues.map(issue => ({ code: 'custom' as const, path: [...overridesPath, ...issue.path], message: issue.message })))
  }
  return overrides
}

/** An override entry replaces the Operating Point's entry for the same asset; other entries stay. */
const mergedByAsset = <Entry extends { readonly assetId: string }>(base: ReadonlyArray<Entry> | undefined, overrides: ReadonlyArray<Entry> | undefined): Entry[] | undefined => {
  if (overrides === undefined || overrides.length === 0) return base === undefined ? undefined : [...base]
  const replaced = new Map(overrides.map(entry => [entry.assetId, entry]))
  const kept = (base ?? []).map(entry => replaced.get(entry.assetId) ?? entry)
  const present = new Set(kept.map(entry => entry.assetId))
  return [...kept, ...overrides.filter(entry => !present.has(entry.assetId))]
}

/** The Operating Point with a Scenario's overrides applied: scalars and per-area scales replace, per-asset entries replace by asset id. */
export const operatingPointWithOverrides = (operatingPoint: GridOperatingPointV2, overrides: GridOperatingPointOverrides): GridOperatingPointV2 => {
  const priceAreaDemandScale = overrides.priceAreaDemandScale === undefined
    ? operatingPoint.priceAreaDemandScale
    : { ...operatingPoint.priceAreaDemandScale, ...overrides.priceAreaDemandScale }
  const merged = {
    ...operatingPoint,
    loadScale: overrides.loadScale ?? operatingPoint.loadScale,
    ...(priceAreaDemandScale === undefined ? {} : { priceAreaDemandScale }),
    generatorStates: mergedByAsset(operatingPoint.generatorStates, overrides.generatorStates),
    branchStates: mergedByAsset(operatingPoint.branchStates, overrides.branchStates),
    hvdcSchedules: mergedByAsset(operatingPoint.hvdcSchedules, overrides.hvdcSchedules),
    externalExchangeSchedules: mergedByAsset(operatingPoint.externalExchangeSchedules, overrides.externalExchangeSchedules),
    externalSystemStates: mergedByAsset(operatingPoint.externalSystemStates, overrides.externalSystemStates),
  }
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as GridOperatingPointV2
}

export interface GridDefinitionCompiler {
  readonly compileModel: (ref: string) => GridModelV2
  readonly compileAutomation: (ref: string) => GridAutomation
  /** The measured profiles and hour an Operating Point's demand follows on a Model. */
  readonly operatingPointDemand: (operatingPointRef: string, modelRef: string) => GridOperatingPointDemand
  readonly compile: (definition: GridDefinition) => CompiledGridDefinition
}

/** Validates a frequency-control preset file against its catalog entry: the same id, title and description. */
const parseAutomationPreset = (entry: GridAutomationCatalogEntry, raw: unknown): GridAutomation => {
  const { file } = entry.source
  const parsed = gridAutomationSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`${file}: invalid Grid Automation\n${parsed.error.issues.map(issue => `  $.${issue.path.join('.')}: ${issue.message}`).join('\n')}`)
  }
  const preset = parsed.data
  for (const field of ['id', 'title', 'description'] as const) {
    if (preset[field] !== entry[field]) throw new Error(`${file}: $.${field} ${JSON.stringify(preset[field])} does not match the catalog entry ${JSON.stringify(entry[field])}`)
  }
  return preset
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
  readonly readAutomationFile: GridModelFileReader
}): GridDefinitionCompiler => {
  const modelEntry = catalogEntriesById(config.catalog.models, 'Grid Model')
  const operatingPointEntry = catalogEntriesById(config.catalog.operatingPoints, 'Grid Operating Point')
  const automationEntry = catalogEntriesById(config.catalog.automations, 'Grid Automation')
  const loadProfilesEntry = catalogEntriesById(config.catalog.loadProfiles, 'Grid Load Profiles')
  const models = new Map<string, GridModelV2>()
  const profileSets = new Map<string, GridLoadProfiles>()
  const operatingPoints = new Map<string, GridOperatingPointV2>()
  const compiledModels = new Map<string, CompiledModelEntry>()
  const automations = new Map<string, GridAutomation>()

  const compileAutomation = (ref: string): GridAutomation => {
    const cached = automations.get(ref)
    if (cached !== undefined) return cached
    const entry = automationEntry(ref)
    const preset = parseAutomationPreset(entry, config.readAutomationFile(entry.source.file))
    automations.set(ref, preset)
    return preset
  }

  const loadModel = (entry: GridModelCatalogEntry): GridModelV2 => {
    if (entry.source.kind === 'grid-model') {
      const { file } = entry.source
      const model = validateGridModel(config.readModelFile(file), file)
      if (model.id !== entry.id) throw new Error(`${file}: $.id ${model.id} must be the catalog id ${entry.id}`)
      return model
    }
    const { baseModelRef, file } = entry.source
    if (modelEntry(baseModelRef).source.kind !== 'grid-model') {
      throw new Error(`Grid Model ${entry.id}: base ${baseModelRef} is itself a Model Addition; additions compose onto a base Grid Model only`)
    }
    const addition = validateGridModelAddition(config.readModelFile(file), file)
    if (addition.id !== entry.id) throw new Error(`${file}: $.id ${addition.id} must be the catalog id ${entry.id}`)
    if (addition.baseModelRef !== baseModelRef) throw new Error(`${file}: $.baseModelRef ${addition.baseModelRef} must be the catalog base ${baseModelRef}`)
    return composeGridModel({ addition, base: { kind: 'model', model: compileModel(baseModelRef) }, source: file })
  }

  /** The validated Grid Model v2 of a catalog model, composed when it is an addition; read once per id. */
  const compileModel = (ref: string): GridModelV2 => {
    const cached = models.get(ref)
    if (cached !== undefined) return cached
    const model = loadModel(modelEntry(ref))
    models.set(ref, model)
    return model
  }

  /** The Load Profiles of a catalog model: built for its base Grid Model and at its reference hour; read once per id. */
  const loadProfilesFor = (entry: GridModelCatalogEntry, model: GridModelV2): GridLoadProfiles => {
    const profilesEntry = loadProfilesEntry(entry.loadProfilesRef)
    const { file } = profilesEntry.source
    const baseRef = entry.source.kind === 'grid-model' ? entry.id : entry.source.baseModelRef
    if (profilesEntry.modelRef !== baseRef) throw new Error(`Grid Model ${entry.id}: its Load Profiles ${profilesEntry.id} are built for ${profilesEntry.modelRef}, not for ${baseRef}`)
    let profiles = profileSets.get(profilesEntry.id)
    if (profiles === undefined) {
      profiles = validateGridLoadProfiles(config.readModelFile(file), file)
      if (profiles.id !== profilesEntry.id) throw new Error(`${file}: $.id ${profiles.id} must be the catalog id ${profilesEntry.id}`)
      if (profiles.modelId !== profilesEntry.modelRef) throw new Error(`${file}: $.modelId ${profiles.modelId} must be the catalog model ${profilesEntry.modelRef}`)
      profileSets.set(profilesEntry.id, profiles)
    }
    if (Date.parse(profiles.referenceHour) !== Date.parse(model.referenceHour)) {
      throw new Error(`${file}: $.referenceHour ${profiles.referenceHour} is not the reference hour ${model.referenceHour} of Grid Model ${entry.id}`)
    }
    return profiles
  }

  const operatingPointDemand = (operatingPointRef: string, modelRef: string): GridOperatingPointDemand => {
    const { demand } = operatingPointEntry(operatingPointRef)
    return { profiles: loadProfilesFor(modelEntry(modelRef), compileModel(modelRef)), season: demand.season, referenceHour: demand.referenceHour }
  }

  const loadOperatingPoint = (ref: string, modelRef: string, model: GridModelV2): GridOperatingPointV2 => {
    const key = `${ref}\u0000${modelRef}`
    const cached = operatingPoints.get(key)
    if (cached !== undefined) return cached
    const entry = operatingPointEntry(ref)
    const { file } = entry.source
    const operatingPoint = validateGridOperatingPoint(config.readModelFile(file), file, gridOperatingPointTargetsForModel(model))
    if (operatingPoint.id !== entry.id) throw new Error(`${file}: $.id ${operatingPoint.id} must be the catalog id ${entry.id}`)
    if (operatingPoint.title !== entry.title) throw new Error(`${file}: $.title ${JSON.stringify(operatingPoint.title)} does not match the catalog entry ${JSON.stringify(entry.title)}`)
    for (const compatible of entry.compatibleModelRefs) {
      if (!operatingPoint.compatibleModelRefs.includes(compatible)) throw new Error(`${file}: $.compatibleModelRefs lacks ${compatible}, which the catalog entry lists`)
    }
    operatingPoints.set(key, operatingPoint)
    return operatingPoint
  }

  const compile = (definition: GridDefinition): CompiledGridDefinition => {
    const catalogModel = modelEntry(definition.model.ref)
    const operatingPointCatalogEntry = operatingPointEntry(definition.operatingPoint.ref)
    const automationCatalogEntry = automationEntry(definition.automation.ref)
    if (!operatingPointCatalogEntry.compatibleModelRefs.includes(definition.model.ref)) {
      throw new Error(`Grid Operating Point ${definition.operatingPoint.ref} is not compatible with Model ${definition.model.ref}`)
    }
    if (!automationCatalogEntry.compatibleModelRefs.includes(definition.model.ref)) {
      throw new Error(`Grid Automation ${definition.automation.ref} is not compatible with Model ${definition.model.ref}`)
    }
    const v2 = compileModel(definition.model.ref)
    const overrides = resolveOverrides(definition, gridOperatingPointTargetsForModel(v2))
    const automation = compileAutomation(definition.automation.ref)
    if (automation.swing.nominalFrequencyHz !== v2.nominalFrequencyHz) {
      throw new Error(`Grid Automation ${automation.id} is for ${automation.swing.nominalFrequencyHz} Hz, Model ${v2.id} for ${v2.nominalFrequencyHz} Hz`)
    }
    const key = [definition.model.ref, definition.operatingPoint.ref, JSON.stringify(overrides)].join('\u0000')
    let compiled = compiledModels.get(key)
    if (compiled === undefined) {
      const operatingPoint = operatingPointWithOverrides(loadOperatingPoint(definition.operatingPoint.ref, definition.model.ref, v2), overrides)
      const runtime = compileGridModelV2(v2, operatingPoint, operatingPointDemand(definition.operatingPoint.ref, definition.model.ref), {
        generationAvailabilityScale: overrides.generationAvailabilityScale,
        storageStateOfCharge: overrides.storageStateOfCharge,
      })
      requireCatalogMatch(catalogModel, runtime.model)
      compiled = { model: runtime.model, index: compileGridModelIndex(runtime.model), operatingPoint: runtime.operatingPoint, digest: sha256(JSON.stringify(runtime.model)) }
      compiledModels.set(key, compiled)
    }
    const definitionDigest = createHash('sha256')
      .update(compiled.digest)
      .update(JSON.stringify(compiled.operatingPoint))
      .update(JSON.stringify(automation))
      .digest('hex')
    return {
      gridId: definition.id,
      model: compiled.model,
      index: compiled.index,
      operatingPoint: compiled.operatingPoint,
      automation,
      definitionDigest,
    }
  }

  return { compileModel, compileAutomation, operatingPointDemand, compile }
}

/** Reads the built-in frequency-control presets in automations/. */
export const gridAutomationFileReader: GridModelFileReader = gridModelFileReader(new URL('./automations/', import.meta.url))

const builtinCompiler = createGridDefinitionCompiler({
  catalog: electricGridDefinitionCatalog,
  readModelFile: gridModelFileReader(new URL('./models/', import.meta.url)),
  readAutomationFile: gridAutomationFileReader,
})

export const compileGridDefinition = (definition: GridDefinition): CompiledGridDefinition => builtinCompiler.compile(definition)

/** A built-in frequency-control Automation by catalog id, read and validated on first use. */
export const gridAutomationPreset = (ref: string): GridAutomation => builtinCompiler.compileAutomation(ref)

/** A built-in Grid Model v2 by catalog id (composed when it is an addition), read and validated on first use. */
export const gridModelV2 = (ref: string): GridModelV2 => builtinCompiler.compileModel(ref)

/** The measured profiles and hour a built-in Operating Point's demand follows on a built-in Model. */
export const gridOperatingPointDemand = (operatingPointRef: string, modelRef: string): GridOperatingPointDemand =>
  builtinCompiler.operatingPointDemand(operatingPointRef, modelRef)
