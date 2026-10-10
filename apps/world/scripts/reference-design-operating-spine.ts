/** One actual compact hot-spine package. This compiler only changes physical
 * ownership/incidence; Rust owns all current numerical residual laws. The
 * removed SURGE stock is exported, never discarded or used as a held boundary. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseFuelConstruction } from './reference-design-fuel-construction'
import { parseFuelHandling } from './reference-design-fuel-handling'
import { parseControlAbsorber } from './reference-design-control-absorber'
import { parseTransferThermal } from './reference-design-fuel-transfer-thermal'
import { parseOperatingFuelGap } from './reference-design-fuel-cooling'
import { prepareOperatingHot } from './reference-design-operating-hot'
import { compileOperatingThermal, parseOperatingThermal } from './reference-design-operating-thermal'
import { fluidTree, preparePressureContinuity } from './reference-design-operating-fluid'
import { loadOperatingHydraulics, operatingMainInertance, type Section } from './reference-design-operating-hydraulics'
import { prepareOperatingPzr, type compileOperatingPzr } from './reference-design-operating-pzr'
import { operatingSourceNativeMetadata } from './reference-design-operating-source'
import { routeElevation } from './reference-design-surge-route'

type Edge = { id: string, from: number, to: number }
type Stock = { id: string, volume_m3: number, mass_kg: number, internalEnergy_J: number,
  massPAtEnergy_kg_Pa: number, massEnergyAtPressure_kg_J: number, absorberTracer_kgEq: number }
type Partition = Pick<Awaited<ReturnType<typeof prepareOperatingPzr>>['hotPartition'], 'sourceOwner' | 'totalVolume_m3' | 'parts' | 'area_m2'>
const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0)
const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2e-13 * Math.max(1, Math.abs(a), Math.abs(b))

/** Fixed physical carve, not a configurable graph rewrite. Specific properties
 * and dM/dU|p are intensive; M,U,dM/dp|U and all retained material amounts split
 * with volume. The original packet is not mutated. */
export function carveOperatingPrimary<T extends Stock>(original: readonly T[], edges: readonly Edge[], partition: Partition) {
  const hot = original.findIndex(r => r.id === 'HOT.A'), surge = original.findIndex(r => r.id === 'SURGE')
  if (original.length !== 26 || edges.length !== 32 || hot < 0 || surge < 0 || new Set(original.map(r => r.id)).size !== original.length)
    throw Error('Expected the actual uncarved26-owner primary graph')
  fluidTree(original, edges)
  const owner = original[hot]!, parts = partition.parts
  if (partition.sourceOwner !== owner.id || parts.length !== 3 || parts.some((p, i) => p.id !== ['HOT.A.UPSTREAM', 'HOT.A.JUNCTION', 'HOT.A.DOWNSTREAM'][i]
    || !Number.isFinite(p.volume_m3) || p.volume_m3 <= 0 || !Number.isFinite(p.length_m) || p.length_m <= 0)
    || !near(sum(parts.map(p => p.volume_m3)), owner.volume_m3) || !near(partition.totalVolume_m3, owner.volume_m3)
    || !near(parts[1]!.volume_m3, partition.area_m2) || !near(parts[1]!.length_m, 1)
    || parts.some(p => !near(p.volume_m3, p.length_m * partition.area_m2))) throw Error('HOT.A physical partition does not match its actual owner')
  const scale = (p: typeof parts[number]): T => {
    const f = p.volume_m3 / owner.volume_m3, r = { ...owner, id: p.id, volume_m3: p.volume_m3 }
    // These are the only extensive fields of the actual prepared water chart.
    for (const key of ['mass_kg', 'internalEnergy_J', 'massPAtEnergy_kg_Pa', 'absorberTracer_kgEq',
      'energyP_J_Pa', 'energyT_J_K', 'liquidMass_kg', 'steamMass_kg', 'airMass_kg', 'nitrogenMass_kg']) {
      if (key in owner) {
        const value = (owner as Record<string, unknown>)[key]
        if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Invalid extensive water stock ' + key)
        ;(r as Record<string, unknown>)[key] = value * f
      }
    }
    return r
  }
  const regions = original.flatMap((r, i) => i === surge ? [] : i === hot ? parts.map(scale) : [{ ...r }])
  const index = (id: string) => { const i = regions.findIndex(r => r.id === id); if (i < 0) throw Error('Removed or unknown primary owner ' + id); return i }
  const regionMap = original.map((r, i) => i === hot || i === surge ? -1 : index(r.id))
  const rebased: Edge[] = [], edgeMap: number[][] = edges.map(() => []), append = (old: number, a: string, b: string) => {
    edgeMap[old]!.push(rebased.length); rebased.push({ id: a + '->' + b, from: index(a), to: index(b) })
  }
  let inlet = -1, outlet = -1, external = -1
  for (const [e, edge] of edges.entries()) {
    const a = original[edge.from]!.id, b = original[edge.to]!.id
    if (a === 'HOT.A' && b === 'SURGE') { external = e; continue }
    if (a === 'UPPER' && b === 'HOT.A') {
      inlet = e; append(e, 'UPPER', parts[0]!.id); append(e, parts[0]!.id, parts[1]!.id); append(e, parts[1]!.id, parts[2]!.id)
    } else if (a === 'HOT.A' && b === 'SG.A.PRIMARY') { outlet = e; append(e, parts[2]!.id, b) }
    else {
      if (edge.from === hot || edge.to === hot || edge.from === surge || edge.to === surge) throw Error('Unexpected HOT.A/SURGE physical port')
      append(e, a, b)
    }
  }
  if ([inlet, outlet, external].some(i => i < 0) || regions.length !== 27 || rebased.length !== 33) throw Error('Incomplete physical HOT.A/SURGE carve')
  const tree = fluidTree(regions, rebased)
  if (tree.cycles.length !== 7) throw Error('Changed actual primary circulation dimension')
  for (const key of ['volume_m3', 'mass_kg', 'internalEnergy_J', 'absorberTracer_kgEq', 'massPAtEnergy_kg_Pa'] as const)
    if (!near(sum(regions.map(r => r[key])) + original[surge]![key], sum(original.map(r => r[key])))) throw Error('Nonconservative physical carve ' + key)
  return { regions, edges: rebased, regionMap, edgeMap, tree, hot, surge, inlet, outlet, external,
    surgeStock: { ...original[surge]! }, junction: index(parts[1]!.id), partition }
}

type Carved = ReturnType<typeof carveOperatingPrimary>
/** Rebase the actual19 supports to21 without changing numerical constitutive
 * laws. Distributed HOT.A loss is split by length exactly once. The separate
 * lateral junction/line force law is still an explicit external dependency. */
