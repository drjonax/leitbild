import { z } from 'zod'
import { gridProjectionSchema } from '../model.ts'
import { processContingencyPoolStatus } from '../runtime/contingency-pool.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import type { GridOperatingPointDefinition } from '../grid-model.ts'
import { modelDiagnosticsSchema, modelFidelitySchema } from './catalog.ts'
import { defineGridQuery, gridFor, gridPayloadSchema } from './common.ts'
import {
  branchDefinitionSchema,
  generatorDefinitionSchema,
  generatorLifecycleStateSchema,
  loadDefinitionSchema,
  loadServiceStateSchema,
  loadShedCauseSchema,
} from './schemas.ts'

const finite = z.number().finite()
const count = z.number().int().nonnegative()

// 70 %: the corridor attention band below the 85 % loading alarm (runtime/projection.ts); grid overhaul audit C-17.
const constrainedBranchLoadingPercent = 70
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
    externalExchanges: operatingPoint.externalExchanges.map(entry => ({ ...entry })),
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
  }
}

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
    externalExchanges: z.array(z.object({ systemId: z.string(), scheduledExportMw: finite }).strict()).describe('Scheduled export to each synchronous external system (MW).'),
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
  }).strict().describe('The Grid Automation preset in force, summarised.'),
  projection: gridProjectionSchema,
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
        lossEnergyMwh: finite,
      }).strict(),
    }).strict(),
    contingencyWorkerPool: z.object({
      size: count.describe('Worker threads the process may run for N-1 screening; 0: every screening is inline.'),
      sizeReason: z.string().describe('How the size was chosen: cores, the configured cap and the cgroup v2 CPU quota (Linux) or the platform without one.'),
      liveWorkerCount: count.describe('Workers alive now; idle ones are terminated.'),
    }).strict().nullable().describe('The process\'s N-1 worker pool, shared by every Grid; null until the first screening creates it.'),
  }).strict(),
  thresholds: z.object({
    constrainedBranchLoadingPercent: finite.describe('constrainedBranches lists closed branches loaded at or above this percent.'),
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

const summaryFor = (grid: GridRuntimeInstance): z.infer<typeof summaryResultSchema> => {
  const model = grid.definition.model
  const constrained = model.branches
    .map(definition => ({ definition, state: grid.branches.get(definition.id)! }))
    .filter(branch => branch.state.state === 'closed' && branch.state.loadingPercent >= constrainedBranchLoadingPercent)
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
    projection: grid.projection,
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
    thresholds: { constrainedBranchLoadingPercent, affectedLoadUnservedMw },
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
  description: 'Returns the Grid projection (system frequency, generation, demand, served and unserved load, reserve), asset counts, fidelity and diagnostics, the most loaded constrained branches, the largest units, and the loads with unserved demand. The thresholds field states what counts as constrained and affected. Per-island frequency is in world.electric-grid.islands.list.',
  searchTerms: ['grid status', 'overview', 'system state', 'frequency', 'balance', 'reserve', 'unserved load', 'constrained corridors', 'nettstatus', 'oversikt', 'driftsbilde', 'frekvens', 'ikke levert energi', 'flaskehals'],
  input: gridPayloadSchema,
  output: summaryResultSchema,
  answer: (payload, grids) => summaryFor(gridFor(grids, payload.gridId)),
})
