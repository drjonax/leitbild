import type { GridAutomation, GovernorClass } from '../schemas/grid-automation.ts'
import type { GridGenerationKind, GridGeneratorDefinition } from '../grid-model.ts'
import type { FrequencyReserveAllocation, FrequencyUnit } from './frequency/types.ts'

interface DynamicsSource {
  readonly reference: string
  readonly note: string
}

/**
 * Frequency-control dynamics of one generation kind. Model v1 carries no per-unit machine data, so
 * every value here is a per-kind value marked inferred, each with the source it was taken from.
 */
export interface GeneratorKindDynamics {
  readonly connection: 'synchronous' | 'converter'
  readonly governorClass: GovernorClass
  /** Rated power factor: ratedMva = capacityMw / ratedPowerFactor. */
  readonly ratedPowerFactor: number
  /** H on ratedMva, in seconds; 0 for converter-connected units. */
  readonly inertiaConstantSeconds: number
  /** Permanent droop bp in percent; the FCR a unit can deliver follows from it. null: no frequency governor. */
  readonly governorDroopPercent: number | null
  readonly provenance: {
    readonly method: 'inferred'
    readonly sources: Readonly<Record<'connection' | 'ratedPowerFactor' | 'inertiaConstant' | 'governorDroop', DynamicsSource>>
  }
}

const nvf2025 = 'Statnett, Nasjonal veileder for funksjonskrav i kraftsystemet (NVF 2025), https://www.statnett.no/globalassets/for-aktorer-i-kraftsystemet/systemansvaret/retningslinjer-fos/nvf-2025.pdf'
const kundur = 'P. Kundur, Power System Stability and Control (1994), Table 3.2 typical inertia constants'
const reviewTable = 'Fernández-Guillamón et al., Power systems with high renewable energy sources: a review of inertia and frequency control strategies over time (2019), https://arxiv.org/pdf/2004.02951, inertia constant table'

const synchronousPowerFactor: DynamicsSource = {
  reference: nvf2025,
  note: 'NVF 2025 requires synchronous units to supply Q ≥ 0.46·Pmax (cos φ ≤ 0.91) at full output; rated power factor 0.9 is derived from it.',
}
const droopSetting: DynamicsSource = {
  reference: nvf2025,
  note: 'NVF 2025 Table 12-8: standard droop setting bp = 4 % (settable range 2-12 % in Table 12-7); also used for normal interconnected operation.',
}
const converterNoInertia: DynamicsSource = {
  reference: nvf2025,
  note: 'Converter-connected power park modules have no synchronous rotating mass coupled to the grid: H = 0 and no inherent inertial response.',
}

export const generatorKindDynamics: Readonly<Record<Exclude<GridGenerationKind, 'import'>, GeneratorKindDynamics>> = {
  hydro: {
    connection: 'synchronous',
    governorClass: 'hydro',
    ratedPowerFactor: 0.9,
    inertiaConstantSeconds: 3,
    governorDroopPercent: 4,
    provenance: {
      method: 'inferred',
      sources: {
        connection: { reference: nvf2025, note: 'Hydro units are synchronous generators with turbine governors (NVF 2025 chapter 12).' },
        ratedPowerFactor: synchronousPowerFactor,
        inertiaConstant: { reference: kundur, note: 'Hydraulic units 2.0-4.0 s; the midpoint 3.0 s is used for every unit.' },
        governorDroop: droopSetting,
      },
    },
  },
  thermal: {
    connection: 'synchronous',
    governorClass: 'steam',
    ratedPowerFactor: 0.9,
    inertiaConstantSeconds: 4.2,
    governorDroopPercent: 4,
    provenance: {
      method: 'inferred',
      sources: {
        connection: { reference: nvf2025, note: 'Thermal units are synchronous generators with turbine governors (NVF 2025 chapter 12).' },
        ratedPowerFactor: synchronousPowerFactor,
        inertiaConstant: { reference: kundur, note: 'Two-pole thermal units 2.5-6.0 s; the midpoint 4.2 s is used (Norwegian thermal plants are gas turbines and CHP).' },
        governorDroop: droopSetting,
      },
    },
  },
  nuclear: {
    connection: 'synchronous',
    governorClass: 'none',
    ratedPowerFactor: 0.9,
    inertiaConstantSeconds: 4.4,
    governorDroopPercent: null,
    provenance: {
      method: 'inferred',
      sources: {
        connection: { reference: nvf2025, note: 'Nuclear turbine-generators are synchronous machines.' },
        ratedPowerFactor: synchronousPowerFactor,
        inertiaConstant: { reference: reviewTable, note: 'Nuclear units of 1,000-1,200 MW: 4.0-4.8 s as summarised from this review, not re-verified in the table; the midpoint 4.4 s is used. Model v1 has no nuclear generator.' },
        governorDroop: { reference: nvf2025, note: 'Run at constant output: no FCR is allocated to nuclear units in this model.' },
      },
    },
  },
  wind: {
    connection: 'converter',
    governorClass: 'converter',
    ratedPowerFactor: 1,
    inertiaConstantSeconds: 0,
    governorDroopPercent: null,
    provenance: {
      method: 'inferred',
      sources: {
        connection: converterNoInertia,
        ratedPowerFactor: { reference: nvf2025, note: 'ratedMva carries no inertia for a converter; it is set equal to capacity.' },
        inertiaConstant: converterNoInertia,
        governorDroop: { reference: nvf2025, note: 'Wind parks provide no FCR in this model (not eligible in the Nordic presets).' },
      },
    },
  },
  solar: {
    connection: 'converter',
    governorClass: 'converter',
    ratedPowerFactor: 1,
    inertiaConstantSeconds: 0,
    governorDroopPercent: null,
    provenance: {
      method: 'inferred',
      sources: {
        connection: converterNoInertia,
        ratedPowerFactor: { reference: nvf2025, note: 'ratedMva carries no inertia for a converter; it is set equal to capacity.' },
        inertiaConstant: converterNoInertia,
        governorDroop: { reference: nvf2025, note: 'Solar parks provide no FCR in this model (not eligible in the Nordic presets).' },
      },
    },
  },
  battery: {
    connection: 'converter',
    governorClass: 'converter',
    ratedPowerFactor: 1,
    inertiaConstantSeconds: 0,
    governorDroopPercent: null,
    provenance: {
      method: 'inferred',
      sources: {
        connection: converterNoInertia,
        ratedPowerFactor: { reference: nvf2025, note: 'ratedMva carries no inertia for a converter; it is set equal to capacity.' },
        inertiaConstant: converterNoInertia,
        governorDroop: { reference: nvf2025, note: 'A battery modelled as a generator provides no FCR; Grid storage assets carry the storage response.' },
      },
    },
  },
}

