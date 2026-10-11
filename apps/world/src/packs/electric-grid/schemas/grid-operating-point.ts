import { z } from 'zod'
import { gridDataError, parseGridData, type GridDataIssue } from './data-issues.ts'
import { gridIdPatterns, priceAreaSchema, type PriceArea } from './grid-ids.ts'
import type { GridModelV2 } from './grid-model.ts'

// Operating Point v2: the initial condition of a Grid Model, keyed by stable asset ids.
// Demand is referenceDemandMw × loadScale × priceAreaDemandScale[area]. Absent per-asset
// entries leave that asset as the model and runtime initialise it.

const positive = z.number().finite().positive()
const nonNegative = z.number().finite().nonnegative()
const assetId = (pattern: RegExp, kind: string) => z.string().regex(pattern, `must be a ${kind} id`)
/** Europe/Oslo wall-clock time of day. */
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'must be a HH:MM local time')

export const gridGeneratorInitialStateSchema = z.object({
  assetId: assetId(gridIdPatterns.generator, 'generator'),
  state: z.enum(['online', 'offline', 'tripped']),
  availableMw: nonNegative.optional(),
  targetMw: nonNegative.optional(),
}).strict().superRefine((entry, context) => {
  if (entry.state !== 'online' && entry.targetMw !== undefined && entry.targetMw > 0) context.addIssue({ code: 'custom', path: ['targetMw'], message: `a ${entry.state} generator has no dispatch target` })
  if (entry.targetMw !== undefined && entry.availableMw !== undefined && entry.targetMw > entry.availableMw) {
    context.addIssue({ code: 'custom', path: ['targetMw'], message: `must not exceed availableMw (${entry.availableMw})` })
  }
})

export const gridBranchInitialStateSchema = z.object({
  assetId: assetId(gridIdPatterns.branch, 'branch'),
  state: z.enum(['closed', 'open']),
  /** Available fraction of the rating; the derate-branch command accepts the same range. */
  availability: z.number().finite().min(0.05).max(1).optional(),
}).strict()

/**
 * A branch's continuous and emergency rating at this Operating Point's conditions (such as its air
 * temperature), replacing the model's ratingMw and emergencyRatingMw; an availability in
 * branchStates derates these in turn.
 */
export const gridBranchRatingSchema = z.object({
  assetId: assetId(gridIdPatterns.branch, 'branch'),
  ratingMw: positive,
  emergencyRatingMw: positive,
}).strict().superRefine((entry, context) => {
  if (entry.emergencyRatingMw < entry.ratingMw) context.addIssue({ code: 'custom', path: ['emergencyRatingMw'], message: `must be at least ratingMw (${entry.ratingMw})` })
})

const requireIncreasingTimes = (value: { readonly points: ReadonlyArray<{ readonly localTime: string }> }, context: z.core.$RefinementCtx<unknown>): void => {
  value.points.forEach((entry, index) => {
    const previous = value.points[index - 1]
    if (previous !== undefined && entry.localTime <= previous.localTime) {
      context.addIssue({ code: 'custom', path: ['points', index, 'localTime'], message: `must follow ${previous.localTime}` })
    }
  })
}

// A schedule's set-point holds until its next point; the last holds until the first point of the next day.
/** Positive transferMw flows from the link's fromBusId to its toBusId. */
export const gridHvdcScheduleSchema = z.object({
  assetId: assetId(gridIdPatterns.hvdcLink, 'HVDC link'),
  timeZone: z.literal('Europe/Oslo'),
  points: z.array(z.object({ localTime, transferMw: z.number().finite() }).strict()).min(1),
}).strict().superRefine(requireIncreasingTimes)

/** Positive exportMw flows from Norway into the external area. */
export const gridExchangeScheduleSchema = z.object({
  assetId: assetId(gridIdPatterns.externalSystem, 'external system'),
  timeZone: z.literal('Europe/Oslo'),
  points: z.array(z.object({ localTime, exportMw: z.number().finite() }).strict()).min(1),
}).strict().superRefine(requireIncreasingTimes)

/** Fields shared by Operating Point files and Scenario operatingPoint.overrides. */
export const gridOperatingPointStateShape = {
  loadScale: positive,
  priceAreaDemandScale: z.partialRecord(priceAreaSchema, positive).optional(),
  generatorStates: z.array(gridGeneratorInitialStateSchema).optional(),
  branchStates: z.array(gridBranchInitialStateSchema).optional(),
  hvdcSchedules: z.array(gridHvdcScheduleSchema).optional(),
  externalExchangeSchedules: z.array(gridExchangeScheduleSchema).optional(),
}

export interface GridOperatingPointState {
  readonly loadScale?: number | undefined
  readonly priceAreaDemandScale?: Partial<Record<PriceArea, number>> | undefined
  readonly generatorStates?: ReadonlyArray<z.infer<typeof gridGeneratorInitialStateSchema>> | undefined
  readonly branchStates?: ReadonlyArray<z.infer<typeof gridBranchInitialStateSchema>> | undefined
  readonly hvdcSchedules?: ReadonlyArray<z.infer<typeof gridHvdcScheduleSchema>> | undefined
  readonly externalExchangeSchedules?: ReadonlyArray<z.infer<typeof gridExchangeScheduleSchema>> | undefined
}
export const gridOperatingPointPerAssetFields = ['generatorStates', 'branchStates', 'hvdcSchedules', 'externalExchangeSchedules'] as const

