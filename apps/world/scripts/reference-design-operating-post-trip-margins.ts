/** S2 zero-time probe Z3, part 1: post-trip moderator density-ratio and PZR
 * equilibrium-expansion margins against the kinetics source domains (D3 (a)).
 * Moved from the research directory (operating-joined-spine-s2/zero-time/
 * z3-post-trip-margins.ts, receipt z3-post-trip-margins-receipt.json) with its
 * numerics unchanged; the density-ratio and pressure domains are now read from
 * the kinetics owner page's `reference-operating-source` block.
 *
 * Maintained IF97 through the hash-verified adapter (withOperatingIf97). The
 * PZR path is the reversible open-vessel equilibrium path: V fixed, saturated
 * liquid leaves at the current pressure (dM=-dm, dU=-h_f dm), so the total
 * entropy of vessel plus departed liquid is conserved. It is an upper bound on
 * pressure (maximum flashing). A zero-time property calculation, not a
 * trajectory; the cited inputs below are the owner pages' recorded values.
 *
 * Usage: bun reference-design-operating-post-trip-margins.ts <wiki root> <if97-dir> <receipt.json> */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {withOperatingIf97} from './reference-design-operating-fluid'
import {parseOperatingSource} from './reference-design-operating-source'

const kineticsPage = 'world/packs/process-plant/reference-designs/ld-01/systems/reactor/kinetics.md'
type P = {rho: number, u: number, h: number, T: number, p: number, cp: number, alpha: number, kappa: number, saturationSlope: number}
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')

