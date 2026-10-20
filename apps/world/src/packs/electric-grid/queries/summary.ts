import { z } from 'zod'
import { gridProjectionSchema } from '../model.ts'
import { processContingencyPoolStatus } from '../runtime/contingency-pool.ts'
import { operatingPointImportMw } from '../runtime/boundary-separation.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import type { GridOperatingPointDefinition } from '../grid-model.ts'
import { gridDemandSampleClock } from '../runtime/demand.ts'
import { gridTablesFor } from '../runtime/state/tables.ts'
import { modelDiagnosticsSchema, modelFidelitySchema } from './catalog.ts'
import { defineGridQuery, gridFor, gridPayloadSchema } from './common.ts'
import { gridLoadingBands } from '../loading-bands.ts'
import {
  branchDefinitionSchema,
  demandProfileSeriesSchema,
  demandSampleSchema,
  generatorDefinitionSchema,
  generatorLifecycleStateSchema,
  loadDefinitionSchema,
  loadServiceStateSchema,
  loadShedCauseSchema,
} from './schemas.ts'

const finite = z.number().finite()
const count = z.number().int().nonnegative()

// A load is affected when any of its demand is unserved: shed manually, by LFDD, or lost to an outage.
const affectedLoadUnservedMw = 0
const constrainedBranchRowLimit = 8
const generatorRowLimit = 12
const affectedLoadRowLimit = 8

const operatingPointSummary = (operatingPoint: GridOperatingPointDefinition) => {
  const { branchStates, ...values } = operatingPoint
  return {
    ...values,
    hvdcSetpoints: operatingPoint.hvdcSetpoints.map(entry => ({ ...entry })),
    externalExchanges: operatingPoint.externalExchanges.map(entry => ({ ...entry, borders: entry.borders.map(border => ({ ...border, boundaryBusIds: [...border.boundaryBusIds] })) })),
    initialBranchStates: {
      openCount: branchStates.filter(entry => entry.state === 'open').length,
      deratedCount: branchStates.filter(entry => entry.state === 'closed' && entry.availability < 1).length,
    },
  }
}

const automationSummary = (grid: GridRuntimeInstance) => {
  const automation = grid.definition.automation
  return {
    id: automation.id,
    title: automation.title,
    description: automation.description,
    nominalFrequencyHz: automation.swing.nominalFrequencyHz,
    automaticFrequencyRestoration: automation.afrr.enabled,
    manualFrequencyRestoration: automation.mfrr.enabled,
    lfddStageThresholdsHz: automation.lfdd.stages.map(stage => stage.thresholdHz),
    synchroCheck: { ...automation.synchroCheck },
    externalExchangeRampMwPerMinute: automation.externalExchange.rampMwPerMinute,
  }
}

/** Each synchronous external system's exchange schedule now, beside the Operating Point's. */
const externalExchangesOf = (grid: GridRuntimeInstance) => grid.definition.index.externalSystems.flatMap((system, position) => {
  if (!system.synchronous) return []
  const state = grid.arrays.externalSystems[position]!
  return [{
    systemId: system.id,
    label: system.label,
    operatingPointExportMw: 0 - operatingPointImportMw(grid, system),
    scheduledExportMw: 0 - state.scheduledImportMw,
    targetExportMw: 0 - state.targetImportMw,
    exchangeMw: 0 - state.importMw,
    islandId: state.islandId,
    voidedBySeparation: state.exchangeVoided,
  }]
})