export function rebaseOperatingHydraulics(original: Awaited<ReturnType<typeof loadOperatingHydraulics>>, carved: Carved) {
  const mapRegion = (i: number) => { const r = carved.regionMap[i]; if (r === undefined || r < 0) throw Error('Hydraulic receipt refers to removed water owner'); return r }
  const mapEdge = (i: number) => { const e = carved.edgeMap[i]; if (!e?.length) throw Error('Hydraulic receipt refers to removed edge'); return e[0]! }
  const hot = original.sections.find(s => s.id === 'HOT.A')
  if (!hot || original.sections.length !== 19) throw Error('Expected actual19 hydraulic supports')
  const chain = [...carved.edgeMap[carved.inlet]!, ...carved.edgeMap[carved.outlet]!]
  const sections: Section[] = original.sections.flatMap(s => s.id !== 'HOT.A' ? [{ ...s, region: mapRegion(s.region),
    flow: s.flow.map(t => ({ ...t, edge: mapEdge(t.edge) })), force: s.force.map(t => ({ ...t, edge: mapEdge(t.edge) })),
    conversionRecipients: s.conversionRecipients.map(r => ({ ...r, region: mapRegion(r.region) })) }] : carved.partition.parts.map((p, i) => {
      const region = carved.regions.findIndex(r => r.id === p.id), flow = [{ edge: chain[i]!, weight: .5 }, { edge: chain[i + 1]!, weight: .5 }]
      return { ...s, id: p.id, region, flow, force: flow.map(t => ({ ...t })),
        parameters: { ...s.parameters, length_m: p.length_m, form_loss: s.parameters.form_loss * p.length_m / s.parameters.length_m },
        movingVolume_m3: p.volume_m3, retainedThermalVolume_m3: p.volume_m3,
        conversionRecipients: s.conversionRecipients.map(r => ({ ...r, region })) }
    }))
  const columns = original.cycles.columns.map(col => {
    const c = carved.edges.map(() => 0)
    for (const [old, targets] of carved.edgeMap.entries()) for (const e of targets) c[e] = col[old]!
    if (col[carved.external] !== 0 || col[carved.inlet] !== col[carved.outlet]) throw Error('Invalid original HOT.A/SURGE cycle support')
    const B = carved.regions.map(() => 0)
    for (const [e, w] of c.entries()) { B[carved.edges[e]!.from]! -= w; B[carved.edges[e]!.to]! += w }
    if (B.some(x => x !== 0)) throw Error('Rebased circulation is not in the incidence nullspace')
    return c
  })
  const cycles = { ids: [...original.cycles.ids], columns,
    incidence: columns.flatMap((col, cycle) => col.flatMap((weight, edge) => weight !== 0 ? [{ edge, cycle, weight }] : [])) }
  const forceIncidence = sections.flatMap((s, section) => s.force.map(t => ({ ...t, section })))
  const coveredEdges = [...new Set(forceIncidence.map(t => t.edge))].sort((a, b) => a - b)
  const gravityIncidence = original.gravityIncidence.map(g => ({ ...g, edge: mapEdge(g.edge), region: g.region === carved.hot
    ? carved.regions.findIndex(r => r.id === carved.partition.parts[g.edge === carved.outlet ? 2 : 0]!.id) : mapRegion(g.region) }))
  const main = operatingMainInertance(sections, cycles)
  if (sections.length !== 21 || coveredEdges.length !== 31 || !near(main.matrix.aa, original.mainInertance.aa)
    || !near(main.matrix.ab, original.mainInertance.ab) || !near(main.matrix.bb, original.mainInertance.bb)
    || !near(sum(sections.filter(s => s.id.startsWith('HOT.A.')).map(s => s.parameters.form_loss)), hot.parameters.form_loss))
    throw Error('Changed physical circulation geometry/loss in HOT.A carve')
  return { ...original, sections, forceIncidence, gravityIncidence, cycles, mainInertance: main.matrix, mainInertanceSupports: main.supports,
    coveredEdges, unclosedTreeEdges: carved.edges.flatMap((e, edge) => coveredEdges.includes(edge) ? [] : [{ edge, id: e.id }]),
    unclosedJunctions: ['HOT.A.JUNCTION finite directional lateral surge intersection (external port)'],
    kineticScope: '21 once-owned geometric supports; same two-main metric and five split force rows. Lateral surge/expansion acceleration and junction force are not admitted.' }
}

/** Actual route integration/ownership, not another hydraulic numerical law.
 * The two half-route supports are a selected mass-lumped geometric candidate;
 * force/convection/traction and its joint pressure chart need native admission.
 * In particular, actual first-moment Px contains expansion-tree flow that is
 * NOT automatically retained by the original two-main circulation metric. */
export function compileOperatingSurgeHydraulics(pzr: Pick<Awaited<ReturnType<typeof prepareOperatingPzr>>, 'surge' | 'hotPartition'>) {
  const r = pzr.surge.route, length = r.developedLength_m, middle = length / 2, area = r.area_m2
  const elevationIntegral = (s: number) => {
    if (!Number.isFinite(s) || s < 0 || s > length) throw Error('Surge integral outside actual route')
    if (s <= r.risingStart_m) return r.sourceElevation_m * s
    const arc = Math.PI * r.bendRadius_m / 2
    if (s <= r.verticalStart_m) {
      const d = s - r.risingStart_m
      return r.sourceElevation_m * s + r.bendRadius_m * d - r.bendRadius_m ** 2 * Math.sin(d / r.bendRadius_m)
    }
    const d = s - r.verticalStart_m
    return r.sourceElevation_m * s + r.bendRadius_m * arc - r.bendRadius_m ** 2 + r.bendRadius_m * d + d * d / 2
  }
  const halves = [0, 1].map(half => {
    const start = half * middle, end = start + middle
    const pieces = pzr.surge.pieces.flatMap(piece => {
      const lo = Math.max(start, piece.start_m), hi = Math.min(end, piece.end_m)
      if (lo >= hi) return []
      // The actual eight-metre cut is in a straight, not inside either elbow.
      if (piece.elbowLoss !== 0 && (lo !== piece.start_m || hi !== piece.end_m)) throw Error('A split elbow requires an explicit loss-location decision')
      return [{ id: piece.id + '.HALF.' + half, physical_piece_id: piece.id, start_m: lo, end_m: hi,
        length_m: hi - lo, area_m2: area, volume_m3: (hi - lo) * area,
        inletElevation_m: routeElevation(r, lo), outletElevation_m: routeElevation(r, hi),
        meanElevation_m: (elevationIntegral(hi) - elevationIntegral(lo)) / (hi - lo),
        roughness_m: piece.wallRoughness_m, elbowLoss: piece.elbowLoss }]
    })
    return { id: 'SURGE.HALF.' + half, start_m: start, end_m: end, length_m: middle, area_m2: area,
      volume_m3: middle * area, inletElevation_m: routeElevation(r, start), outletElevation_m: routeElevation(r, end),
      elevationChange_m: routeElevation(r, end) - routeElevation(r, start),
      meanElevation_m: (elevationIntegral(end) - elevationIntegral(start)) / middle,
      geometricInertance_per_m: middle / area, hydraulicDiameter_m: r.internalDiameter_m, roughness_m: r.roughness_m,
      elbowLoss: sum(pieces.map(p => p.elbowLoss)), pieces,
      forceRecipient: 'SURGE', additionalThermalPower: false as const }
  })
  if (!near(sum(halves.map(h => h.volume_m3)), r.liquidVolume_m3)
    || !near(sum(halves.map(h => h.length_m)), length)
    || !near(sum(halves.map(h => h.elbowLoss)), 2 * r.elbowLoss)
    || !near(sum(halves.map(h => h.meanElevation_m * h.length_m)) / length, r.volumeMeanElevation_m))
    throw Error('Nonconservative physical surge-half partition')
  const mainArea = pzr.hotPartition.area_m2, width = Math.sqrt(mainArea), lateralArm = width / 2,
    junctionLength = pzr.hotPartition.parts[1]!.length_m
  if (![area, mainArea, lateralArm, junctionLength].every(x => Number.isFinite(x) && x > 0)) throw Error('Invalid actual junction first moment')
  return { halves, momentumPlane: { distance_m: middle, elevation_m: routeElevation(r, middle) },
    inventoryMeanElevation_m: r.volumeMeanElevation_m,
    lossLaw: 'Reviewed circular Churchill Darcy64/Re continuation with actual roughness; NOT annular96/Re or smooth Colebrook. The coarse face sections use the native smooth circular Churchill law (roughness omitted, bounded in surge-route.md).',
    endpointLoss: { hotEntrance: 0, pzrReceipt: 0, pzrWithdrawalCdA_m2: area / Math.sqrt(1 + r.entryLoss),
      scope: 'Selected line/intersection/mouth realization: no retired HOT entrance/tee or PZR exit loss, because their momentum receipts pay that dissipation; phase-weighted withdrawal area belongs to its separate endpoint receipt. The coarse local-pressure faces, which lack those receipts, carry the equivalent end coefficients in hydraulics.sections SURGE.HALF.0/1.' },
    junctionFirstMoment: { status: 'PROJECTION_CANDIDATE' as const, owner: 'HOT.A.JUNCTION',
      mainAxisArm_m: junctionLength / 2, lateralArm_m: lateralArm,
      lateralInertance_per_m: lateralArm / area,
      mainMoment: 'Px=Lx/2*(qin_main+qout_main)', lateralMoment: 'Py=width/2*qout_surge',
      meanVelocity: 'Current vector first moment divided by actual junction mass; never qsurge/(rho*surgeArea) as whole-junction velocity',
      scope: 'Uniform retained-density continuity first moment. Actual open-face/wall traction and upwind vector convection are unadmitted. MAIN metric covers only its selected cycle contribution; expansion-tree Px inertia needs explicit ownership or an omission diagnostic.' },
    inertiaScope: 'Two diagonal Lhalf/A geometric supports are a mass-lumped low-Mach candidate, not exact affine-profile inertia, an acoustic face or admitted surge dynamics' }
}

