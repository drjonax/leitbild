import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { carveOperatingPrimary, compileOperatingHousingLosses, compileOperatingLineLosses, compileOperatingPoint, compileOperatingSurgeHydraulics, fittingLoss,
  operatingHousingMechanicalGeometry, operatingPointSources, prepareOperatingSpine, type FaceLossSection } from './reference-design-operating-spine'
import { operatingCirculationCycles, type Section } from './reference-design-operating-hydraulics'
import { compileOperatingPzr } from './reference-design-operating-pzr'
import { routeElevation } from './reference-design-surge-route'

// Test-only stock amounts: structural conservation independently of IF97.
function fixture() {
  const names = ['CORE.NE.1', 'CORE.NE.2', 'CORE.NW.1', 'CORE.NW.2', 'CORE.SW.1', 'CORE.SW.2', 'CORE.SE.1', 'CORE.SE.2',
    'DOWN', 'LOWER', 'UPPER', 'HOT.A', 'SG.A.PRIMARY', 'PUMP.A1', 'PUMP.A2', 'COLD.A', 'RETURN.A',
    'HOT.B', 'SG.B.PRIMARY', 'PUMP.B1', 'PUMP.B2', 'COLD.B', 'RETURN.B', 'HOUSING.MAIN', 'HOUSING.NECK', 'SURGE']
  const regions = names.map((id, i) => ({ id, volume_m3: id === 'HOT.A' ? 15 : 1 + i / 10,
    mass_kg: 100 + i, internalEnergy_J: 10000 + i, massPAtEnergy_kg_Pa: .001 + i / 10000,
    massEnergyAtPressure_kg_J: -.0001, absorberTracer_kgEq: .1 + i / 1000,
    energyP_J_Pa: 2 + i, energyT_J_K: 300 + i, liquidMass_kg: 100 + i, steamMass_kg: 0,
    airMass_kg: 0, nitrogenMass_kg: 0, mainFlowArea_m2: 1, elevation_m: 2.5 }))
  const edges: { id: string, from: number, to: number }[] = []
  const add = (a: string, b: string) => edges.push({ id: a + '->' + b, from: names.indexOf(a), to: names.indexOf(b) })
  add('DOWN', 'LOWER')
  for (const sector of ['NE', 'NW', 'SW', 'SE']) { add('LOWER', `CORE.${sector}.1`); add(`CORE.${sector}.1`, `CORE.${sector}.2`); add(`CORE.${sector}.2`, 'UPPER') }
  for (const side of ['A', 'B']) {
    add('UPPER', `HOT.${side}`); add(`HOT.${side}`, `SG.${side}.PRIMARY`)
    for (const p of [1, 2]) { add(`SG.${side}.PRIMARY`, `PUMP.${side}${p}`); add(`PUMP.${side}${p}`, `COLD.${side}`) }
    add(`COLD.${side}`, `RETURN.${side}`); add(`RETURN.${side}`, 'DOWN')
  }
  add('UPPER', 'HOUSING.MAIN'); add('HOUSING.MAIN', 'HOUSING.NECK'); add('HOT.A', 'SURGE')
  const area = Math.PI / 4, stub = (15 - area) / 2
  const partition = { sourceOwner: 'HOT.A', totalVolume_m3: 15, area_m2: area,
    parts: [{ id: 'HOT.A.UPSTREAM', volume_m3: stub, length_m: stub / area },
      { id: 'HOT.A.JUNCTION', volume_m3: area, length_m: 1 }, { id: 'HOT.A.DOWNSTREAM', volume_m3: stub, length_m: stub / area }] }
  return { regions, edges, partition }
}
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0)

// Independent fixed-pose dimensions for the source-owned housing geometry.
const housingFixture: Parameters<typeof operatingHousingMechanicalGeometry>[0] = { clusters: 52, rodletsPerCluster: 24, bodyDiameter_m: .0095, bodyLength_m: 4.65,
  insertedBodyBottom_m: -2.25, spiderBottom_m: 2.4, spiderHeight_m: .1, spiderMass_kg: 4,
  steelDensity_kg_m3: 7920, stemDiameter_m: .012, stemLength_m: 6, headBottom_m: 4,
  housingID_m: .25, housingTop_m: 8, housingCapHeight_m: .05, neckID_m: .05, neckTop_m: 13.6,
  collarID_m: .0125, collarOD_m: .025, collarBottoms_m: [8.05, 8.35], collarHeight_m: .1, normalTravel_m: 4, headGrossArea_m2: 16.75 }

