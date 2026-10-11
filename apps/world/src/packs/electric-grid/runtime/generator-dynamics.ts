import type { GridAutomation, GovernorClass } from '../schemas/grid-automation.ts'
import type { GridGenerationKind, GridGeneratorDefinition } from '../grid-model.ts'
import type { FrequencyReserveAllocation, FrequencyUnit } from './frequency/types.ts'

interface GovernorSource {
  readonly reference: string
  readonly note: string
}

/**
 * Frequency governor of one generation kind. Grid Model v2 carries each unit's machine data
 * (rated MVA, power factor, H, connection, minimum stable output) but no governor data, so the
 * governor class and permanent droop apply per kind, each with its source.
 */
export interface GeneratorKindGovernor {
  readonly governorClass: GovernorClass
  /** Permanent droop bp in percent; the FCR a unit can deliver follows from it. null: no frequency governor. */
  readonly droopPercent: number | null
  readonly source: GovernorSource
}

const nvf2025 = 'Statnett, Nasjonal veileder for funksjonskrav i kraftsystemet (NVF 2025), https://www.statnett.no/globalassets/for-aktorer-i-kraftsystemet/systemansvaret/retningslinjer-fos/nvf-2025.pdf'
const droopNote = 'NVF 2025 Table 12-8: standard droop setting bp = 4 % (settable range 2-12 % in Table 12-7); also used for normal interconnected operation.'

export const generatorKindGovernors: Readonly<Record<GridGenerationKind, GeneratorKindGovernor>> = {
  hydro: { governorClass: 'hydro', droopPercent: 4, source: { reference: nvf2025, note: `Hydro turbine governors (NVF 2025 chapter 12). ${droopNote}` } },
  thermal: { governorClass: 'steam', droopPercent: 4, source: { reference: nvf2025, note: `Thermal turbine governors (NVF 2025 chapter 12). ${droopNote}` } },
  nuclear: { governorClass: 'none', droopPercent: null, source: { reference: nvf2025, note: 'Run at constant output: no FCR is allocated to nuclear units in this model.' } },
  wind: { governorClass: 'converter', droopPercent: null, source: { reference: nvf2025, note: 'Wind parks provide no FCR in this model (not eligible in the Nordic presets).' } },
  solar: { governorClass: 'converter', droopPercent: null, source: { reference: nvf2025, note: 'Solar parks provide no FCR in this model (not eligible in the Nordic presets).' } },
}

export const governorForGenerator = (definition: GridGeneratorDefinition): GeneratorKindGovernor => generatorKindGovernors[definition.kind]

/** H·S of a synchronous unit in MWs, from the Model's H on rated MVA; 0 for converter-connected units. */
export const generatorKineticEnergyMws = (definition: GridGeneratorDefinition): number =>
  definition.synchronous ? definition.inertiaSeconds * definition.ratedMva : 0

/** Synchronous machines form island voltage and frequency; converter-connected units follow them. */
export const generatorIsVoltageForming = (definition: GridGeneratorDefinition): boolean => definition.synchronous

/**
 * Most FCR a unit's governor delivers by its droop: ΔP = Pn·Δf/(bp·f0). FCR-N at the FCR-N full
 * deviation; FCR-D up/down at the FCR-D full frequency, less the FCR-N part of the same droop.
 */
export const droopFcrCapabilityMw = (definition: GridGeneratorDefinition, automation: GridAutomation): {
  readonly fcrNMw: number
  readonly fcrDUpMw: number
  readonly fcrDDownMw: number
} => {
  const droop = governorForGenerator(definition).droopPercent
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
 * rated MVA, inertia and connection from the Model, the governor class from the kind table;
 * output limits and set-point from the live state and unit commitment; reserves from the unit's
 * current allocation. Governor, aFRR and mFRR output stays within [minimumMw, availableMw].
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
  return {
    id: definition.id,
    connection: definition.synchronous ? 'synchronous' : 'converter',
    governorClass: governorForGenerator(definition).governorClass,
    synchronised: config.synchronised,
    ratedMva: definition.ratedMva,
    inertiaConstantSeconds: definition.inertiaSeconds,
    minimumMw: config.minimumMw,
    maximumMw: config.availableMw,
    targetMw: config.targetMw,
    rampRateMwPerSecond: definition.rampRateMwPerMinute / 60,
    reserves: config.reserves,
  }
}
