// Electrical parameter rules of the model build. Every inferred branch, transformer and shunt
// value comes from one rule here; provenance notes name the rule id, and *.ledger.json lists the
// rules with their sources. Per-unit values are on the model's sBase (100 MVA):
// x_pu = x_Ω · S_base / kV², b_pu = b_S · kV² / S_base.

export const sBaseMva = 100

export const voltageClassesKv = [132, 220, 300, 420] as const
export type VoltageClassKv = typeof voltageClassesKv[number]

export interface ConductorRule {
  readonly id: string
  readonly xOhmPerKm: number
  readonly rOhmPerKm: number
  readonly bMicroSiemensPerKm: number
  /** Continuous thermal rating of one circuit, MVA (taken as MW at unity power factor). */
  readonly ratingMvaPerCircuit: number
  readonly source: string
}

// Ratings: √3 · kV · I_nom of the PyPSA standard line type of each class (PyPSA
// pypsa/data/standard_types/line_types.csv; PyPSA-Eur config.default.yaml maps 132/150 kV to
// 243-AL1/39, 220 kV to the 2-bundle, 300 kV to the 3-bundle, 380–500 kV to the 4-bundle
// Al/St 240/40). 420 kV takes the 380 kV 4-bundle current.
const ratingMva = (kv: number, currentKa: number): number => Math.round(Math.sqrt(3) * kv * currentKa)

export const overheadRules: Readonly<Record<VoltageClassKv, ConductorRule>> = {
  420: {
    id: 'overhead-420kv', xOhmPerKm: 0.30, rOhmPerKm: 0.025, bMicroSiemensPerKm: 4.0, ratingMvaPerCircuit: ratingMva(420, 2.58),
    source: 'x/r/b: lane FD1 parameter guidance (2026-10-10); rating: √3·420 kV·2.58 kA, PyPSA line type "Al/St 240/40 4-bundle 380.0"',
  },
  300: {
    id: 'overhead-300kv', xOhmPerKm: 0.33, rOhmPerKm: 0.035, bMicroSiemensPerKm: 3.8, ratingMvaPerCircuit: ratingMva(300, 1.935),
    source: 'x/r/b: lane FD1 parameter guidance (2026-10-10); rating: √3·300 kV·1.935 kA, PyPSA line type "Al/St 240/40 3-bundle 300.0"',
  },
  // FD1 gives no 220 kV class: x, r and b are interpolated linearly in kV between its 132 and 300 kV classes.
  220: {
    id: 'overhead-220kv', xOhmPerKm: 0.363, rOhmPerKm: 0.066, bMicroSiemensPerKm: 3.32, ratingMvaPerCircuit: ratingMva(220, 1.29),
    source: 'x/r/b: linear in kV between the FD1 132 and 300 kV classes; rating: √3·220 kV·1.29 kA, PyPSA line type "Al/St 240/40 2-bundle 220.0"',
  },
  132: {
    id: 'overhead-132kv', xOhmPerKm: 0.40, rOhmPerKm: 0.10, bMicroSiemensPerKm: 2.8, ratingMvaPerCircuit: ratingMva(132, 0.645),
    source: 'x/r/b: lane FD1 parameter guidance (2026-10-10); rating: √3·132 kV·0.645 kA, PyPSA line type "243-AL1/39-ST1A 110.0"',
  },
}

const cableImpedance = { xOhmPerKm: 0.13, rOhmPerKm: 0.03, bMicroSiemensPerKm: 60 }
// Cable ratings: ABB "XLPE Underground Cable Systems" rev 3, Table 4 (110–500 kV, copper, ground
// 20 °C, 1.0 m depth, 1.0 K·m/W, trefoil cross-bonded): 1000 mm² 1095 A, 2000 mm² 1605 A.
const cableImpedanceSource = 'x/r/b: lane FD1 parameter guidance for XLPE cable (2026-10-10)'
export const cableRules: Readonly<Record<VoltageClassKv, ConductorRule>> = {
  420: { id: 'cable-420kv', ...cableImpedance, ratingMvaPerCircuit: ratingMva(420, 1.605), source: `${cableImpedanceSource}; rating: √3·420 kV·1.605 kA, 2000 mm² Cu XLPE in trefoil (ABB XLPE Underground Cable Systems rev 3, Table 4)` },
  300: { id: 'cable-300kv', ...cableImpedance, ratingMvaPerCircuit: ratingMva(300, 1.605), source: `${cableImpedanceSource}; rating: √3·300 kV·1.605 kA, 2000 mm² Cu XLPE in trefoil (ABB XLPE Underground Cable Systems rev 3, Table 4)` },
  220: { id: 'cable-220kv', ...cableImpedance, ratingMvaPerCircuit: ratingMva(220, 1.095), source: `${cableImpedanceSource}; rating: √3·220 kV·1.095 kA, 1000 mm² Cu XLPE in trefoil (ABB XLPE Underground Cable Systems rev 3, Table 4)` },
  132: { id: 'cable-132kv', ...cableImpedance, ratingMvaPerCircuit: ratingMva(132, 1.095), source: `${cableImpedanceSource}; rating: √3·132 kV·1.095 kA, 1000 mm² Cu XLPE in trefoil (ABB XLPE Underground Cable Systems rev 3, Table 4)` },
}