type HousingGeometry = Pick<ReturnType<typeof parseControlAbsorber>, 'clusters' | 'rodletsPerCluster' | 'bodyDiameter_m' | 'bodyLength_m'
  | 'insertedBodyBottom_m' | 'spiderBottom_m' | 'spiderHeight_m' | 'spiderMass_kg' | 'steelDensity_kg_m3' | 'stemDiameter_m'
  | 'stemLength_m' | 'headBottom_m' | 'housingID_m' | 'housingTop_m' | 'housingCapHeight_m' | 'neckID_m' | 'neckTop_m'
  | 'collarID_m' | 'collarOD_m' | 'collarBottoms_m' | 'collarHeight_m' | 'normalTravel_m' | 'headGrossArea_m2'>

/** Actual fixed-pose free sections, including the collar's OUTER bypass. The
 * spider uses its already selected distributed-volume reduction; its frame
 * perimeter is not authored, so that piece has no wall perimeter. */
export function operatingHousingMechanicalGeometry(c: HousingGeometry, travel: number) {
  if (!Number.isFinite(travel) || travel < 0 || travel > c.normalTravel_m) throw Error('Housing mechanical pose outside normal travel')
  const body0 = c.insertedBodyBottom_m + travel, body1 = body0 + c.bodyLength_m,
    spider0 = c.spiderBottom_m + travel, spider1 = spider0 + c.spiderHeight_m,
    stem0 = spider1, stem1 = stem0 + c.stemLength_m,
    mainPlane = (c.headBottom_m + c.housingTop_m) / 2,
    neckPlane = (c.housingTop_m + c.housingCapHeight_m + c.neckTop_m) / 2,
    cuts = [...new Set([c.headBottom_m, c.housingTop_m, c.housingTop_m + c.housingCapHeight_m, c.neckTop_m,
      mainPlane, neckPlane, body0, body1, spider0, spider1, stem0, stem1,
      ...c.collarBottoms_m.flatMap(z => [z, z + c.collarHeight_m])]
      .filter(z => z >= c.headBottom_m && z <= c.neckTop_m))].sort((a, b) => a - b)
  const pieces = cuts.slice(0, -1).map((lo, i) => {
    const hi = cuts[i + 1]!, z = (lo + hi) / 2, main = z < c.housingTop_m,
      gross = c.clusters * Math.PI * (main ? c.housingID_m : c.neckID_m) ** 2 / 4,
      body = z >= body0 && z < body1 ? c.clusters * c.rodletsPerCluster * Math.PI * c.bodyDiameter_m ** 2 / 4 : 0,
      spider = z >= spider0 && z < spider1 ? c.clusters * c.spiderMass_kg / (c.steelDensity_kg_m3 * c.spiderHeight_m) : 0,
      stem = z >= stem0 && z < stem1 ? c.clusters * Math.PI * c.stemDiameter_m ** 2 / 4 : 0,
      collar = c.collarBottoms_m.some(start => z >= start && z < start + c.collarHeight_m)
        ? c.clusters * Math.PI * (c.collarOD_m ** 2 - c.collarID_m ** 2) / 4 : 0,
      area = gross - body - spider - stem - collar, length = hi - lo,
      // Bore, body, stem and both collar faces are authored round surfaces.
      perimeter = c.clusters * Math.PI * ((main ? c.housingID_m : c.neckID_m) + (body ? c.rodletsPerCluster * c.bodyDiameter_m : 0)
        + (stem ? c.stemDiameter_m : 0) + (collar ? c.collarOD_m + c.collarID_m : 0))
    if (![area, length].every(v => Number.isFinite(v) && v > 0)) throw Error('Nonpositive actual housing aperture')
    return { owner: main ? 'HOUSING.MAIN' : 'HOUSING.NECK', start_m: lo, end_m: hi, length_m: length,
      area_m2: area, volume_m3: area * length, inverse_area_length_per_m: length / area,
      collar_outer_bypass: collar > 0, spider_frame: spider > 0, wetted_perimeter_m: spider > 0 ? null : perimeter }
  })
  return { pieces, mainPlane_m: mainPlane, neckPlane_m: neckPlane }
}

/** Sharp-edged fitting laws of Idelchik, Handbook of Hydraulic Resistance,
 * 3rd ed. (1994): sudden contraction (ch. 4) and thin sharp-edged perforated
 * plate (ch. 8), both referred to the narrow/opening velocity; Borda-Carnot
 * sudden expansion from the momentum balance. n and f are free-area ratios. */
