/** S2 zero-time probe Z3, part 2: the relief-bounded post-trip coolant
 * envelope, the film drop at bounding decay-plus-pump duties under the
 * selected SG contact laws (zero time, stationary local wall balance), IF97
 * density ratios, and the minimal domain extension with its 25 % margin on
 * the excursion, now checked against D3 (a)'s `ld01-post-trip-domain` block.
 * Moved from the research directory (operating-joined-spine-s2/zero-time/
 * z3-trip-envelope.ts, receipt z3-trip-envelope-receipt.json) with its
 * numerics unchanged; the source domains and the extension are read from the
 * kinetics owner page. The film-drop roots use the research Python
 * environment (SciPy, CoolProp) through the SG contact implementation
 * (reference-design-sg-service-contact.ts), as the SG contact receipts do.
 * A zero-time calculation, not a trajectory.
 *
 * Usage: bun reference-design-operating-post-trip-envelope.ts <wiki root> <research-python> <if97-dir>
 *   <z2-receipt> <post-trip-margins-receipt> <out.json> */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {sgServiceContactPython} from './reference-design-sg-service-contact'
import {sgContactBasis} from './reference-design-sg-contact'
import {gasConstants} from './reference-design-service-pump-mixture'
import {withOperatingIf97} from './reference-design-operating-fluid'
import {parseOperatingPostTripDomain, parseOperatingSource} from './reference-design-operating-source'

const kineticsPage = 'world/packs/process-plant/reference-designs/ld-01/systems/reactor/kinetics.md'
const [wiki, python, if97Dir, z2Path, z3Path, output, ...rest] = Bun.argv.slice(2)
if (!wiki || !python || !if97Dir || !z2Path || !z3Path || !output || rest.length) throw Error('Usage: see header')
if (await Bun.file(output).exists()) throw Error('Receipts are never overwritten: ' + output)
const kinetics = await Bun.file(join(wiki, kineticsPage)).text(), source = parseOperatingSource(kinetics),
  postTrip = parseOperatingPostTripDomain(kinetics, source)
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
const z2 = JSON.parse(await Bun.file(z2Path).text()), z3 = JSON.parse(await Bun.file(z3Path).text())
const atPower_Pa: number = z2.results[0].root.secondaryPressure_Pa
const eq = Object.fromEntries(z3.pzr.equilibrium.map((e: {outsurge_m3: number, endPressure_Pa: number}) => [e.outsurge_m3, e.endPressure_Pa]))
const relief_Pa = [6.6e6, 6.8e6, 7.0e6] // steam-power/admission-and-protection.md:63 (reseat 6.6, crack 6.8, full lift 7.0)
const pumpHeat_W = 17.197720e6 // model/station-balance.md:110 (primary fluid shaft work; RCPs assumed running)
const reactor_W = 3000e6, kernelFractionSum = 0.065 // model/station-balance.md:110; systems/reactor/heat-and-history.md:199
const duties = {pumpOnly_W: pumpHeat_W / 2, kernelMaxPlusPump_W: (kernelFractionSum * reactor_W + pumpHeat_W) / 2}
const flow = 9167.294305 // model/station-balance.md:202
const primaryPressure_Pa: number = eq[9] // Z3 equilibrium end pressure at 9 m3 (film is weakly pressure dependent)
const calc = String.raw`
import sys,io,json,math,contextlib
payload=json.load(sys.stdin);ns={'__name__':'sg_service_contact'}
sys.stdin=io.StringIO(json.dumps(payload['input']));buf=io.StringIO()
with contextlib.redirect_stdout(buf):
 exec(compile(payload['source'],'reference-design-sg-service-contact.ts:sgServiceContactPython','exec'),ns)
from scipy.optimize import brentq
sat=ns['sat'];contacted=ns['contacted'];primary_contact=ns['primary_contact'];liquid_prop=ns['liquid_prop'];D=ns['D'];A=ns['A'];eps=ns['eps'];pr=payload['probe']
def duty(ps,Tp,pp,m):
 s=dict(p=pp,T=Tp,pv=0,rhoSteam=0,alphaLiquid=1,rhoMixture=liquid_prop('D',pp,Tp));Ts=sat(ps)['T']
 Tw=brentq(lambda Tw:-primary_contact(s,Tw,m)['heatIntoFluid_W_m2']-contacted(ps,Ts,Tw,D,epsilon=eps)[0],Ts,Tp,xtol=1e-12,rtol=1e-15,maxiter=500)
 return A*contacted(ps,Ts,Tw,D,epsilon=eps)[0],Tw
rows=[]
for ps in pr['relief']:
 Ts=sat(ps)['T']
 for name,Q in pr['duties'].items():
  for pp in pr['primaryPressures']:
   Tp=brentq(lambda T:duty(ps,T,pp,pr['flow'])[0]-Q,Ts+1e-6,Ts+40,xtol=1e-11,rtol=1e-15,maxiter=500)
   Qa,Tw=duty(ps,Tp,pp,pr['flow'])
   rows.append(dict(secondaryPressure_Pa=ps,duty=name,dutyPerSG_W=Q,achievedDuty_W=Qa,primaryPressure_Pa=pp,heosSaturation_K=Ts,primary_K=Tp,wall_K=Tw,drop_K=Tp-Ts,filmDrop_K=Tp-Tw,boilingSuperheat_K=Tw-Ts))
print(json.dumps(dict(rows=rows),sort_keys=True,allow_nan=False))
`
const payload = {source: sgServiceContactPython, input: {contact: sgContactBasis, gas: gasConstants},
  probe: {relief: relief_Pa, duties, flow, primaryPressures: [primaryPressure_Pa, 15.2e6]}}