test('housing free geometry retains collar outer bypass and subtracts stem through cap bore', () => {
  const c = housingFixture, h = operatingHousingMechanicalGeometry(c, 2.8), A = (d: number) => Math.PI * d ** 2 / 4,
    main = c.clusters * (A(c.housingID_m) * 4 - c.rodletsPerCluster * A(c.bodyDiameter_m) * 1.2
      - c.spiderMass_kg / c.steelDensity_kg_m3 - A(c.stemDiameter_m) * 2.7),
    neck = c.clusters * (A(c.neckID_m) * 5.6 - A(c.stemDiameter_m) * 3.3
      - (A(c.collarOD_m) - A(c.collarID_m)) * .2),
    collar = h.pieces.find(p => p.collar_outer_bypass)!,
    throughArea = c.clusters * (A(c.neckID_m) - A(c.collarOD_m) + A(c.collarID_m) - A(c.stemDiameter_m))
  expect(sum(h.pieces.filter(p => p.owner === 'HOUSING.MAIN').map(p => p.volume_m3))).toBeCloseTo(main, 13)
  expect(sum(h.pieces.filter(p => p.owner === 'HOUSING.NECK').map(p => p.volume_m3))).toBeCloseTo(neck, 13)
  expect(neck).toBeCloseTo(.5485335441299637, 14)
  expect(collar.area_m2).toBeCloseTo(throughArea, 14)
  expect(collar.area_m2).toBeGreaterThan(100 * c.clusters * (A(c.collarID_m) - A(c.stemDiameter_m)))
  expect(h.pieces.find(p => p.start_m === 8 && p.end_m === 8.05)!.area_m2)
    .toBeCloseTo(c.clusters * (A(c.neckID_m) - A(c.stemDiameter_m)), 14)
  for (const [i, p] of h.pieces.entries()) {
    if (i > 0) expect(p.start_m).toBe(h.pieces[i - 1]!.end_m)
    expect(p.inverse_area_length_per_m).toBeCloseTo(p.length_m / p.area_m2, 14)
  }
  expect(() => operatingHousingMechanicalGeometry(c, NaN)).toThrow('pose')
  expect(() => operatingHousingMechanicalGeometry(c, -1)).toThrow('pose')
  expect(() => operatingHousingMechanicalGeometry(c, 4.1)).toThrow('pose')
})

test('housing losses follow the support pieces, sharp-edge laws and authored perimeters only', () => {
  const c = housingFixture, A = (d: number) => Math.PI * d ** 2 / 4, regions = ['HOUSING.MAIN', 'HOUSING.NECK'],
    losses = compileOperatingHousingLosses(c, 2.8, 9.80665, id => regions.indexOf(id)), h = operatingHousingMechanicalGeometry(c, 2.8)
  expect(fittingLoss.contraction(0)).toBe(.5); expect(fittingLoss.expansion(0)).toBe(1); expect(fittingLoss.thinPlate(1)).toBe(0)
  for (const [face, lo, hi] of [['UPPER->HOUSING.MAIN', 4, 6], ['HOUSING.MAIN->HOUSING.NECK', 6, 10.825]] as const) {
    const own = losses.filter(s => s.face === face)
    expect(sum(own.map(s => s.parameters.length_m))).toBeCloseTo(hi - lo, 12)
    for (const s of own) {
      expect(s.kind).toBe('face_loss'); expect(s.parameters.pump).toBeNull(); expect(s.parameters.grid_count).toBe(0)
      expect(s.parameters.form_loss).toBeCloseTo(sum(s.terms.map(t => t.loss)), 15)
    }
  }
  const mouth = losses.find(s => s.terms.some(t => t.id === 'HEAD.MOUTH'))!, n = mouth.parameters.area_m2 / 16.75
  expect(mouth.parameters.area_m2).toBeCloseTo(c.clusters * (A(.25) - 24 * A(.0095)), 13)
  expect(mouth.parameters.form_loss).toBeCloseTo((.5 * (1 - n) ** .75 + (1 - n) ** 2) / 2, 14)
  expect(mouth.parameters.hydraulic_diameter_m).toBeCloseTo(4 * mouth.parameters.area_m2 / (c.clusters * Math.PI * (.25 + 24 * .0095)), 14)
  const spider = losses.find(s => s.terms.some(t => t.id === 'SPIDER.FRAME'))!
  expect(spider.parameters.wall).toBe('none'); expect(spider.parameters.hydraulic_diameter_m).toBe(0)
  const cap = losses.find(s => s.terms.some(t => t.id === 'CAP.BORE'))!, nc = (A(.05) - A(.012)) / (A(.25) - A(.012))
  expect(cap.parameters.form_loss).toBeCloseTo((.5 * (1 - nc) ** .75 + (1 - nc) ** 2) / 2, 14)
  const collars = losses.filter(s => s.terms.some(t => t.id === 'COLLAR')), ncol = (A(.05) - A(.012) - A(.025) + A(.0125)) / (A(.05) - A(.012))
  expect(collars).toHaveLength(2)
  for (const s of collars) expect(s.parameters.form_loss).toBeCloseTo(.5 * (1 - ncol) ** .75 + (1 - ncol) ** 2, 14)
  expect(losses.filter(s => s.parameters.wall === 'none')).toHaveLength(1)
  expect(losses.length).toBe(h.pieces.filter(p => p.length_m >= 1e-9 && p.end_m <= h.neckPlane_m).length)
})

