import { z } from 'zod'

// Automation Definition for island frequency control: swing integration, FCR-N/FCR-D,
// aFRR, mFRR, LFDD, storage response and generator frequency protection. Frequencies are
// absolute Hz on the declared nominal frequency; every field names its unit.

const hz = z.number().finite().positive()
const seconds = z.number().finite().positive()
const nonNegativeSeconds = z.number().finite().nonnegative()
const fraction = z.number().finite().min(0).max(1)
const positiveFraction = z.number().finite().gt(0).max(1)
const mw = z.number().finite().nonnegative()
const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'ids are lowercase kebab-case')

export const governorClassSchema = z.enum(['hydro', 'steam', 'converter', 'none'])
export type GovernorClass = z.infer<typeof governorClassSchema>

const eligibleGovernorClassesSchema = z.array(governorClassSchema.exclude(['none'])).min(1)
  .refine(classes => new Set(classes).size === classes.length, 'eligible governor classes must be unique')

export const reserveRequirementSchema = z.discriminatedUnion('basis', [
  /** A fixed volume for the synchronous island. */
  z.object({ basis: z.literal('fixed'), mw }).strict(),
  /** A share of the island's connected demand. */
  z.object({ basis: z.literal('share-of-island-load'), fraction }).strict(),
  /** A multiple of the output of the largest synchronised unit (N-1 dimensioning). */
  z.object({ basis: z.literal('largest-unit-output'), factor: z.number().finite().positive() }).strict(),
])
export type ReserveRequirement = z.infer<typeof reserveRequirementSchema>

const directionalRequirementSchema = z.object({
  up: reserveRequirementSchema,
  down: reserveRequirementSchema,
}).strict()

export const automationSectionSchema = z.enum([
  'simulation', 'swing', 'fcrN', 'fcrD', 'afrr', 'mfrr', 'lfdd', 'storage', 'generatorProtection', 'synchroCheck',
])

const sourceReferenceSchema = z.object({
  section: automationSectionSchema,
  title: z.string().min(1),
  url: z.url().refine(value => value.startsWith('https://'), 'sources must use HTTPS'),
  accessedOn: z.iso.date(),
  /** verified: read in the source; derived: computed from verified values; modelling-choice: not a published value; unverified: could not be confirmed. */
  status: z.enum(['verified', 'derived', 'modelling-choice', 'unverified']),
  note: z.string().min(1),
}).strict()

const simulationSchema = z.object({
  /** Fixed internal integration step. */
  subStepSeconds: z.number().finite().gt(0).max(1),
  /** Largest adapter time step accepted in one advance; longer steps fail instead of stretching. */
  maximumCatchUpSeconds: seconds,
}).strict()

const swingSchema = z.object({
  nominalFrequencyHz: hz,
  /** Load self-regulation: percent change of served load per Hz of deviation. */
  loadDampingPercentPerHz: z.number().finite().nonnegative(),
}).strict()

const fcrNSchema = z.object({
  /** Symmetric insensitivity around nominal frequency. */
  deadbandHz: z.number().finite().nonnegative(),
  /** Deviation from nominal at which FCR-N is fully activated. */
  fullActivationDeviationHz: hz,
  timeConstantSeconds: seconds,
  requirement: reserveRequirementSchema,
  eligibleGovernorClasses: eligibleGovernorClassesSchema,
}).strict().refine(value => value.deadbandHz < value.fullActivationDeviationHz, 'FCR-N deadband must be below full activation deviation')

const fcrDDirectionSchema = z.object({
  /** Frequency at which activation starts. */
  startHz: hz,
  /** Frequency at which activation is complete. */
  fullHz: hz,
  timeConstantSeconds: seconds,
  requirement: reserveRequirementSchema,
}).strict()

const fcrDSchema = z.object({
  up: fcrDDirectionSchema.refine(value => value.fullHz < value.startHz, 'FCR-D up must activate towards lower frequency'),
  down: fcrDDirectionSchema.refine(value => value.fullHz > value.startHz, 'FCR-D down must activate towards higher frequency'),
  eligibleGovernorClasses: eligibleGovernorClassesSchema,
}).strict()

const afrrSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    controlMode: z.enum(['flat-frequency', 'tie-line-bias']),
    /** Frequency bias as a multiple of the island's FCR-N strength plus load damping (MW/Hz). */
    frequencyBiasFactor: z.number().finite().positive(),
    proportionalGain: z.number().finite().nonnegative(),
    integralTimeSeconds: seconds,
    cycleSeconds: seconds,
    /** Time for a provider to reach its full allocated aFRR volume. */
    fullActivationSeconds: seconds,
    requirement: directionalRequirementSchema,
    eligibleGovernorClasses: eligibleGovernorClassesSchema,
  }).strict(),
])

const mfrrSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    /** aFRR utilisation (activated / allocated in that direction) that requests mFRR. */
    afrrUtilisationThresholdFraction: positiveFraction,
    /** Time the utilisation must persist before mFRR is activated. */
    sustainedSeconds: seconds,
    fullActivationSeconds: seconds,
    minimumActivationMw: z.number().finite().positive(),
    requirement: directionalRequirementSchema,
    eligibleGovernorClasses: eligibleGovernorClassesSchema,
  }).strict(),
])

const lfddStageSchema = z.object({
  id,
  thresholdHz: hz,
  /** Time frequency must stay below the threshold before the stage operates. */
  delaySeconds: nonNegativeSeconds,
  /** Share of the island's connected demand disconnected by this stage. */
  shareOfLoad: positiveFraction,
}).strict()

const lfddSchema = z.object({
  stages: z.array(lfddStageSchema).min(1),
}).strict().superRefine((value, context) => {
  if (new Set(value.stages.map(stage => stage.id)).size !== value.stages.length) {
    context.addIssue({ code: 'custom', message: 'LFDD stage ids must be unique', path: ['stages'] })
  }
  value.stages.forEach((stage, index) => {
    const previous = value.stages[index - 1]
    if (previous && stage.thresholdHz >= previous.thresholdHz) {
      context.addIssue({ code: 'custom', message: 'LFDD stage thresholds must strictly decrease', path: ['stages', index, 'thresholdHz'] })
    }
  })
  const cumulative = value.stages.reduce((sum, stage) => sum + stage.shareOfLoad, 0)
  if (cumulative > 1 + 1e-12) context.addIssue({ code: 'custom', message: 'LFDD cumulative share of load exceeds 1', path: ['stages'] })
})

const stateOfChargeLimitsSchema = z.object({
  minimumFraction: fraction,
  maximumFraction: fraction,
}).strict().refine(value => value.minimumFraction < value.maximumFraction, 'state of charge minimum must be below maximum')

const storageSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }).strict(),
  z.object({
    mode: z.literal('droop'),
    deadbandHz: z.number().finite().nonnegative(),
    /** Frequency change in percent of nominal that moves output across the full rating. */
    droopPercent: z.number().finite().positive(),
    timeConstantSeconds: seconds,
    stateOfChargeLimits: stateOfChargeLimitsSchema,
  }).strict(),
  z.object({
    mode: z.literal('fcr-d'),
    /** Uses the fcrD up/down activation bands over the full storage rating. */
    timeConstantSeconds: seconds,
    stateOfChargeLimits: stateOfChargeLimitsSchema,
  }).strict(),
  z.object({
    mode: z.literal('ffr'),
    triggerHz: hz,
    fullActivationSeconds: seconds,
    supportDurationSeconds: seconds,
    /** Maximum deactivation rate as a share of the rating per second. */
    deactivationRateFractionPerSecond: positiveFraction,
    /** Time after deactivation before the trigger is armed again. */
    rearmDelaySeconds: nonNegativeSeconds,
    stateOfChargeLimits: stateOfChargeLimitsSchema,
  }).strict(),
])

const protectionElementSchema = z.object({
  id,
  thresholdHz: hz,
  delaySeconds: nonNegativeSeconds,
}).strict()