const proc = Bun.spawn([python, '-c', calc], {stdin: new Blob([JSON.stringify(payload)]), stdout: 'pipe', stderr: 'pipe'})
const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
if (code) throw Error(err)
const film = JSON.parse(out).rows as {secondaryPressure_Pa: number, duty: string, primaryPressure_Pa: number, drop_K: number}[]
const dropAt = (ps: number, d: string) => film.find(r => r.secondaryPressure_Pa === ps && r.duty === d && r.primaryPressure_Pa === primaryPressure_Pa)!.drop_K
const ref = {upper: 679.3368894359069, lower: 715.3052293172567} // systems/reactor/kinetics.md, Selected hot reference coefficient package
const res = await withOperatingIf97(if97Dir, async query => {
  const sats = await query([atPower_Pa, ...relief_Pa].map(p => ({branch: 'sat-liquid', p, T: 0})))
  const Tsat = Object.fromEntries([atPower_Pa, ...relief_Pa].map((p, k) => [p, sats[k]!.T]))
  const envelope = {
    zeroDutyFloor_K: Tsat[6.6e6]!, pumpOnlyFloor_K: Tsat[6.6e6]! + dropAt(6.6e6, 'pumpOnly_W'),
    kernelMaxFloor_K: Tsat[6.6e6]! + dropAt(6.6e6, 'kernelMaxPlusPump_W'),
    pumpOnlyTop_K: Tsat[7.0e6]! + dropAt(7.0e6, 'pumpOnly_W'), kernelMaxTop_K: Tsat[7.0e6]! + dropAt(7.0e6, 'kernelMaxPlusPump_W')}
  const ps = [eq[12]!, eq[9]!, 14e6, 15e6, 15.2e6]
  const pts = Object.entries(envelope).flatMap(([name, T]) => ps.map(p => ({name, T, p})))
  const d = await query(pts.map(q => ({branch: 'liquid', p: q.p, T: q.T})))
  const ratios = pts.map((q, k) => ({temperature: q.name, T_C: q.T - 273.15, pressure_Pa: q.p, rho_kg_m3: d[k]!.rho, upperRatio: d[k]!.rho / ref.upper, lowerRatio: d[k]!.rho / ref.lower}))
  return {Tsat, envelope, ratios}
})
const ext = (current: number, envelope: number, sign: 1 | -1) => ({current, envelope, excursion: sign * (envelope - current),
  envelopePlus25pct: current + 1.25 * (envelope - current), coveredNow: sign * (envelope - current) <= 0})
