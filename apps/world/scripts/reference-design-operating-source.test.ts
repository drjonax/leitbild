import { describe, expect, test } from 'bun:test'
import { fuelAssemblyPositions } from './reference-design-fuel-handling'
import { compileOperatingMapping, type OperatingMappingInput } from './reference-design-operating-mapping'
import { prepareOperatingEnergy, type OperatingEnergyCoefficients } from './reference-design-operating-energy'
import type { DecayHistoryRecord } from './reference-design-decay-history'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareOperatingHot } from './reference-design-operating-hot'
import { compileOperatingPostTripDomain, compileOperatingSource, evaluateOperatingSource, operatingPostTripDomainNative, operatingReferenceFissions,
  operatingSourceDirection, operatingSourceNativeMetadata, operatingSourceFreshFuelAtoms, parseOperatingPostTripDomain, parseOperatingSource,
  validateOperatingSourceAccepted,
  type OperatingSourceCoefficients, type OperatingSourceConditions, type OperatingSourceConstruction, type OperatingSourceDirection } from './reference-design-operating-source'

// Literal original construction; neither fine-field preparation nor an imported
// nominal coarse fixture supplies this source's actual pin incidence.
const fuel: OperatingMappingInput['fuel'] = {
  assemblies: 193, latticeSide: 17, rodsPerAssembly: 264, guidesPerAssembly: 25, pitch_m: .0126,
  rodOuterDiameter_m: .0095, cladThickness_m: .00057, pelletDiameter_m: .0082, guideOuterDiameter_m: .0122,
  activeLength_m: 4, fuelDensityFraction: .95, fuelTheoreticalDensity_kg_m3: 10960, cladDensity_kg_m3: 6551,
}
const handling: OperatingMappingInput['handling'] = { slotRadiusSquared: 61, seatedBottom_m: -2.25, bottomFittingLength_m: .25 }
const partition: OperatingMappingInput['partition'] = {
  quadrants: [
    { id: 'NE', x0_m: 0, x1_m: 1.85, y0_m: 0, y1_m: 1.85 },
    { id: 'NW', x0_m: -1.85, x1_m: 0, y0_m: 0, y1_m: 1.85 },
    { id: 'SW', x0_m: -1.85, x1_m: 0, y0_m: -1.85, y1_m: 0 },
    { id: 'SE', x0_m: 0, x1_m: 1.85, y0_m: -1.85, y1_m: 0 },
  ], axialBounds_m: [-2, -4 / 3, -2 / 3, 0, 2 / 3, 4 / 3, 2],
}
const poses = fuelAssemblyPositions(handling, fuel).map(fa => ({ faId: fa.id, x_m: fa.x_m, y_m: fa.y_m, bottom_m: handling.seatedBottom_m }))
const mapping = compileOperatingMapping({ fuel, handling, partition, poses })
const p: OperatingSourceCoefficients = {
  identity: 'LD01-HOT-SOURCE-1', generationTime_s: .00002, nuEffective: 2.43,
  delayedFractions: [.00021, .00142, .00127, .00257, .00075, .00027], delayedHalfLives_s: [55.7, 22.7, 6.2, 2.3, .61, .23],
  radialTransfer_per_s: 500, axialTransfer_per_s: 1000, referenceFissions_per_s: 93622636116911440000,
  rodWorth: .10, doppler_pcm_sqrtK: -115, waterWorth: .15, boron_pcm_ppmEq: -8,
  fissileHeavyMassFraction: .045, u235MolarMass_kg_mol: .2350439299, u238MolarMass_kg_mol: .2380507884,
  oxygenMolarMass_kg_mol: .015999, avogadro_per_mol: 6.02214076e23,
  effectiveFission_barn: 100, effectiveXeCapture_barn: 2000000, effectiveSmCapture_barn: 40000,
  directIodine_per_fission: .06, directXenon_per_fission: .003, directPromethium_per_fission: .01,
  iodineHalfLife_s: 23652, xenonHalfLife_s: 32760, promethiumHalfLife_s: 191160,
  capsuleBirths_per_s: 4e9, capsuleHalfLife_s: 83469852, sourceEquivalentPerNeutron: 1,
  fuelDomain_K: [500, 1800], moderatorDomain_K: [550, 610], pressureDomain_Pa: [14e6, 16e6],
  densityRatioDomain: [.85, 1.1], boronDomain_ppmEq: [0, 2500], fissileRatioDomain: [.95, 1], reactivityDomain: [-.30, .15],
  maximumReferenceFissionExposure_s: 172800, couplingSensitivity: [.5, 1, 2],
  generationTimeSensitivity_s: [.00001, .00002, .00004], delayedFractionSensitivity: [.9, 1, 1.1],
  rodWorthSensitivity: [.07, .10, .13], dopplerSensitivity_pcm_sqrtK: [-90, -115, -140], absorptionSensitivity: [.5, 1, 2],
}
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0)
const increment = (values: number[], index: number, amount: number) => { values[index] = values[index]! + amount }
const fresh = operatingSourceFreshFuelAtoms(mapping, p)
const construction: OperatingSourceConstruction = {
  assemblyPitch_m: 17 * fuel.pitch_m, sourceZ_m: -1, referenceRodTravel_m: 2.8,
  referenceFissileAtoms: fresh.fissile.map(n => .98 * n),
  referencePoisonInventories: { iodineAtoms: Array(386).fill(3e21), xenonAtoms: Array(386).fill(2e20),
    promethiumAtoms: Array(386).fill(2e21), samariumAtoms: Array(386).fill(1e21) },
  referenceNonpoisonCaptureOpacity_m2: fresh.fertile.map(n => 4e-28 * .999 * n),
  absorber: { clusters: 52, rodletsPerCluster: 24, absorberDiameter_m: .0085,
    insertedActiveBottom_m: -2, activeLength_m: 4, normalTravel_m: 4 },
}
const referenceThermo = {
  fuelTemperature_K: Array(386).fill(850), waterDensity_kg_m3: mapping.regions.map(r => r.axialBand < 3 ? 715.3052293172567 : 679.3368894359069),
  moderatorTemperature_K: mapping.regions.map(r => r.axialBand < 3 ? 578.15 : 593.15),
  pressure_Pa: Array(24).fill(15.2e6), boron_ppmEq: Array(24).fill(1000),
}
const model = compileOperatingSource(mapping, p, construction, referenceThermo)