const summaryResultSchema = z.object({
  gridId: z.string(),
  model: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    sourceIds: z.array(z.string()),
    sourceBuild: z.object({ id: z.string(), generatedAt: z.string() }).strict(),
    fidelity: modelFidelitySchema,
  }).strict(),
  operatingPoint: z.object({
    id: z.string(),
    title: z.string(),
    loadScale: finite.describe('Multiplies every load\'s demand.'),
    generationAvailabilityScale: finite.describe('Multiplies every generator\'s availability.'),
    storageStateOfCharge: finite.nullable().describe('Initial charge of every storage asset; null when the Operating Point gives none.'),
    hvdcSetpoints: z.array(z.object({ linkId: z.string(), setpointMw: finite }).strict()).describe('Initial HVDC set-points (MW, positive from the link\'s fromBusId).'),
    externalExchanges: z.array(z.object({
      systemId: z.string(),
      scheduledExportMw: finite,
      borders: z.array(z.object({
        label: z.string().describe('The Norwegian price area and the external area, as NO1–SE3.'),
        boundaryBusIds: z.array(z.string()),
        scheduledExportMw: finite,
      }).strict()).describe('The schedule per AC border, the measured flow of the Operating Point\'s hour; they sum to scheduledExportMw.'),
    }).strict()).describe('Scheduled export to each synchronous external system (MW).'),
    initialBranchStates: z.object({
      openCount: z.number().int().nonnegative(),
      deratedCount: z.number().int().nonnegative(),
    }).strict().describe('Branches the Operating Point starts open, and closed branches it starts below their full rating (a summer ambient rating is such a derate); power-flow.snapshot gives each availability.'),
  }).strict(),
  automation: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    nominalFrequencyHz: finite,
    automaticFrequencyRestoration: z.boolean().describe('aFRR (AGC) acts in every energised island.'),
    manualFrequencyRestoration: z.boolean().describe('mFRR activates when aFRR is persistently used.'),
    lfddStageThresholdsHz: z.array(finite).describe('Under-frequency load-shedding stage thresholds, highest first (Hz).'),
    synchroCheck: z.object({
      maximumFrequencyDifferenceHz: finite.describe('Largest frequency difference at which a branch may close between two energised islands (Hz).'),
      maximumAngleDifferenceDegrees: finite.describe('Largest voltage-angle difference at which a branch may close a loop inside one energised island (°).'),
    }).strict(),
    externalExchangeRampMwPerMinute: finite.describe('Rate at which a synchronous external system\'s scheduled exchange follows set-external-exchange (MW/min); the model\'s assumption, not a published limit.'),
  }).strict().describe('The Grid Automation preset in force, summarised.'),
  externalExchanges: z.array(z.object({
    systemId: z.string(),
    label: z.string(),
    operatingPointExportMw: finite.describe('The Operating Point\'s scheduled exchange (MW, positive exports from Norway).'),
    scheduledExportMw: finite.describe('The schedule in force now (MW, positive exports); it ramps to targetExportMw.'),
    targetExportMw: finite.describe('The schedule\'s target: the dispatch\'s, the last set-external-exchange, or 0 after a separation voided it (MW, positive exports).'),
    exchangeMw: finite.describe('Power flowing to the system now, its schedule plus its response to frequency (MW, positive exports); 0 while coupled to no island.'),
    islandId: z.string().nullable().describe('The Norwegian island the system is coupled to through a closed tie; null while separated from every island.'),
    voidedBySeparation: z.boolean().describe('A separation from every Norwegian island voided the exchange and the schedule is not back at the Operating Point\'s; an external exchange-voided alarm is active meanwhile.'),
  }).strict()).describe('Each synchronous external system\'s exchange schedule beside the Operating Point\'s; set-external-exchange sets its target.'),
  projection: gridProjectionSchema,
  demandProfiles: z.object({
    sample: demandSampleSchema,
    profiles: z.array(z.object({
      id: z.string(),
      label: z.string(),
      series: demandProfileSeriesSchema.nullable(),
      sources: z.array(z.string()).describe('Sources of the profile values.'),
      factor: finite.describe('Factor at the demand sample.'),
      loadCount: count,
      demandMw: finite.describe('Demand of its loads at the demand sample, before shedding (MW).'),
    }).strict()),
  }).strict().describe('The daily profiles demand follows: for the Norway Models each price area\'s Elhub municipality group (private, business, industry) over the Operating Point season\'s measured week, 1 at the Operating Point\'s hour. asset.get gives a load\'s profile with its hour values.'),
  assetCounts: z.object({ bus: count, branch: count, generator: count, load: count, storage: count }).strict(),
  diagnostics: z.object({
    model: modelDiagnosticsSchema,
    runtime: z.object({
      lastSuccessfulTickAt: z.string().nullable(),
      lastTickDurationMs: finite,
      maximumTickDurationMs: finite,
      topologyRebuildCount: count,
      lastTopologyRebuildDurationMs: finite,
      queryCount: count,
      lastQueryDurationMs: finite,
      persistenceFailureCount: count,
      lastPersistenceFailure: z.string().nullable(),
      energyAudit: z.object({
        lastMaximumIslandMismatchMw: finite.describe('Largest |Σ injection| of an energised island at the last solve (MW); balance closes by construction.'),
        cumulativeMismatchMwh: finite,
        suppliedEnergyMwh: finite.describe('Generation and imports into islands over the run (MWh).'),
        servedEnergyMwh: finite,
        lossEnergyMwh: finite.describe('Branch and HVDC converter losses over the run (MWh).'),
        networkLossEnergyMwh: finite.describe('Losses of the networks below 132 kV behind the energised loads over the run (MWh): supplied = served + losses + these.'),
      }).strict(),
    }).strict(),
    contingencyWorkerPool: z.object({
      size: count.describe('Worker threads the process may run for N-1 screening; 0: every screening is inline.'),
      sizeReason: z.string().describe('How the size was chosen: cores, the configured cap and the cgroup v2 CPU quota (Linux) or the platform without one.'),
      liveWorkerCount: count.describe('Workers alive now; idle ones are terminated.'),
    }).strict().nullable().describe('The process\'s N-1 worker pool, shared by every Grid; null until the first screening creates it.'),
  }).strict(),
  thresholds: z.object({
    constrainedBranchLoadingPercent: finite.describe('constrainedBranches lists closed branches loaded at or above this percent, below any loading alarm.'),
    overloadLoadingPercent: finite.describe('The Automation\'s highest continuous-rating branch loading alarm raises at this percent: a branch at or above it is overloaded.'),
    affectedLoadUnservedMw: finite.describe('affectedLoads lists loads whose unserved demand exceeds this (MW).'),
  }).strict(),
  constrainedBranchCount: count,
  constrainedBranches: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: branchDefinitionSchema.shape.kind,
    state: z.object({ availability: finite, flowModel: z.enum(['ac', 'dc']).nullable(), flowMw: finite, apparentPowerMva: finite, loadingPercent: finite }).strict(),
  }).strict()).describe(`Most loaded constrained branches, at most ${constrainedBranchRowLimit}; empty when none is constrained.`),
  generators: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: generatorDefinitionSchema.shape.kind,
    state: z.object({ state: generatorLifecycleStateSchema, availableMw: finite, dispatchMw: finite, targetMw: finite }).strict(),
  }).strict()).describe(`Largest units by dispatch, at most ${generatorRowLimit}.`),
  affectedLoadCount: count,
  affectedLoads: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: loadDefinitionSchema.shape.kind,
    priority: loadDefinitionSchema.shape.priority,
    state: z.object({
      demandMw: finite,
      servedMw: finite,
      unservedMw: finite.describe('curtailedMw + lfddShedMw + outageMw (MW).'),
      shedMw: finite,
      curtailedMw: finite,
      lfddShedMw: finite,
      outageMw: finite.describe('Lost because the island is de-energised (MW).'),
      shedCauses: z.array(loadShedCauseSchema),
      serviceState: loadServiceStateSchema,
    }).strict(),
  }).strict()).describe(`Loads with the most unserved demand, at most ${affectedLoadRowLimit}; empty when all demand is served.`),
}).strict()