/** Transitory admissible overload (SO GL, Regulation (EU) 2017/1485, Art. 25): factor on the continuous rating and its duration. */
export const emergencyRule = {
  id: 'emergency-120pct-15min',
  factor: 1.2,
  durationSeconds: 900,
  source: 'short-term limit typically 20 % above continuous for 15 min (Statnett SDOK-39-30 rev 6.0, thermal limits of overhead lines)',
} as const

export const transformerRule = {
  id: 'transformer-capacity-matched',
  /** Short-circuit reactance on the unit's own rating, pu (FD1 guidance: 0.10–0.15). */
  reactanceOnRatingPu: 0.12,
  /** X/R of large power transformers, modelling judgement within the 30–50 typical of units above 100 MVA. */
  xOverR: 40,
  /** Margin over the larger local injection of the low-voltage bus. */
  injectionMargin: 1.25,
  /** Ratings round up to this step, MVA. */
  stepMva: 50,
  source: 'rating: the smaller of the high-voltage line capacity and the low-voltage line capacity plus the larger of generation and load on the low-voltage bus (what that bus passes on), at least 1.25 × that local injection, rounded up to 50 MVA; x 0.12 pu on rating (FD1 guidance 0.10–0.15), X/R 40; tap ratio 1',
} as const

/** Numerical floor on series reactance, pu (≈ 0.6 km of 420 kV line): very short corridors stay well conditioned. */
export const reactanceFloorPu = 1e-4

export const shuntRule = {
  id: 'shunt-reactor-charging-share',
  minimumKv: 300,
  /** Share of the line charging at a bus (half of each connected ≥ minimumKv line or cable) that its reactors absorb. */
  compensatedShare: 0.7,
  /** Reactors smaller than this are not modelled, MVAr. */
  minimumMvar: 5,
  source: 'reactor absorbs 70 % of half the 1-pu charging of every connected ≥300 kV line and cable; typical shunt compensation degrees are 60–80 % (IPST 2005, paper 05IPST109)',
} as const

export const voltageClassOf = (kv: number): VoltageClassKv => {
  const match = voltageClassesKv.find(value => value === kv)
  if (match === undefined) throw new Error(`no electrical rule for ${kv} kV; the model covers ${voltageClassesKv.join('/')} kV`)
  return match
}

export interface SeriesParameters {
  readonly reactancePu: number
  readonly resistancePu: number
  readonly chargingSusceptancePu: number
  readonly ratingMw: number
  readonly emergencyRatingMw: number
  readonly emergencyDurationSeconds: number
  readonly ruleIds: ReadonlyArray<string>
}

/** All circuits in parallel; the cable share of the corridor uses the cable rule. */
export const lineParameters = (config: {
  readonly nominalKv: number
  readonly lengthKm: number
  readonly cableLengthKm: number
  readonly circuits: number
}): SeriesParameters => {
  const voltageClass = voltageClassOf(config.nominalKv)
  const overhead = overheadRules[voltageClass]
  const cable = cableRules[voltageClass]
  const cableKm = Math.min(config.cableLengthKm, config.lengthKm)
  const overheadKm = config.lengthKm - cableKm
  const impedanceBase = config.nominalKv ** 2 / sBaseMva
  const perCircuit = {
    x: (overhead.xOhmPerKm * overheadKm + cable.xOhmPerKm * cableKm) / impedanceBase,
    r: (overhead.rOhmPerKm * overheadKm + cable.rOhmPerKm * cableKm) / impedanceBase,
    b: (overhead.bMicroSiemensPerKm * overheadKm + cable.bMicroSiemensPerKm * cableKm) * 1e-6 * impedanceBase,
  }
  const usedRules = [...(overheadKm > 0 ? [overhead] : []), ...(cableKm > 0 ? [cable] : [])]
  const ratingMw = Math.min(...usedRules.map(rule => rule.ratingMvaPerCircuit)) * config.circuits
  const reactancePu = perCircuit.x / config.circuits
  return {
    reactancePu: Math.max(reactancePu, reactanceFloorPu),
    resistancePu: perCircuit.r / config.circuits,
    chargingSusceptancePu: perCircuit.b * config.circuits,
    ratingMw,
    emergencyRatingMw: Math.round(ratingMw * emergencyRule.factor),
    emergencyDurationSeconds: emergencyRule.durationSeconds,
    ruleIds: [...usedRules.map(rule => rule.id), ...(reactancePu < reactanceFloorPu ? ['reactance-floor'] : []), emergencyRule.id],
  }
}

export const transformerParameters = (ratingMva: number, circuits: number): Omit<SeriesParameters, 'chargingSusceptancePu'> => {
  const reactancePu = transformerRule.reactanceOnRatingPu * sBaseMva / ratingMva
  return {
    reactancePu,
    resistancePu: reactancePu / transformerRule.xOverR,
    ratingMw: ratingMva,
    emergencyRatingMw: Math.round(ratingMva * emergencyRule.factor),
    emergencyDurationSeconds: emergencyRule.durationSeconds,
    ruleIds: [transformerRule.id, emergencyRule.id, ...(circuits > 1 ? [`units-${circuits}`] : [])],
  }
}

export const electricalRules = { sBaseMva, overheadRules, cableRules, emergencyRule, transformerRule, reactanceFloorPu, shuntRule }
