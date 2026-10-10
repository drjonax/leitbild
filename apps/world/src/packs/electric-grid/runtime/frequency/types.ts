import type { GovernorClass } from '../../schemas/grid-automation.ts'

/** Reserve volumes allocated to one unit, in MW. FCR-N is symmetric. */
export interface FrequencyReserveAllocation {
  readonly fcrNMw: number
  readonly fcrDUpMw: number
  readonly fcrDDownMw: number
  readonly afrrUpMw: number
  readonly afrrDownMw: number
  readonly mfrrUpMw: number
  readonly mfrrDownMw: number
}

/** A generating unit as seen by island frequency control. */
export interface FrequencyUnit {
  readonly id: string
  /** Synchronous machines contribute kinetic energy; converter-connected units do not. */
  readonly connection: 'synchronous' | 'converter'
  readonly governorClass: GovernorClass
  /** Connected and running in this island. */
  readonly synchronised: boolean
  readonly ratedMva: number
  /** Inertia constant H on ratedMva, in seconds. */
  readonly inertiaConstantSeconds: number
  /** Minimum stable output while synchronised. */
  readonly minimumMw: number
  /** Available maximum output. */
  readonly maximumMw: number
  /** Operator, market or scenario set-point; aFRR and mFRR act as adjustments on top of it. */
  readonly targetMw: number
  readonly rampRateMwPerSecond: number
  readonly reserves: FrequencyReserveAllocation
}

/** Battery or other converter storage. Positive power discharges into the island. */
export interface FrequencyStorageUnit {
  readonly id: string
  readonly connected: boolean
  readonly maximumDischargeMw: number
  readonly maximumChargeMw: number
  readonly energyCapacityMwh: number
  readonly chargeEfficiency: number
  readonly dischargeEfficiency: number
  /** Operator set-point; frequency response acts on top of it within the ratings. */
  readonly scheduledMw: number
}

export type FrequencyLoadPriority = 'critical' | 'high' | 'normal' | 'low'

export interface FrequencyLoad {
  readonly id: string
  readonly priority: FrequencyLoadPriority
  /** Demand at nominal frequency before load shedding. */
  readonly demandMw: number
  /** Demand on feeders that LFDD never disconnects (for example essential supplies). */
  readonly protectedMw: number
}

/** Equivalent of a synchronously connected neighbouring system. */
export interface ExternalFrequencyEquivalent {
  readonly id: string
  readonly kineticEnergyMws: number
  /** Scheduled import into the island; negative exports. */
  readonly scheduledImportMw: number
  readonly frequencyResponseMwPerHz: number
  readonly responseTimeConstantSeconds: number
  readonly responseLimitMw: number
}

export interface IslandFrequencyInput {
  readonly islandId: string
  readonly units: ReadonlyArray<FrequencyUnit>
  readonly storage: ReadonlyArray<FrequencyStorageUnit>
  readonly loads: ReadonlyArray<FrequencyLoad>
  readonly externals: ReadonlyArray<ExternalFrequencyEquivalent>
  /** Network losses carried by the island over the advance. */
  readonly lossesMw: number
  /** Measured minus scheduled net export on tie lines; required by tie-line-bias aFRR. */
  readonly tieLineDeviationMw?: number
}