export const dynamicsForGenerator = (definition: GridGeneratorDefinition): GeneratorKindDynamics => {
  if (definition.kind === 'import') {
    throw new Error(`generator ${definition.id} has kind import; model a neighbouring system as an external system behind a boundary bus instead`)
  }
  return generatorKindDynamics[definition.kind]
}

export const generatorRatedMva = (definition: GridGeneratorDefinition): number =>
  definition.capacityMw / dynamicsForGenerator(definition).ratedPowerFactor

/** H·S of a synchronised unit in MWs; 0 for converter-connected units. */
export const generatorKineticEnergyMws = (definition: GridGeneratorDefinition): number => {
  const dynamics = dynamicsForGenerator(definition)
  return dynamics.connection === 'synchronous' ? dynamics.inertiaConstantSeconds * generatorRatedMva(definition) : 0
}

export const generatorIsVoltageForming = (definition: GridGeneratorDefinition): boolean =>
  dynamicsForGenerator(definition).connection === 'synchronous'

/**
 * Most FCR a unit's governor delivers by its droop: ΔP = Pn·Δf/(bp·f0). FCR-N at the FCR-N full
 * deviation; FCR-D up/down at the FCR-D full frequency, less the FCR-N part of the same droop.
 */
export const droopFcrCapabilityMw = (definition: GridGeneratorDefinition, automation: GridAutomation): {
  readonly fcrNMw: number
  readonly fcrDUpMw: number
  readonly fcrDDownMw: number
} => {
  const droop = dynamicsForGenerator(definition).governorDroopPercent
  if (droop === null) return { fcrNMw: 0, fcrDUpMw: 0, fcrDDownMw: 0 }
  const nominalHz = automation.swing.nominalFrequencyHz
  const perHz = definition.capacityMw / (droop / 100 * nominalHz)
  const fcrNMw = perHz * automation.fcrN.fullActivationDeviationHz
  return {
    fcrNMw,
    fcrDUpMw: Math.max(0, perHz * (nominalHz - automation.fcrD.up.fullHz) - fcrNMw),
    fcrDDownMw: Math.max(0, perHz * (automation.fcrD.down.fullHz - nominalHz) - fcrNMw),
  }
}

/**
 * The one mapping from a Model generator and its live state to the frequency library's unit:
 * rated MVA, inertia, connection and governor class from the kind table; output limits and
 * set-point from the live state and unit commitment; reserves from the unit's current allocation.
 * Governor, aFRR and mFRR output stays within [minimumMw, availableMw].
 */
export const frequencyUnitFor = (config: {
  readonly definition: GridGeneratorDefinition
  readonly synchronised: boolean
  /** Lowest output the unit may be held at: minimum stable generation online, 0 while stopping. */
  readonly minimumMw: number
  readonly availableMw: number
  readonly targetMw: number
  readonly reserves: FrequencyReserveAllocation
}): FrequencyUnit => {
  const { definition } = config
  const dynamics = dynamicsForGenerator(definition)
  return {
    id: definition.id,
    connection: dynamics.connection,
    governorClass: dynamics.governorClass,
    synchronised: config.synchronised,
    ratedMva: generatorRatedMva(definition),
    inertiaConstantSeconds: dynamics.inertiaConstantSeconds,
    minimumMw: config.minimumMw,
    maximumMw: config.availableMw,
    targetMw: config.targetMw,
    rampRateMwPerSecond: definition.rampRateMwPerMinute / 60,
    reserves: config.reserves,
  }
}