const r = (name: string, p: number) => res.ratios.find((x: {temperature: string, pressure_Pa: number}) => x.temperature === name && x.pressure_Pa === p)!.upperRatio
const [densityMax, pressureMin] = [source.densityRatioDomain[1], source.pressureDomain_Pa[0]]
const extension = {
  densityRatioUpper_pumpOnlyFloor_at15_2MPa: ext(densityMax, r('pumpOnlyFloor_K', 15.2e6), 1),
  densityRatioUpper_zeroDutyFloor_at15_2MPa: ext(densityMax, r('zeroDutyFloor_K', 15.2e6), 1),
  densityRatioUpper_pumpOnlyFloor_atEq9m3: ext(densityMax, r('pumpOnlyFloor_K', eq[9]!), 1),
  pressureFloor_eq9m3: ext(pressureMin, eq[9]!, -1), pressureFloor_eq12m3: ext(pressureMin, eq[12]!, -1),
}
// D3 (a): each selected limit must cover its envelope plus 25 % of the excursion.
const covering = {
  densityRatioMax: {selected: postTrip.densityRatioMax, required: extension.densityRatioUpper_zeroDutyFloor_at15_2MPa.envelopePlus25pct,
    covers: postTrip.densityRatioMax >= extension.densityRatioUpper_zeroDutyFloor_at15_2MPa.envelopePlus25pct},
  pressureMin_Pa: {selected: postTrip.pressureMin_Pa, required: extension.pressureFloor_eq12m3.envelopePlus25pct,
    covers: postTrip.pressureMin_Pa <= extension.pressureFloor_eq12m3.envelopePlus25pct},
}
const receipt = {probe: 'Z3 addendum: relief-bounded post-trip coolant envelope, density ratios and minimal domain extension (zero time)',
  sourceSha256: hash(await Bun.file(import.meta.path).text()), script: 'apps/world/scripts/reference-design-operating-post-trip-envelope.ts',
  wiki: {root: wiki, kineticsSha256: hash(kinetics)}, calculationSha256: hash(calc), importedImplementationSha256: hash(sgServiceContactPython),
  parents: {z2: hash(await Bun.file(z2Path).text()), z3: hash(await Bun.file(z3Path).text())},
  inputs: {atPowerSecondaryPressure_Pa: atPower_Pa, relief_Pa, duties, flow, primaryPressure_Pa, ref, sources: {
    relief: 'systems/steam-power/admission-and-protection.md:63', pumpHeat: 'model/station-balance.md:110', reactor: 'model/station-balance.md:110',
    kernelFractionSum: 'systems/reactor/heat-and-history.md:199 (kernel fractions sum to 0.065; used only as an upper decay bound)',
    flow: 'model/station-balance.md:202', references: 'systems/reactor/kinetics.md, Selected hot reference coefficient package',
    domains: 'systems/reactor/kinetics.md reference-operating-source block', postTripDomain: 'systems/reactor/kinetics.md ld01-post-trip-domain block'}},
  filmAtDuty: film, ...res, extension, postTripDomain: {selected: postTrip, covering}}
await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({Tsat: Object.fromEntries(Object.entries(res.Tsat).map(([k, v]) => [k, (v as number) - 273.15])),
  envelope_C: Object.fromEntries(Object.entries(res.envelope).map(([k, v]) => [k, (v as number) - 273.15])),
  drops: film.map(f => [f.secondaryPressure_Pa / 1e6, f.duty, f.primaryPressure_Pa / 1e6, +f.drop_K.toFixed(4)]), extension, covering}))
