import { z } from 'zod'
import { gridDataError, parseGridData, type GridDataIssue } from './data-issues.ts'
import { externalAreaSchema, gridIdPatterns, loadDemandGroups, municipalityLoadGroups, priceAreaSchema, type ExternalArea, type MunicipalityLoadGroup, type PriceArea } from './grid-ids.ts'
import { gridIsoHourSchema, gridProvenanceSchema, type GridModelV2 } from './grid-model.ts'

// Operating Point v2: the initial condition of a Grid Model, keyed by stable asset ids.
// The demand of each price area and Elhub group (demand.priceAreaGroupMw) is shared by its loads
// in proportion to their referenceDemandMw; loadScale and priceAreaDemandScale[area] multiply it.
// Absent per-asset entries leave that asset as the model and runtime initialise it.

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

/**
 * A synchronous external system's exchange, per AC border (gridExchangeBordersOf): positive exportMw
 * flows from Norway over the border's ties into the external area. The system's exchange is the sum.
 */
export const gridExchangeScheduleSchema = z.object({
  assetId: assetId(gridIdPatterns.externalSystem, 'external system'),
  timeZone: z.literal('Europe/Oslo'),
  points: z.array(z.object({
    localTime,
    borders: z.array(z.object({ priceArea: priceAreaSchema, externalArea: externalAreaSchema, exportMw: z.number().finite() }).strict()).min(1),
  }).strict().superRefine((point, context) => {
    const seen = new Set<string>()
    point.borders.forEach((border, index) => {
      const label = gridExchangeBorderLabel(border)
      if (seen.has(label)) context.addIssue({ code: 'custom', path: ['borders', index], message: `${label} already has an entry` })
      seen.add(label)
    })
  })).min(1),
}).strict().superRefine(requireIncreasingTimes)

/**
 * The state of a synchronous external equivalent at this Operating Point: the kinetic energy of
 * its synchronous machines and its demand vary with the season and hour, its reserve volumes do not.
 */
export const gridExternalSystemStateSchema = z.object({
  assetId: assetId(gridIdPatterns.externalSystem, 'external system'),
  /** Kinetic energy E_k of the equivalent's synchronous machines. */
  inertiaGws: positive,
  /** Demand of the equivalent, for its load self-regulation. */
  loadMw: positive,
  provenance: gridProvenanceSchema,
}).strict()

/** Fields shared by Operating Point files and Scenario operatingPoint.overrides. */
export const gridOperatingPointStateShape = {
  loadScale: positive,
  priceAreaDemandScale: z.partialRecord(priceAreaSchema, positive).optional(),
  generatorStates: z.array(gridGeneratorInitialStateSchema).optional(),
  branchStates: z.array(gridBranchInitialStateSchema).optional(),
  hvdcSchedules: z.array(gridHvdcScheduleSchema).optional(),
  externalExchangeSchedules: z.array(gridExchangeScheduleSchema).optional(),
  externalSystemStates: z.array(gridExternalSystemStateSchema).optional(),
}

export interface GridOperatingPointState {
  readonly loadScale?: number | undefined
  readonly priceAreaDemandScale?: Partial<Record<PriceArea, number>> | undefined
  readonly generatorStates?: ReadonlyArray<z.infer<typeof gridGeneratorInitialStateSchema>> | undefined
  readonly branchStates?: ReadonlyArray<z.infer<typeof gridBranchInitialStateSchema>> | undefined
  readonly hvdcSchedules?: ReadonlyArray<z.infer<typeof gridHvdcScheduleSchema>> | undefined
  readonly externalExchangeSchedules?: ReadonlyArray<z.infer<typeof gridExchangeScheduleSchema>> | undefined
  readonly externalSystemStates?: ReadonlyArray<z.infer<typeof gridExternalSystemStateSchema>> | undefined
}
export const gridOperatingPointPerAssetFields = ['generatorStates', 'branchStates', 'hvdcSchedules', 'externalExchangeSchedules', 'externalSystemStates'] as const

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

/**
 * The measured hour whose demand the Operating Point sets, the demand of each price area and Elhub
 * group in it, and the season of the load profiles its loads follow from there: each profile is
 * exactly 1 at that hour.
 */
export const gridOperatingPointDemandSchema = z.object({
  season: z.enum(['winter', 'summer']),
  /** A whole Europe/Oslo hour inside the season's profile week, ISO 8601 with its offset. */
  referenceHour: gridIsoHourSchema,
  /** Demand of each price area and Elhub group at that hour (MW): an entry for every area and group the model has loads in. */
  priceAreaGroupMw: z.partialRecord(priceAreaSchema, z.partialRecord(z.enum(municipalityLoadGroups), positive)),
  /**
   * Losses of the networks below 132 kV in each price area at that hour (MW), which no meter in
   * priceAreaGroupMw sees: an entry for every area the model has loads in. Each of the area's loads
   * carries a share in proportion to its demand, follows its demand profile with it, and is never
   * shed or curtailed as consumer demand.
   */
  networkLossMw: z.partialRecord(priceAreaSchema, nonNegative),
}).strict()