test('fixed HOT.A carve conserves all extensive stores and removes SURGE once without mutation', () => {
  const f = fixture(), before = structuredClone(f), c = carveOperatingPrimary(f.regions, f.edges, f.partition)
  expect(c.regions).toHaveLength(27); expect(c.edges).toHaveLength(33); expect(c.tree.cycles).toHaveLength(7)
  expect(c.regions.some(r => r.id === 'SURGE' || r.id === 'HOT.A')).toBe(false)
  for (const key of ['volume_m3', 'mass_kg', 'internalEnergy_J', 'massPAtEnergy_kg_Pa', 'absorberTracer_kgEq', 'energyP_J_Pa', 'energyT_J_K', 'liquidMass_kg'] as const)
    expect(sum(c.regions.map(r => r[key])) + c.surgeStock[key]).toBeCloseTo(sum(f.regions.map(r => r[key])), 8)
  for (const p of c.regions.filter(r => r.id.startsWith('HOT.A.'))) expect(p.massEnergyAtPressure_kg_J).toBe(f.regions[c.hot]!.massEnergyAtPressure_kg_J)
  expect(c.regions[c.junction]!.volume_m3).toBe(Math.PI / 4)
  expect(f).toEqual(before)
  const cycles = operatingCirculationCycles({ regions: f.regions, edges: f.edges })
  for (const column of cycles.columns) {
    const rebased = c.edges.map(() => 0), B = c.regions.map(() => 0)
    for (const [e, targets] of c.edgeMap.entries()) for (const t of targets) rebased[t] = column[e]!
    for (const [e, w] of rebased.entries()) { B[c.edges[e]!.from]! -= w; B[c.edges[e]!.to]! += w }
    expect(B).toEqual(c.regions.map(() => 0))
  }
})

test('carve refuses altered partition, hidden owners and malformed incidence', () => {
  const f = fixture()
  const bad = structuredClone(f.partition); bad.parts[1]!.volume_m3 *= 2
  expect(() => carveOperatingPrimary(f.regions, f.edges, bad)).toThrow('partition')
  const changed = structuredClone(f.regions); changed[11]!.internalEnergy_J = NaN
  expect(() => carveOperatingPrimary(changed, f.edges, f.partition)).toThrow('stock')
  const other = structuredClone(f.edges); other[31]!.from = 10
  expect(() => carveOperatingPrimary(f.regions, other, f.partition)).toThrow('port')
  const outside = structuredClone(f.edges); outside[0]!.from = -1
  expect(() => carveOperatingPrimary(f.regions, outside, f.partition)).toThrow('incidence')
})