const generatorProtectionSchema = z.object({
  underFrequency: z.array(protectionElementSchema).min(1),
  overFrequency: z.array(protectionElementSchema).min(1),
  rocof: z.object({
    thresholdHzPerSecond: z.number().finite().positive(),
    delaySeconds: nonNegativeSeconds,
  }).strict(),
}).strict().refine(value => {
  const ids = [...value.underFrequency, ...value.overFrequency].map(element => element.id)
  return new Set(ids).size === ids.length && !ids.includes('rocof')
}, 'generator protection element ids must be unique and must not be "rocof"')

const synchroCheckSchema = z.object({
  /** Largest frequency difference between two energised islands at which a branch may join them. */
  maximumFrequencyDifferenceHz: hz,
  /** Largest voltage-angle difference across an open branch whose ends are already in one energised island (loop closing). */
  maximumAngleDifferenceDegrees: z.number().finite().positive().max(180),
}).strict()

export const gridAutomationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  sources: z.array(sourceReferenceSchema),
  simulation: simulationSchema,
  swing: swingSchema,
  fcrN: fcrNSchema,
  fcrD: fcrDSchema,
  afrr: afrrSchema,
  mfrr: mfrrSchema,
  lfdd: lfddSchema,
  storage: storageSchema,
  generatorProtection: generatorProtectionSchema,
  synchroCheck: synchroCheckSchema,
}).strict().superRefine((value, context) => {
  const nominal = value.swing.nominalFrequencyHz
  const issue = (message: string, path: ReadonlyArray<string | number>): void => {
    context.addIssue({ code: 'custom', message, path: [...path] })
  }
  if (value.simulation.maximumCatchUpSeconds < value.simulation.subStepSeconds) {
    issue('maximum catch-up must be at least one sub-step', ['simulation', 'maximumCatchUpSeconds'])
  }
  if (value.fcrD.up.startHz >= nominal) issue('FCR-D up must start below nominal frequency', ['fcrD', 'up', 'startHz'])
  if (value.fcrD.down.startHz <= nominal) issue('FCR-D down must start above nominal frequency', ['fcrD', 'down', 'startHz'])
  if (value.afrr.enabled) {
    const cycles = value.afrr.cycleSeconds / value.simulation.subStepSeconds
    if (Math.abs(cycles - Math.round(cycles)) > 1e-9) issue('aFRR cycle must be a whole number of sub-steps', ['afrr', 'cycleSeconds'])
  }
  if (value.mfrr.enabled && !value.afrr.enabled) issue('mFRR activation is driven by aFRR utilisation and requires aFRR', ['mfrr', 'enabled'])
  value.lfdd.stages.forEach((stage, index) => {
    if (stage.thresholdHz >= value.fcrD.up.fullHz) issue('LFDD stages must lie below full FCR-D up activation', ['lfdd', 'stages', index, 'thresholdHz'])
  })
  value.generatorProtection.underFrequency.forEach((element, index) => {
    if (element.thresholdHz >= nominal || element.thresholdHz <= nominal * 0.9) {
      issue('under-frequency protection must lie between 90 % of nominal and nominal', ['generatorProtection', 'underFrequency', index, 'thresholdHz'])
    }
  })
  value.generatorProtection.overFrequency.forEach((element, index) => {
    if (element.thresholdHz <= nominal || element.thresholdHz >= nominal * 1.1) {
      issue('over-frequency protection must lie between nominal and 110 % of nominal', ['generatorProtection', 'overFrequency', index, 'thresholdHz'])
    }
  })
  if (value.storage.mode === 'droop' && value.storage.deadbandHz >= nominal * value.storage.droopPercent / 100) {
    issue('storage droop deadband must be below the full-activation deviation', ['storage', 'deadbandHz'])
  }
  if (value.storage.mode === 'ffr' && value.storage.triggerHz >= nominal) issue('FFR trigger must lie below nominal frequency', ['storage', 'triggerHz'])
})
export type GridAutomation = z.infer<typeof gridAutomationSchema>
export type GridAutomationSection = z.infer<typeof automationSectionSchema>
