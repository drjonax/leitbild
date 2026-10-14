/** One explicitly authored hot LD-01 regional source configuration. Offline
 * constitutive compilation/evaluation only; no solver or fine-field preparation. */
import { join } from 'node:path'
import { z } from 'zod'
import type { compileOperatingMapping } from './reference-design-operating-mapping'
import type { ControlAbsorber } from './reference-design-control-absorber'

const positive = z.number().finite().positive(), finite = z.number().finite(), nonnegative = finite.min(0)
const six = z.tuple([nonnegative, nonnegative, nonnegative, nonnegative, nonnegative, nonnegative])
const pair = z.tuple([finite, finite])
const schema = z.object({
  identity: z.literal('LD01-HOT-SOURCE-1'), generationTime_s: positive, nuEffective: positive,
  delayedFractions: six, delayedHalfLives_s: z.tuple([positive, positive, positive, positive, positive, positive]),
  radialTransfer_per_s: positive, axialTransfer_per_s: positive,
  referenceFissions_per_s: positive,
  doppler_pcm_sqrtK: finite.negative(), waterWorth: positive, boron_pcm_ppmEq: finite.negative(),
  fissileHeavyMassFraction: positive.max(1), u235MolarMass_kg_mol: positive, u238MolarMass_kg_mol: positive,
  oxygenMolarMass_kg_mol: positive, avogadro_per_mol: positive,
  effectiveFission_barn: positive, effectiveXeCapture_barn: positive, effectiveSmCapture_barn: positive,
  directIodine_per_fission: nonnegative, directXenon_per_fission: nonnegative, directPromethium_per_fission: nonnegative,
  iodineHalfLife_s: positive, xenonHalfLife_s: positive, promethiumHalfLife_s: positive,
  capsuleBirths_per_s: nonnegative, capsuleHalfLife_s: positive, sourceEquivalentPerNeutron: positive,
  fuelDomain_K: pair, moderatorDomain_K: pair, pressureDomain_Pa: pair, densityRatioDomain: pair,
  boronDomain_ppmEq: pair, fissileRatioDomain: pair, reactivityDomain: pair,
  maximumReferenceFissionExposure_s: positive,
  couplingSensitivity: z.tuple([positive, positive, positive]),
  generationTimeSensitivity_s: z.tuple([positive, positive, positive]),
  delayedFractionSensitivity: z.tuple([positive, positive, positive]),
  rodWorth: positive, rodWorthSensitivity: z.tuple([positive, positive, positive]),
  dopplerSensitivity_pcm_sqrtK: z.tuple([finite.negative(), finite.negative(), finite.negative()]),
  absorptionSensitivity: z.tuple([positive, positive, positive]),
}).strict().superRefine((p, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (p.nuEffective <= 1 || p.delayedFractions.reduce((a, b) => a + b, 0) >= 1) fail('Invalid offspring normalization')
  for (const key of ['fuelDomain_K', 'moderatorDomain_K', 'pressureDomain_Pa', 'densityRatioDomain',
    'boronDomain_ppmEq', 'fissileRatioDomain', 'reactivityDomain'] as const)
    if (p[key][0] >= p[key][1]) fail('Invalid coefficient domain: ' + key)
  if (p.fuelDomain_K[0] <= 0 || p.densityRatioDomain[0] <= 0 || p.fissileRatioDomain[0] <= 0) fail('Invalid positive domain')
})
export type OperatingSourceCoefficients = z.infer<typeof schema>
export function parseOperatingSource(document: string): OperatingSourceCoefficients {
  const blocks = [...document.matchAll(/^```reference-operating-source\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-operating-source block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

// D3 (a), kinetics.md "Post-trip domain extension": it widens the density-ratio
// and pressure domains only while the native accepted-state check holds (the
// source-free regional operator, water term at the factor, at least the margin
// subcritical); otherwise the domains above apply.
const postTripSchema = z.object({
  densityRatioMax: positive, pressureMin_Pa: positive, shutdownMarginMin_dk_k: positive,
  marginWaterTermFactor: positive, extrapolationSensitivity: z.tuple([positive, positive, positive]),
}).strict()
export type OperatingPostTripDomain = z.infer<typeof postTripSchema>
export function parseOperatingPostTripDomain(document: string, source: OperatingSourceCoefficients): OperatingPostTripDomain {
  const blocks = [...document.matchAll(/^```ld01-post-trip-domain\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one ld01-post-trip-domain block')
  const d = postTripSchema.parse(JSON.parse(blocks[0]![1]!)), [low, nominal, high] = d.extrapolationSensitivity
  if (d.densityRatioMax < source.densityRatioDomain[1]) throw Error('The post-trip density-ratio maximum must widen the source domain')
  if (d.pressureMin_Pa > source.pressureDomain_Pa[0]) throw Error('The post-trip pressure minimum must widen the source domain')
  if (d.shutdownMarginMin_dk_k >= 1) throw Error('Invalid post-trip shutdown margin')
  if (d.marginWaterTermFactor < 1) throw Error('The post-trip margin water-term factor must not weaken the term')
  if (!(low < nominal && nominal === 1 && nominal < high)) throw Error('Invalid post-trip extrapolation sensitivity')
  return d
}
/** Native boundary of D3 (a): joined/post_trip_domain.rs `Extension`. */
export function operatingPostTripDomainNative(d: OperatingPostTripDomain) {
  return { density_ratio_maximum: d.densityRatioMax, pressure_minimum_pa: d.pressureMin_Pa,
    shutdown_margin_minimum: d.shutdownMarginMin_dk_k, margin_water_term_factor: d.marginWaterTermFactor,
    extrapolation_sensitivity: [...d.extrapolationSensitivity] }
}
/** The joined packet's `post_trip_domain` section from the wiki's kinetics owner page. */
export async function compileOperatingPostTripDomain(wiki: string) {
  const document = await Bun.file(join(wiki, 'world/packs/process-plant/reference-designs/ld-01/systems/reactor/kinetics.md')).text()
  return operatingPostTripDomainNative(parseOperatingPostTripDomain(document, parseOperatingSource(document)))
}
type Mapping = ReturnType<typeof compileOperatingMapping>
export type OperatingSourceConstruction = {
  assemblyPitch_m: number, sourceZ_m: number,
  /** One achieved preparation pose, supplied by the hot-state owner. */
  referenceRodTravel_m: number,
  /** Explicit achieved/prepared current stock; never silently reseeded fresh. */
  referenceFissileAtoms: readonly number[],
  referencePoisonInventories: { iodineAtoms: readonly number[], xenonAtoms: readonly number[],
    promethiumAtoms: readonly number[], samariumAtoms: readonly number[] },
  referenceNonpoisonCaptureOpacity_m2: readonly number[],
  absorber: Pick<ControlAbsorber, 'clusters' | 'rodletsPerCluster' | 'absorberDiameter_m' |
    'insertedActiveBottom_m' | 'activeLength_m' | 'normalTravel_m'>,
}
export type OperatingReferenceThermo = {
  fuelTemperature_K: readonly number[], waterDensity_kg_m3: readonly number[], boron_ppmEq: readonly number[],
  pressure_Pa: readonly number[], moderatorTemperature_K: readonly number[],
}
export type OperatingSourceConditions = OperatingReferenceThermo & {
  achievedRodTravel_m: readonly number[], fissileAtoms: readonly number[], xenonAtoms: readonly number[],
  samariumAtoms: readonly number[],
  /** Nonpoison actual-minus-reference capture opacity, m², from its ONE owner.
   * Baseline capture is already included by the calibrated rhoBase. */
  captureLossChange_m2: readonly number[], capsuleAge_s: number,
}
export type OperatingSourceDirection = OperatingSourceConditions
export type OperatingSourceInputs = {
  regions: { reactivity: number, external_source_per_s: number }[], transfer_rates_per_s: number[],
  fissions_per_population_s: number[], emission_fractions: number[], outside_fractions: number[],
}
export type CompiledOperatingSource = ReturnType<typeof compileOperatingSource>
const sum = (x: readonly number[]) => x.reduce((a, b) => a + b, 0)
const add = (values: number[], index: number, value: number) => { values[index] = values[index]! + value }
const arrays = (label: string, values: readonly number[], count: number) => {
  if (values.length !== count || !values.every(Number.isFinite)) throw Error('Invalid ' + label)
}
function checkConditions(c: OperatingSourceConditions, regions: number, carriers: number, rods: number) {
  for (const key of ['waterDensity_kg_m3', 'boron_ppmEq', 'pressure_Pa', 'moderatorTemperature_K'] as const) arrays(key, c[key], regions)
  for (const key of ['fuelTemperature_K', 'fissileAtoms', 'xenonAtoms', 'samariumAtoms', 'captureLossChange_m2'] as const) arrays(key, c[key], carriers)
  arrays('achieved rod travel', c.achievedRodTravel_m, rods)
  if (!Number.isFinite(c.capsuleAge_s)) throw Error('Invalid capsule age')
}
// Continuous actual overlap. At a knot return the right-hand achieved-travel
// derivative; it is not a central derivative across a nonsmooth physical edge.
function overlap(lo: number, hi: number, bottom: number, length: number) {
  const top = bottom + length, value = Math.max(0, Math.min(hi, top) - Math.max(lo, bottom))
  const derivative = value > 0 ? (top < hi ? 1 : 0) - (bottom >= lo ? 1 : 0) : top === lo ? 1 : 0
  return { value, derivative }
}
function rodFractions(mapping: Mapping, construction: OperatingSourceConstruction) {
  const pitch = construction.assemblyPitch_m
  if (!Number.isFinite(pitch) || pitch <= 0) throw Error('Invalid assembly pitch')
  const rods = mapping.assemblies.filter(fa => {
    const x = Math.round(fa.reference_x_m / pitch), y = Math.round(fa.reference_y_m / pitch)
    return (x % 2 === 0 && y % 2 === 0 && (x !== 0 || y !== 0)) ||
      (Math.abs(x) === 1 && Math.abs(y) === 3) || (Math.abs(x) === 3 && Math.abs(y) === 1)
  }).map((fa, index) => ({ id: 'LD01.CR.' + String(index + 1).padStart(3, '0'), faId: fa.faId,
    x_m: fa.reference_x_m, y_m: fa.reference_y_m }))
  if (rods.length !== 52 || construction.absorber.clusters !== 52 || construction.absorber.rodletsPerCluster !== 24) throw Error('Invalid 52-cluster footprint')
  const pinPitch = pitch / 17, offsets = [2, 5, 8, 11, 14].flatMap(y => [2, 5, 8, 11, 14]
    .filter(x => x !== 8 || y !== 8).map(x => ({ x: (x - 8) * pinPitch, y: (y - 8) * pinPitch })))
  const signFraction = (coordinate: number, positive: boolean) => coordinate === 0 ? .5 : (coordinate > 0) === positive ? 1 : 0
  const sectorWeights = mapping.regions.filter(r => r.axialBand === 0).map(q => rods.map(rod =>
    sum(offsets.map(o => signFraction(rod.x_m + o.x, q.x0_m === 0) * signFraction(rod.y_m + o.y, q.y0_m === 0))) / 24))
  for (let a = 0; a < rods.length; a++) if (Math.abs(sum(sectorWeights.map(row => row[a]!)) - 1) > 1e-14) throw Error('Rod sector incidence does not close')
  return { rods, sectorWeights }
}
function rodResponse(model: { mapping: Mapping, construction: OperatingSourceConstruction,
  rodSectorWeights: number[][] }, travel: readonly number[], direction?: readonly number[]) {
  const a = model.construction.absorber
  return model.mapping.regions.map(r => {
    const weights = model.rodSectorWeights[r.sector]!, denominator = sum(weights) * (r.z1_m - r.z0_m)
    if (!(denominator > 0)) throw Error('Unrodded sector needs explicit worth admission')
    return sum(weights.map((weight, m) => {
      const own = overlap(r.z0_m, r.z1_m, a.insertedActiveBottom_m + travel[m]!, a.activeLength_m)
      return weight * (direction ? own.derivative * direction[m]! : own.value)
    })) / denominator
  })
}

/** Fresh original material basis only. Current prepared/depleted stock must
 * be passed explicitly to compileOperatingSource by its history owner. */
export function operatingSourceFreshFuelAtoms(mapping: Mapping, p: OperatingSourceCoefficients) {
  const atomMassMean = 1 / (p.fissileHeavyMassFraction / p.u235MolarMass_kg_mol + (1 - p.fissileHeavyMassFraction) / p.u238MolarMass_kg_mol),
    heavyFraction = atomMassMean / (atomMassMean + 2 * p.oxygenMolarMass_kg_mol)
  return {
    fissile: mapping.carriers.map(a => a.referenceFuelMass_kg * heavyFraction * p.fissileHeavyMassFraction / p.u235MolarMass_kg_mol * p.avogadro_per_mol),
    fertile: mapping.carriers.map(a => a.referenceFuelMass_kg * heavyFraction * (1 - p.fissileHeavyMassFraction) / p.u238MolarMass_kg_mol * p.avogadro_per_mol),
  }
}

/** Authored sine reference in the actual fuel support; no runtime shape reset. */
export function operatingReferenceFissions(mapping: Mapping, p: OperatingSourceCoefficients) {
  const raw = mapping.regions.map(r => r.fuelVolume_m3 *
    (Math.cos(Math.PI * (r.z0_m + 2) / 4) - Math.cos(Math.PI * (r.z1_m + 2) / 4)) / (r.z1_m - r.z0_m)),
    regions = raw.map(value => p.referenceFissions_per_s * value / sum(raw)),
    carriers = Array(mapping.carriers.length).fill(0) as number[]
  for (const e of mapping.intersections) add(carriers, e.carrier, regions[e.region]! * e.fuelVolume_m3 / mapping.regions[e.region]!.fuelVolume_m3)
  return { regions, carriers }
}

export function compileOperatingSource(mapping: Mapping, supplied: OperatingSourceCoefficients,
  construction: OperatingSourceConstruction, referenceThermo: OperatingReferenceThermo) {
  const coefficients = schema.parse(supplied), p = coefficients, R = mapping.regions.length, A = mapping.carriers.length
  if (R !== 24 || A !== 386 || mapping.totals.outsideFuelVolume_m3 !== 0 ||
    mapping.assemblies.some(fa => fa.x_m !== fa.reference_x_m || fa.y_m !== fa.reference_y_m) ||
    mapping.carriers.some(a => a.z0_m !== (a.index === 0 ? -2 : 0) || a.z1_m !== (a.index === 0 ? 0 : 2)))
    throw Error('HOT-SOURCE-1 requires original full seated configuration')
  if (mapping.regions.some((r, i) => r.sector * 6 + r.axialBand !== i || r.fuelVolume_m3 <= 0 ||
    Math.abs(r.z0_m - (-2 + r.axialBand * 2 / 3)) > 1e-14 || Math.abs(r.z1_m - (-2 + (r.axialBand + 1) * 2 / 3)) > 1e-14))
    throw Error('Incompatible HOT-SOURCE-1 region order/bounds')
  for (let q = 0; q < 4; q++) {
    const a = mapping.regions[q * 6]!, b = mapping.regions[((q + 1) % 4) * 6]!
    if ((a.x0_m === 0) === (b.x0_m === 0) && (a.y0_m === 0) === (b.y0_m === 0) ||
      (a.x0_m === 0) !== (b.x0_m === 0) && (a.y0_m === 0) !== (b.y0_m === 0)) throw Error('Nonadjacent sector ring')
  }
  if (![construction.sourceZ_m, construction.referenceRodTravel_m, construction.absorber.insertedActiveBottom_m, construction.absorber.activeLength_m,
    construction.absorber.normalTravel_m, construction.absorber.absorberDiameter_m].every(Number.isFinite) ||
    construction.absorber.activeLength_m !== 4 || construction.absorber.normalTravel_m !== 4 || construction.absorber.absorberDiameter_m <= 0 ||
    construction.referenceRodTravel_m < 0 || construction.referenceRodTravel_m > construction.absorber.normalTravel_m) throw Error('Invalid source/absorber construction')
  const { rods, sectorWeights } = rodFractions(mapping, construction)
  const transfers: { donor: number, receiver: number }[] = [], transferRates: number[] = []
  for (const region of mapping.regions) {
    const i = region.sector * 6 + region.axialBand
    for (const sector of [(region.sector + 1) % 4, (region.sector + 3) % 4]) {
      transfers.push({ donor: i, receiver: sector * 6 + region.axialBand }); transferRates.push(p.radialTransfer_per_s)
    }
    for (const band of [region.axialBand - 1, region.axialBand + 1]) if (band >= 0 && band < 6) {
      transfers.push({ donor: i, receiver: region.sector * 6 + band }); transferRates.push(p.axialTransfer_per_s)
    }
  }
  const lambda = p.delayedHalfLives_s.map(t => Math.LN2 / t), nuDelayed = p.delayedFractions.map(b => p.nuEffective * b),
    gamma = 1 / (p.nuEffective * p.generationTime_s), sigmaF = p.effectiveFission_barn * 1e-28,
    sigmaXe = p.effectiveXeCapture_barn * 1e-28, sigmaSm = p.effectiveSmCapture_barn * 1e-28,
    freshFuelAtoms = operatingSourceFreshFuelAtoms(mapping, p),
    fissileReferenceAtoms = [...construction.referenceFissileAtoms], originalFertileAtoms = freshFuelAtoms.fertile,
    G = mapping.intersections.map(e => gamma * e.fuelVolume_m3 / mapping.regions[e.region]!.fuelVolume_m3),
    H = G.map((g, edge) => g / (sigmaF * fissileReferenceAtoms[mapping.intersections[edge]!.carrier]!)),
    referenceFissions = operatingReferenceFissions(mapping, p),
    neutronReference = referenceFissions.regions.map(f => f / gamma),
    carrierFissions = Array(A).fill(0) as number[], exposure = Array(A).fill(0) as number[]
  for (const [edge, e] of mapping.intersections.entries()) {
    add(carrierFissions, e.carrier, G[edge]! * neutronReference[e.region]!)
    add(exposure, e.carrier, H[edge]! * neutronReference[e.region]!)
  }
  arrays('current reference fissile atoms', fissileReferenceAtoms, A)
  if (fissileReferenceAtoms.some((n, a) => n <= 0 || n > freshFuelAtoms.fissile[a]!)) throw Error('Invalid current reference fissile inventory')
  for (const [label, values] of Object.entries(construction.referencePoisonInventories)) {
    arrays('reference poison ' + label, values, A)
    if (values.some(n => n < 0)) throw Error('Invalid reference poison inventory')
  }
  const iodineAtoms = [...construction.referencePoisonInventories.iodineAtoms],
    xenonAtoms = [...construction.referencePoisonInventories.xenonAtoms],
    promethiumAtoms = [...construction.referencePoisonInventories.promethiumAtoms],
    samariumAtoms = [...construction.referencePoisonInventories.samariumAtoms],
    precursors = carrierFissions.flatMap(f => lambda.map((l, g) => nuDelayed[g]! * f / l)),
    conditions: OperatingSourceConditions = { ...structuredClone(referenceThermo), achievedRodTravel_m: Array(52).fill(construction.referenceRodTravel_m),
      fissileAtoms: [...fissileReferenceAtoms], xenonAtoms, samariumAtoms, captureLossChange_m2: Array(A).fill(0), capsuleAge_s: 0 }
  checkConditions(conditions, R, A, 52)
  const sourceWeights = mapping.regions.map(r => construction.sourceZ_m >= r.z0_m && construction.sourceZ_m < r.z1_m ? .25 : 0)
  if (Math.abs(sum(sourceWeights) - 1) > 1e-14) throw Error('Unrepresented fixed source support')
  const baseInputs: OperatingSourceInputs = {
    regions: Array.from({ length: R }, (_, i) => ({ reactivity: 0, external_source_per_s: sourceWeights[i]! * p.capsuleBirths_per_s * p.sourceEquivalentPerNeutron })),
    transfer_rates_per_s: transferRates, fissions_per_population_s: G,
    emission_fractions: mapping.intersections.map(e => e.uniformEmissionFraction),
    outside_fractions: mapping.carriers.map(a => a.outsideEmissionFraction),
  }
  const rates = Array(R).fill(0) as number[]
  for (const [edge, e] of mapping.intersections.entries()) {
    add(rates, e.region, -sum(nuDelayed) * G[edge]! * neutronReference[e.region]!)
    add(rates, e.region, baseInputs.emission_fractions[edge]! * carrierFissions[e.carrier]! * sum(nuDelayed))
  }
  transfers.forEach((e, k) => { const f = transferRates[k]! * neutronReference[e.donor]!; add(rates, e.donor, -f); add(rates, e.receiver, f) })
  // Source-OFF critical comparator. The actual capsule remains a nonsteady
  // receipt; it is never cancelled by changing the core's reference coefficient.
  const rhoBase = rates.map((rate, i) => -p.generationTime_s * rate / neutronReference[i]!)
  baseInputs.regions.forEach((r, i) => { r.reactivity = rhoBase[i]! })
  arrays('reference nonpoison capture opacity', construction.referenceNonpoisonCaptureOpacity_m2, A)
  if (construction.referenceNonpoisonCaptureOpacity_m2.some(v => v < 0)) throw Error('Negative reference capture opacity')
  const referenceLeakage = rhoBase.map(rho => -rho / p.generationTime_s), referenceCaptures = Array(R).fill(0) as number[]
  for (const [edge, e] of mapping.intersections.entries()) {
    const a = e.carrier, loss = H[edge]! * (construction.referenceNonpoisonCaptureOpacity_m2[a]! + sigmaXe * xenonAtoms[a]! + sigmaSm * samariumAtoms[a]!)
    add(referenceLeakage, e.region, (p.nuEffective - 1) * G[edge]! - loss)
    add(referenceCaptures, e.region, loss * neutronReference[e.region]!)
  }
  if (referenceLeakage.some(v => !Number.isFinite(v) || v < 0)) throw Error('Selected source reference implies negative leakage')
  const model = { coefficients, construction: structuredClone(construction), mapping, rods, rodSectorWeights: sectorWeights,
    regions: mapping.regions.map(() => ({ generation_time_s: p.generationTime_s, reactivity_domain: { minimum: p.reactivityDomain[0], maximum: p.reactivityDomain[1] } })),
    materials: mapping.carriers.map(() => ({ delayed_yields_per_fission: [...nuDelayed], decay_constants_per_s: [...lambda] })),
    transfers, supports: mapping.intersections.map(e => ({ region: e.region, material: e.carrier })),
    fissileReferenceAtoms, originalFertileAtoms, exposurePerPopulation_s_m2: H, productionReference: G,
    sigmaF_m2: sigmaF, sigmaXe_m2: sigmaXe, sigmaSm_m2: sigmaSm, sourceWeights, rhoBase, baseInputs,
    referenceLeakage_per_s: referenceLeakage,
    referenceNumberBudget: { captures_per_fission: sum(referenceCaptures) / p.referenceFissions_per_s,
      leakage_per_fission: sum(referenceLeakage.map((l, i) => l * neutronReference[i]!)) / p.referenceFissions_per_s,
      inducedBirths_per_fission: p.nuEffective, fissionTerminations_per_fission: 1 },
    reference: { neutrons: neutronReference, precursors, conditions, carrierFissions_per_s: carrierFissions,
      exposure_per_m2_s: exposure, iodineAtoms, xenonAtoms, promethiumAtoms, samariumAtoms },
  }
  validateOperatingSourceAccepted(model, neutronReference, conditions, 0)
  return model
}

export function evaluateOperatingSource(model: CompiledOperatingSource, neutrons: readonly number[], c: OperatingSourceConditions) {
  const { coefficients: p, mapping, reference } = model, R = mapping.regions.length, A = mapping.carriers.length
  arrays('neutron populations', neutrons, R); checkConditions(c, R, A, 52)
  if (c.fuelTemperature_K.some(t => t <= 0)) throw Error('Square-root fuel functional unavailable')
  const inputs: OperatingSourceInputs = { regions: model.rhoBase.map(reactivity => ({ reactivity, external_source_per_s: 0 })),
    transfer_rates_per_s: [...model.baseInputs.transfer_rates_per_s], fissions_per_population_s: [],
    emission_fractions: [...model.baseInputs.emission_fractions], outside_fractions: [...model.baseInputs.outside_fractions] },
    carrierFissions = Array(A).fill(0) as number[], exposure = Array(A).fill(0) as number[],
    rodNow = rodResponse(model, c.achievedRodTravel_m), rodRef = rodResponse(model, reference.conditions.achievedRodTravel_m),
    born = p.capsuleBirths_per_s * p.sourceEquivalentPerNeutron * Math.exp(-Math.LN2 * c.capsuleAge_s / p.capsuleHalfLife_s)
  inputs.regions.forEach((r, i) => {
    const ratio = c.waterDensity_kg_m3[i]! / reference.conditions.waterDensity_kg_m3[i]!
    r.reactivity += -p.rodWorth * (rodNow[i]! - rodRef[i]!) + p.waterWorth * (ratio - 1) +
      p.boron_pcm_ppmEq * 1e-5 * (c.boron_ppmEq[i]! * ratio - reference.conditions.boron_ppmEq[i]!)
    r.external_source_per_s = model.sourceWeights[i]! * born
  })
  for (const [edge, e] of mapping.intersections.entries()) {
    const a = e.carrier, i = e.region, g0 = model.productionReference[edge]!, h = model.exposurePerPopulation_s_m2[edge]!,
      g = g0 * c.fissileAtoms[a]! / model.fissileReferenceAtoms[a]!, weight = e.fuelVolume_m3 / mapping.regions[i]!.fuelVolume_m3,
      loss = c.captureLossChange_m2[a]! + model.sigmaXe_m2 * (c.xenonAtoms[a]! - reference.xenonAtoms[a]!) +
        model.sigmaSm_m2 * (c.samariumAtoms[a]! - reference.samariumAtoms[a]!)
    inputs.fissions_per_population_s.push(g)
    add(carrierFissions, a, g * neutrons[i]!)
    add(exposure, a, h * neutrons[i]!)
    inputs.regions[i]!.reactivity += p.doppler_pcm_sqrtK * 1e-5 * weight *
      (Math.sqrt(c.fuelTemperature_K[a]!) - Math.sqrt(reference.conditions.fuelTemperature_K[a]!)) +
      p.generationTime_s * ((p.nuEffective - 1) * (g - g0) - h * loss)
  }
  const poisonCapture = exposure.map((phi, a) => ({ xenon: model.sigmaXe_m2 * phi * c.xenonAtoms[a]!, samarium: model.sigmaSm_m2 * phi * c.samariumAtoms[a]! }))
  if (![...inputs.regions.flatMap(r => [r.reactivity, r.external_source_per_s]), ...carrierFissions, ...exposure,
    ...poisonCapture.flatMap(r => [r.xenon, r.samarium])].every(Number.isFinite)) throw Error('Nonfinite source result')
  return { inputs, carrierFissions_per_s: carrierFissions, exposure_per_m2_s: exposure, poisonCapture_per_s: poisonCapture, rodOverlap: rodNow }
}

/** Immutable native input boundary for the SAME already-compiled reference.
 * This does not calibrate a second source or retain a second plant state. */
export function operatingSourceNativeMetadata(model: CompiledOperatingSource) {
  const {coefficients:p,reference,construction:c}=model,
    bounds=(pair:readonly [number,number])=>({minimum:pair[0],maximum:pair[1]}),
    rodReference=rodResponse(model,reference.conditions.achievedRodTravel_m)
  return {
    parameters:{generation_time_s:p.generationTime_s,nu_effective:p.nuEffective,
      doppler_per_sqrt_k:p.doppler_pcm_sqrtK*1e-5,water_worth:p.waterWorth,
      boron_per_ppm_eq:p.boron_pcm_ppmEq*1e-5,rod_worth:p.rodWorth,
      sigma_xe_m2:model.sigmaXe_m2,sigma_sm_m2:model.sigmaSm_m2,
      capsule_births_per_s:p.capsuleBirths_per_s*p.sourceEquivalentPerNeutron,
      capsule_decay_per_s:Math.LN2/p.capsuleHalfLife_s,
      inserted_active_bottom_m:c.absorber.insertedActiveBottom_m,
      rod_active_length_m:c.absorber.activeLength_m,rod_maximum_travel_m:c.absorber.normalTravel_m,
      domains:{fuel_temperature_k:bounds(p.fuelDomain_K),moderator_temperature_k:bounds(p.moderatorDomain_K),
        pressure_pa:bounds(p.pressureDomain_Pa),density_ratio:bounds(p.densityRatioDomain),
        boron_ppm_eq:bounds(p.boronDomain_ppmEq),fissile_ratio:bounds(p.fissileRatioDomain),
        reactivity:bounds(p.reactivityDomain),maximum_additional_reference_exposure_s:p.maximumReferenceFissionExposure_s}},
    regions:model.mapping.regions.map((r,i)=>({rho_base:model.rhoBase[i]!,
      reference_density_kg_m3:reference.conditions.waterDensity_kg_m3[i]!,
      reference_boron_ppm_eq:reference.conditions.boron_ppmEq[i]!,reference_rod_overlap:rodReference[i]!,
      source_weight:model.sourceWeights[i]!,z0_m:r.z0_m,z1_m:r.z1_m,
      rod_weights:model.rodSectorWeights[r.sector]!.map(w=>w/sum(model.rodSectorWeights[r.sector]!))})),
    materials:model.mapping.carriers.map((_,a)=>({reference_fissile_atoms:model.fissileReferenceAtoms[a]!,
      reference_fuel_temperature_k:reference.conditions.fuelTemperature_K[a]!,
      reference_xenon_atoms:reference.xenonAtoms[a]!,reference_samarium_atoms:reference.samariumAtoms[a]!,
      reference_nonpoison_capture_opacity_m2:c.referenceNonpoisonCaptureOpacity_m2[a]!})),
    supports:model.mapping.intersections.map((e,k)=>({region:e.region,material:e.carrier,
      production_reference_per_s:model.productionReference[k]!,exposure_per_population_s_m2:model.exposurePerPopulation_s_m2[k]!,
      fuel_importance:e.fuelVolume_m3/model.mapping.regions[e.region]!.fuelVolume_m3})),
  }
}

export function operatingSourceDirection(model: CompiledOperatingSource, neutrons: readonly number[], c: OperatingSourceConditions,
  dNeutrons: readonly number[], d: OperatingSourceDirection) {
  const { coefficients: p, mapping, reference } = model, R = mapping.regions.length, A = mapping.carriers.length
  evaluateOperatingSource(model, neutrons, c); arrays('neutron direction', dNeutrons, R); checkConditions(d, R, A, 52)
  const inputs: OperatingSourceInputs = { regions: Array.from({ length: R }, () => ({ reactivity: 0, external_source_per_s: 0 })),
    transfer_rates_per_s: Array(model.transfers.length).fill(0), fissions_per_population_s: [],
    emission_fractions: Array(mapping.intersections.length).fill(0), outside_fractions: Array(A).fill(0) },
    fissions = Array(A).fill(0) as number[], exposure = Array(A).fill(0) as number[],
    rod = rodResponse(model, c.achievedRodTravel_m, d.achievedRodTravel_m),
    born = p.capsuleBirths_per_s * p.sourceEquivalentPerNeutron * Math.exp(-Math.LN2 * c.capsuleAge_s / p.capsuleHalfLife_s)
  inputs.regions.forEach((r, i) => {
    const densityRef = reference.conditions.waterDensity_kg_m3[i]!, ratio = c.waterDensity_kg_m3[i]! / densityRef,
      dratio = d.waterDensity_kg_m3[i]! / densityRef
    r.reactivity = -p.rodWorth * rod[i]! + p.waterWorth * dratio + p.boron_pcm_ppmEq * 1e-5 *
      (d.boron_ppmEq[i]! * ratio + c.boron_ppmEq[i]! * dratio)
    r.external_source_per_s = -model.sourceWeights[i]! * born * Math.LN2 / p.capsuleHalfLife_s * d.capsuleAge_s
  })
  for (const [edge, e] of mapping.intersections.entries()) {
    const a = e.carrier, i = e.region, g0 = model.productionReference[edge]!, h = model.exposurePerPopulation_s_m2[edge]!,
      g = g0 * c.fissileAtoms[a]! / model.fissileReferenceAtoms[a]!, dg = g0 * d.fissileAtoms[a]! / model.fissileReferenceAtoms[a]!,
      weight = e.fuelVolume_m3 / mapping.regions[i]!.fuelVolume_m3,
      loss = d.captureLossChange_m2[a]! + model.sigmaXe_m2 * d.xenonAtoms[a]! + model.sigmaSm_m2 * d.samariumAtoms[a]!
    inputs.fissions_per_population_s.push(dg)
    add(fissions, a, dg * neutrons[i]! + g * dNeutrons[i]!)
    add(exposure, a, h * dNeutrons[i]!)
    inputs.regions[i]!.reactivity += p.doppler_pcm_sqrtK * 1e-5 * weight * d.fuelTemperature_K[a]! / (2 * Math.sqrt(c.fuelTemperature_K[a]!)) +
      p.generationTime_s * ((p.nuEffective - 1) * dg - h * loss)
  }
  const phi = evaluateOperatingSource(model, neutrons, c).exposure_per_m2_s,
    poison = exposure.map((v, a) => ({ xenon: model.sigmaXe_m2 * (v * c.xenonAtoms[a]! + phi[a]! * d.xenonAtoms[a]!),
      samarium: model.sigmaSm_m2 * (v * c.samariumAtoms[a]! + phi[a]! * d.samariumAtoms[a]!) }))
  if (![...inputs.regions.flatMap(r => [r.reactivity, r.external_source_per_s]), ...fissions, ...exposure,
    ...poison.flatMap(r => [r.xenon, r.samarium])].every(Number.isFinite)) throw Error('Nonfinite source direction')
  return { inputs, carrierFissions_per_s: fissions, exposure_per_m2_s: exposure, poisonCapture_per_s: poison, rodOverlap: rod }
}

/** Physical admission is separate from finite signed numerical evaluation.
 * This is ADDITIONAL achieved fissions/F_reference since the immutable prepared
 * baseline, not the original preparation's spent fuel/history. The owner must
 * retain both and must not reset this allowance on a copy/restart. */
export function validateOperatingSourceAccepted(model: CompiledOperatingSource, neutrons: readonly number[], c: OperatingSourceConditions,
  maximumAdditionalCarrierReferenceExposure_s: number) {
  const p = model.coefficients, result = evaluateOperatingSource(model, neutrons, c)
  const within = (value: number, domain: readonly [number, number], label: string) => {
    if (!Number.isFinite(value) || value < domain[0] || value > domain[1]) throw Error('Outside HOT-SOURCE-1 ' + label)
  }
  if (neutrons.some(n => n < 0) || c.xenonAtoms.some(n => n < 0) || c.samariumAtoms.some(n => n < 0) || c.capsuleAge_s < 0 ||
    !Number.isFinite(maximumAdditionalCarrierReferenceExposure_s) || maximumAdditionalCarrierReferenceExposure_s < 0 ||
    maximumAdditionalCarrierReferenceExposure_s > p.maximumReferenceFissionExposure_s ||
    c.captureLossChange_m2.some((delta, a) => model.construction.referenceNonpoisonCaptureOpacity_m2[a]! + delta < 0))
    throw Error('Invalid accepted source inventory/history')
  c.fuelTemperature_K.forEach(t => within(t, p.fuelDomain_K, 'fuel temperature'))
  c.achievedRodTravel_m.forEach(t => within(t, [0, model.construction.absorber.normalTravel_m], 'achieved rod travel'))
  c.fissileAtoms.forEach((n, a) => within(n / model.fissileReferenceAtoms[a]!, p.fissileRatioDomain, 'fissile inventory'))
  c.waterDensity_kg_m3.forEach((rho, i) => {
    within(rho / model.reference.conditions.waterDensity_kg_m3[i]!, p.densityRatioDomain, 'water density')
    within(c.boron_ppmEq[i]!, p.boronDomain_ppmEq, 'boron')
    within(c.pressure_Pa[i]!, p.pressureDomain_Pa, 'pressure')
    within(c.moderatorTemperature_K[i]!, p.moderatorDomain_K, 'moderator temperature')
    within(result.inputs.regions[i]!.reactivity, p.reactivityDomain, 'local net-generation coefficient')
  })
  return result
}