test('actual five-piece surge splits at8m with disjoint inertia, head, elbow and first-moment geometry', () => {
  const record = (name: string, value: unknown) => '```' + name + '\n' + JSON.stringify(value) + '\n```'
  // Test-only owner texts in the shapes the PZR compiler reads.
  const pzr = compileOperatingPzr({ selection: '## Allocation\n\n' + record('reference-operating-pzr', {
    commonPressure_Pa: 15e6, liquidTemperature_K: 600, vaporTemperature_K: 630, phaseBoundaryHeight_m: 6,
    bands_m: [0, 1, 3, 6, 9, 12], interfacialLength_m: .003, solidRoughness_m: .000045, absorberMassFraction: .001 })
    + '\n\n## Stratified PZR cell\n\n' + record('ld01-pzr-stratified', { withdrawalScale_m: .3, admittedPreparationThickness_m: .3,
      inversionExchangeVelocity_m_s: 1, liquidRelaxationTime_s: .3, vaporRelaxationTime_s: .5, relaxationSensitivity: [.5, 1, 2],
      bubbleDiameter_m: .001, sprayDropDiameter_m: .003, dropDiameterSensitivity_m: [.0015, .003, .006], resolvabilityFactor: 1000 }),
    surge: record('reference-surge-route', {
      source: 'LD01.HOT.A', receiver: 'LD01.PZR', sourceElevation_m: 2.5, receiverElevation_m: 6.5,
      developedLength_m: 16, firstStraight_m: 6, bendRadius_m: .45, internalDiameter_m: .3, wallThickness_m: .025,
      steelDensity_kg_m3: 7920, roughness_m: .0000015, entryLoss: .5, elbowLoss: .2, exitLoss: 1 }),
    properties: '## Bounded metastable admission\n\n' + record('ld01-metastable-band', { pressureRange_Pa: [1e7, 1.6e7], lowerBoundExclusive: true,
      liquidSuperheatMax_K: 2, vaporSubcoolingMax_K: 1.4, trialMax_K: 3, creditedMax_K: .5, liquidTemperatureMax_K: 623.15,
      liquidPressureCeiling_Pa: 1.7e7, vaporPressureCeiling_Pa: 1.6e7 }),
    observations: '## Primary pressure, inventory and heat transport\n\nSelect the PZR PT1/PT2/PT3 direct pressure interfaces at the top fluid boundary, +18.5 m on the current plant datum.\n',
    measurements: '### PZR electronic differential level\n\nTwo isolated flush interfaces sample static pressures at bottom +6.5 m and top +18.5 m.\n' },
  { id: 'HOT.A', volume_m3: 15, mainFlowArea_m2: Math.PI / 4, elevation_m: 2.5 })
  const h = compileOperatingSurgeHydraulics(pzr), A = Math.PI * .3 ** 2 / 4
  expect(h.halves.map(p => p.length_m)).toEqual([8, 8])
  expect(h.halves.map(p => p.elevationChange_m)).toEqual([0, 4])
  expect(h.halves.map(p => p.elbowLoss)).toEqual([.2, .2])
  expect(h.halves.flatMap(p => p.pieces)).toHaveLength(6)
  expect(sum(h.halves.map(p => p.volume_m3))).toBeCloseTo(16 * A, 14)
  expect(h.halves[0]!.pieces.at(-1)!.physical_piece_id).toBe('SURGE.PHYSICAL.2')
  expect(h.halves[1]!.pieces[0]!.physical_piece_id).toBe('SURGE.PHYSICAL.2')
  expect(h.halves[0]!.pieces.at(-1)!.end_m).toBe(h.halves[1]!.pieces[0]!.start_m)
  expect(h.momentumPlane).toEqual({ distance_m: 8, elevation_m: 2.5 })
  expect(h.inventoryMeanElevation_m).toBeGreaterThan(h.momentumPlane.elevation_m)
  for (const half of h.halves) {
    expect(half.geometricInertance_per_m).toBeCloseTo(8 / A, 12)
    expect(half.roughness_m).toBe(.0000015); expect(half.additionalThermalPower).toBe(false)
    // Independent bounded midpoint quadrature of actual z(s), not the compiler's primitive.
    const n = 2000, ds = half.length_m / n
    let integral = 0
    for (let i = 0; i < n; i++) integral += routeElevation(pzr.surge.route, half.start_m + (i + .5) * ds) * ds
    expect(Math.abs(integral / half.length_m - half.meanElevation_m)).toBeLessThan(2e-7)
  }
  expect(h.endpointLoss.hotEntrance).toBe(0); expect(h.endpointLoss.pzrReceipt).toBe(0)
  expect(h.endpointLoss.pzrWithdrawalCdA_m2).toBeCloseTo(A / Math.sqrt(1.5), 14)
  expect(h.junctionFirstMoment.lateralInertance_per_m).toBeCloseTo(Math.sqrt(Math.PI / 4) / (2 * A), 13)
  expect(h.junctionFirstMoment.status).toBe('PROJECTION_CANDIDATE')
  expect(h.junctionFirstMoment.scope).toContain('expansion-tree')
  const cut = structuredClone(pzr); cut.surge.pieces[1]!.start_m = 7; cut.surge.pieces[1]!.end_m = 9
  expect(() => compileOperatingSurgeHydraulics(cut)).toThrow('split elbow')
  // Line losses: friction and one elbow per half, each end the mean of its two directions.
  const losses = compileOperatingLineLosses(h, pzr, { dividingTurnLoss: 1 }, 9.80665, 27),
    prism = Math.sqrt(Math.PI / 4), hotEnd = (1 + (1 - A / prism) ** 2) / 2,
    receiver = 4.5, pzrEnd = ((1 - A / receiver) ** 2 + .5) / 2
  expect(losses.map(s => s.face)).toEqual(['HOT.A.JUNCTION->SURGE', 'SURGE->PZR.SURGE.MOUTH'])
  for (const [k, s] of losses.entries()) {
    expect(s.region).toBe(27); expect(s.parameters.wall).toBe('circular_churchill')
    expect([s.parameters.length_m, s.parameters.area_m2, s.parameters.hydraulic_diameter_m]).toEqual([8, A, .3])
    expect(s.parameters.elevation_change_m).toBe([0, 4][k]!)
    expect(s.parameters.form_loss).toBeCloseTo(.2 + [hotEnd, pzrEnd][k]!, 14)
  }
  expect(() => compileOperatingLineLosses(h, pzr, { dividingTurnLoss: -1 }, 9.80665, 27)).toThrow('Invalid')
})