export const gridOperatingPointSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().regex(gridIdPatterns.definitionRef, 'must be an electric-grid definition ref'),
  title: z.string().min(1),
  description: z.string().min(1),
  compatibleModelRefs: z.array(z.string().regex(gridIdPatterns.definitionRef)).min(1),
  demand: gridOperatingPointDemandSchema,
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

/**
 * An AC border of a synchronous external system: the system's boundary buses in one of its areas
 * whose ties end in one Norwegian price area (NO1–SE3: Hasle – Borgvik, Halden – Skogssäter and
 * Eidskog – Charlottenberg). Physical cross-border flows are published per such border.
 */
export interface GridExchangeBorder {
  readonly priceArea: PriceArea
  readonly externalArea: ExternalArea
  readonly boundaryBusIds: ReadonlyArray<string>
  /** Continuous rating of the border's ties (MW). */
  readonly ratingMw: number
}

export const gridExchangeBorderLabel = (border: { readonly priceArea: PriceArea; readonly externalArea: ExternalArea }): string => `${border.priceArea}–${border.externalArea}`

/** The AC borders of each synchronous external system of a model, in price-area then external-area order; a boundary bus whose ties end in several price areas, or in none, is refused. */
export const gridExchangeBordersOf = (model: GridModelV2): ReadonlyMap<string, ReadonlyArray<GridExchangeBorder>> => {
  const busById = new Map(model.buses.map(bus => [bus.id, bus]))
  const ties = new Map<string, Array<{ readonly priceArea: PriceArea | undefined; readonly ratingMw: number }>>()
  for (const branch of model.branches) {
    for (const [own, other] of [[branch.fromBusId, branch.toBusId], [branch.toBusId, branch.fromBusId]] as const) {
      ties.set(own, [...(ties.get(own) ?? []), { priceArea: busById.get(other)?.priceArea, ratingMw: branch.ratingMw }])
    }
  }
  return new Map(model.externalSystems.filter(system => system.synchronous).map(system => {
    const borders = new Map<string, { priceArea: PriceArea; externalArea: ExternalArea; boundaryBusIds: string[]; ratingMw: number }>()
    for (const busId of system.boundaryBusIds) {
      const externalArea = busById.get(busId)?.externalArea
      const busTies = ties.get(busId) ?? []
      const areas = [...new Set(busTies.map(tie => tie.priceArea))]
      if (externalArea === undefined || areas.length !== 1 || areas[0] === undefined) {
        throw new Error(`${system.id}: boundary bus ${busId} must tie into exactly one Norwegian price area, it ties into ${areas.length === 0 ? 'none' : areas.map(area => area ?? 'a non-Norwegian bus').join(', ')}`)
      }
      const priceArea = areas[0]
      const label = gridExchangeBorderLabel({ priceArea, externalArea })
      const border = borders.get(label) ?? { priceArea, externalArea, boundaryBusIds: [], ratingMw: 0 }
      border.boundaryBusIds.push(busId)
      border.ratingMw += busTies.reduce((sum, tie) => sum + tie.ratingMw, 0)
      borders.set(label, border)
    }
    return [system.id, [...borders.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, border]) => border)] as const
  }))
}

/** The assets of one compiled Grid Model that an Operating Point may address. */
export interface GridOperatingPointTargets {
  readonly generators: ReadonlyMap<string, { readonly capacityMw: number }>
  readonly branches: ReadonlySet<string>
  readonly hvdcLinks: ReadonlyMap<string, { readonly ratingMw: number }>
  /** External systems; a synchronous one with its AC borders. */
  readonly externalSystems: ReadonlyMap<string, { readonly synchronous: boolean; readonly borders: ReadonlyArray<GridExchangeBorder> }>
  readonly loadPriceAreas: ReadonlySet<string>
  /** The Elhub groups the model has loads of, per price area. */
  readonly loadGroupsByPriceArea: ReadonlyMap<string, ReadonlySet<MunicipalityLoadGroup>>
}

const loadGroupsByPriceArea = (model: GridModelV2): ReadonlyMap<string, ReadonlySet<MunicipalityLoadGroup>> => {
  const groups = new Map<string, Set<MunicipalityLoadGroup>>()
  for (const load of model.loads) {
    const area = groups.get(load.priceArea) ?? new Set<MunicipalityLoadGroup>()
    area.add(loadDemandGroups[load.kind])
    groups.set(load.priceArea, area)
  }
  return groups
}