export const fittingLoss = {
  contraction: (n: number) => .5 * (1 - n) ** .75,
  expansion: (n: number) => (1 - n) ** 2,
  thinPlate: (f: number) => (.707 * (1 - f) ** .375 + 1 - f) ** 2,
}
const ratio = (n: number) => { if (!(Number.isFinite(n) && n > 0 && n < 1)) throw Error('Fitting area ratio outside (0,1)'); return n }

export type FaceLossTerm = { id: string, loss: number, law: string }
/** A passive loss carried on one mechanical face. Its throughput is that face's
 * own current (coefficient 1) and its force is applied to that face only, the
 * same adjoint pairing as the channel sections' weighted ports. It owns no
 * water, inertia or head: those stay with the face's supports and segments. */
export type FaceLossSection = { id: string, kind: 'face_loss', face: string, region: number,
  parameters: Section['parameters'], terms: FaceLossTerm[], conversionRecipients: Section['conversionRecipients'] }
const faceLossParameters = (piece: { length_m: number, area_m2: number, hydraulic_diameter_m: number, elevation_change_m: number },
  wall: 'none' | 'smooth_pipe' | 'circular_churchill', loss: number, gravity: number): Section['parameters'] =>
  ({ ...piece, gravity_m_s2: gravity, wall, form_loss: loss, grid_count: 0, grid_factor: 0, blockage_fraction: 0, pump: null })
const recipients = (region: number): Section['conversionRecipients'] =>
  (['wall', 'grid', 'form'] as const).map(term => ({ term, region, fraction: 1 }))

/** Housing paths UPPER->HOUSING.MAIN and HOUSING.MAIN->HOUSING.NECK, piece by
 * piece over the same free areas as their inertia supports. Every number comes
 * from the reference-control-absorber record at the compiled pose. Entry/exit
 * fittings use the mean of their two directional coefficients because the
 * native face law is reciprocal; pure contraction/expansion pairs are listed. */
export function compileOperatingHousingLosses(c: HousingGeometry, travel: number, gravity: number, region: (id: string) => number) {
  const h = operatingHousingMechanicalGeometry(c, travel), bore = c.clusters * Math.PI * c.housingID_m ** 2 / 4,
    ring = c.clusters * Math.PI * (c.collarOD_m ** 2 - c.collarID_m ** 2) / 4, L = fittingLoss, out: FaceLossSection[] = []
  for (const [face, lo, hi] of [['UPPER->HOUSING.MAIN', c.headBottom_m, h.mainPlane_m],
    ['HOUSING.MAIN->HOUSING.NECK', h.mainPlane_m, h.neckPlane_m]] as const) {
    for (const p of h.pieces.filter(p => p.start_m >= lo && p.end_m <= hi)) {
      // Coincident body-top/spider-bottom planes leave a sub-nanometre cut.
      if (p.length_m < 1e-9) continue
      const terms: FaceLossTerm[] = []
      if (p.start_m === c.headBottom_m) {
        const n = ratio(p.area_m2 / c.headGrossArea_m2)
        terms.push({ id: 'HEAD.MOUTH', loss: (L.contraction(n) + L.expansion(n)) / 2,
          law: 'mean of sharp contraction from UPPER (inflow) and Borda-Carnot jet into UPPER (outflow), n=A_mouths/headGrossArea' })
      }
      if (p.spider_frame) terms.push({ id: 'SPIDER.FRAME', loss: L.thinPlate(ratio(p.area_m2 / bore)),
        law: 'thin sharp-edged plate at the authored frame porosity A_free/A_bore; frame shape not authored' })
      if (p.start_m === c.housingTop_m) {
        const below = h.pieces.find(q => q.end_m === c.housingTop_m)!, n = ratio(p.area_m2 / below.area_m2)
        terms.push({ id: 'CAP.BORE', loss: (L.contraction(n) + L.expansion(n)) / 2,
          law: 'mean of sharp contraction into the cap bore (inflow) and Borda-Carnot expansion into the housing (outflow)' })
      }
      if (p.collar_outer_bypass) {
        const n = ratio(p.area_m2 / (p.area_m2 + ring))
        terms.push({ id: 'COLLAR', loss: L.contraction(n) + L.expansion(n),
          law: 'sharp contraction plus Borda-Carnot re-expansion through one 0.1 m collar, same in both directions' })
      }
      const wall = p.wetted_perimeter_m === null ? 'none' as const : 'smooth_pipe' as const
      if (wall === 'none' && !terms.length) throw Error('Housing piece without an owned loss')
      const r = region(p.owner)
      out.push({ id: `${face}@${p.start_m.toFixed(6)}`, kind: 'face_loss', face, region: r, terms, conversionRecipients: recipients(r),
        parameters: faceLossParameters({ length_m: p.length_m, area_m2: p.area_m2, elevation_change_m: p.length_m,
          hydraulic_diameter_m: p.wetted_perimeter_m === null ? 0 : 4 * p.area_m2 / p.wetted_perimeter_m },
          wall, sum(terms.map(t => t.loss)), gravity) })
    }
  }
  return out
}

type MomentumSupport = { region: number, path_length_m: number, inverse_area_length_per_m: number, volume_m3: number }
type PressureSegment = { region: number, path_length_m: number, elevation_change_m: number }
type MechanicalFace = { id: string, from: number, to: number, flow_area_m2: number,
  supports: MomentumSupport[], pressure_segments: PressureSegment[] }
type PzrGeometry = Pick<ReturnType<typeof compileOperatingPzr>, 'regions' | 'faces' | 'mouth' | 'radialGeometry' | 'surge' | 'hotPartition'>

/** Coarse local-pressure line losses on the two SURGE faces (surge-route.md).
 * Friction and each elbow stay on their own half route. Each end carries the
 * mean of its two directional coefficients because the native face law is
 * reciprocal; toward-PZR is positive face flow on both faces. */
export function compileOperatingLineLosses(line: Pick<ReturnType<typeof compileOperatingSurgeHydraulics>, 'halves'>,
  pzr: Pick<PzrGeometry, 'surge' | 'regions' | 'mouth' | 'hotPartition'>, branch: { dividingTurnLoss: number }, gravity: number, surge: number) {
  const r = pzr.surge.route, A = r.area_m2, junction = pzr.hotPartition.parts[1]!,
    prism = junction.length_m * Math.sqrt(pzr.hotPartition.area_m2), receiver = pzr.regions[pzr.mouth.region]!.axialArea_m2
  if (!Number.isFinite(branch.dividingTurnLoss) || branch.dividingTurnLoss < 0 || line.halves.length !== 2) throw Error('Invalid surge line loss input')
  const ends = [
    { face: 'HOT.A.JUNCTION->SURGE', id: 'HOT.A.BRANCH', towardPzr: branch.dividingTurnLoss, towardHot: fittingLoss.expansion(ratio(A / prism)),
      law: 'mean of Idelchik 90-degree dividing side-branch factor (toward PZR) and Borda-Carnot line jet into the 1 m junction prism (toward HOT)' },
    { face: 'SURGE->PZR.SURGE.MOUTH', id: 'PZR.MOUTH', towardPzr: fittingLoss.expansion(ratio(A / receiver)), towardHot: r.entryLoss,
      law: 'mean of Borda-Carnot jet into the bottom outer PZR region (toward PZR) and the record entryLoss with CdA=A/sqrt(1+entryLoss) (toward HOT)' },
  ] as const
  return line.halves.map((half, k): FaceLossSection => {
    const end = ends[k]!, terms: FaceLossTerm[] = [
      { id: half.id + '.ELBOW', loss: half.elbowLoss, law: 'route-record elbowLoss at its own half' },
      { id: end.id, loss: (end.towardPzr + end.towardHot) / 2, law: end.law }]
    if (half.hydraulicDiameter_m !== r.internalDiameter_m || half.area_m2 !== A) throw Error('Surge half does not use the actual bore')
    return { id: half.id, kind: 'face_loss', face: end.face, region: surge, terms, conversionRecipients: recipients(surge),
      parameters: faceLossParameters({ length_m: half.length_m, area_m2: A, hydraulic_diameter_m: r.internalDiameter_m,
        elevation_change_m: half.elevationChange_m }, 'circular_churchill', sum(terms.map(t => t.loss)), gravity) }
  })
}