// Independent owner-statement fixture; the actual test below reads the wiki.
function pointFixture() {
  const docs: Record<string, string> = {
    'systems/primary-coolant/pressurizer-thermal-state.md': '#### Acquisition and initial intent\n\nRetain the pressure setpoint **14,864,186.8055 Pa**, gain and bands.\n\n#### Bounded native evidence\n\nText.\n',
    'systems/instrumentation/operational-observations.md': '## Primary pressure, inventory and heat transport\n\n```text\n# not a heading\n```\n\nSelect the PZR PT1/PT2/PT3 direct pressure interfaces at the top fluid boundary, +18.5 m on the current plant datum (12 m above the PZR bottom). LT datum remains the PZR bottom and its 12 m equivalent vessel height.\n',
    'systems/primary-coolant/inventory-and-chemistry.md': '## Normal inventory controller\n\nThe candidate target is 6 m at the nominal state. Use one channel.\n',
    'model/connected-primary-initialization.md': '## Current original physical hot preparation\n\nPassages retain momenta and actual supported 1500 rpm rotor states.\n',
    'systems/primary-coolant/pressure-and-inventory.md': '### Acquired-pressure command comparison\n\nAt top-tap pressure 14,862,307.3669 Pa and commissioned setpoint 14,864,186.8055 Pa, duty follows.\n',
    'systems/primary-coolant/pumps-and-support.md': '## Shaft and energy model\n\nCommands request zero or nominal speed for the initial operational interface; tests may differ.\n',
  }
  return { docs, pzr: { bottom_m: 6.5, top_m: 18.5 } }
}

