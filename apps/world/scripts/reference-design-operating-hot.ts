/** Compose ONE current-owner input package and consume it in the standalone
 * native equations. Offline preparation only; no live installation/integrator. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseFuelConstruction } from './reference-design-fuel-construction'
import { parseFuelHandling, fuelAssemblyPositions } from './reference-design-fuel-handling'
import { parseControlAbsorber } from './reference-design-control-absorber'
import { parseDecayHistory } from './reference-design-decay-history'
import { compileOperatingMapping, type OperatingPartition } from './reference-design-operating-mapping'
import { compileOperatingSource, evaluateOperatingSource, parseOperatingSource } from './reference-design-operating-source'
import { parseOperatingEnergy, prepareOperatingEnergy } from './reference-design-operating-energy'
import { admitSolidNode, prepareOperatingFluid, preparePressureContinuity, steadySolidsSchema, type SolidPreparation } from './reference-design-operating-fluid'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const MeV_J = 1.602176634e-13
const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0)
const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 5e-12 * Math.max(Math.abs(a), Math.abs(b), 1e-100)

/** `solids` is the steady solid state (G18) or, only for the spine
 * compiler's settle input and for checks that do not read solid
 * temperatures, the explicit seed of that settle. */
export async function prepareOperatingHot(wiki: string, if97: string, solids: SolidPreparation) {
  const root = 'world/packs/process-plant/reference-designs/ld-01/',
    names = ['systems/reactor/fuel-construction.md', 'systems/reactor/fuel-handling-and-pool.md',
      'systems/reactor/control-absorber-and-guide-water.md', 'systems/reactor/kinetics.md', 'systems/reactor/heat-and-history.md'],
    docs = await Promise.all(names.map(name => Bun.file(join(wiki, root, name)).text())),
    fuel = parseFuelConstruction(docs[0]!), handling = parseFuelHandling(docs[1]!), absorber = parseControlAbsorber(docs[2]!),
    sourceCoefficients = parseOperatingSource(docs[3]!), energyCoefficients = parseOperatingEnergy(docs[4]!), history = parseDecayHistory(docs[4]!),
    radius = handling.supportRadius_m, bottom = handling.seatedBottom_m + handling.bottomFittingLength_m,
    partition: OperatingPartition = {
      quadrants: [
        { id: 'NE', x0_m: 0, x1_m: radius, y0_m: 0, y1_m: radius },
        { id: 'NW', x0_m: -radius, x1_m: 0, y0_m: 0, y1_m: radius },
        { id: 'SW', x0_m: -radius, x1_m: 0, y0_m: -radius, y1_m: 0 },
        { id: 'SE', x0_m: 0, x1_m: radius, y0_m: -radius, y1_m: 0 },
      ],
      axialBounds_m: [bottom, bottom + fuel.activeLength_m / 6, bottom + fuel.activeLength_m / 3,
        bottom + fuel.activeLength_m / 2, bottom + 2 * fuel.activeLength_m / 3,
        bottom + 5 * fuel.activeLength_m / 6, bottom + fuel.activeLength_m],
    },
    poses = fuelAssemblyPositions(handling, fuel).map(fa => ({ faId: fa.id, x_m: fa.x_m, y_m: fa.y_m, bottom_m: handling.seatedBottom_m })),
    mapping = compileOperatingMapping({ fuel, handling, partition, poses }),
    energy = prepareOperatingEnergy(mapping, sourceCoefficients, energyCoefficients, history),
    // Q normalizes only a diagnostic eventual-enthalpy flow. It is NOT injected
    // into current fluid Udot: finite fuel receives most of this current heat.
    fluid = await prepareOperatingFluid(wiki, if97, energy.totalDeposited_W, solids),
    // Each carrier's Doppler reference is its own steady nodes' law measure
    // (G18 role 2), matched by identity, never a material-level scalar.
    reference = new Map(fluid.materials.preparedCarriers.map(c => [c.id, c] as const)),
    carrierReference = (id: string) => { const c = reference.get(id); if (!c) throw Error('No prepared solid carrier ' + id); return c },
    coolant = fluid.primary.sourceBandToCoolant.map(index => fluid.primary.regions[index]!),
    referenceThermo = {
      fuelTemperature_K: energy.carriers.map(c => carrierReference(c.id).dopplerReference_K),
      waterDensity_kg_m3: coolant.map(r => r.water.rho), pressure_Pa: coolant.map(r => r.water.p),
      moderatorTemperature_K: coolant.map(r => r.water.T),
      boron_ppmEq: coolant.map(() => fluid.hotReference.boronReference_ppmEq),
    },
    source = compileOperatingSource(mapping, sourceCoefficients, {
      assemblyPitch_m: fuel.latticeSide * fuel.pitch_m, sourceZ_m: handling.sourceCapsule_m, absorber,
      referenceRodTravel_m: fluid.hotReference.achievedRodTravel_m,
      referenceFissileAtoms: energy.carriers.map(c => c.fissileAtoms),
      referenceNonpoisonCaptureOpacity_m2: energy.carriers.map(c => energyCoefficients.fertileCapture_barn * 1e-28 * c.fertileAtoms),
      referencePoisonInventories: {
        iodineAtoms: energy.carriers.map(c => c.iodineAtoms), xenonAtoms: energy.carriers.map(c => c.xenonAtoms),
        promethiumAtoms: energy.carriers.map(c => c.promethiumAtoms), samariumAtoms: energy.carriers.map(c => c.samariumAtoms),
      },
    }, referenceThermo),
    achieved = evaluateOperatingSource(source, source.reference.neutrons, source.reference.conditions)
  // The feedback law's own domain admits every fuel node it can read.
  for (const c of fluid.materials.preparedCarriers) for (const n of c.fuelNodes)
    admitSolidNode(`${c.id}/fuel/${n.radial}`, n.temperature_K, sourceCoefficients.fuelDomain_K)
  for (const [a, c] of energy.carriers.entries()) {
    if (!close(c.fissions_per_s, achieved.carrierFissions_per_s[a]!) || !close(c.exposure_per_m2_s, achieved.exposure_per_m2_s[a]!))
      throw Error('Compiled hot source disagrees with finite material preparation: ' + c.id)
  }
  const directCoolantHeat_W = fluid.primary.regions.map(() => 0)
  for (const [i, heat] of energy.coolantByRegion_W.entries()) directCoolantHeat_W[fluid.primary.sourceBandToCoolant[i]!]! += heat
  const directCoolantPressurePreparation = preparePressureContinuity(fluid.primary.regions, fluid.primary.edges,
    directCoolantHeat_W, fluid.primary.regions.map(() => 0), Array(fluid.primary.cycleCount).fill(0))
  const solidStores = fluid.materials.preparedCarriers.flatMap(c => [
      ...c.fuelNodes.map(f => ({ id: c.id + '/fuel/' + f.radial, energy_j: f.energy_J, capacity_j_k: f.capacity_J_K })),
      { id: c.id + '/clad', energy_j: c.clad.energy_J, capacity_j_k: c.clad.capacity_J_K },
    ]),
    nativeInput = {
      identity: 'LD01-HOT-PREPARATION-1',
      source: {
        regions: source.regions, materials: source.materials, transfers: source.transfers, supports: source.supports,
        inputs: achieved.inputs, exposure_per_population_s_m2: source.exposurePerPopulation_s_m2,
        stationary_state: [...source.reference.neutrons, ...source.reference.precursors],
        prepared_state: [...source.reference.neutrons, ...energy.carriers.flatMap(c => c.precursors)],
      },
      energy: {
        fission_joules_per_event: energy.history.fissionEnergy_J,
        fission_cross_section_m2: source.sigmaF_m2,
        fertile_cross_section_m2: energyCoefficients.fertileCapture_barn * 1e-28,
        fertile_binding_joules_per_capture: energyCoefficients.fertileBinding_MeV * MeV_J,
        xenon_binding_joules_per_capture: energyCoefficients.xenonBinding_MeV * MeV_J,
        samarium_binding_joules_per_capture: energyCoefficients.samariumBinding_MeV * MeV_J,
        xenon_cross_section_m2: source.sigmaXe_m2, samarium_cross_section_m2: source.sigmaSm_m2,
        binding_coolant_fraction: energyCoefficients.bindingCoolantFraction,
        prompt_fission_coolant_fraction: energyCoefficients.promptFissionCoolantFraction,
        fission_groups: energy.history.groups.filter(g => g.feed === 'fission').map(g => ({ decay_per_s: g.lambda_s_inv, retained_joules_per_event: g.energy_J_per_event })),
        capture_groups: energy.history.groups.filter(g => g.feed === 'fertileCapture').map(g => ({ decay_per_s: g.lambda_s_inv, retained_joules_per_event: g.energy_J_per_event })),
        poison_decay_per_s: [sourceCoefficients.iodineHalfLife_s, sourceCoefficients.xenonHalfLife_s, sourceCoefficients.promethiumHalfLife_s].map(t => Math.LN2 / t),
        poison_yields_per_fission: [sourceCoefficients.directIodine_per_fission, sourceCoefficients.directXenon_per_fission, sourceCoefficients.directPromethium_per_fission, 0],
        carriers: energy.carriers.map(c => ({ id: c.id, fuel_store_ids: [c.id + '/fuel/0', c.id + '/fuel/1'],
          fuel_node_fractions: [.5, .5], clad_store_id: c.id + '/clad',
          original_fissile_atoms: c.originalFissileAtoms, original_fertile_atoms: c.originalFertileAtoms,
          fissile_atoms: c.fissileAtoms, fertile_atoms: c.fertileAtoms, spent_fissions: c.spentFissions,
          capture_product_atoms: c.captureProductAtoms, expected_exposure_per_m2_s: c.exposure_per_m2_s,
          expected_fissions_per_s: c.fissions_per_s, expected_fuel_w: c.fuel_W, expected_coolant_w: c.coolant_W,
          stores_j: c.stores_J, poison_atoms: [c.iodineAtoms, c.xenonAtoms, c.promethiumAtoms, c.samariumAtoms] })),
      },
      fluid: {
        primary_mass_kg: fluid.primary.totalMass_kg, primary_energy_j: fluid.primary.totalInternalEnergy_J,
        primary_volume_m3: fluid.primary.totalVolume_m3,
        regions: fluid.primary.regions.map(r => ({ id: r.id, volume_m3: r.volume_m3, density_kg_m3: r.water.rho,
          pressure_pa: r.water.p, enthalpy_j_kg: r.water.h,
          specific_internal_energy_j_kg: r.water.u, mass_kg: r.mass_kg, energy_j: r.internalEnergy_J,
          mass_p_at_energy_kg_pa: r.massPAtEnergy_kg_Pa, mass_energy_at_pressure_kg_j: r.massEnergyAtPressure_kg_J })),
        solid_stores: [...solidStores, ...fluid.materials.solidStores.map(s => ({ id: s.id, energy_j: s.energy_J,
          capacity_j_k: s.capacity_J_K })), ...fluid.steamGenerators.flatMap(sg => sg.metal.map(m => ({ id: m.id,
          energy_j: m.energy_J, capacity_j_k: m.capacity_J_K })))],
        source_band_to_region: fluid.primary.sourceBandToCoolant,
        direct_coolant_projection: { heat_w: directCoolantHeat_W, edges: fluid.primary.edges.map(e => ({ from: e.from, to: e.to })),
          donors: directCoolantPressurePreparation.donors, flows_kg_s: directCoolantPressurePreparation.flows_kg_s,
          pressure_rate_pa_s: directCoolantPressurePreparation.pressureRate_Pa_s },
      },
    }
  return { identity: nativeInput.identity, provenance: names.map((name, i) => ({ name: root + name, sha256: hash(docs[i]!) })),
    nativeInput, mapping: mapping.totals, source: { identity: sourceCoefficients.identity,
      neutronReference: source.reference.neutrons, stationaryPrecursors: source.reference.precursors,
      referenceLeakage_per_s: source.referenceLeakage_per_s },
    compiledSource: source, energy, fluid, directCoolantPressurePreparation, totalCurrentHeat_W: energy.totalDeposited_W,
    actualCapturePerFission: energy.referenceFertileCaptures_per_s / energy.referenceFissions_per_s,
    preparedFissileSpentFraction: sum(energy.carriers.map(c => c.spentFissions)) / sum(energy.carriers.map(c => c.originalFissileAtoms)),
    scope: 'Actual current-owner quantitative preparation consumed by native equations, not a stationary hot plant or connected trajectory.' }
}