const demandProfilesSummary = (grid: GridRuntimeInstance) => {
  const profiles = grid.definition.model.demandProfiles
  const loadProfile = gridTablesFor(grid.definition).loadDemandProfile
  const loadCount = new Array<number>(profiles.length).fill(0)
  const demandMw = new Array<number>(profiles.length).fill(0)
  loadProfile.forEach((profile, load) => {
    loadCount[profile]! += 1
    demandMw[profile]! += grid.arrays.loads.demandMw[load]!
  })
  return {
    sample: gridDemandSampleClock(grid.demandSample),
    profiles: profiles.map((profile, index) => ({
      id: profile.id,
      label: profile.label,
      series: profile.series === null ? null : { ...profile.series },
      sources: [...profile.provenance.sources],
      factor: grid.demandSample.factors[index]!,
      loadCount: loadCount[index]!,
      demandMw: demandMw[index]!,
    })),
  }
}

const summaryFor = (grid: GridRuntimeInstance): z.infer<typeof summaryResultSchema> => {
  const model = grid.definition.model
  const bands = gridLoadingBands(grid.definition.automation.alarms)
  const constrained = model.branches
    .map(definition => ({ definition, state: grid.branches.get(definition.id)! }))
    .filter(branch => branch.state.state === 'closed' && branch.state.loadingPercent >= bands.attentionPercent)
    .sort((left, right) => right.state.loadingPercent - left.state.loadingPercent)
  const affected = model.loads
    .map(definition => ({ definition, state: grid.loads.get(definition.id)! }))
    .filter(load => load.state.unservedMw > affectedLoadUnservedMw)
    .sort((left, right) => right.state.unservedMw - left.state.unservedMw)
  const generators = model.generators
    .map(definition => ({ definition, state: grid.generators.get(definition.id)! }))
    .sort((left, right) => right.state.dispatchMw - left.state.dispatchMw)
    .slice(0, generatorRowLimit)
  return {
    gridId: grid.definition.gridId,
    model: {
      id: model.id,
      title: model.title,
      description: model.description,
      sourceIds: [...model.sourceIds],
      sourceBuild: { ...model.sourceBuild },
      fidelity: { ...model.fidelity },
    },
    operatingPoint: operatingPointSummary(grid.definition.operatingPoint),
    automation: automationSummary(grid),
    externalExchanges: externalExchangesOf(grid),
    projection: grid.projection,
    demandProfiles: demandProfilesSummary(grid),
    assetCounts: {
      bus: model.buses.length,
      branch: model.branches.length,
      generator: model.generators.length,
      load: model.loads.length,
      storage: model.storage.length,
    },
    diagnostics: {
      model: grid.definition.index.diagnostics,
      runtime: { ...grid.diagnostics, energyAudit: { ...grid.diagnostics.energyAudit } },
      contingencyWorkerPool: processContingencyPoolStatus(),
    },
    thresholds: { constrainedBranchLoadingPercent: bands.attentionPercent, overloadLoadingPercent: bands.overloadPercent, affectedLoadUnservedMw },
    constrainedBranchCount: constrained.length,
    constrainedBranches: constrained.slice(0, constrainedBranchRowLimit).map(({ definition, state }) => ({
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      state: { availability: state.availability, flowModel: state.flowModel, flowMw: state.flowMw, apparentPowerMva: state.apparentPowerMva, loadingPercent: state.loadingPercent },
    })),
    generators: generators.map(({ definition, state }) => ({
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      state: { state: state.state, availableMw: state.availableMw, dispatchMw: state.dispatchMw, targetMw: state.targetMw },
    })),
    affectedLoadCount: affected.length,
    affectedLoads: affected.slice(0, affectedLoadRowLimit).map(({ definition, state }) => ({
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      priority: definition.priority,
      state: {
        demandMw: state.demandMw,
        servedMw: state.servedMw,
        unservedMw: state.unservedMw,
        shedMw: state.shedMw,
        curtailedMw: state.curtailedMw,
        lfddShedMw: state.lfddShedMw,
        outageMw: state.outageMw,
        shedCauses: [...state.shedCauses],
        serviceState: state.serviceState,
      },
    })),
  }
}

export const gridSummaryQuery = defineGridQuery({
  id: 'world.electric-grid.grid.summary',
  title: 'Get Grid summary',
  description: 'Returns the Grid projection (system frequency, generation, demand, served and unserved load, reserve), each synchronous external system\'s exchange schedule beside the Operating Point\'s, asset counts, fidelity and diagnostics, the most loaded constrained branches, the largest units, and the loads with unserved demand. The thresholds field states what counts as constrained and affected. Per-island frequency is in world.electric-grid.islands.list.',
  searchTerms: ['grid status', 'overview', 'system state', 'frequency', 'balance', 'reserve', 'unserved load', 'constrained corridors', 'nettstatus', 'oversikt', 'driftsbilde', 'frekvens', 'ikke levert energi', 'flaskehals'],
  input: gridPayloadSchema,
  output: summaryResultSchema,
  answer: (payload, grids) => summaryFor(gridFor(grids, payload.gridId)),
})