/** Coarse physical path geometry for generalized hydraulic impulse I_Q*Q,
 * I_Q=sum(rho*alpha*integral(ds/A)). Not literal linear momentum, a constant
 * density mass-current metric, or a second pressure projection framework.
 * The same profile projects a region-uniform force with Lsupport/Vregion. */
export function compileOperatingMechanics(primary: { regions: readonly { id: string, volume_m3: number, elevation_m: number }[],
  edges: readonly Edge[], junction: number, surgeStock: { id: string, volume_m3: number, elevation_m: number } },
  hydraulics: { sections: readonly Section[], gravityIncidence: readonly { edge: number, region: number, delta_z_m: number }[] },
  pzr: PzrGeometry, control: HousingGeometry, travel: number, faceLosses: readonly FaceLossSection[]) {
  if (primary.regions.length !== 27 || primary.edges.length !== 33) throw Error('Mechanical map requires actual carved27/33 primary')
  const surge = 27, pzrOffset = 28, regions = [...primary.regions, primary.surgeStock, ...pzr.regions]
    .map(r => ({ id: r.id, volume_m3: r.volume_m3, elevation_m: r.elevation_m })),
    faces: MechanicalFace[] = primary.edges.map(e => ({ ...e, flow_area_m2: Infinity, supports: [], pressure_segments: [] })),
    force_projection: { face: number, region: number, coefficient_per_m2: number, normal: [number, number] }[] = []
  const add = (face: MechanicalFace, region: number, L: number, inverseA: number, V: number, dz = 0) => {
    face.supports.push({ region, path_length_m: L, inverse_area_length_per_m: inverseA, volume_m3: V })
    face.pressure_segments.push({ region, path_length_m: L, elevation_change_m: dz })
    // Reference throat velocity only; current transport is rho_up*alpha_up*Q.
    face.flow_area_m2 = Math.min(face.flow_area_m2, L / inverseA)
  }
  for (const section of hydraulics.sections) for (const side of ['incoming', 'outgoing'] as const) {
    const ports = section.flow.filter(t => side === 'incoming' ? primary.edges[t.edge]!.to === section.region : primary.edges[t.edge]!.from === section.region)
    if (![1, 2].includes(ports.length) || ports.some(t => t.weight !== .5)) throw Error('Unselected primary parallel support geometry')
    const L = section.parameters.length_m / 2, A = section.parameters.area_m2 / ports.length
    for (const port of ports) add(faces[port.edge]!, section.region, L, L / A, L * A)
  }
  // Existing actual heads include massless mixed-plenum reference-plane to
  // mouth segments. They are explicit pressure geometry, not zero-filled pipe
  // inertia and not extra thermal storage.
  for (const head of hydraulics.gravityIncidence) {
    const face = faces[head.edge]!, segment = face.pressure_segments.find(s => s.region === head.region)
    if (segment) segment.elevation_change_m += head.delta_z_m
    else face.pressure_segments.push({ region: head.region, path_length_m: 0, elevation_change_m: head.delta_z_m })
  }
  const housing = operatingHousingMechanicalGeometry(control, travel), index = (id: string) => {
    const i = regions.findIndex(r => r.id === id); if (i < 0) throw Error('Unknown mechanical region ' + id); return i
  }
  for (const owner of ['HOUSING.MAIN', 'HOUSING.NECK']) if (!near(sum(housing.pieces.filter(p => p.owner === owner).map(p => p.volume_m3)), regions[index(owner)]!.volume_m3))
    throw Error('Housing mechanical free volume disagrees with retained stock')
  for (const [from, to, lo, hi] of [
    ['UPPER', 'HOUSING.MAIN', control.headBottom_m, housing.mainPlane_m],
    ['HOUSING.MAIN', 'HOUSING.NECK', housing.mainPlane_m, housing.neckPlane_m],
  ] as const) {
    const face = faces.find(f => f.from === index(from) && f.to === index(to))
    if (!face || face.supports.length) throw Error('Missing or duplicated housing momentum path')
    for (const p of housing.pieces.filter(p => p.start_m >= lo && p.end_m <= hi))
      add(face, index(p.owner), p.length_m, p.inverse_area_length_per_m, p.volume_m3, p.length_m)
    if (from === 'UPPER') face.pressure_segments.unshift({ region: index(from), path_length_m: 0,
      elevation_change_m: control.headBottom_m - regions[index(from)]!.elevation_m })
  }
  const line = compileOperatingSurgeHydraulics(pzr), lateral = pzr.hotPartition.junctionPorts[2]!,
    start: MechanicalFace = { id: 'HOT.A.JUNCTION->SURGE', from: primary.junction, to: surge, flow_area_m2: lateral.area_m2, supports: [], pressure_segments: [] },
    end: MechanicalFace = { id: 'SURGE->PZR.SURGE.MOUTH', from: surge, to: pzrOffset + pzr.mouth.region,
      flow_area_m2: pzr.mouth.area_m2, supports: [], pressure_segments: [] }
  const arm = line.junctionFirstMoment.lateralArm_m
  add(start, primary.junction, arm, arm / lateral.area_m2, arm * lateral.area_m2)
  for (const [face, half] of [[start, line.halves[0]!], [end, line.halves[1]!]] as const)
    for (const p of half.pieces) add(face, surge, p.length_m, p.length_m / p.area_m2, p.volume_m3, p.outletElevation_m - p.inletElevation_m)
  // The retained line's pressure is referred to its volume-mean elevation,
  // not the arclength-midpoint plane. Transfer that reference hydrostatically;
  // this is not a second physical length, inertia or inventory.
  const lineReferenceHead = primary.surgeStock.elevation_m - line.momentumPlane.elevation_m
  start.pressure_segments.push({ region: surge, path_length_m: 0, elevation_change_m: lineReferenceHead })
  end.pressure_segments.unshift({ region: surge, path_length_m: 0, elevation_change_m: -lineReferenceHead })
  const mouth = pzr.regions[pzr.mouth.region]!, mouthLength = mouth.elevation_m - pzr.mouth.elevation_m
  add(end, pzrOffset + pzr.mouth.region, mouthLength, mouthLength / mouth.axialArea_m2, mouthLength * mouth.axialArea_m2, mouthLength)
  faces.push(start, end)
  force_projection.push({ face: 34, region: end.to, coefficient_per_m2: mouthLength / mouth.volume_m3, normal: [0, 1] })
  for (const physical of pzr.faces) {
    const face: MechanicalFace = { id: physical.id, from: pzrOffset + physical.from, to: pzrOffset + physical.to,
      flow_area_m2: physical.area_m2, supports: [], pressure_segments: [] }
    for (const [local, incoming] of [[physical.from, true], [physical.to, false]] as const) {
      const r = pzr.regions[local]!
      if (physical.direction === 'axial') {
        const L = Math.abs(r.elevation_m - physical.elevation_m)
        add(face, pzrOffset + local, L, L / r.axialArea_m2, L * r.axialArea_m2, L)
      } else {
        const boundary = pzr.radialGeometry.innerRadius_m, lo = incoming ? r.radialCentroid_m : boundary,
          hi = incoming ? boundary : r.radialCentroid_m, height = r.top_m - r.bottom_m,
          porosity = r.lane === 'inner' ? r.axialArea_m2 / (Math.PI * boundary ** 2) : 1,
          L = hi - lo, inverseA = Math.log(hi / lo) / (2 * Math.PI * height * porosity),
          V = Math.PI * (hi ** 2 - lo ** 2) * height * porosity
        add(face, pzrOffset + local, L, inverseA, V)
      }
      const s = face.supports.at(-1)!
      force_projection.push({ face: faces.length, region: pzrOffset + local,
        coefficient_per_m2: s.path_length_m / r.volume_m3, normal: [...physical.normal] })
    }
    // Its declared physical throat, not a logarithmic/volume-mean area.
    face.flow_area_m2 = physical.area_m2; faces.push(face)
  }
  if (regions.length !== 38 || faces.length !== 48 || new Set(faces.map(f => f.id)).size !== faces.length
    || regions.some(r => !Number.isFinite(r.volume_m3) || r.volume_m3 <= 0 || !Number.isFinite(r.elevation_m))
    || faces.some(f => !Number.isFinite(f.flow_area_m2) || f.flow_area_m2 <= 0 || !f.supports.length
      || f.supports.some(s => ![s.path_length_m, s.inverse_area_length_per_m, s.volume_m3].every(v => Number.isFinite(v) && v > 0))
      || f.pressure_segments.some(s => !Number.isFinite(s.path_length_m) || s.path_length_m < 0 || !Number.isFinite(s.elevation_change_m))
      || !near(sum(f.pressure_segments.map(s => s.elevation_change_m)), regions[f.to]!.elevation_m - regions[f.from]!.elevation_m)))
    throw Error('Incomplete physical local-pressure path map')
  // Face losses append after the channel sections, each on its own face only.
  // PZR-internal faces own their field drag/interphase laws, never a section.
  const firstPzrFace = primary.edges.length + 2, lossFaces = faceLosses.map(s => {
    const face = faces.findIndex(f => f.id === s.face)
    if (face < 0) throw Error('Unknown face for passive loss ' + s.id)
    if (face >= firstPzrFace) throw Error('A PZR-internal face cannot carry a section loss')
    if (!faces[face]!.supports.some(t => t.region === s.region)) throw Error('Passive loss region does not support its face ' + s.id)
    return face
  })
  const section_force_projection = [...hydraulics.sections.flatMap((s, section) => s.force.map(t => ({ face: t.edge, section, coefficient: t.weight }))),
    ...lossFaces.map((face, k) => ({ face, section: hydraulics.sections.length + k, coefficient: 1 }))]
  const loaded = new Set(section_force_projection.map(t => t.face)),
    unloaded = faces.flatMap((f, i) => i < firstPzrFace && !loaded.has(i) ? [f.id] : [])
  return { regions, faces, force_projection, section_force_projection,
    housing, pressureProfile: 'Current mixture hydrostatic head on each segment plus length-linear dynamic pressure remainder; sharp pure-phase rest shares one reconstructed face pressure.',
    radialProfile: 'Exact annular inverse-area integral between selected positive centroids and lane boundary; uniform existing inner-lane rod porosity reduction.',
    momentumScope: 'Generalized hydraulic impulse; parallel half-paths once per component. HOT lateral y profile overlaps main x water, not a second x inertia or a second junction momentum bank.',
    omittedMomentum: 'Mixed LOWER/UPPER/COLD reservoirs have no invented pipe inertia; closed-end beyond-centroid motion is unresolved at this coarse pressure-cell resolution.',
    lossScope: { liquidFacesWithoutSectionLoss: unloaded, pzrFieldFaces: faces.slice(firstPzrFace).map(f => f.id),
      faceLossFaces: [...new Set(lossFaces)].map(i => faces[i]!.id) },
    scope: 'Physical geometry and force/velocity projection only. No advancement, phase-event, operational-fidelity or performance admission.' }
}