export const gridOperatingPointTargetsForModel = (model: GridModelV2): GridOperatingPointTargets => {
  const borders = gridExchangeBordersOf(model)
  return {
    generators: new Map(model.generators.map(generator => [generator.id, generator])),
    branches: new Set(model.branches.map(branch => branch.id)),
    hvdcLinks: new Map(model.hvdcLinks.map(link => [link.id, link])),
    externalSystems: new Map(model.externalSystems.map(system => [system.id, { synchronous: system.synchronous, borders: borders.get(system.id) ?? [] }])),
    loadPriceAreas: new Set(model.loads.map(load => load.priceArea)),
    loadGroupsByPriceArea: loadGroupsByPriceArea(model),
  }
}

/** Issues of an Operating Point's demand against one model: one entry for exactly each price area and group with loads. */
const demandIssues = (demand: GridOperatingPointV2['demand'], targets: GridOperatingPointTargets): ReadonlyArray<GridDataIssue> => {
  const issues: GridDataIssue[] = []
  const path = ['demand', 'priceAreaGroupMw'] as const
  for (const [area, groups] of targets.loadGroupsByPriceArea) {
    const entries = demand.priceAreaGroupMw[area as PriceArea]
    for (const group of municipalityLoadGroups) {
      if (groups.has(group) && entries?.[group] === undefined) issues.push({ path: [...path, area, group], message: `required: the model has ${area} ${group} loads` })
    }
  }
  for (const [area, entries] of Object.entries(demand.priceAreaGroupMw)) {
    for (const group of Object.keys(entries ?? {})) {
      if (!targets.loadGroupsByPriceArea.get(area)?.has(group as MunicipalityLoadGroup)) issues.push({ path: [...path, area, group], message: `the model has no ${area} ${group} loads` })
    }
  }
  for (const area of targets.loadPriceAreas) {
    if (demand.networkLossMw[area as PriceArea] === undefined) issues.push({ path: ['demand', 'networkLossMw', area], message: `required: the model has ${area} loads` })
  }
  for (const area of Object.keys(demand.networkLossMw)) {
    if (!targets.loadPriceAreas.has(area)) issues.push({ path: ['demand', 'networkLossMw', area], message: `the model has no loads in ${area}` })
  }
  return issues
}

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
    if (system === undefined) return fail(['externalExchangeSchedules', index, 'assetId'], `unknown external system ${entry.assetId}`)
    if (!system.synchronous) return fail(['externalExchangeSchedules', index, 'assetId'], `${entry.assetId} is reached only through HVDC; schedule its links instead`)
    const byLabel = new Map(system.borders.map(border => [gridExchangeBorderLabel(border), border]))
    entry.points.forEach((point, pointIndex) => {
      const path = ['externalExchangeSchedules', index, 'points', pointIndex, 'borders'] as const
      const listed = new Set(point.borders.map(gridExchangeBorderLabel))
      for (const label of byLabel.keys()) if (!listed.has(label)) fail(path, `required: ${entry.assetId} has the AC border ${label}`)
      point.borders.forEach((border, borderIndex) => {
        const target = byLabel.get(gridExchangeBorderLabel(border))
        if (target === undefined) return fail([...path, borderIndex], `${entry.assetId} has no AC border ${gridExchangeBorderLabel(border)}`)
        if (Math.abs(border.exportMw) > target.ratingMw) fail([...path, borderIndex, 'exportMw'], `must be within ±${target.ratingMw} MW, the rating of the border's ties`)
      })
    })
  })
  state.externalSystemStates?.forEach((entry, index) => {
    const system = targets.externalSystems.get(entry.assetId)
    if (system === undefined) fail(['externalSystemStates', index, 'assetId'], `unknown external system ${entry.assetId}`)
    else if (!system.synchronous) fail(['externalSystemStates', index, 'assetId'], `${entry.assetId} is not synchronous: it has no inertia or load in the model`)
  })
  return issues
}

/** Validates Operating Point v2 JSON against one compatible model; errors carry JSON paths. */
export const validateGridOperatingPoint = (json: unknown, source: string, targets: GridOperatingPointTargets): GridOperatingPointV2 => {
  const operatingPoint = parseGridData(gridOperatingPointSchema, json, source, 'Grid Operating Point v2')
  const issues = [
    ...demandIssues(operatingPoint.demand, targets),
    ...gridOperatingPointStateIssues(operatingPoint, targets),
    ...(operatingPoint.branchRatings ?? []).flatMap((entry, index): GridDataIssue[] =>
      targets.branches.has(entry.assetId) ? [] : [{ path: ['branchRatings', index, 'assetId'], message: `unknown branch ${entry.assetId}` }]),
  ]
  if (issues.length > 0) throw gridDataError(source, 'Grid Operating Point v2', issues)
  return operatingPoint
}
