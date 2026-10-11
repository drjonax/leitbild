import { z } from 'zod'

// Automation sections for branch protection and the alarm system. Loadings are percent of a
// branch's rating times its availability (derate); every field names its unit.

const seconds = z.number().finite().positive()
const nonNegativeSeconds = z.number().finite().nonnegative()
const percent = z.number().finite().positive()
const mw = z.number().finite().nonnegative()
const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'ids are lowercase kebab-case')
const wholeMilliseconds = (value: number): boolean => Math.abs(value * 1_000 - Math.round(value * 1_000)) < 1e-9

/** Per branch kind; the DC model also carries v1 HVDC links and switches as branches. */
const perBranchKindSecondsSchema = z.object({
  ac_line: seconds,
  cable: seconds,
  transformer: seconds,
  hvdc_link: seconds,
  switch: seconds,
}).strict()

export const branchProtectionSchema = z.discriminatedUnion('enabled', [
  /** No branch trips at all: branches carry any flow and only alarms report overloads. */
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    /** Relays sample branch flows on this fixed grid of Grid elapsed time; the network is solved at every sample. */
    sampleIntervalSeconds: z.number().finite().gt(0).max(10).refine(wholeMilliseconds, 'the sample interval must be whole milliseconds'),
    /** First-order conductor heating time constant towards (flow / rating)². */
    thermalTimeConstantSeconds: perBranchKindSecondsSchema,
    /** Pickup of the instantaneous element in percent of the continuous rating. */
    instantaneousPercentOfRating: percent,
  }).strict(),
])
export type GridBranchProtectionSettings = z.infer<typeof branchProtectionSchema>

const priority = z.union([z.literal(1), z.literal(2), z.literal(3)])

const timing = {
  /** 1 is the most urgent. */
  priority,
  /** Time the raise condition must hold before the alarm raises. */
  raiseDelaySeconds: nonNegativeSeconds,
  /** Time the clear condition must hold before the alarm clears. */
  clearDelaySeconds: nonNegativeSeconds,
}

const alarmTimingSchema = z.object(timing).strict()
export type GridAlarmTiming = z.infer<typeof alarmTimingSchema>

const frequencyBandSchema = z.object({
  id,
  ...timing,
  /** |f − nominal| above which the band's under- or over-frequency alarm raises (Hz). */
  deviationHz: z.number().finite().positive(),
  /** |f − nominal| below which it clears (Hz). */
  clearDeviationHz: z.number().finite().nonnegative(),
}).strict().refine(band => band.clearDeviationHz < band.deviationHz, 'a frequency band must clear below its raise deviation')

const loadingBandSchema = z.object({
  id,
  ...timing,
  basis: z.enum(['continuous-rating', 'emergency-rating']),
  /** Loading at or above which the alarm raises (% of the basis rating × availability). */
  raisePercent: percent,
  /** Loading below which it clears. */
  clearPercent: percent,
}).strict().refine(band => band.clearPercent < band.raisePercent, 'a loading band must clear below its raise loading')

const magnitudeAlarmSchema = z.object({
  ...timing,
  /** Amount above which the alarm raises (MW). */
  raiseMw: z.number().finite().positive(),
  /** Amount below which it clears (MW). */
  clearMw: mw,
}).strict().refine(alarm => alarm.clearMw < alarm.raiseMw, 'an alarm must clear below its raise amount')

const uniqueIds = (items: ReadonlyArray<{ readonly id: string }>): boolean => new Set(items.map(item => item.id)).size === items.length

export const alarmsSchema = z.object({
  /** An alarm changes between raised and cleared at most once in this interval. */
  minimumTransitionIntervalSeconds: seconds,
  /** Island frequency bands, innermost first; each raises an under- and an over-frequency alarm. */
  islandFrequency: z.array(frequencyBandSchema).min(1)
    .refine(uniqueIds, 'frequency band ids must be unique')
    .refine(bands => bands.every((band, index) => index === 0 || band.deviationHz > bands[index - 1]!.deviationHz), 'frequency bands must widen'),
  /** An island holding demand or a Plant connection has no voltage-forming source. */
  islandDeEnergised: alarmTimingSchema,
  /** An energised island separated from the topology the Grid started with. */
  islandFormed: alarmTimingSchema,
  /** Per reserve product: requirement not covered by the island's units and external systems. */
  reserveDeficit: magnitudeAlarmSchema,
  /** Demand shed in an energised island (manual curtailment and LFDD). */
  unservedLoad: magnitudeAlarmSchema,
  lfddStageOperated: alarmTimingSchema,
  /** The AC load flow of an energised island did not converge. */
  acNonConvergence: alarmTimingSchema,
  /** Loading bands of closed branches. */
  branchLoading: z.array(loadingBandSchema).min(1).refine(uniqueIds, 'branch loading band ids must be unique'),
  branchTripped: alarmTimingSchema,
  generatorTripped: alarmTimingSchema,
}).strict()
export type GridAlarmSettings = z.infer<typeof alarmsSchema>
