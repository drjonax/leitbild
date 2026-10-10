import type { generatorKinds } from '../schemas/grid-ids.ts'

// Per-kind dynamic and capability parameters of generating units. NVE registers capacity and
// mean production only, so every value below is a typical published figure for the kind; each
// generator's provenance names this table's rule id.

type ModelledKind = Extract<typeof generatorKinds[number], 'hydro-reservoir' | 'hydro-run-of-river' | 'hydro-pumped' | 'wind'>

export interface GeneratorKindRule {
  readonly id: string
  readonly synchronous: boolean
  /** Rated power factor; ratedMva = capacityMw / powerFactor. */
  readonly powerFactor: number
  readonly voltageSetpointPu: number
  /** H on rated MVA, s (0 for converter-connected units). */
  readonly inertiaSeconds: number
  /** Minimum stable output as a share of capacity for a single registered plant. */
  readonly minimumStableShare: number
  /** Ramp limit as a share of capacity per minute. */
  readonly rampSharePerMinute: number
  readonly blackStartCapable: boolean
  readonly sources: Readonly<Record<'powerFactor' | 'voltageSetpointPu' | 'inertiaSeconds' | 'minimumStableShare' | 'rampSharePerMinute' | 'blackStartCapable', string>>
}

const fsi2 = 'ENTSO-E "Future System Inertia 2" (Statnett-hosted report)'

const hydroSources = {
  powerFactor: 'rated cos φ 0.9: NVF 2025 requires synchronous units to supply Q ≥ 0.46·Pmax (cos φ ≤ 0.91) at full output (Statnett, Nasjonal veileder for funksjonskrav i kraftsystemet)',
  voltageSetpointPu: 'nominal set-point 1.0 pu; operators adjust it within the normal voltage range',
  inertiaSeconds: `H 3.44 s on rated MVA, the average Statnett uses for its online inertia estimate (${fsi2}, §9.2.3)`,
  minimumStableShare: 'Statkraft: most hydropower turbines should not run below 60 % of capacity; with two or more units a plant can hold 30 % of its capacity on one unit',
  rampSharePerMinute: '10 % of nameplate rating per minute, a common hydro generator ramp limit (U.S. Bureau of Reclamation, Hydro Model Data Project)',
  blackStartCapable: 'Statnett procures black-start capability from hydropower; providers are not published, so storage hydro is marked capable (low confidence)',
} as const

export const generatorKindRules: Readonly<Record<ModelledKind, GeneratorKindRule>> = {
  'hydro-reservoir': { id: 'unit-hydro-reservoir', synchronous: true, powerFactor: 0.9, voltageSetpointPu: 1.0, inertiaSeconds: 3.44, minimumStableShare: 0.3, rampSharePerMinute: 0.1, blackStartCapable: true, sources: hydroSources },
  'hydro-pumped': { id: 'unit-hydro-pumped', synchronous: true, powerFactor: 0.9, voltageSetpointPu: 1.0, inertiaSeconds: 3.44, minimumStableShare: 0.3, rampSharePerMinute: 0.1, blackStartCapable: true, sources: hydroSources },
  'hydro-run-of-river': {
    id: 'unit-hydro-run-of-river', synchronous: true, powerFactor: 0.9, voltageSetpointPu: 1.0, inertiaSeconds: 3.44, minimumStableShare: 0.3, rampSharePerMinute: 0.1, blackStartCapable: false,
    sources: { ...hydroSources, blackStartCapable: 'run-of-river plants lack the storage to sustain a black start' },
  },
  wind: {
    id: 'unit-wind', synchronous: false, powerFactor: 0.95, voltageSetpointPu: 1.0, inertiaSeconds: 0, minimumStableShare: 0, rampSharePerMinute: 0.1, blackStartCapable: false,
    sources: {
      powerFactor: 'Q/Pmax ≥ 0.33 (cos φ 0.95) at the connection point (Statnett NVF guide to offshore wind installations, 2025-08-25; RfG, Regulation (EU) 2016/631, Art. 21 Table 9, Nordic Q/Pmax range 0.95)',
      voltageSetpointPu: 'nominal set-point 1.0 pu at the connection point',
      inertiaSeconds: 'converter-connected turbines contribute no synchronous inertia',
      minimumStableShare: 'a wind farm runs down to zero output',
      rampSharePerMinute: 'active-power ramp limited to 10 % of capacity per minute, as for hydro units (no separate published Nordic value)',
      blackStartCapable: 'grid-following converters cannot energise a dead grid',
    },
  },
}

/** Aggregates of registered plants below the threshold: small-scale hydro inertia (FSI2 §5: H = 1 s). */
export const smallHydroInertiaSeconds = 1

/** Registered plants below this capacity are aggregated per bus and kind, MW (MB1 brief). */
export const aggregationThresholdMw = 10

/** Attachment radius per kind, km: the golden list's maximum attachment distance (norway-grid-golden.json). */
export const attachmentRadiusKm: Readonly<Record<'hydro' | 'wind', number>> = { hydro: 30, wind: 30 }

/**
 * Utilisation (mean annual GWh per MW of capacity, in hours) at or above which a regular NVE plant
 * (type K) is classed as run-of-river: NVE's registry gives no regulation class, and plants with
 * little storage run near full output most of the year (modelling judgement).
 */
export const runOfRiverUtilisationHours = 5000
