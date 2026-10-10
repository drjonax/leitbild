import { z } from 'zod'
import { gridProjectionSchema } from '../model.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
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
    loadScale: finite,
    generationAvailabilityScale: finite,
    storageStateOfCharge: finite,
  }).strict(),
  automation: z.object({
    id: z.string(),
    title: z.string(),
    loadProfiles: z.boolean(),
    storageFrequencyResponse: z.boolean(),
    underFrequencyLoadShedding: z.boolean(),
    primaryFrequencyResponseMwPerHz: finite,
    synchroCheckHz: finite,
  }).strict(),
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
    }).strict(),
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
    state: z.object({ availability: finite, flowMw: finite, loadingPercent: finite }).strict(),
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
      unservedMw: finite,
      shedMw: finite,
      curtailedMw: finite,
      lfddShedMw: finite,
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
    .filter(load => load.state.demandMw - load.state.servedMw > affectedLoadUnservedMw)
    .sort((left, right) => (right.state.demandMw - right.state.servedMw) - (left.state.demandMw - left.state.servedMw))
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
    operatingPoint: { ...grid.definition.operatingPoint },
    automation: { ...grid.definition.automation },
    projection: grid.projection,
    assetCounts: {
      bus: model.buses.length,
      branch: model.branches.length,
      generator: model.generators.length,
      load: model.loads.length,
      storage: model.storage.length,
    },
    diagnostics: { model: grid.definition.index.diagnostics, runtime: { ...grid.diagnostics } },
    thresholds: { constrainedBranchLoadingPercent, affectedLoadUnservedMw },
    constrainedBranchCount: constrained.length,
    constrainedBranches: constrained.slice(0, constrainedBranchRowLimit).map(({ definition, state }) => ({
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      state: { availability: state.availability, flowMw: state.flowMw, loadingPercent: state.loadingPercent },
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
        unservedMw: state.demandMw - state.servedMw,
        shedMw: state.shedMw,
        curtailedMw: state.curtailedMw,
        lfddShedMw: state.lfddShedMw,
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