/** Which faces carry which passive losses, and why the rest do not. Lists are
 * derived from the compiled projections; reasons name their wiki owners. */
export function operatingPassiveLossScope(loss: { liquidFacesWithoutSectionLoss: readonly string[], pzrFieldFaces: readonly string[],
  faceLossFaces: readonly string[] }, faceLosses: readonly FaceLossSection[]) {
  return {
    channelSections: 'Primary faces 0-30 keep the 21 channel sections, their weights and owned budgets unchanged (primary-hydraulic-basis.md).',
    faceLossSections: loss.faceLossFaces.map(face => ({ face,
      sections: faceLosses.filter(s => s.face === face).map(s => ({ id: s.id, wall: s.parameters.wall,
        terms: s.terms.map(t => ({ id: t.id, loss: t.loss })) })) })),
    liquidFacesWithoutSectionLoss: [...loss.liquidFacesWithoutSectionLoss],
    pzrFieldFaces: { faces: [...loss.pzrFieldFaces], reason: 'Drag and interphase laws belong to the PZR field; section projections are rejected there.' },
    gasPaths: 'Sections act on the liquid carrier only. Primary/SURGE gas phase paths have no passive drag in this package.',
    notRepresented: [
      'COLD->RETURN entrance and RETURN->DOWN turn/expansion: zero credited loss by owner selection (mechanical-energy-and-geometry.md); geometry estimate K=1.777 is an open design-basis question in primary-hydraulic-basis.md, not adopted.',
      'UPPER->HOT.A/HOT.B nozzle entrance: inside the retained HOT path budget, so no separate coefficient.',
      'HOT.A run-through momentum exchange with surge flow (about 2*rho*w_main*Q_surge/A_main): odd in surge flow, not expressible by a reciprocal face law.',
    ],
    approximations: [
      'Direction-dependent end and fitting coefficients enter as the mean of their two directions because the native face law is reciprocal: surge HOT end +-0.077, PZR end +-0.117, housing mouth +-0.14, cap +-0.22 for one-way flow; exact per symmetric oscillation cycle.',
      'Surge-line friction uses the native smooth circular Churchill law; the selected 1.5 um roughness would raise friction by at most 3.8% to 100 kg/s and 11.5% at 500 kg/s.',
    ],
  }
}