/** One entry per asset in each per-asset list. */
export const refineGridOperatingPointState = (state: GridOperatingPointState, context: z.core.$RefinementCtx<unknown>): void => {
  for (const field of gridOperatingPointPerAssetFields) {
    const seen = new Set<string>()
    state[field]?.forEach((entry, index) => {
      if (seen.has(entry.assetId)) context.addIssue({ code: 'custom', path: [field, index, 'assetId'], message: `${entry.assetId} already has an entry` })
      seen.add(entry.assetId)
    })
  }
}

export const gridOperatingPointSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().regex(gridIdPatterns.definitionRef, 'must be an electric-grid definition ref'),
  title: z.string().min(1),
  description: z.string().min(1),
  compatibleModelRefs: z.array(z.string().regex(gridIdPatterns.definitionRef)).min(1),
  ...gridOperatingPointStateShape,
  branchRatings: z.array(gridBranchRatingSchema).optional(),
}).strict().superRefine((operatingPoint, context) => {
  refineGridOperatingPointState(operatingPoint, context)
  const seen = new Set<string>()
  operatingPoint.branchRatings?.forEach((entry, index) => {
    if (seen.has(entry.assetId)) context.addIssue({ code: 'custom', path: ['branchRatings', index, 'assetId'], message: `${entry.assetId} already has an entry` })
    seen.add(entry.assetId)
  })
})
export type GridOperatingPointV2 = z.infer<typeof gridOperatingPointSchema>

/** The assets of one compiled Grid Model that an Operating Point may address. */
export interface GridOperatingPointTargets {
  readonly generators: ReadonlyMap<string, { readonly capacityMw: number }>
  readonly branches: ReadonlySet<string>
  readonly hvdcLinks: ReadonlyMap<string, { readonly ratingMw: number }>
  readonly externalSystems: ReadonlyMap<string, { readonly synchronous: boolean }>
  readonly loadPriceAreas: ReadonlySet<string>
}

export const gridOperatingPointTargetsForModel = (model: GridModelV2): GridOperatingPointTargets => ({
  generators: new Map(model.generators.map(generator => [generator.id, generator])),
  branches: new Set(model.branches.map(branch => branch.id)),
  hvdcLinks: new Map(model.hvdcLinks.map(link => [link.id, link])),
  externalSystems: new Map(model.externalSystems.map(system => [system.id, system])),
  loadPriceAreas: new Set(model.loads.map(load => load.priceArea)),
})

/** Issues of an Operating Point state against one model, with paths relative to the state. */
export const gridOperatingPointStateIssues = (state: GridOperatingPointState, targets: GridOperatingPointTargets): ReadonlyArray<GridDataIssue> => {
  const issues: GridDataIssue[] = []
  const fail = (path: ReadonlyArray<PropertyKey>, message: string): void => { issues.push({ path, message }) }
  for (const area of Object.keys(state.priceAreaDemandScale ?? {})) {
    if (!targets.loadPriceAreas.has(area)) fail(['priceAreaDemandScale', area], `the model has no loads in ${area}`)
  }
  state.generatorStates?.forEach((entry, index) => {
    const generator = targets.generators.get(entry.assetId)
    if (generator === undefined) return fail(['generatorStates', index, 'assetId'], `unknown generator ${entry.assetId}`)
    if (entry.availableMw !== undefined && entry.availableMw > generator.capacityMw) fail(['generatorStates', index, 'availableMw'], `must not exceed capacityMw (${generator.capacityMw})`)
    if (entry.targetMw !== undefined && entry.targetMw > generator.capacityMw) fail(['generatorStates', index, 'targetMw'], `must not exceed capacityMw (${generator.capacityMw})`)
  })
  state.branchStates?.forEach((entry, index) => {
    if (!targets.branches.has(entry.assetId)) fail(['branchStates', index, 'assetId'], `unknown branch ${entry.assetId}`)
  })
  state.hvdcSchedules?.forEach((entry, index) => {
    const link = targets.hvdcLinks.get(entry.assetId)
    if (link === undefined) return fail(['hvdcSchedules', index, 'assetId'], `unknown HVDC link ${entry.assetId}`)
    entry.points.forEach((point, pointIndex) => {
      if (Math.abs(point.transferMw) > link.ratingMw) fail(['hvdcSchedules', index, 'points', pointIndex, 'transferMw'], `must be within ±${link.ratingMw} MW`)
    })
  })
  state.externalExchangeSchedules?.forEach((entry, index) => {
    const system = targets.externalSystems.get(entry.assetId)
    if (system === undefined) fail(['externalExchangeSchedules', index, 'assetId'], `unknown external system ${entry.assetId}`)
    else if (!system.synchronous) fail(['externalExchangeSchedules', index, 'assetId'], `${entry.assetId} is reached only through HVDC; schedule its links instead`)
  })
  return issues
}

/** Validates Operating Point v2 JSON against one compatible model; errors carry JSON paths. */
export const validateGridOperatingPoint = (json: unknown, source: string, targets: GridOperatingPointTargets): GridOperatingPointV2 => {
  const operatingPoint = parseGridData(gridOperatingPointSchema, json, source, 'Grid Operating Point v2')
  const issues = [
    ...gridOperatingPointStateIssues(operatingPoint, targets),
    ...(operatingPoint.branchRatings ?? []).flatMap((entry, index): GridDataIssue[] =>
      targets.branches.has(entry.assetId) ? [] : [{ path: ['branchRatings', index, 'assetId'], message: `unknown branch ${entry.assetId}` }]),
  ]
  if (issues.length > 0) throw gridDataError(source, 'Grid Operating Point v2', issues)
  return operatingPoint
}