test('declared operating point reads each owner statement once', () => {
  const { docs, pzr } = pointFixture(), point = compileOperatingPoint(docs, pzr, 1500)
  expect([point.pzrRoofPressure_Pa, point.pzrRoofElevation_m, point.pzrLevel_m, point.rcpSpeedRequest]).toEqual([14864186.8055, 18.5, 6, 'nominal'])
  expect(point.provenance).toEqual(operatingPointSources)
  expect(point.pzrLevelSurfaceElevation_m).toBe(12.5); expect(point.pzrBottomElevation_m).toBe(6.5)
  // Another declared level is carried unchanged; there are no bands to snap to.
  const inside = { ...docs, 'systems/primary-coolant/inventory-and-chemistry.md': docs['systems/primary-coolant/inventory-and-chemistry.md']!.replace('target is 6 m', 'target is 5.25 m') }
  expect(compileOperatingPoint(inside, pzr, 1500).pzrLevel_m).toBe(5.25)
  const over = { ...docs, 'systems/primary-coolant/inventory-and-chemistry.md': docs['systems/primary-coolant/inventory-and-chemistry.md']!.replace('target is 6 m', 'target is 12 m') }
  expect(() => compileOperatingPoint(over, pzr, 1500)).toThrow('Invalid declared')
  const edit = (page: string, from: string, to: string) => ({ ...docs, [page]: docs[page]!.replace(from, to) })
  expect(() => compileOperatingPoint(edit('systems/primary-coolant/pressure-and-inventory.md', '186.8055 Pa,', '186.8056 Pa,'), pzr, 1500)).toThrow('disagree')
  expect(() => compileOperatingPoint(edit('systems/instrumentation/operational-observations.md', '+18.5 m', '+18 m'), pzr, 1500)).toThrow('roof tap')
  expect(() => compileOperatingPoint(docs, pzr, 1400)).toThrow('nominal speed')
  expect(() => compileOperatingPoint(edit('systems/primary-coolant/pressurizer-thermal-state.md', '#### Acquisition and initial intent\n\nRetain', '#### Acquisition and initial intent\n\n#### Other\n\nRetain'), pzr, 1500)).toThrow('Expected one selected statement')
  const doubled = docs['systems/primary-coolant/inventory-and-chemistry.md']!
  expect(() => compileOperatingPoint({ ...docs, 'systems/primary-coolant/inventory-and-chemistry.md': doubled + 'The candidate target is 6 m at the nominal state.\n' }, pzr, 1500)).toThrow('Expected one selected statement')
  const { 'systems/primary-coolant/pumps-and-support.md': _, ...missing } = docs
  expect(() => compileOperatingPoint(missing, pzr, 1500)).toThrow('Missing operating-point owner')
})