/** Text owned by exactly one heading, excluding fenced code. */
function headingText(text: string, heading: string) {
  const lines = text.split('\n'), headings: { index: number, level: number, title: string }[] = []
  let fenced = false
  for (const [index, line] of lines.entries()) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced
    const m = fenced ? null : /^(#{1,6}) (.+?)\s*$/.exec(line)
    if (m) headings.push({ index, level: m[1]!.length, title: m[2]! })
  }
  const own = headings.filter(h => h.title === heading)
  if (own.length !== 1) throw Error('Expected exactly one heading ' + heading)
  const next = headings.find(h => h.index > own[0]!.index && h.level <= own[0]!.level)
  return lines.slice(own[0]!.index + 1, next?.index).join('\n')
}

/** Owner statements for the declared prepared state. These pages hold their
 * values in reviewed prose, so each must match exactly once under its heading;
 * a reworded or duplicated statement refuses instead of being guessed. */
export const operatingPointSources = {
  pzrRoofPressure_Pa: { page: 'systems/primary-coolant/pressurizer-thermal-state.md', heading: 'Acquisition and initial intent' },
  pzrRoofElevation_m: { page: 'systems/instrumentation/operational-observations.md', heading: 'Primary pressure, inventory and heat transport' },
  pzrLevel_m: { page: 'systems/primary-coolant/inventory-and-chemistry.md', heading: 'Normal inventory controller' },
  rcpSpeedRequest: { page: 'model/connected-primary-initialization.md', heading: 'Current original physical hot preparation' },
} as const
const operatingPointChecks = {
  setpoint: { page: 'systems/primary-coolant/pressure-and-inventory.md', heading: 'Acquired-pressure command comparison' },
  speedVocabulary: { page: 'systems/primary-coolant/pumps-and-support.md', heading: 'Shaft and energy model' },
} as const
export const operatingPointPages = [...new Set([...Object.values(operatingPointSources), ...Object.values(operatingPointChecks)].map(s => s.page))]

/** Declared selections for the prepared state, not targets for any flow. */
export function compileOperatingPoint(docs: Readonly<Record<string, string>>,
  pzr: { regions: readonly { id: string, bottom_m: number, top_m: number }[] }, referenceRpm: number) {
  const phrase = (source: { page: string, heading: string }, pattern: RegExp) => {
    const text = docs[source.page]
    if (text === undefined) throw Error('Missing operating-point owner ' + source.page)
    const found = [...headingText(text, source.heading).matchAll(pattern)]
    if (found.length !== 1) throw Error(`Expected one selected statement in ${source.page} § ${source.heading}`)
    return found[0]![1] ?? ''
  }
  const value = (s: string) => Number(s.replaceAll(',', '')), src = operatingPointSources, check = operatingPointChecks
  const setpoint = value(phrase(src.pzrRoofPressure_Pa, /Retain the pressure setpoint \*\*([0-9][0-9,]*\.[0-9]+) Pa\*\*/g)),
    compared = value(phrase(check.setpoint, /commissioned setpoint ([0-9][0-9,]*\.[0-9]+) Pa/g)),
    roof = value(phrase(src.pzrRoofElevation_m, /Select the PZR PT1\/PT2\/PT3 direct pressure interfaces at the top fluid boundary, \+([0-9]+(?:\.[0-9]+)?) m on the current plant datum/g)),
    level = value(phrase(src.pzrLevel_m, /The candidate target is ([0-9]+(?:\.[0-9]+)?) m at the nominal state\./g)),
    rpm = value(phrase(src.rcpSpeedRequest, /actual supported ([0-9]+) rpm rotor states/g))
  phrase(src.pzrRoofElevation_m, /(LT datum remains the PZR bottom)/g)
  phrase(check.speedVocabulary, /(Commands request zero or nominal speed for the initial operational interface)/g)
  const bottom = Math.min(...pzr.regions.map(r => r.bottom_m)), top = Math.max(...pzr.regions.map(r => r.top_m))
  if (![setpoint, roof, level, rpm, bottom].every(Number.isFinite) || setpoint <= 0 || level <= 0 || level >= top - bottom)
    throw Error('Invalid declared PZR/RCP operating point')
  if (setpoint !== compared) throw Error('PZR pressure setpoint owners disagree')
  if (roof !== top) throw Error('PT1 roof tap is not the compiled PZR top fluid boundary')
  if (rpm !== referenceRpm) throw Error('Prepared RCP speed is not the commissioned nominal speed')
  const surface = bottom + level, below = pzr.regions.filter(r => r.top_m === surface).map(r => r.id),
    above = pzr.regions.filter(r => r.bottom_m === surface).map(r => r.id)
  return { pzrRoofPressure_Pa: setpoint, pzrRoofElevation_m: roof, pzrLevel_m: level, rcpSpeedRequest: 'nominal' as const,
    provenance: { ...src },
    crossChecks: { ...check },
    meaning: {
      pzrRoofPressure_Pa: 'PT1 commissioned proportional-control setpoint: absolute local static pressure at the roof vapor tap, not interface or primary pressure',
      pzrRoofElevation_m: 'Plant-datum elevation of the PT1/PT2/PT3 roof tap; equals the compiled PZR top fluid boundary',
      pzrLevel_m: `Indicated liquid height above the PZR bottom at +${bottom} m plant elevation (LT datum); surface at +${surface} m`,
      rcpSpeedRequest: 'All four supported RCPs request nominal speed, i.e. hydraulics.pump.referenceOmega_rad_s; no second speed value',
    },
    pzrBottomElevation_m: bottom, pzrLevelSurfaceElevation_m: surface,
    pzrLevelRegionBoundary: { onBoundary: below.length > 0 && above.length > 0, below, above },
    scope: 'Declared selections for a consistent prepared state. They are controller/indication setpoints and the supported speed request, not imposed pressures, levels or flows, and not evidence that the preparation is stationary.' }
}