if (import.meta.main) {
const [wiki, if97Dir, output, ...rest] = Bun.argv.slice(2)
if (!wiki || !if97Dir || !output || rest.length) throw Error('Usage: post-trip-margins <wiki root> <if97-dir> <receipt.json>')
if (await Bun.file(output).exists()) throw Error('Receipts are never overwritten: ' + output)
const scripts = import.meta.dir
const kinetics = await Bun.file(join(wiki, kineticsPage)).text(), source = parseOperatingSource(kinetics)
const ref = {upper: {rho: 679.3368894359069, T: 593.15}, lower: {rho: 715.3052293172567, T: 578.15}, p: 15.2e6} // systems/reactor/kinetics.md "Selected hot reference coefficient package" (numerical hot reference)
const densityRatioDomain = [...source.densityRatioDomain], pressureDomain = [...source.pressureDomain_Pa], bound = densityRatioDomain[1]!
const pressures = [13.0e6, 13.5e6, 14.0e6, 14.5e6, 15.0e6], temps = Array.from({length: 21}, (_, k) => 280 + k + 273.15)
const pzr = {p0: 14864186.8055, // primary-coolant/pressurizer-thermal-state.md:229 (task-supplied start; saturated)
  level0_m: 6.0, height_m: 12, // pressurizer-thermal-state.md:96 (gross 5 m2 x 12 m, bottom +6.5 m)
  rodDiameter_m: 0.02, normal: {n: 32, top_m: 1}, backup: {n: 256, top_m: 3}, // heater-equipment.md:11-12
  outsurge_m3: [5, 9, 10, 12]}
const rodArea = (n: number) => n * Math.PI * (pzr.rodDiameter_m / 2) ** 2
const bands = [{z0: 0, z1: 1, A: 5 - rodArea(32 + 256)}, {z0: 1, z1: 3, A: 5 - rodArea(256)}, {z0: 3, z1: 12, A: 5}] // heater-equipment.md:16
const volBelow = (z: number) => bands.reduce((v, b) => v + b.A * Math.max(0, Math.min(z, b.z1) - b.z0), 0)
const levelOf = (V: number) => { let z = 0; for (const b of bands) { const cap = b.A * (b.z1 - b.z0); if (V <= cap) return z + V / b.A; V -= cap; z = b.z1 } throw Error('liquid above vessel') }
const Vvessel = volBelow(12), Vl0 = volBelow(pzr.level0_m)
if (Math.abs(Vvessel - 59.7486726) > 1e-7 || Math.abs(Vl0 - 29.7486726) > 1e-7) throw Error('PZR geometry does not reproduce wiki volumes')

const result = await withOperatingIf97(if97Dir, async query => {
  // 1. reference reproduction and density grid
  const [ru, rl] = await query([{branch: 'liquid', p: ref.p, T: ref.upper.T}, {branch: 'liquid', p: ref.p, T: ref.lower.T}])
  const refCheck = {upper: ru!.rho, lower: rl!.rho, upperExact: ru!.rho === ref.upper.rho, lowerExact: rl!.rho === ref.lower.rho}
  if (!refCheck.upperExact || !refCheck.lowerExact) throw Error('Reference densities not reproduced by maintained IF97')
  const grid = await query(pressures.flatMap(p => temps.map(T => ({branch: 'liquid', p, T}))))
  const table = pressures.map((p, i) => ({pressure_Pa: p, rows: temps.map((T, j) => { const rho = grid[i * temps.length + j]!.rho
    return {T_C: T - 273.15, rho_kg_m3: rho, upperRatio: rho / ref.upper.rho, lowerRatio: rho / ref.lower.rho} })}))
  // crossing temperature of ratio 1.1 by batched bisection on [500, 600] K (liquid branch)
  const probs = pressures.flatMap(p => (['upper', 'lower'] as const).map(band => ({p, band, target: bound * ref[band].rho, lo: 500, hi: 600})))
  for (let it = 0; it < 60; it++) {
    const mids = probs.map(q => (q.lo + q.hi) / 2), r = await query(probs.map((q, k) => ({branch: 'liquid', p: q.p, T: mids[k]!})))
    probs.forEach((q, k) => { if (r[k]!.rho > q.target) q.lo = mids[k]!; else q.hi = mids[k]! })
  }
  const crossings = probs.map(q => ({pressure_Pa: q.p, band: q.band, densityAtBound_kg_m3: q.target, crossing_C: (q.lo + q.hi) / 2 - 273.15, bracketWidth_K: q.hi - q.lo}))
  // 2. PZR equilibrium open-vessel path, integrated in p with RK4 on a precomputed node table
  const pEnd = 9.0e6, h = 500, steps = Math.ceil((pzr.p0 - pEnd) / h)
  const nodes = Array.from({length: 2 * steps + 1}, (_, k) => pzr.p0 - k * h / 2)
  const sat = await query(nodes.flatMap(p => [{branch: 'sat-liquid', p, T: 0}, {branch: 'sat-vapor', p, T: 0}]))
  const coef = nodes.map((p, k) => { const f = sat[2 * k]!, g = sat[2 * k + 1]!
    const dv = (q: P) => -(q.kappa - q.alpha * q.saturationSlope) / q.rho
    const du = (q: P) => (q.p * q.kappa - q.T * q.alpha) / q.rho + (q.cp - q.p * q.alpha / q.rho) * q.saturationSlope
    return {p, T: f.T, vf: 1 / f.rho, vg: 1 / g.rho, uf: f.u, ug: g.u, hf: f.h, hg: g.h, dvf: dv(f), dvg: dv(g), duf: du(f), dug: du(g)} })
  type C = typeof coef[number]
  // y=[Ml,Mv,mout,Vout]; derivative w.r.t. p (negative steps)
  const eq = (c: C, y: number[]) => { const [Ml, Mv] = y as [number, number]
    const a11 = c.vf, a12 = c.vg, b1 = -(Ml * c.dvf + Mv * c.dvg), a21 = -c.p * c.vf, a22 = c.ug - c.hf, b2 = -(Ml * c.duf + Mv * c.dug)
    const det = a11 * a22 - a12 * a21, dMl = (b1 * a22 - a12 * b2) / det, dMv = (a11 * b2 - a21 * b1) / det, dm = -(dMl + dMv)
    return [dMl, dMv, dm, dm / (1 / c.vf)] }
  // frozen-liquid adiabatic bound: z=[Mg,Mc,Vv]
  const fr = (c: C, z: number[]) => { const [Mg, Mc] = z as [number, number]
    const dMg = -(Mg * (c.dug + c.p * c.dvg) + Mc * (c.duf + c.p * c.dvf)) / (c.hg - c.hf)
    return [dMg, -dMg, (c.vg - c.vf) * dMg + (Mg * c.dvg + Mc * c.dvf)] }
  const c0 = coef[0]!, Ml0 = Vl0 / c0.vf, Mv0 = (Vvessel - Vl0) / c0.vg, U0 = Ml0 * c0.uf + Mv0 * c0.ug
  const integrate = (stride: number, f: (c: C, y: number[]) => number[], y0: number[]) => {
    const hh = -h * stride, path = [{k: 0, y: y0}]; let y = y0
    for (let k = 0; k + 2 * stride < nodes.length; k += 2 * stride) {
      const a = coef[k]!, m = coef[k + stride]!, b = coef[k + 2 * stride]!
      const k1 = f(a, y), k2 = f(m, y.map((v, i) => v + hh / 2 * k1[i]!)), k3 = f(m, y.map((v, i) => v + hh / 2 * k2[i]!)), k4 = f(b, y.map((v, i) => v + hh * k3[i]!))
      y = y.map((v, i) => v + hh / 6 * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!)); path.push({k: k + 2 * stride, y})
    }
    return path }
  const at = (path: {k: number, y: number[]}[], idx: number, target: number) => {
    for (let i = 1; i < path.length; i++) { const a = path[i - 1]!, b = path[i]!
      if ((a.y[idx]! - target) * (b.y[idx]! - target) <= 0) { const w = (target - a.y[idx]!) / (b.y[idx]! - a.y[idx]!)
        return {p: nodes[a.k]! + w * (nodes[b.k]! - nodes[a.k]!), y: a.y.map((v, j) => v + w * (b.y[j]! - v)), c: coef[b.k]!} } }
    throw Error('outsurge target beyond integrated pressure range') }
  const eqFine = integrate(1, eq, [Ml0, Mv0, 0, 0]), eqCoarse = integrate(2, eq, [Ml0, Mv0, 0, 0])
  const last = eqFine[eqFine.length - 1]!, cl = coef[last.k]!
  const massDefect = last.y[0]! + last.y[1]! + last.y[2]! - (Ml0 + Mv0)
  const volumeDefect = last.y[0]! * cl.vf + last.y[1]! * cl.vg - Vvessel
  const equilibrium = pzr.outsurge_m3.map(V => { const f = at(eqFine, 3, V), g = at(eqCoarse, 3, V)
    const liquidVolume = f.y[0]! * f.c.vf
    return {outsurge_m3: V, endPressure_Pa: f.p, endPressureCoarseStepDifference_Pa: f.p - g.p, saturation_C: f.c.T - 273.15,
      depressurization_Pa: pzr.p0 - f.p, outsurgeMass_kg: f.y[2]!, liquidMass_kg: f.y[0]!, vaporMass_kg: f.y[1]!, liquidVolume_m3: liquidVolume,
      level_m: levelOf(liquidVolume), flashedOrContractedLiquidVolume_m3: Vl0 - V - liquidVolume} })
  const frFine = integrate(1, fr, [Mv0, 0, Vvessel - Vl0]), frCoarse = integrate(2, fr, [Mv0, 0, Vvessel - Vl0])
  const frozen = pzr.outsurge_m3.map(V => { const f = at(frFine, 2, Vvessel - Vl0 + V), g = at(frCoarse, 2, Vvessel - Vl0 + V)
    return {outsurge_m3: V, endPressure_Pa: f.p, endPressureCoarseStepDifference_Pa: f.p - g.p, condensedInVapor_kg: f.y[1]!,
      level_m: levelOf(Vl0 - V + f.y[1]! * f.c.vf)} })
  return {refCheck, table, crossings, pzr: {initial: {p_Pa: pzr.p0, T_C: c0.T - 273.15, liquidVolume_m3: Vl0, vaporVolume_m3: Vvessel - Vl0,
    fluidVolume_m3: Vvessel, liquidMass_kg: Ml0, vaporMass_kg: Mv0, internalEnergy_J: U0}, stepPa: h, endIntegrationPressure_Pa: nodes[last.k],
    closure: {massDefect_kg: massDefect, volumeDefect_m3: volumeDefect}, equilibrium, frozenLiquidAdiabatic: frozen}}
})
const deps = ['reference-design-operating-fluid.ts', 'reference-design-if97-primitives.ts']
const receipt = {probe: 'Z3 post-trip domain margins (zero time; maintained IF97 via withOperatingIf97)',
  sourceSha256: hash(await Bun.file(import.meta.path).text()), script: 'apps/world/scripts/reference-design-operating-post-trip-margins.ts',
  wiki: {root: wiki, kineticsSha256: hash(kinetics)},
  dependencies: Object.fromEntries(await Promise.all(deps.map(async n => [n, hash(await Bun.file(join(scripts, n)).text())]))),
  inputs: {ref, bound, densityRatioDomain, pressureDomain, pressures, temperatures_K: temps, pzr, bands, sources: {
    references: 'systems/reactor/kinetics.md, Selected hot reference coefficient package', domains: 'systems/reactor/kinetics.md reference-operating-source block',
    pzrStart: 'systems/primary-coolant/pressurizer-thermal-state.md:229 (task-supplied saturated start, level 6.00 m)',
    vessel: 'systems/primary-coolant/pressurizer-thermal-state.md:96 (5 m2 x 12 m gross, fluid 59.7486726 m3); :189 (29.7486726 / 30 m3 at the 6 m split)',
    rods: 'systems/primary-coolant/heater-equipment.md:11-12, :16 (32 rods 0-1 m, 256 rods 0-3 m, 20 mm)'}},
  ...result}
await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({output, crossings: result.crossings.map((c: {pressure_Pa: number, band: string, crossing_C: number}) => [c.pressure_Pa / 1e6, c.band, +c.crossing_C.toFixed(4)]),
  eq: result.pzr.equilibrium.map((e: {outsurge_m3: number, endPressure_Pa: number, level_m: number, endPressureCoarseStepDifference_Pa: number}) => [e.outsurge_m3, +(e.endPressure_Pa / 1e6).toFixed(6), +e.level_m.toFixed(4), e.endPressureCoarseStepDifference_Pa]),
  frozen: result.pzr.frozenLiquidAdiabatic.map((e: {outsurge_m3: number, endPressure_Pa: number, level_m: number}) => [e.outsurge_m3, +(e.endPressure_Pa / 1e6).toFixed(6), +e.level_m.toFixed(4)]),
  closure: result.pzr.closure}))
}