const wiki = process.env.LD01_WIKI_ROOT, if97 = process.env.LD01_IF97_DIRECTORY
if (!!wiki !== !!if97) throw Error('Supply both actual wiki and pinned IF97 directory')
test.skipIf(!wiki || !if97)('actual single hot packet rebases every recipient, finite store and hydraulic cycle; native consumes it', async () => {
  const p = await prepareOperatingSpine(wiki!, if97!)
  expect(p.thermal.water).toHaveLength(27); expect(p.edges).toHaveLength(33)
  expect(p.hot.fluid.regions.map(r => r.id)).toEqual(p.thermal.water.map(r => r.id))
  expect(p.source_water).toHaveLength(24); expect(p.water_flow_area_m2).toHaveLength(27); expect(p.water_boron_amount_kg_eq).toHaveLength(27)
  expect(p.thermal.fuel_bands).toHaveLength(386); expect(p.thermal.helium).toHaveLength(193)
  expect(p.thermal.core_contacts).toHaveLength(448); expect(p.thermal.sg_segments).toHaveLength(8)
  const h = p.thermal.water.filter(r => r.id.startsWith('HOT.A.'))
  expect(sum(h.map(r => r.volume_m3))).toBe(15); expect(h[1]!.volume_m3).toBe(Math.PI / 4)
  expect(sum(h.map(r => r.mass_kg))).toBeCloseTo(15 * 679.3368894359069, 8)
  expect(p.hot.fluid.primary_mass_kg).toBeCloseTo(sum(p.thermal.water.map(r => r.mass_kg)), 8)
  expect(p.hot.fluid.primary_energy_j).toBeCloseTo(sum(p.thermal.water.map(r => r.energy_j)), 3)
  expect(sum(p.water_boron_amount_kg_eq)).toBeCloseTo(p.hot.fluid.primary_mass_kg / 1000, 9)
  expect(p.external_ports.surge_stock.volume_m3).toBeCloseTo(p.pzr.surge.route.liquidVolume_m3, 13)
  expect(p.external_ports.surge_stock.absorberTracer_kgEq).toBeCloseTo(p.external_ports.surge_stock.mass_kg / 1000, 12)
  expect(p.thermal.water[p.external_ports.primary_to_surge.primary_water]!.id).toBe('HOT.A.JUNCTION')
  type Any = typeof p.hydraulics.sections[number]
  const channels = p.hydraulics.sections.filter((s: Any): s is Section => !('kind' in s)),
    passive = p.hydraulics.sections.filter((s: Any): s is FaceLossSection => 'kind' in s)
  expect(channels).toHaveLength(21); expect(p.hydraulics.cycles.columns).toHaveLength(7)
  expect(p.hydraulics.sections.slice(0, 21)).toEqual(channels)
  expect(p.hydraulics.surge.halves).toHaveLength(2)
  expect(p.hydraulics.surge.halves.map(h => h.elevationChange_m)).toEqual([0, 4])
  const cell = p.pzr.cell
  expect([cell.index, cell.bottom_m, cell.top_m]).toEqual([28, 6.5, 18.5])
  expect(cell.fluidVolume_m3).toBe(sum(cell.freeArea.map(a => (a.to_m - a.from_m) * a.area_m2)))
  expect(cell.ports).toEqual([{ id: 'PZR.SURGE.MOUTH', kind: 'surge', elevation_m: 6.5, bore_m: .3, face: 34 }])
  expect(cell.taps).toEqual([{ id: 'PT1', elevation_m: 18.5 }, { id: 'LT.LOW', elevation_m: 6.5 }, { id: 'LT.HIGH', elevation_m: 18.5 }])
  expect([cell.absorberMassFraction, cell.interfacialLength_m]).toEqual([.001, .003])
  expect(p.hydraulics.coveredEdges).toHaveLength(31); expect(p.hydraulics.unclosedTreeEdges).toHaveLength(2)
  expect(p.hydraulics.mainInertance.aa).toBeCloseTo(70.629211610045, 10)
  expect(p.hydraulics.mainInertance.ab).toBeCloseTo(2.654786439092273, 12)
  expect(p.hydraulics.mainInertance.bb).toBeCloseTo(70.629211610045, 10)
  const m = p.mechanics
  expect(m.regions).toHaveLength(29); expect(m.faces).toHaveLength(35); expect(m.force_projection).toHaveLength(0)
  expect(m.regions[28]).toEqual({ id: 'PZR', volume_m3: cell.fluidVolume_m3, elevation_m: cell.top_m })
  expect(m.faces.slice(0, 33).map(f => f.id)).toEqual(p.edges.map(e => e.id))
  expect(m.faces[33]!.id).toBe('HOT.A.JUNCTION->SURGE'); expect(m.faces[34]!.id).toBe('SURGE->PZR.SURGE.MOUTH')
  for (const face of m.faces) {
    expect(face.supports.length).toBeGreaterThan(0)
    // Face 34 ends at the surge mouth; the PZR side is its port view.
    const to = face.to === 28 ? cell.ports[0]!.elevation_m : m.regions[face.to]!.elevation_m
    expect(sum(face.pressure_segments.map(s => s.elevation_change_m))).toBeCloseTo(to - m.regions[face.from]!.elevation_m, 12)
    expect([...face.supports, ...face.pressure_segments].every(s => s.region !== 28)).toBe(true)
  }
  expect(m.faces.filter(f => f.to === 28 || f.from === 28).map(f => f.id)).toEqual(['SURGE->PZR.SURGE.MOUTH'])
  for (const section of channels) {
    const owned = m.faces.slice(0, 33).flatMap(f => f.supports).filter(s => s.region === section.region)
    expect(sum(owned.map(s => s.volume_m3))).toBeCloseTo(section.movingVolume_m3, 11)
  }
  // Each passive face section is the adjoint of exactly its own face current.
  for (const [k, s] of passive.entries())
    expect(m.section_force_projection.filter(t => t.section === 21 + k)).toEqual([{ face: m.faces.findIndex(f => f.id === s.face), section: 21 + k, coefficient: 1 }])
  expect(m.section_force_projection.every(t => t.face < 35)).toBe(true)
  const loaded = new Set(m.section_force_projection.map(t => m.faces[t.face]!.id))
  expect(m.faces.slice(0, 35).filter(f => !loaded.has(f.id)).map(f => f.id)).toEqual(p.hydraulics.passiveLossScope.liquidFacesWithoutSectionLoss)
  expect(passive.filter(s => s.face === 'UPPER->HOUSING.MAIN').length).toBeGreaterThan(0)
  expect(passive.filter(s => s.face === 'HOUSING.MAIN->HOUSING.NECK').length).toBeGreaterThan(0)
  expect(passive.filter(s => s.face === 'HOT.A.JUNCTION->SURGE' || s.face === 'SURGE->PZR.SURGE.MOUTH').map(s => s.id)).toEqual(['SURGE.HALF.0', 'SURGE.HALF.1'])
  expect(p.hydraulics.passiveLossScope.liquidFacesWithoutSectionLoss).toEqual([])
  expect(p.hydraulics.hotBranchLoss.dividingTurnLoss).toBe(1)
  expect(m.faces[31]!.supports.every(s => m.regions[s.region]!.id === 'HOUSING.MAIN')).toBe(true)
  expect(m.faces[32]!.supports.some(s => m.regions[s.region]!.id === 'HOUSING.NECK')).toBe(true)
  // An outgoing half of the two-way SG bundle owns half its area, not two
  // duplicated copies of the full half-bundle water/inertia.
  const sg = p.hydraulics.sections.find(s => s.id === 'SG.A.PRIMARY')!, sgEdge = p.edges.findIndex(e => e.id === 'SG.A.PRIMARY->PUMP.A1'),
    sgSupport = m.faces[sgEdge]!.supports.find(s => s.region === sg.region)!
  expect(sgSupport.inverse_area_length_per_m).toBeCloseTo(sg.parameters.length_m / sg.parameters.area_m2, 12)
  expect(m.faces[33]!.pressure_segments.some(s => s.path_length_m === 0 && s.elevation_change_m !== 0)).toBe(true)
  expect(sum(p.hydraulics.sections.filter(s => s.id.startsWith('HOT.A.')).map(s => s.parameters.form_loss))).toBeCloseTo(.49504493, 14)
  for (const column of p.hydraulics.cycles.columns) {
    const B = p.thermal.water.map(() => 0)
    for (const [e, q] of column.entries()) { B[p.edges[e]!.from]! -= q; B[p.edges[e]!.to]! += q }
    expect(B).toEqual(p.thermal.water.map(() => 0))
  }
  for (const c of [...p.thermal.core_contacts, ...p.thermal.passive_contacts]) expect(p.thermal.water[c.water]).toBeDefined()
  for (const c of p.thermal.sg_segments) expect(p.thermal.water[c.primary]!.id).toBe(`SG.${c.id.split('.')[1]}.PRIMARY`)
  for (const [i, w] of p.source_water.entries()) expect(p.thermal.water[w]!.id).toBe(`CORE.${['NE', 'NW', 'SW', 'SE'][Math.floor(i / 6)]}.${i % 6 < 3 ? 1 : 2}`)
  // The gas energy datum is actual ideal-He U=3/2 nRT, never solid's273.15K datum.
  for (const he of p.thermal.helium) expect(he.energy_j).toBeCloseTo(1.5 * he.nr_j_k * he.temperature_k, 7)
  expect(p.preparation.direct_source_projection.donorBranchConsistent).toBe(true)
  expect(p.preparation.direct_source_projection.maxConstraintDefect_kg_s).toBeLessThan(1e-7)
  const point = p.preparation.operatingPoint
  expect([point.pzrRoofPressure_Pa, point.pzrRoofElevation_m, point.pzrLevel_m, point.rcpSpeedRequest]).toEqual([14864186.8055, 18.5, 6, 'nominal'])
  expect(point.pzrLevelSurfaceElevation_m).toBe(12.5)
  const pump = p.hydraulics.pump, omega = pump.referenceOmega_rad_s
  expect([pump.driveTrackingTime_s, pump.driveTorqueCapFactor, pump.driveEfficiency]).toEqual([5, 1.5, .96])
  expect(pump.drag_Nm_per_rad_s * omega ** 2).toBeCloseTo(.01 * pump.nominalFluidPower_W, 8)
  expect(pump.rotorInertia_kg_m2).toBeCloseTo((pump.nominalFluidPower_W + pump.drag_Nm_per_rad_s * omega ** 2) * 10 / omega ** 2, 10)
  expect('nominalDragPower_W' in pump).toBe(false)
  const native = process.env.LD01_OPERATING_HOT_SPINE_TEST
  if (native) {
    const directory = await mkdtemp(join(tmpdir(), 'ld01-hot-spine-'))
    try {
      const path = join(directory, 'packet.json'); await Bun.write(path, JSON.stringify(p))
      const child = Bun.spawn([native, '--ignored', '--nocapture'], {
        env: { ...process.env, LD01_OPERATING_HOT_SPINE_PACKET: path }, stdout: 'pipe', stderr: 'pipe' })
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      if (code !== 0) throw Error(error + output)
      expect(output).toContain('1 passed'); console.log(error.trim())
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30000)