export async function prepareOperatingSpine(wiki: string, if97: string) {
  const base = join(wiki, 'world/packs/process-plant/reference-designs/ld-01'), read = (p: string) => Bun.file(join(base, p)).text()
  const [hot, fuelDoc, handlingDoc, controlDoc, thermalDoc, gapDoc] = await Promise.all([
    prepareOperatingHot(wiki, if97), read('systems/reactor/fuel-construction.md'), read('systems/reactor/fuel-handling-and-pool.md'),
    read('systems/reactor/control-absorber-and-guide-water.md'), read('model/operating-thermal.md'), read('systems/reactor/phase-dependent-heat-transfer.md')])
  const originalThermal = compileOperatingThermal(parseFuelConstruction(fuelDoc), parseFuelHandling(handlingDoc), parseControlAbsorber(controlDoc),
    hot.fluid, hot.energy, parseOperatingThermal(thermalDoc), parseTransferThermal(handlingDoc), parseOperatingFuelGap(gapDoc))
  const hotOwner = hot.fluid.geometry.regions.find(r => r.id === 'HOT.A')!
  const [pzr, originalHydraulics, pointDocs] = await Promise.all([prepareOperatingPzr(wiki, if97, hotOwner), loadOperatingHydraulics(wiki, hot.fluid.geometry),
    Promise.all(operatingPointPages.map(async page => [page, await read(page)] as const)).then(Object.fromEntries) as Promise<Record<string, string>>])
  const operatingPoint = compileOperatingPoint(pointDocs, pzr, originalHydraulics.selection.referenceRpm)
  const carved = carveOperatingPrimary(hot.fluid.primary.regions, hot.fluid.primary.edges, pzr.hotPartition)
  const waterIndex = (old: number) => { const i = carved.regionMap[old]; if (i === undefined || i < 0) throw Error('Thermal/source contact requires an explicit physical repartition'); return i }
  const direct = carved.regions.map(() => 0)
  for (const [i, q] of originalThermal.direct_water_source_w.entries()) {
    if (q !== 0) direct[waterIndex(i)]! += q
  }
  const thermal = { ...originalThermal,
    core_contacts: originalThermal.core_contacts.map(c => ({ ...c, water: waterIndex(c.water) })),
    passive_contacts: originalThermal.passive_contacts.map(c => ({ ...c, water: waterIndex(c.water) })),
    sg_segments: originalThermal.sg_segments.map(c => ({ ...c, primary: waterIndex(c.primary) })),
    water: carved.regions.map(r => ({ id: r.id, pressure_pa: r.water.p, temperature_k: r.water.T,
      volume_m3: r.volume_m3, mass_kg: r.mass_kg, energy_j: r.internalEnergy_J })), direct_water_source_w: direct }
  const projection = preparePressureContinuity(carved.regions, carved.edges, direct, carved.regions.map(() => 0), Array(7).fill(0))
  const source_water = hot.nativeInput.fluid.source_band_to_region.map(waterIndex)
  const nativeFluid = { ...hot.nativeInput.fluid,
    primary_mass_kg: sum(carved.regions.map(r => r.mass_kg)), primary_energy_j: sum(carved.regions.map(r => r.internalEnergy_J)),
    primary_volume_m3: sum(carved.regions.map(r => r.volume_m3)), source_band_to_region: source_water,
    regions: carved.regions.map(r => ({ id: r.id, volume_m3: r.volume_m3, density_kg_m3: r.water.rho, pressure_pa: r.water.p,
      enthalpy_j_kg: r.water.h, specific_internal_energy_j_kg: r.water.u, mass_kg: r.mass_kg, energy_j: r.internalEnergy_J,
      mass_p_at_energy_kg_pa: r.massPAtEnergy_kg_Pa, mass_energy_at_pressure_kg_j: r.massEnergyAtPressure_kg_J })),
    direct_coolant_projection: { heat_w: direct, edges: carved.edges.map(e => ({ from: e.from, to: e.to })),
      donors: projection.donors, flows_kg_s: projection.flows_kg_s, pressure_rate_pa_s: projection.pressureRate_Pa_s } }
  const rebasedHydraulics = rebaseOperatingHydraulics(originalHydraulics, carved),
    hydraulics = { ...rebasedHydraulics, surge: { ...rebasedHydraulics.surge, ...compileOperatingSurgeHydraulics(pzr) } }
  const control = parseControlAbsorber(controlDoc), travel = hot.fluid.geometry.referenceRodTravel_m,
    carvedRegion = (id: string) => { const i = carved.regions.findIndex(r => r.id === id); if (i < 0) throw Error('Unknown carved owner ' + id); return i },
    faceLosses = [...compileOperatingHousingLosses(control, travel, hydraulics.gravity_m_s2, carvedRegion),
      ...compileOperatingLineLosses(hydraulics.surge, pzr, hydraulics.hotBranchLoss, hydraulics.gravity_m_s2, carved.regions.length)]
  const mechanics = compileOperatingMechanics(carved, hydraulics, pzr, control, travel, faceLosses)
  const packetHydraulics = { ...hydraulics, sections: [...hydraulics.sections, ...faceLosses],
    passiveLossScope: operatingPassiveLossScope(mechanics.lossScope, faceLosses) }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { identity: 'LD01-HOT-SPINE-1', thermal, hot: { ...hot.nativeInput, fluid: nativeFluid },
    feedback_metadata: operatingSourceNativeMetadata(hot.compiledSource), feedback_reference: hot.compiledSource.reference.conditions,
    edges: carved.edges, source_water, water_flow_area_m2: carved.regions.map(r => r.mainFlowArea_m2),
    water_boron_amount_kg_eq: carved.regions.map(r => r.absorberTracer_kgEq), hydraulics: packetHydraulics, pzr, mechanics,
    external_ports: {
      surge_stock: carved.surgeStock,
      primary_to_surge: { id: 'HOT.A.JUNCTION->SURGE', primary_water: carved.junction, surge_id: carved.surgeStock.id,
        area_m2: pzr.hotPartition.surgeArea_m2, elevation_m: pzr.hotPartition.elevation_m,
        normal: pzr.hotPartition.junctionPorts[2]!.normal },
      surge_to_pzr: { id: 'SURGE->PZR.SURGE.MOUTH', surge_id: carved.surgeStock.id, pzr_water: pzr.mouth.region,
        area_m2: pzr.mouth.area_m2, elevation_m: pzr.mouth.elevation_m, normal: pzr.mouth.normal },
      receiptRule: 'Signed actual donor material/thermal enthalpy; no prescribed flow, pressure matching or zero-filled external equation',
      scope: 'Finite removed line stock and actual geometry/storage ports; native SURGE provides current signed M/H/B transport. Surge/junction forces, PZR pressure/kinematic/inertia and phase events, and complete unit F remain open.' },
    preparation: { direct_source_projection: projection, operatingPoint,
      scope: 'Preparation-only pressure/enthalpy/continuity check with specified zero cycle currents and no external mass. It is not the joined current-flow solution. operatingPoint declares the selected PZR roof setpoint, level setpoint and RCP speed request for a consistent preparation.' },
    provenance: { sourceSha256: hash(await Bun.file(import.meta.path).text()), hot: hot.provenance, fluid: hot.fluid.provenance,
      hydraulics: originalHydraulics.provenance, pzr: pzr.provenance,
      operatingPoint: operatingPointPages.map(name => ({ name, sha256: hash(pointDocs[name]!) })),
      thermalOwners: ['systems/reactor/fuel-construction.md', 'systems/reactor/fuel-handling-and-pool.md', 'systems/reactor/control-absorber-and-guide-water.md',
        'model/operating-thermal.md', 'systems/reactor/phase-dependent-heat-transfer.md'].map((name, i) => ({ name,
          sha256: hash([fuelDoc, handlingDoc, controlDoc, thermalDoc, gapDoc][i]!) })) },
    scope: 'Connected current source/finite-thermal/primary residual inputs, with explicit external surge/PZR dependencies. No held-pressure, complete mechanical, global-rank or trajectory admission.' }
}

if (import.meta.main) {
  const [wiki, if97] = Bun.argv.slice(2)
  if (!wiki || !if97 || Bun.argv.length !== 4) throw Error('Usage: operating-spine <wiki root> <pinned IF97 directory>')
  console.log(JSON.stringify(await prepareOperatingSpine(wiki, if97)))
}