test('native metadata exports the existing immutable source, not a recalibration',()=>{
  const m=operatingSourceNativeMetadata(model)
  expect(m.regions).toHaveLength(24);expect(m.materials).toHaveLength(386)
  expect(m.supports).toHaveLength(model.supports.length)
  expect(m.regions.map(r=>r.rho_base)).toEqual(model.rhoBase)
  expect(m.supports.map(s=>s.production_reference_per_s)).toEqual(model.productionReference)
  expect(m.regions.every(r=>Math.abs(sum(r.rod_weights)-1)<1e-14)).toBe(true)
})

const actualWiki=process.env.LD01_WIKI_ROOT,actualIf97=process.env.LD01_IF97_DIRECTORY,
  nativeSourceTest=process.env.LD01_OPERATING_SOURCE_TEST
test.skipIf(!actualWiki||!actualIf97||!nativeSourceTest)('actual current-source native value and direction match the consumed TS owner',async()=>{
  const hot=await prepareOperatingHot(actualWiki!,actualIf97!,{kind:'provisional'}),m=hot.compiledSource,
    current=structuredClone(m.reference.conditions) as MutableConditions,
    d=Object.fromEntries(Object.entries(current).map(([k,v])=>[k,Array.isArray(v)?v.map(()=>0):0])) as MutableConditions,
    names={fuelTemperature_K:'fuel_temperature_k',waterDensity_kg_m3:'water_density_kg_m3',boron_ppmEq:'boron_ppm_eq',
      pressure_Pa:'pressure_pa',moderatorTemperature_K:'moderator_temperature_k',fissileAtoms:'fissile_atoms',
      xenonAtoms:'xenon_atoms',samariumAtoms:'samarium_atoms',captureLossChange_m2:'capture_loss_change_m2',
      achievedRodTravel_m:'achieved_rod_travel_m',capsuleAge_s:'capsule_age_s'},
    snake=(c:OperatingSourceConditions)=>Object.fromEntries(Object.entries(c).map(([k,v])=>[names[k as keyof typeof names],v])),
    zeroN=m.reference.neutrons.map(()=>0),
    make=(name:string,c:MutableConditions,direction:MutableConditions,neutrons:number[],dn:number[])=>({name,
      neutrons,d_neutrons:dn,conditions:snake(c),d_conditions:snake(direction),
      expected:evaluateOperatingSource(m,neutrons,c),expected_direction:operatingSourceDirection(m,neutrons,c,dn,direction)})
  const cases=[make('actual prepared reference',structuredClone(current),structuredClone(d),[...m.reference.neutrons],zeroN)]
  // Finite, nonuniform perturbations exercise every feedback owner together.
  // These are test excitations, not new plant coefficients or forcing tables.
  current.fuelTemperature_K.forEach((_,a)=>{current.fuelTemperature_K[a]!+=10+a%7;d.fuelTemperature_K[a]=.3+(a%3)*.1
    current.fissileAtoms[a]!*=.999;d.fissileAtoms[a]=current.fissileAtoms[a]!*.0001
    current.xenonAtoms[a]!*=1.03;d.xenonAtoms[a]=current.xenonAtoms[a]!*.001
    current.samariumAtoms[a]!*=1.02;d.samariumAtoms[a]=current.samariumAtoms[a]!*.002
    current.captureLossChange_m2[a]=m.construction.referenceNonpoisonCaptureOpacity_m2[a]!*.0002
    d.captureLossChange_m2[a]=m.construction.referenceNonpoisonCaptureOpacity_m2[a]!*.00001})
  current.waterDensity_kg_m3.forEach((_,i)=>{current.waterDensity_kg_m3[i]!*=.998;d.waterDensity_kg_m3[i]=.05
    // Fixed local boron amount at fixed volume: ppm changes inversely withrho.
    current.boron_ppmEq[i]!/= .998;d.boron_ppmEq[i]=-current.boron_ppmEq[i]!*.05/current.waterDensity_kg_m3[i]!
    current.pressure_Pa[i]!+=1000;d.pressure_Pa[i]=100
    current.moderatorTemperature_K[i]!+=.2;d.moderatorTemperature_K[i]=.01})
  current.achievedRodTravel_m.forEach((_,i)=>{current.achievedRodTravel_m[i]!+=.015+(i%3)*.001;d.achievedRodTravel_m[i]=.0002})
  current.capsuleAge_s=60;d.capsuleAge_s=1
  cases.push(make('current coupled feedback and fixed-amount boron',current,d,
    m.reference.neutrons.map((n,i)=>n*(1+(i%3)*.002)),m.reference.neutrons.map(n=>n*.0001)))
  const work=await mkdtemp(join(tmpdir(),'ld01-current-source-'))
  try {
    const path=join(work,'packet.json');await Bun.write(path,JSON.stringify({metadata:operatingSourceNativeMetadata(m),cases}))
    const child=Bun.spawn([nativeSourceTest!,'--ignored','--nocapture'],{env:{...process.env,LD01_OPERATING_SOURCE_PACKET:path},stdout:'pipe',stderr:'pipe'}),
      [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
    if(code!==0)throw Error(err+out);expect(out).toContain('1 passed');console.log(err.trim())
  } finally {await rm(work,{recursive:true,force:true})}
},120000)
type MutableConditions = { [K in keyof OperatingSourceConditions]: OperatingSourceConditions[K] extends readonly number[] ? number[] : number }
const conditions = (): MutableConditions => structuredClone(model.reference.conditions) as MutableConditions
const zeroDirection = (): MutableConditions => ({
  fuelTemperature_K: Array(386).fill(0), waterDensity_kg_m3: Array(24).fill(0), boron_ppmEq: Array(24).fill(0),
  moderatorTemperature_K: Array(24).fill(0), pressure_Pa: Array(24).fill(0), achievedRodTravel_m: Array(52).fill(0),
  fissileAtoms: Array(386).fill(0), xenonAtoms: Array(386).fill(0), samariumAtoms: Array(386).fill(0),
  captureLossChange_m2: Array(386).fill(0), capsuleAge_s: 0,
})
const closeRelative = (actual: number, expected: number, tolerance = 1e-11, scale = 1) =>
  expect(Math.abs(actual - expected) / Math.max(scale, Math.abs(expected))).toBeLessThan(tolerance)
const shift = (c: OperatingSourceConditions, d: OperatingSourceDirection, h: number): OperatingSourceConditions => {
  const value = structuredClone(c)
  for (const key of Object.keys(value) as (keyof OperatingSourceConditions)[]) {
    if (key === 'capsuleAge_s') value[key] += h * d[key]
    else value[key] = value[key].map((x, i) => x + h * d[key][i]!)
  }
  return value
}
const flattened = (r: ReturnType<typeof evaluateOperatingSource>) => [
  ...r.inputs.regions.flatMap(i => [i.reactivity, i.external_source_per_s]), ...r.inputs.transfer_rates_per_s,
  ...r.inputs.fissions_per_population_s, ...r.inputs.emission_fractions, ...r.inputs.outside_fractions,
  ...r.carrierFissions_per_s, ...r.exposure_per_m2_s, ...r.poisonCapture_per_s.flatMap(i => [i.xenon, i.samarium]), ...r.rodOverlap,
]

describe('D3 (a) post-trip domain extension', () => {
  const block = { densityRatioMax: 1.125, pressureMin_Pa: 12500000, shutdownMarginMin_dk_k: 0.01, marginWaterTermFactor: 2,
    extrapolationSensitivity: [0.5, 1, 2] }
  const page = (d: object) => '```reference-operating-source\n' + JSON.stringify(p) + '\n```\n\n```ld01-post-trip-domain\n' + JSON.stringify(d) + '\n```\n'
  test('one strict block widens only the density-ratio and pressure domains and crosses to the native Extension', () => {
    expect(parseOperatingPostTripDomain(page(block), p)).toEqual(block as never)
    expect(operatingPostTripDomainNative(parseOperatingPostTripDomain(page(block), p))).toEqual({ density_ratio_maximum: 1.125,
      pressure_minimum_pa: 12500000, shutdown_margin_minimum: 0.01, margin_water_term_factor: 2, extrapolation_sensitivity: [0.5, 1, 2] })
    expect(() => parseOperatingPostTripDomain(page(block) + page(block), p)).toThrow('one')
    expect(() => parseOperatingPostTripDomain('```reference-operating-source\n' + JSON.stringify(p) + '\n```\n', p)).toThrow('one')
    expect(() => parseOperatingPostTripDomain(page({ ...block, extra: 1 }), p)).toThrow()
    expect(() => parseOperatingPostTripDomain(page({ ...block, densityRatioMax: 1.09 }), p)).toThrow('widen')
    expect(() => parseOperatingPostTripDomain(page({ ...block, pressureMin_Pa: 14.5e6 }), p)).toThrow('widen')
    expect(() => parseOperatingPostTripDomain(page({ ...block, shutdownMarginMin_dk_k: 0 }), p)).toThrow()
    expect(() => parseOperatingPostTripDomain(page({ ...block, marginWaterTermFactor: 0.5 }), p)).toThrow('weaken')
    expect(() => parseOperatingPostTripDomain(page({ ...block, extrapolationSensitivity: [1, 1, 2] }), p)).toThrow('sensitivity')
  })
  test.skipIf(!process.env.LD01_WIKI_ROOT)('the actual kinetics owner page compiles the joined packet section', async () => {
    expect(await compileOperatingPostTripDomain(process.env.LD01_WIKI_ROOT!)).toEqual({ density_ratio_maximum: 1.125,
      pressure_minimum_pa: 12500000, shutdown_margin_minimum: 0.01, margin_water_term_factor: 2, extrapolation_sensitivity: [0.5, 1, 2] })
  })
})

describe('authored hot operating source', () => {
  test('one strict consumed owner block and explicit current material references are mandatory', () => {
    const document = '```reference-operating-source\n' + JSON.stringify(p) + '\n```\n'
    expect(parseOperatingSource(document)).toEqual(p)
    expect(() => parseOperatingSource(document + document)).toThrow('one')
    expect(() => parseOperatingSource(document.replace('"nuEffective":2.43', '"nuEffective":0.9'))).toThrow('offspring')
    expect(() => parseOperatingSource(document.replace('"identity"', '"extra":1,"identity"'))).toThrow()
    expect(() => compileOperatingSource(mapping, p, { ...construction, referenceFissileAtoms: [] }, referenceThermo)).toThrow('fissile')
    expect(() => compileOperatingSource(mapping, p, { ...construction, referenceFissileAtoms: fresh.fissile.map(n => n * 1.001) }, referenceThermo)).toThrow('fissile')
    expect(() => compileOperatingSource(mapping, p, { ...construction, referenceNonpoisonCaptureOpacity_m2: Array(386).fill(1e9) }, referenceThermo)).toThrow('negative leakage')
    expect(() => compileOperatingSource(mapping, p, { ...construction, referenceRodTravel_m: -1 }, referenceThermo)).toThrow('construction')
    expect(() => compileOperatingSource(mapping, p, { ...construction, referenceRodTravel_m: NaN }, referenceThermo)).toThrow('construction')
  })

  test('actual 193 fuel identities compile one 2340-state bank, 1344 supports and 88 literal transfers', () => {
    expect(model.materials).toHaveLength(386); expect(model.regions).toHaveLength(24)
    expect(model.supports).toHaveLength(1344); expect(model.transfers).toHaveLength(88)
    expect(model.reference.precursors).toHaveLength(2316)
    expect(new Set(model.transfers.map(e => `${e.donor}/${e.receiver}`)).size).toBe(88)
    model.transfers.forEach((e, k) => {
      expect(model.baseInputs.transfer_rates_per_s[k]).toBe(Math.floor(e.donor / 6) === Math.floor(e.receiver / 6) ? 1000 : 500)
      expect(model.transfers.some(f => f.donor === e.receiver && f.receiver === e.donor)).toBe(true)
    })
    const shape = operatingReferenceFissions(mapping, p)
    closeRelative(sum(shape.regions), p.referenceFissions_per_s)
    closeRelative(sum(shape.carriers), p.referenceFissions_per_s)
    model.reference.carrierFissions_per_s.forEach((f, a) => closeRelative(f, shape.carriers[a]!))
    expect(model.fissileReferenceAtoms).toEqual([...construction.referenceFissileAtoms])
    expect(model.originalFertileAtoms).toEqual(fresh.fertile) // original basis, not current prepared stock
  })

  test('one immutable source-off reference closes all regional/material balances and the neutron number budget', () => {
    const c = conditions(), evaluated = evaluateOperatingSource(model, model.reference.neutrons, c),
      nRate = model.reference.neutrons.map((n, i) => evaluated.inputs.regions[i]!.reactivity * n / p.generationTime_s),
      cRate = Array(2316).fill(0) as number[]
    mapping.intersections.forEach((edge, k) => {
      model.materials[edge.carrier]!.delayed_yields_per_fission.forEach((nu, g) => {
        const birth = nu * evaluated.inputs.fissions_per_population_s[k]! * model.reference.neutrons[edge.region]!,
          emission = model.materials[edge.carrier]!.decay_constants_per_s[g]! * model.reference.precursors[edge.carrier * 6 + g]!
        nRate[edge.region] = nRate[edge.region]! - birth + evaluated.inputs.emission_fractions[k]! * emission
        cRate[edge.carrier * 6 + g] = cRate[edge.carrier * 6 + g]! + birth
      })
    })
    model.transfers.forEach((e, k) => {
      const amount = evaluated.inputs.transfer_rates_per_s[k]! * model.reference.neutrons[e.donor]!
      nRate[e.donor] = nRate[e.donor]! - amount; nRate[e.receiver] = nRate[e.receiver]! + amount
    })
    cRate.forEach((v, k) => {
      const lambda = model.materials[Math.floor(k / 6)]!.decay_constants_per_s[k % 6]!
      closeRelative(v - lambda * model.reference.precursors[k]!, 0, 1e-13, p.referenceFissions_per_s)
    })
    nRate.forEach(v => closeRelative(v, 0, 1e-13, p.referenceFissions_per_s))
    expect(model.rhoBase.some(v => Math.abs(v) > 1e-4)).toBe(true) // W/P changes the axial reference
    expect(model.referenceLeakage_per_s.every(v => v > 0)).toBe(true)
    closeRelative(1 + model.referenceNumberBudget.captures_per_fission + model.referenceNumberBudget.leakage_per_fission, p.nuEffective)
    expect(sum(evaluated.inputs.regions.map(r => r.external_source_per_s))).toBe(4e9)
    // Actual S is a nonsteady receipt, never subtracted by reference calibration.
    expect(model.baseInputs.regions.map(r => r.reactivity)).toEqual(model.rhoBase)
  })

  test('actual 52 achieved overlaps are normalized once and one jam remains local', () => {
    expect(model.rods).toHaveLength(52); expect(new Set(model.rods.map(r => r.faId)).size).toBe(52)
    const c = conditions(); c.achievedRodTravel_m.fill(0)
    const inserted = evaluateOperatingSource(model, model.reference.neutrons, c)
    inserted.rodOverlap.forEach(v => closeRelative(v, 1))
    const reference = evaluateOperatingSource(model, model.reference.neutrons, conditions())
    inserted.inputs.regions.forEach((r, i) => closeRelative(r.reactivity - model.rhoBase[i]!, -.1 * (1 - reference.rodOverlap[i]!)))
    c.achievedRodTravel_m.fill(4)
    evaluateOperatingSource(model, model.reference.neutrons, c).rodOverlap.forEach(v => expect(v).toBe(0))
    const localRod = model.rods.findIndex(r => r.x_m > .1 && r.y_m > .1)
    c.achievedRodTravel_m[localRod] = 0
    const jam = evaluateOperatingSource(model, model.reference.neutrons, c)
    expect(jam.rodOverlap.some(v => v > 0)).toBe(true)
    jam.rodOverlap.forEach((v, i) => { if (mapping.regions[i]!.sector !== 0) expect(v).toBe(0) })
    expect(Math.max(...jam.rodOverlap)).toBeLessThan(.1)
    // No all-inserted shutdown outcome is prescribed by this static coupon.
  })

  test('fissions, finite-target loss and Xe/Sm burnoff consume the same exposure without resetting production', () => {
    const c = conditions(), a = 100; c.fissileAtoms[a] = c.fissileAtoms[a]! * .97; c.xenonAtoms[a] = c.xenonAtoms[a]! * 1.1; c.samariumAtoms[a] = c.samariumAtoms[a]! * 1.2
    c.captureLossChange_m2[a] = 3e-4
    const result = evaluateOperatingSource(model, model.reference.neutrons, c)
    closeRelative(result.carrierFissions_per_s[a]!, model.sigmaF_m2 * result.exposure_per_m2_s[a]! * c.fissileAtoms[a]!)
    closeRelative(result.carrierFissions_per_s[a]!, .97 * model.reference.carrierFissions_per_s[a]!)
    closeRelative(result.exposure_per_m2_s[a]!, model.reference.exposure_per_m2_s[a]!)
    closeRelative(result.poisonCapture_per_s[a]!.xenon, model.sigmaXe_m2 * result.exposure_per_m2_s[a]! * c.xenonAtoms[a]!)
    closeRelative(result.poisonCapture_per_s[a]!.samarium, model.sigmaSm_m2 * result.exposure_per_m2_s[a]! * c.samariumAtoms[a]!)
    const expected = Array(24).fill(0) as number[]
    mapping.intersections.forEach((e, k) => {
      if (e.carrier !== a) return
      increment(expected, e.region, p.generationTime_s * ((p.nuEffective - 1) * -.03 * model.productionReference[k]! -
        model.exposurePerPopulation_s_m2[k]! * (3e-4 + model.sigmaXe_m2 * .1 * model.reference.xenonAtoms[a]! + model.sigmaSm_m2 * .2 * model.reference.samariumAtoms[a]!)))
    })
    result.inputs.regions.forEach((r, i) => closeRelative(r.reactivity - model.rhoBase[i]!, expected[i]!, 2e-13))
  })

  test('fuel, boron and water partials keep their distinct stated physical signs', () => {
    const c = conditions(); c.fuelTemperature_K.fill(1000)
    const hot = evaluateOperatingSource(model, model.reference.neutrons, c)
    hot.inputs.regions.forEach((r, i) => closeRelative(r.reactivity - model.rhoBase[i]!, -115e-5 * (Math.sqrt(1000) - Math.sqrt(850))))
    const d = zeroDirection(); d.boron_ppmEq.fill(1)
    operatingSourceDirection(model, model.reference.neutrons, conditions(), Array(24).fill(0), d).inputs.regions.forEach(r => closeRelative(r.reactivity, -8e-5))
    const water = zeroDirection(); water.waterDensity_kg_m3 = [...referenceThermo.waterDensity_kg_m3]
    operatingSourceDirection(model, model.reference.neutrons, conditions(), Array(24).fill(0), water).inputs.regions.forEach(r => closeRelative(r.reactivity, .15 - 8e-5 * 1000))
  })

  test('declared coefficient challenges remain evaluable immutable alternate source configurations', () => {
    const alternatives: OperatingSourceCoefficients[] = [
      ...p.couplingSensitivity.map(scale => ({ ...p, radialTransfer_per_s: 500 * scale, axialTransfer_per_s: 1000 * scale })),
      ...p.generationTimeSensitivity_s.map(generationTime_s => ({ ...p, generationTime_s })),
      ...p.delayedFractionSensitivity.map(scale => ({ ...p, delayedFractions: p.delayedFractions.map(beta => scale * beta) as OperatingSourceCoefficients['delayedFractions'] })),
      ...p.rodWorthSensitivity.map(rodWorth => ({ ...p, rodWorth })),
      ...p.dopplerSensitivity_pcm_sqrtK.map(doppler_pcm_sqrtK => ({ ...p, doppler_pcm_sqrtK })),
      ...p.absorptionSensitivity.map(scale => ({ ...p, effectiveXeCapture_barn: 2e6 * scale, effectiveSmCapture_barn: 4e4 * scale })),
    ]
    alternatives.forEach(coefficients => {
      const changed = compileOperatingSource(mapping, coefficients, construction, referenceThermo), c = structuredClone(changed.reference.conditions)
      c.fuelTemperature_K = Array(386).fill(1000); c.achievedRodTravel_m = Array(52).fill(3)
      const response = evaluateOperatingSource(changed, changed.reference.neutrons, c)
      expect(changed.referenceLeakage_per_s.every(v => v >= 0)).toBe(true)
      expect(response.inputs.regions.every(r => Number.isFinite(r.reactivity))).toBe(true)
      closeRelative(1 + changed.referenceNumberBudget.captures_per_fission + changed.referenceNumberBudget.leakage_per_fission, p.nuEffective)
    })
    // This checks availability and accounting, not that a preferred response
    // wins an operating scenario; no alternate replaces a running event's p.
    expect(model.coefficients).toEqual(p)
  })

  test('complete analytic directions agree with independent signed centred evaluation away from overlap knots', () => {
    const c = conditions(), d = zeroDirection(), n = model.reference.neutrons.map((v, i) => v * (1 + .01 * Math.sin(i))),
      dn = n.map((v, i) => .07 * v * Math.cos(i))
    c.achievedRodTravel_m = model.rods.map((_, i) => 2.71 + .01 * Math.sin(i)); c.capsuleAge_s = 1e6
    d.achievedRodTravel_m = model.rods.map((_, i) => .03 * Math.cos(i)); d.capsuleAge_s = 1e6
    d.fuelTemperature_K = mapping.carriers.map((_, i) => 10 * Math.cos(i))
    d.fissileAtoms = c.fissileAtoms.map((v, i) => .001 * v * Math.sin(i))
    d.xenonAtoms = c.xenonAtoms.map((v, i) => .1 * v * Math.cos(i))
    d.samariumAtoms = c.samariumAtoms.map((v, i) => .07 * v * Math.sin(i))
    d.captureLossChange_m2 = mapping.carriers.map((_, i) => 1e-4 * Math.sin(i))
    d.waterDensity_kg_m3 = referenceThermo.waterDensity_kg_m3.map((v, i) => .01 * v * Math.sin(i))
    d.boron_ppmEq = mapping.regions.map((_, i) => 10 * Math.cos(i))
    const h = 1e-3, exact = flattened(operatingSourceDirection(model, n, c, dn, d)),
      plus = flattened(evaluateOperatingSource(model, n.map((v, i) => v + h * dn[i]!), shift(c, d, h))),
      minus = flattened(evaluateOperatingSource(model, n.map((v, i) => v - h * dn[i]!), shift(c, d, -h)))
    exact.forEach((v, i) => closeRelative((plus[i]! - minus[i]!) / (2 * h), v, 2e-5, 1e-6))
  })

  test('achieved overlap cuts have an explicit right derivative, not a fictitious centred tangent', () => {
    const c = conditions(), d = zeroDirection(); c.achievedRodTravel_m.fill(2); d.achievedRodTravel_m.fill(1)
    const base = evaluateOperatingSource(model, model.reference.neutrons, c), exact = operatingSourceDirection(model, model.reference.neutrons, c, Array(24).fill(0), d),
      h = 1e-6, plus = evaluateOperatingSource(model, model.reference.neutrons, shift(c, d, h))
    exact.rodOverlap.forEach((v, i) => closeRelative((plus.rodOverlap[i]! - base.rodOverlap[i]!) / h, v, 1e-8))
  })

  test('signed Newton trials are not clipped and accepted states enforce physical and since-reference limits', () => {
    const c = conditions(), n = model.reference.neutrons.map(v => -v); c.xenonAtoms[0] = -1e20; c.fissileAtoms[0] = -1e24
    expect(evaluateOperatingSource(model, n, c).exposure_per_m2_s.some(v => v < 0)).toBe(true)
    expect(() => validateOperatingSourceAccepted(model, n, c, 0)).toThrow('inventory')
    expect(() => validateOperatingSourceAccepted(model, model.reference.neutrons, conditions(), 172801)).toThrow('history')
    const badOpacity = conditions(); badOpacity.captureLossChange_m2[0] = -2 * construction.referenceNonpoisonCaptureOpacity_m2[0]!
    expect(() => validateOperatingSourceAccepted(model, model.reference.neutrons, badOpacity, 0)).toThrow('inventory')
    const badFuel = conditions(); badFuel.fuelTemperature_K[0] = 0
    expect(() => evaluateOperatingSource(model, model.reference.neutrons, badFuel)).toThrow('unavailable')
    const half = conditions(); half.capsuleAge_s = p.capsuleHalfLife_s
    closeRelative(sum(evaluateOperatingSource(model, model.reference.neutrons, half).inputs.regions.map(r => r.external_source_per_s)), 2e9)
    // 0 means no ADDITIONAL operational exposure since the current prepared
    // stock, never that the 30d preparation had zero fissions or spent history.
    expect(() => validateOperatingSourceAccepted(model, model.reference.neutrons, conditions(), 172800)).not.toThrow()
  })

  test('moving/partial fuel, wrong ring order and unsupported source support are not admitted as hot coefficients', () => {
    const partial = compileOperatingMapping({ fuel, handling, partition, poses: poses.map((r, i) => i === 0 ? { ...r, bottom_m: -.75 } : r) })
    expect(() => compileOperatingSource(partial, p, construction, referenceThermo)).toThrow('full seated')
    expect(() => compileOperatingSource(mapping, p, { ...construction, sourceZ_m: 3 }, referenceThermo)).toThrow('source support')
    const wrong = structuredClone(mapping); [wrong.regions[6], wrong.regions[12]] = [wrong.regions[12]!, wrong.regions[6]!]
    expect(() => compileOperatingSource(wrong, p, construction, referenceThermo)).toThrow('region order')
  })
})

const energyCoefficients: OperatingEnergyCoefficients = {
  identity: 'LD01-HOT-ENERGY-1', preparationDuration_s: 2592000,
  fertileCapture_barn: 4, fertileBinding_MeV: 4.8063822, xenonBinding_MeV: 8.0871234, samariumBinding_MeV: 7.9867556,
  bindingCoolantFraction: .1, bindingCoolantSensitivity: [0, .1, .2],
  promptFissionCoolantFraction: .02, promptFissionCoolantSensitivity: [0, .02, .04],
}
// Deliberately independent positive history coefficients; actual owner-data
// replay is a separate package check, not this synthetic conservation fixture.
const history: DecayHistoryRecord = {
  fissionEnergy_MeV: 190, referenceFissionEnergy_MeV: 200,
  fissionProductAlpha_MeV_event_s: Array.from({ length: 23 }, (_, i) => .5 * .1 * 10 ** (-i / 3)),
  fissionProductLambda_s_inv: Array.from({ length: 23 }, (_, i) => .1 * 10 ** (-i / 3)),
  effectiveCaptureEnergy_MeV: [.625, .575], effectiveCaptureTimeConstants_s: [2040, 290000], referenceCaptureRatio: .8,
  fissionProductSensitivity: [.8, 1, 1.2], effectiveCaptureSensitivity: [0, .5, 1],
}
const energy = prepareOperatingEnergy(mapping, p, energyCoefficients, history)
const preparedSource = compileOperatingSource(mapping, p, { ...construction,
  referenceFissileAtoms: energy.carriers.map(c => c.fissileAtoms),
  referencePoisonInventories: { iodineAtoms: energy.carriers.map(c => c.iodineAtoms), xenonAtoms: energy.carriers.map(c => c.xenonAtoms),
    promethiumAtoms: energy.carriers.map(c => c.promethiumAtoms), samariumAtoms: energy.carriers.map(c => c.samariumAtoms) },
  referenceNonpoisonCaptureOpacity_m2: energy.carriers.map(c => 4e-28 * c.fertileAtoms),
}, referenceThermo)
describe('actual source / finite material / event-energy join', () => {
  test('30d prescribed exposure debits original targets and current G/H exactly reproduce the declared end-event rate', () => {
    closeRelative(energy.referenceFissions_per_s, p.referenceFissions_per_s)
    const evaluated = evaluateOperatingSource(preparedSource, preparedSource.reference.neutrons, preparedSource.reference.conditions)
    energy.carriers.forEach((c, a) => {
      closeRelative(c.fissileAtoms + c.spentFissions, c.originalFissileAtoms)
      closeRelative(c.fertileAtoms + c.captureProductAtoms, c.originalFertileAtoms)
      expect(c.fissileAtoms).toBeLessThan(c.originalFissileAtoms)
      expect(c.fertileAtoms).toBeLessThan(c.originalFertileAtoms)
      closeRelative(evaluated.carrierFissions_per_s[a]!, c.fissions_per_s)
      closeRelative(evaluated.exposure_per_m2_s[a]!, c.exposure_per_m2_s)
      closeRelative(c.fertileCaptures_per_s, 4e-28 * c.exposure_per_m2_s * c.fertileAtoms)
    })
    // Thirty days is retained preparation, not a reset of achieved spentF;
    // the additional operational allowance begins at this immutable baseline.
    expect(() => validateOperatingSourceAccepted(preparedSource, preparedSource.reference.neutrons, preparedSource.reference.conditions, 0)).not.toThrow()
    expect(sum(energy.carriers.map(c => c.spentFissions)) / p.referenceFissions_per_s).toBeGreaterThan(30 * 86400)
    expect(() => prepareOperatingEnergy(mapping, p, { ...energyCoefficients, preparationDuration_s: 600 * 86400 }, history)).toThrow('Infeasible')
  })

  test('finite six-group precursor and 25 heat stores are not silently overwritten by stationary values', () => {
    energy.carriers.forEach((c, a) => {
      expect(c.precursors).toHaveLength(6); expect(c.stores_J).toHaveLength(25)
      expect(c.precursors.every(v => v > 0)).toBe(true); expect(c.stores_J.every(v => v > 0)).toBe(true)
      c.precursors.forEach((value, g) => {
        expect(value).not.toBe(preparedSource.reference.precursors[a * 6 + g]!)
        // Exponentially decreasing feed means slow-burnup finite C can be
        // slightly above CURRENT stationary C; it is not forced stationary.
        expect(value).toBeGreaterThan(preparedSource.reference.precursors[a * 6 + g]!)
      })
      const slow = 22, group = energy.history.groups[slow]!
      expect(c.stores_J[slow]!).toBeLessThan(group.energy_J_per_event * c.fissions_per_s / group.lambda_s_inv)
    })
  })

  test('parent/daughter and captured target inventories close without an independent poison-worth inventory', () => {
    energy.carriers.forEach((c, a) => {
      const phi = c.exposure_per_m2_s, xeBurn = p.effectiveXeCapture_barn * 1e-28 * phi,
        xeDecayAtoms = c.xenonCaptureProductAtoms * (Math.LN2 / p.xenonHalfLife_s) / xeBurn
      closeRelative(c.iodineAtoms + c.xenonAtoms + c.xenonCaptureProductAtoms + xeDecayAtoms,
        (p.directIodine_per_fission + p.directXenon_per_fission) * c.spentFissions)
      closeRelative(c.promethiumAtoms + c.samariumAtoms + c.samariumCaptureProductAtoms, p.directPromethium_per_fission * c.spentFissions)
      closeRelative(c.xenonCaptures_per_s, preparedSource.sigmaXe_m2 * preparedSource.reference.exposure_per_m2_s[a]! * c.xenonAtoms)
      closeRelative(c.samariumCaptures_per_s, preparedSource.sigmaSm_m2 * preparedSource.reference.exposure_per_m2_s[a]! * c.samariumAtoms)
    })
    const c = structuredClone(preparedSource.reference.conditions) as MutableConditions, a = 100,
      deltaTarget = -.01 * energy.carriers[a]!.fertileAtoms
    c.captureLossChange_m2[a] = 4e-28 * deltaTarget
    const result = evaluateOperatingSource(preparedSource, preparedSource.reference.neutrons, c),
      neutronLossChange = sum(result.inputs.regions.map((r, i) => -(r.reactivity - preparedSource.rhoBase[i]!) / p.generationTime_s * preparedSource.reference.neutrons[i]!))
    closeRelative(neutronLossChange, 4e-28 * energy.carriers[a]!.exposure_per_m2_s * deltaTarget, 1e-10)
  })

  test('event energy and retained histories match exact actual fuel/coolant recipient budgets, not a3GW heater', () => {
    const joulesPerMeV = 1.602176634e-13
    energy.carriers.forEach(c => {
      const rateOfStores = sum(energy.history.groups.map((g, j) => g.energy_J_per_event *
        (g.feed === 'fission' ? c.fissions_per_s : c.fertileCaptures_per_s) - g.lambda_s_inv * c.stores_J[j]!)),
        eventBirth_W = history.fissionEnergy_MeV * joulesPerMeV * c.fissions_per_s +
          (energyCoefficients.fertileBinding_MeV + 1.2) * joulesPerMeV * c.fertileCaptures_per_s +
          energyCoefficients.xenonBinding_MeV * joulesPerMeV * c.xenonCaptures_per_s +
          energyCoefficients.samariumBinding_MeV * joulesPerMeV * c.samariumCaptures_per_s
      closeRelative(c.fuel_W + c.coolant_W + rateOfStores, eventBirth_W)
      closeRelative(c.fuel_W, .98 * c.promptFission_W + c.history_W + .9 * c.binding_W)
      closeRelative(c.coolant_W, .02 * c.promptFission_W + .1 * c.binding_W)
      const created_J = 190 * joulesPerMeV * c.spentFissions +
        (energyCoefficients.fertileBinding_MeV + 1.2) * joulesPerMeV * c.captureProductAtoms +
        joulesPerMeV * (energyCoefficients.xenonBinding_MeV * c.xenonCaptureProductAtoms +
          energyCoefficients.samariumBinding_MeV * c.samariumCaptureProductAtoms)
      closeRelative(c.preparationReleased_J + sum(c.stores_J), created_J)
    })
    closeRelative(sum(energy.coolantByRegion_W), sum(energy.carriers.map(c => c.coolant_W)))
    expect(energy.coolantExport_W).toBe(0)
    closeRelative(energy.totalDeposited_W, energy.totalFuel_W + energy.totalCoolant_W)
    expect(energy.totalDeposited_W).not.toBe(3e9)
  })
})

// Independent 24x24 Schur-complement period check: eliminate material C at
// trial s, retaining EACH actual W/G pair and lambda/(s+lambda). This is a
// bounded test oracle, not an integration service or inherited scalar inhour.
function periodResidual(s: number, deltaRho: number) {
  const matrix = Array.from({ length: 24 }, () => Array(24).fill(0) as number[])
  model.rhoBase.forEach((rho, i) => { matrix[i]![i] = (rho + deltaRho) / p.generationTime_s })
  model.transfers.forEach((e, k) => {
    increment(matrix[e.donor]!, e.donor, -model.baseInputs.transfer_rates_per_s[k]!)
    increment(matrix[e.receiver]!, e.donor, model.baseInputs.transfer_rates_per_s[k]!)
  })
  mapping.intersections.forEach((birth, k) => {
    const groups = model.materials[birth.carrier]!, g = model.productionReference[k]!
    increment(matrix[birth.region]!, birth.region, -sum(groups.delayed_yields_per_fission) * g)
    mapping.intersections.filter(emission => emission.carrier === birth.carrier).forEach(emission => {
      const response = sum(groups.decay_constants_per_s.map((lambda, j) => lambda / (s + lambda) * groups.delayed_yields_per_fission[j]!))
      increment(matrix[emission.region]!, birth.region, emission.uniformEmissionFraction * response * g)
    })
  })
  const diagonalShift = Math.max(...matrix.map((row, i) => -row[i]!)), shifted = matrix.map((row, i) => row.map((v, j) => v + (i === j ? diagonalShift : 0)))
  let vector = model.reference.neutrons.map(n => n / sum(model.reference.neutrons)), eigenvalue = 0
  for (let k = 0; k < 700; k++) {
    const next = shifted.map(row => sum(row.map((v, j) => v * vector[j]!))), scale = sum(next)
    vector = next.map(v => v / scale); eigenvalue = scale - diagonalShift
  }
  const residual = Math.max(...matrix.map((row, i) => Math.abs(sum(row.map((v, j) => v * vector[j]!)) - eigenvalue * vector[i]!)))
  return { value: eigenvalue - s, eigenvalue, vector, residual }
}
test('fixed-input actual material-return operator has independently checked signed long-period perturbations', () => {
  closeRelative(periodResidual(0, 0).value, 0, 1e-8)
  for (const delta of [-1e-4, 1e-4]) {
    let lo = -.99 * Math.min(...model.materials[0]!.decay_constants_per_s), hi = .1
    expect(periodResidual(lo, delta).value).toBeGreaterThan(0); expect(periodResidual(hi, delta).value).toBeLessThan(0)
    for (let k = 0; k < 45; k++) {
      const mid = (lo + hi) / 2
      if (periodResidual(mid, delta).value > 0) lo = mid; else hi = mid
    }
    const s = (lo + hi) / 2, result = periodResidual(s, delta)
    expect(Math.sign(s)).toBe(Math.sign(delta)); expect(result.vector.every(v => v > 0)).toBe(true)
    expect(Math.abs(result.value)).toBeLessThan(1e-8); expect(result.residual).toBeLessThan(1e-8)
  }
})