if (import.meta.main) {
  const [wiki, if97, steady, native, receipt] = Bun.argv.slice(2)
  if (!wiki || !if97 || !steady || !native || ![6, 7].includes(Bun.argv.length))
    throw Error('Usage: operating-hot <wiki root> <pinned IF97 directory> <steady solids JSON of prepare_steady_solids> <native prepare_hot executable> [receipt.json]')
  const packageData = await prepareOperatingHot(wiki, if97, { kind: 'steady', steady: steadySolidsSchema.parse(await Bun.file(steady).json()) }),
    bytes = JSON.stringify(packageData.nativeInput),
    child = Bun.spawn([native], { stdin: new Blob([bytes]), stdout: 'pipe', stderr: 'pipe' }),
    [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status !== 0) throw Error('Native hot preparation failed: ' + error)
  const {compiledSource: _compiledSource, ...reportedPackage}=packageData
  const report = { inputSha256: hash(bytes), native: JSON.parse(output), package: reportedPackage }
  if (receipt) {
    await Bun.write(receipt, JSON.stringify(report))
    console.log(JSON.stringify({ inputSha256: report.inputSha256, receipt, native: report.native,
      summary: { totalCurrentHeat_W: packageData.totalCurrentHeat_W, actualCapturePerFission: packageData.actualCapturePerFission,
        preparedFissileSpentFraction: packageData.preparedFissileSpentFraction,
        preparationExport_J: packageData.energy.preparationExport_J, finiteSolidStores: packageData.nativeInput.fluid.solid_stores.length } }))
  } else console.log(JSON.stringify(report))
}
