/** Actual finite prepared-hot inputs for the compact operating path. No fine
 * model import, stationary plant solve, trajectory, or water-property fit. */
import {createHash} from 'node:crypto'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {z} from 'zod'
import {parseBalanceBasis} from './reference-design-balance'
import {parseSurgeRoute,resolveSurgeRoute} from './reference-design-surge-route'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {parseFuelHandling, fuelHandlingChecks, fuelAssemblyPositions, fuelLatticeSites} from './reference-design-fuel-handling'
import {parseControlAbsorber, controlAbsorberGeometry} from './reference-design-control-absorber'
import {nativeIf97Primitives, nativeIf97Revision, nativeIf97HeaderSha256, nativeIf97LicenseSha256} from './reference-design-if97-primitives'
import {parseSgContact,sgContactOwner} from './reference-design-sg-contact-law'

export type WaterPoint={region:number,p:number,T:number,rho:number,u:number,h:number,cp:number,cv:number,
  w:number,alpha:number,kappa:number,mu:number,conductivity:number,saturationSlope:number}
export type PropertyQuery={branch:'liquid'|'vapor'|'sat-liquid'|'sat-vapor',p:number,T:number}
const finite=(v:number)=>{if(!Number.isFinite(v))throw Error('Nonfinite hot reference');return v}
const positive=(v:number)=>{if(finite(v)<=0)throw Error('Nonpositive hot reference');return v}
const sum=(v:readonly number[])=>v.reduce((a,b)=>a+b,0)
const overlap=(a:number,b:number,c:number,d:number)=>Math.max(0,Math.min(b,d)-Math.max(a,c))
const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
const hotSchema=z.object({primaryPressure_Pa:z.number().min(1e5).max(16e6),achievedRodTravel_m:z.number().finite().nonnegative(),
  boronReference_ppmEq:z.number().finite().nonnegative(),gapAccommodationReferenceTemperature_K:z.number().positive(),
  initialLoopMassflow_kg_s:z.literal(0),sgMetalSegments:z.literal(4)}).strict()
const positiveNumber=z.number().finite().positive(),finiteNumber=z.number().finite()
const record=z.record(z.string(),z.unknown())
/** The steady solid state at the reference power (G18 by S2-D2, SG metal by
 * S2-D3), as the native stock-IDA `prepare_steady_solids` writes it (schema
 * frozen by the SOLIDS lane at 033d69e5). Consumed: every store's steady
 * temperature and energy, every half's surfaces and each carrier's Doppler
 * reference, all by packet id. Its method, basis, admission, reached state,
 * checkpoints and IDA counters are recorded, never consumed. */
export const steadySolidsSchema=z.object({identity:z.literal('LD01-STEADY-SOLIDS-1'),
  packet_identity:z.string(),thermal_identity:z.string(),method:record,basis:record,
  carriers:z.array(z.object({id:z.string().min(1),fuel_store_ids:z.tuple([z.string(),z.string()]),clad_store_id:z.string(),
    fuel_temperatures_k:z.tuple([positiveNumber,positiveNumber]),fuel_energies_j:z.tuple([finiteNumber,finiteNumber]),
    clad_temperature_k:positiveNumber,clad_energy_j:finiteNumber,
    surface_temperatures_k:z.tuple([positiveNumber,positiveNumber,positiveNumber]),doppler_reference_k:positiveNumber,
    fuel_heat_w:finiteNumber,rates_w:z.tuple([finiteNumber,finiteNumber,finiteNumber]),
    surface_residuals_w:z.tuple([finiteNumber,finiteNumber,finiteNumber]),gap:record}).strict()),
  helium:z.array(z.object({id:z.string().min(1),temperature_k:positiveNumber,energy_j:finiteNumber,pressure_pa:positiveNumber,rate_w:finiteNumber}).strict()),
  passive:z.array(z.object({id:z.string().min(1),temperature_k:positiveNumber,energy_j:finiteNumber,rate_w:finiteNumber}).strict()),
  sg_metal:z.array(z.object({id:z.string().min(1),generator:z.string(),temperature_k:positiveNumber,energy_j:finiteNumber,
    primary_to_metal_w:finiteNumber,metal_to_secondary_w:finiteNumber,rate_w:finiteNumber}).strict()),
  steam_generators:z.array(record),admission:record,steady:record,checkpoints:z.array(record),ida:record}).strict()
export type SteadySolids=z.infer<typeof steadySolidsSchema>
/** Where the prepared solid stocks come from: the steady solid state, or the
 * explicit seed of its own solve. The seed puts every core solid store at
 * the prepared core outlet water temperature and each SG metal segment at
 * the mean of its primary inlet water and secondary saturation; it is the
 * stock-IDA settle's initial state only, and the spine compiler never emits
 * a packet prepared from it. No temperature is authored either way. */
export type SolidPreparation={kind:'provisional'}|{kind:'steady',steady:SteadySolids}
type ResolvedSolids={kind:'provisional',coreSeed_K:number,sgMetalSeed_K:number}|{kind:'steady',steady:SteadySolids}
/** Domain admission of one computed solid node, in place of the removed
 * authored-temperature bounds: the node's own law domain, named on refusal.
 * Nothing is clipped. */
export function admitSolidNode(id:string,T:number,domain:readonly [number,number]){
  if(!Number.isFinite(T)||T<domain[0]||T>domain[1])throw Error(`Solid node ${id} at ${T} K is outside its admitted ${domain[0]}--${domain[1]} K`)
  return T
}
/** The caloric laws' admitted domains (thermal.rs owns the laws). */
export const solidDomains_K={fuel:[290,2000],zircaloy:[290,1800]} as const
function jsonBlock(text:string,name:string){
  const rows=[...text.matchAll(new RegExp('^```'+name+'\\s*\\n([\\s\\S]*?)^```\\s*$','gm'))]
  if(rows.length!==1)throw Error('Expected one '+name+' block')
  return JSON.parse(rows[0]![1]!) as unknown
}
export const parseOperatingHotReference=(text:string)=>hotSchema.parse(jsonBlock(text,'reference-operating-hot'))
type Physical={downVolume_m3:number,hotVolume_m3:number,sgPrimaryVolume_m3:number,pumpVolume_m3:number,
  coldHeaderVolume_m3:number,pumpDiameter_m:number,hotDiameter_m:number,returnLength_m:number,sgLength_m:number,
  surgeLength_m:number,surgeDiameter_m:number,surgeElevation_m:number,inlet_K:number,outlet_K:number}

/** Direct SI port of the existing reviewed fuelMaterialPython hf/cpf and
 * hc/cpc laws, with their 300 K caloric datum. Not a new material fit. */
export function operatingFuelCaloric(T:number){
  if(!Number.isFinite(T)||T<290||T>2000)throw Error('Fuel caloric domain 290--2000 K')
  const primitive=(t:number)=>296.7*535.285/Math.expm1(535.285/t)+.0243*t*t/2+8.745e7*Math.exp(-1.577e5/(8.3143*t)),
    q=535.285/T,cp=296.7*q*q*Math.exp(q)/Math.expm1(q)**2+.0243*T+8.745e7*1.577e5/(8.3143*T*T)*Math.exp(-1.577e5/(8.3143*T))
  return {specificEnergy_J_kg:primitive(T)-primitive(300),cp_J_kg_K:positive(cp)}
}
export function operatingCladCaloric(T:number){
  if(!Number.isFinite(T)||T<290||T>1800)throw Error('Cladding caloric domain 290--1800 K')
  const knots=[300,400,640,1090,1093,1113,1133,1153,1173,1193,1213,1233,1248,2098],
    values=[281,302,331,375,502,590,615,719,816,770,619,469,356,356]
  if(T<300)return {specificEnergy_J_kg:281*(T-300)+.105*(T-300)**2,cp_J_kg_K:281+.21*(T-300)}
  let energy=0,cp=values[0]!
  for(let i=0;i<knots.length-1;i++){
    const width=Math.max(0,Math.min(T,knots[i+1]!)-knots[i]!),slope=(values[i+1]!-values[i]!)/(knots[i+1]!-knots[i]!)
    energy+=width*(values[i]!+.5*slope*width)
    if(T>=knots[i]!&&T<=knots[i+1]!)cp=values[i]!+slope*width
  }
  return {specificEnergy_J_kg:energy,cp_J_kg_K:positive(cp)}
}

/** One caloric stock at temperature `T`: its energy from the steady solve
 * (the native law's own state, checked against this port of its primitive
 * to 1e-10 relative) or, for the seed, from this port. */
function stock(id:string,mass_kg:number,T:number,caloric:(T:number)=>{specificEnergy_J_kg:number,cp_J_kg_K:number},energy_J?:number){
  const c=caloric(T),own=mass_kg*c.specificEnergy_J_kg
  if(energy_J!==undefined&&Math.abs(energy_J-own)>1e-10*Math.max(Math.abs(own),mass_kg*1e3))
    throw Error(`Steady stock ${id} energy ${energy_J} J disagrees with the caloric primitive's ${own} J at ${T} K`)
  return {temperature_K:T,energy_J:energy_J??own,capacity_J_K:mass_kg*c.cp_J_kg_K}
}
/** One lookup per steady store list: unique ids, every id found, and (by
 * `covered`) every row consumed exactly once. */
function steadyRows<T extends {id:string}>(rows:readonly T[],label:string){
  const m=new Map(rows.map(r=>[r.id,r] as const)),used=new Set<string>()
  if(m.size!==rows.length)throw Error('Duplicate steady '+label)
  return {get:(id:string)=>{const r=m.get(id);if(!r)throw Error(`Missing steady ${label} ${id}`);used.add(id);return r},
    covered:()=>{if(used.size!==m.size)throw Error(`The steady ${label} list holds ${m.size-used.size} store(s) the preparation does not own`)}}
}
/** The Doppler law's own fuel measure of two equal-mass nodes. */
export const fuelFeedbackTemperature=(inner_K:number,outer_K:number)=>((Math.sqrt(inner_K)+Math.sqrt(outer_K))/2)**2
export type ResolvedSolidPreparation=ResolvedSolids
export function prepareOperatingMaterials(f:Fuel,h:Handling,solids:ResolvedSolids){
  const g=fuelHandlingChecks(h,f),
    gasVolume=f.rodsPerAssembly*Math.PI*(((f.rodOuterDiameter_m/2-f.cladThickness_m)**2-(f.pelletDiameter_m/2)**2)*f.activeLength_m+
      (f.rodOuterDiameter_m/2-f.cladThickness_m)**2*f.plenumLength_m),nR=f.fillPressure_Pa*gasVolume/f.referenceTemperature_K,
    fuelMass=g.assembly.fuel_kg/2,cladMass=g.assembly.activeClad_kg/2,
    steady=solids.kind==='steady'?{carrier:steadyRows(solids.steady.carriers,'carrier'),helium:steadyRows(solids.steady.helium,'helium'),
      passive:steadyRows(solids.steady.passive,'passive store')}:undefined,
    seed=solids.kind==='provisional'?solids.coreSeed_K:NaN,{fuel,zircaloy}=solidDomains_K
  const carriers=fuelAssemblyPositions(h,f).flatMap(fa=>[0,1].map(half=>{
    const id=fa.id+`/segment/${half}`,st=steady?.carrier.get(id),
      nodes=[0,1].map(radial=>({radial,mass_kg:fuelMass/2,...stock(`${id}/fuel/${radial}`,fuelMass/2,
        admitSolidNode(`${id}/fuel/${radial}`,st?st.fuel_temperatures_k[radial]!:seed,fuel),operatingFuelCaloric,st?.fuel_energies_j[radial])})),
      surfaces=st?st.surface_temperatures_k.map((T,k)=>admitSolidNode(`${id}/${['fuel-surface','clad-inner','clad-outer'][k]}`,T,k===0?fuel:zircaloy)):[seed,seed,seed],
      measure=fuelFeedbackTemperature(nodes[0]!.temperature_K,nodes[1]!.temperature_K)
    // The reference is the law's own measure of the same steady nodes: the
    // native value, checked here against its definition.
    if(st&&(st.fuel_store_ids.some((store,k)=>store!==`${id}/fuel/${k}`)||st.clad_store_id!==`${id}/clad`))
      throw Error(`Steady carrier ${id} names other stores`)
    if(st&&!(Math.abs(st.doppler_reference_k-measure)<=1e-12*measure))
      throw Error(`Steady Doppler reference of ${id} (${st.doppler_reference_k} K) is not its nodes' [mean sqrt T]^2 (${measure} K)`)
    return {id,faId:fa.id,half,fuelNodes:nodes,
      clad:{mass_kg:cladMass,...stock(`${id}/clad`,cladMass,admitSolidNode(`${id}/clad`,st?st.clad_temperature_k:seed,zircaloy),operatingCladCaloric,st?.clad_energy_j)},
      surfaceSeed_K:surfaces,dopplerReference_K:st?st.doppler_reference_k:measure}
  }))
  const passive=fuelAssemblyPositions(h,f).flatMap(fa=>[
      ...[{name:'LOWER',length:h.bottomFittingLength_m},{name:'CORE.1',length:f.activeLength_m/2},
        {name:'CORE.2',length:f.activeLength_m/2},{name:'UPPER',length:f.plenumLength_m+h.topFittingLength_m}]
        .map(span=>({id:fa.id+'/guide/'+span.name,mass_kg:g.assembly.guide_kg*span.length/g.assembly.fullLength_m})),
      {id:fa.id+'/plenum-clad',mass_kg:g.assembly.plenumClad_kg},
      {id:fa.id+'/bottom-fitting',mass_kg:h.bottomFitting_kg},
      {id:fa.id+'/top-fitting',mass_kg:h.topFitting_kg},
    ].map(p=>{const st=steady?.passive.get(p.id)
      return {...p,...stock(p.id,p.mass_kg,admitSolidNode(p.id,st?st.temperature_k:seed,zircaloy),operatingCladCaloric,st?.energy_j)}}))
  const helium=fuelAssemblyPositions(h,f).map(fa=>{
    const id=fa.id+'/helium',st=steady?.helium.get(id),T=st?st.temperature_k:seed,energy=1.5*nR*T
    if(!(Number.isFinite(T)&&T>0))throw Error(`Helium ${id} at ${T} K is not a positive temperature`)
    if(st&&(Math.abs(st.energy_j-energy)>1e-10*energy||Math.abs(st.pressure_pa-nR*T/gasVolume)>1e-10*st.pressure_pa))
      throw Error(`Steady helium ${id} energy or pressure disagrees with 1.5 nRT and nRT/V`)
    return {id,volume_m3:gasVolume,nR_J_K:nR,temperature_K:T,pressure_Pa:nR*T/gasVolume,energy_J:st?st.energy_j:energy,capacity_J_K:1.5*nR}
  })
  if(steady){steady.carrier.covered();steady.helium.covered();steady.passive.covered()}
  return {carriers,passive,helium,solids:solids.kind,
    scope:solids.kind==='steady'?'Two equal-area fuel nodes and one clad per material half, one sealed helium per FA and every passive store at the steady solid state of the reference power (G18, stock-IDA settle S2-D2)'
      :'SEED ONLY: every core solid store at the prepared core outlet water temperature, the stock-IDA settle\'s initial state; never emitted'}
}

const querySource=String.raw`
#include <algorithm>
#include <cmath>
#include <iostream>
#include <iomanip>
#include <stdexcept>
void require(bool ok,const std::string& message) { if(!ok) throw std::domain_error(message); }
double max_forward_p=0,max_dense_endpoint_p_error=0;
${nativeIf97Primitives}
int main(){ try {
 std::string branch; double p,T; std::cout<<std::setprecision(17);
 while(std::cin>>branch>>p>>T){
  require(p>=1e5 && p<=16e6,"Hot pilot pressure domain 0.1--16 MPa");
  State q=branch=="sat-liquid"?endpoint(p,true):branch=="sat-vapor"?endpoint(p,false):
    branch=="liquid"?liquid(T,p):branch=="vapor"?vapor(T,p):throw std::domain_error("Unknown branch");
  require(q.region==1||q.region==2,"Hot pilot admits only maintained IF97 R1/R2");
  std::cout<<"{\"region\":"<<q.region<<",\"p\":"<<q.p<<",\"T\":"<<q.T
   <<",\"rho\":"<<q.rho<<",\"u\":"<<q.u<<",\"h\":"<<q.h<<",\"cp\":"<<q.cp
   <<",\"cv\":"<<q.cv<<",\"w\":"<<q.w<<",\"alpha\":"<<q.alpha<<",\"kappa\":"<<q.kappa
   <<",\"mu\":"<<q.mu<<",\"conductivity\":"<<q.conductivity
   <<",\"saturationSlope\":"<<saturation_slope(p)<<"}\n";
 }
 require(std::cin.eof(),"Malformed query"); return 0;
 }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;} }
`

/** Compile one bounded preparation executable against independently acquired,
 * hash-verified upstream IF97; caller never supplies a substitute EOS. */
export async function withOperatingIf97<T>(directory:string,body:(query:(rows:readonly PropertyQuery[])=>Promise<WaterPoint[]>)=>Promise<T>){
  const [header,license]=await Promise.all(['IF97.h','LICENSE'].map(name=>Bun.file(join(directory,name)).arrayBuffer()))
  if(hash(new Uint8Array(header!))!==nativeIf97HeaderSha256||hash(new Uint8Array(license!))!==nativeIf97LicenseSha256)
    throw Error('Pinned upstream IF97 header/license mismatch')
  const work=await mkdtemp(join(tmpdir(),'ld01-operating-fluid-')),executable=join(work,'properties')
  try{
    const compile=Bun.spawn(['c++','-std=c++17','-O2','-I',directory,'-x','c++','-o',executable,'-'],
      {stdin:new Blob([querySource]),stdout:'pipe',stderr:'pipe'})
    const [out,err,status]=await Promise.all([new Response(compile.stdout).text(),new Response(compile.stderr).text(),compile.exited])
    if(status!==0)throw Error(err||out||'IF97 preparation compiler failed')
    const query=async(rows:readonly PropertyQuery[])=>{
      for(const q of rows)if(!['liquid','vapor','sat-liquid','sat-vapor'].includes(q.branch)||!Number.isFinite(q.p)||!Number.isFinite(q.T))throw Error('Invalid IF97 query')
      const child=Bun.spawn([executable],{stdin:new Blob([rows.map(q=>`${q.branch} ${q.p} ${q.T}\n`).join('')]),stdout:'pipe',stderr:'pipe'})
      const [output,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
      if(code!==0)throw Error(error||'IF97 hot preparation query failed')
      const result=output.trim()?output.trim().split('\n').map(line=>JSON.parse(line) as WaterPoint):[]
      if(result.length!==rows.length||result.some(q=>Object.values(q).some(v=>!Number.isFinite(v))))throw Error('Malformed IF97 property result')
      return result
    }
    return await body(query)
  }finally{await rm(work,{recursive:true,force:true})}
}

/** Exact Gibbs identities, not differenced or fitted water derivatives. */
export function waterPartials(q:WaterPoint){
  positive(q.rho);positive(q.cp);positive(q.kappa)
  return {rhoP:q.rho*q.kappa,rhoT:-q.rho*q.alpha,
    uP:(q.p*q.kappa-q.T*q.alpha)/q.rho,uT:q.cp-q.p*q.alpha/q.rho,
    hP:(1-q.T*q.alpha)/q.rho,hT:q.cp}
}
export function fixedVolumeChart(volume_m3:number,q:WaterPoint){
  positive(volume_m3)
  const d=waterPartials(q),mass=volume_m3*q.rho,energy=mass*q.u,
    mP=volume_m3*d.rhoP,mT=volume_m3*d.rhoT,
    eP=volume_m3*(d.rhoP*q.u+q.rho*d.uP),eT=volume_m3*(d.rhoT*q.u+q.rho*d.uT)
  if(!Number.isFinite(eT)||eT===0)throw Error('Singular fixed-volume energy coordinate')
  const A=mP-mT*eP/eT,B=mT/eT
  return {mass_kg:mass,internalEnergy_J:energy,rhoP_kg_m3_Pa:d.rhoP,rhoT_kg_m3_K:d.rhoT,
    uP_J_kg_Pa:d.uP,uT_J_kg_K:d.uT,energyP_J_Pa:eP,energyT_J_K:eT,
    massPAtEnergy_kg_Pa:finite(A),massEnergyAtPressure_kg_J:finite(B)}
}

/** Existing SG pure-water equilibrium chart: differential total M/U;
 * algebraic p and occupied liquid V. No duplicate phase mass integrator. */
export function saturatedVolumeChart(V:number,Vl:number,l:WaterPoint,v:WaterPoint){
  positive(V);if(!Number.isFinite(Vl)||Vl<0||Vl>V||l.p!==v.p||l.T!==v.T||l.region!==1||v.region!==2)throw Error('Invalid saturated chart')
  const dl=waterPartials(l),dv=waterPartials(v),s=l.saturationSlope,
    rlP=dl.rhoP+dl.rhoT*s,rvP=dv.rhoP+dv.rhoT*s,
    ulP=dl.uP+dl.uT*s,uvP=dv.uP+dv.uT*s,
    mP=Vl*rlP+(V-Vl)*rvP,mV=l.rho-v.rho,
    eP=Vl*(rlP*l.u+l.rho*ulP)+(V-Vl)*(rvP*v.u+v.rho*uvP),eV=l.rho*l.u-v.rho*v.u,
    determinant=mP*eV-mV*eP
  if(!Number.isFinite(determinant)||determinant===0)throw Error('Singular saturation chart')
  return {volume_m3:V,liquidVolume_m3:Vl,steamVolume_m3:V-Vl,pressure_Pa:l.p,temperature_K:l.T,
    liquidMass_kg:Vl*l.rho,steamMass_kg:(V-Vl)*v.rho,mass_kg:Vl*l.rho+(V-Vl)*v.rho,
    internalEnergy_J:Vl*l.rho*l.u+(V-Vl)*v.rho*v.u,
    derivative:{mP,mV,eP,eV,determinant,pressureMass:eV/determinant,pressureEnergy:-mV/determinant},
    phaseStatus:Vl===0?'steam-only-boundary':Vl===V?'liquid-only-boundary':'two-phase'}
}

type Fuel=ReturnType<typeof parseFuelConstruction>
type Handling=ReturnType<typeof parseFuelHandling>
type Control=ReturnType<typeof parseControlAbsorber>
export type FluidGeometryInput={fuel:Fuel,handling:Handling,control:Control,achievedRodTravel_m:number,physical:Physical}
const sectorNames=['NE','NW','SW','SE'] as const
function sectorShares(x:number,y:number,r:number){
  // This original seated regular lattice has circles either wholly on one
  // side, or centered exactly on an axis. Refuse a partially shifted scene.
  if((x!==0&&Math.abs(x)<r)||(y!==0&&Math.abs(y)<r))throw Error('Not the selected seated axis-aligned reference')
  const east=x===0?.5:x>0?1:0,north=y===0?.5:y>0?1:0
  return [east*north,(1-east)*north,(1-east)*(1-north),east*(1-north)]
}
export function operatingFluidGeometry({fuel:f,handling:h,control:c,achievedRodTravel_m:y,physical:p}:FluidGeometryInput){
  if(!Object.values(p).every(value=>Number.isFinite(value)&&value>0)||p.outlet_K<=p.inlet_K)throw Error('Invalid physical hot spine input')
  if(!Number.isFinite(y)||y<0||y>c.normalTravel_m)throw Error('Hot reference rod travel outside admitted normal geometry')
  const fg=fuelHandlingChecks(h,f),cg=controlAbsorberGeometry(c,f,h),fa=fuelAssemblyPositions(h,f),pins=fuelLatticeSites(f),
    pitch=f.latticeSide*f.pitch_m,gi=h.guideInnerDiameter_m/2,ro=f.rodOuterDiameter_m/2,
    guideWall=Math.PI*((f.guideOuterDiameter_m/2)**2-gi**2),bodyA=Math.PI*(c.bodyDiameter_m/2)**2,
    bodyBottom=c.insertedBodyBottom_m+y,bodyTop=bodyBottom+c.bodyLength_m,
    gross=[0,0,0,0],solid=[0,0,0,0],externalSolid=[0,0,0,0],body=[0,0,0,0],wet=[0,0,0,0],
    materialContacts:{carrierId:string,coolant:number,cladArea_m2:number}[]=[]
  for(const a of fa){
    const shares=sectorShares(a.x_m,a.y_m,pitch/2),localWet=[0,0,0,0]
    for(let k=0;k<4;k++)gross[k]!+=shares[k]!*pitch**2
    for(const pin of pins){
      const shares=sectorShares(a.x_m+pin.x,a.y_m+pin.y,pin.r),A=pin.guide?guideWall:Math.PI*ro**2
      for(let k=0;k<4;k++){
        solid[k]!+=shares[k]!*A;externalSolid[k]!+=shares[k]!*Math.PI*pin.r**2
        if(!pin.guide){wet[k]!+=shares[k]!*2*Math.PI*ro;localWet[k]!+=shares[k]!*2*Math.PI*ro}
      }
    }
    for(let k=0;k<4;k++)if(localWet[k]!>0)for(let half=0;half<2;half++)
      materialContacts.push({carrierId:a.id+`/segment/${half}`,coolant:2*k+half,cladArea_m2:localWet[k]!*2})
  }
  for(const a of cg.sites)for(const pin of cg.bodySites){
    const shares=sectorShares(a.x_m+pin.x_m,a.y_m+pin.y_m,c.bodyDiameter_m/2)
    for(let k=0;k<4;k++)body[k]!+=shares[k]!*bodyA
  }
  const regions:{id:string,volume_m3:number,elevation_m:number,temperature_K:number,mainFlowArea_m2:number}[]=[]
  for(let k=0;k<4;k++)for(let band=0;band<2;band++){
    const z0=-2+2*band,z1=z0+2,source=Math.PI*(h.sourceThimbleDiameter_m/2)**2*2/4,
      volume=(gross[k]!-solid[k]!)*2-source-body[k]!*overlap(z0,z1,bodyBottom,bodyTop)
    regions.push({id:`CORE.${sectorNames[k]}.${band+1}`,volume_m3:positive(volume),elevation_m:(z0+z1)/2,
      temperature_K:band===0?(p.inlet_K+p.outlet_K)/2:p.outlet_K,mainFlowArea_m2:positive(gross[k]!-externalSolid[k]!)})
  }
  const N=c.clusters*c.rodletsPerCluster,spiderV=c.clusters*c.spiderMass_kg/c.steelDensity_kg_m3,
    stemA=c.clusters*Math.PI*(c.stemDiameter_m/2)**2,spiderBottom=c.spiderBottom_m+y,stemBottom=spiderBottom+c.spiderHeight_m,
    displacement=(lo:number,hi:number)=>N*bodyA*overlap(lo,hi,bodyBottom,bodyTop)+
      spiderV/c.spiderHeight_m*overlap(lo,hi,spiderBottom,stemBottom)+stemA*overlap(lo,hi,stemBottom,stemBottom+c.stemLength_m),
    add=(id:string,V:number,z:number,T:number,A=0)=>regions.push({id,volume_m3:positive(V),elevation_m:z,temperature_K:T,mainFlowArea_m2:A})
  add('DOWN',p.downVolume_m3,0,p.inlet_K,p.downVolume_m3/6)
  add('LOWER',fg.freshGeometry.lower.totalFreeVolume_m3-displacement(-4,-2),-3,p.inlet_K)
  add('UPPER',fg.freshGeometry.upper.totalFreeVolume_m3-displacement(2,4),3,p.outlet_K)
  const pumpA=Math.PI*p.pumpDiameter_m**2/4,returnV=2*pumpA*p.returnLength_m,
    foldR=(p.sgLength_m-18.5)/(Math.PI-2),up=9.5-foldR,down=9-foldR,center=12-foldR,
    foldMean=(up*(2.5+center)/2+down*(3+center)/2+foldR*(Math.PI*center+2*foldR))/p.sgLength_m
  positive(foldR);positive(up);positive(down)
  for(const side of ['A','B']){
    add(`HOT.${side}`,p.hotVolume_m3,2.5,p.outlet_K,Math.PI*p.hotDiameter_m**2/4)
    add(`SG.${side}.PRIMARY`,p.sgPrimaryVolume_m3,foldMean,p.inlet_K,p.sgPrimaryVolume_m3/p.sgLength_m)
    for(const pump of [1,2])add(`PUMP.${side}${pump}`,p.pumpVolume_m3,3,p.inlet_K,pumpA)
    add(`COLD.${side}`,p.coldHeaderVolume_m3,3,p.inlet_K)
    add(`RETURN.${side}`,returnV,3,p.inlet_K,2*pumpA)
  }
  add('HOUSING.MAIN',cg.head.grossMainWater_m3-displacement(c.headBottom_m,c.housingTop_m),(c.headBottom_m+c.housingTop_m)/2,p.outlet_K)
  // grossNeckWater includes the cap bore. Subtract its actual stem occupancy
  // from the same bottom plane, not only from the cap's upper surface.
  add('HOUSING.NECK',cg.head.grossNeckWater_m3-cg.head.collarDisplacement_m3-displacement(c.housingTop_m,c.neckTop_m),(c.housingTop_m+c.housingCapHeight_m+c.neckTop_m)/2,p.outlet_K)
  add('SURGE',Math.PI*p.surgeDiameter_m**2/4*p.surgeLength_m,p.surgeElevation_m,p.outlet_K,Math.PI*p.surgeDiameter_m**2/4)
  const edges:{id:string,from:number,to:number}[]=[],index=(id:string)=>{const n=regions.findIndex(r=>r.id===id);if(n<0)throw Error('Unknown fluid owner');return n},
    edge=(a:string,b:string)=>edges.push({id:`${a}->${b}`,from:index(a),to:index(b)})
  edge('DOWN','LOWER')
  for(const sector of sectorNames){edge('LOWER',`CORE.${sector}.1`);edge(`CORE.${sector}.1`,`CORE.${sector}.2`);edge(`CORE.${sector}.2`,'UPPER')}
  for(const side of ['A','B']){
    edge('UPPER',`HOT.${side}`);edge(`HOT.${side}`,`SG.${side}.PRIMARY`)
    for(const pump of [1,2]){edge(`SG.${side}.PRIMARY`,`PUMP.${side}${pump}`);edge(`PUMP.${side}${pump}`,`COLD.${side}`)}
    edge(`COLD.${side}`,`RETURN.${side}`);edge(`RETURN.${side}`,'DOWN')
  }
  edge('UPPER','HOUSING.MAIN');edge('HOUSING.MAIN','HOUSING.NECK');edge('HOT.A','SURGE')
  return {regions,edges,cycleCount:edges.length-regions.length+1,coreWetArea_m2:wet.map(p=>p*2),materialContacts,
    activeGuideWallMass_kg:f.assemblies*f.guidesPerAssembly*guideWall*f.activeLength_m*f.cladDensity_kg_m3,
    fuelMass_kg:f.assemblies*fg.assembly.fuel_kg,activeCladMass_kg:f.assemblies*fg.assembly.activeClad_kg,
    fullGuideMass_kg:f.assemblies*fg.assembly.guide_kg,plenumCladMass_kg:f.assemblies*fg.assembly.plenumClad_kg,
    fittingMass_kg:f.assemblies*fg.assembly.fittings_kg,referenceRodTravel_m:y,
    totalVolume_m3:sum(regions.map(r=>r.volume_m3)),coreWaterVolume_m3:sum(regions.slice(0,8).map(r=>r.volume_m3)),
    guideBoresThermallyMixed:true,guideBoresNotMainFlowArea:true}
}

/** Deterministic tree incidence; all non-tree columns remain named cycle
 * currents. Only two main-loop cycles are retained momentum coordinates;
 * the other five require current algebraic resistance equations at the join. */
export function fluidTree(regions:readonly {id:string}[],edges:readonly {from:number,to:number}[],gauge=0){
  if(!Number.isInteger(gauge)||gauge<0||gauge>=regions.length)throw Error('Invalid pressure gauge')
  if(new Set(regions.map(r=>r.id)).size!==regions.length||edges.some(e=>!Number.isInteger(e.from)||!Number.isInteger(e.to)
    ||e.from<0||e.to<0||e.from>=regions.length||e.to>=regions.length||e.from===e.to))throw Error('Invalid primary incidence')
  const seen=new Set([gauge]),parent=regions.map(()=>-1),parentEdge=regions.map(()=>-1),order=[gauge]
  for(let j=0;j<order.length;j++)for(const [e,edge]of edges.entries()){
    const n=edge.from===order[j]?edge.to:edge.to===order[j]?edge.from:-1
    if(n>=0&&!seen.has(n)){seen.add(n);parent[n]=order[j]!;parentEdge[n]=e;order.push(n)}
  }
  if(seen.size!==regions.length)throw Error('Disconnected primary pressure territory')
  const tree=new Set(parentEdge.filter(e=>e>=0)),cycles=edges.map((_,i)=>i).filter(e=>!tree.has(e))
  return {gauge,parent,parentEdge,order,cycles}
}

/** Solve divergence(q)=rate for a tree, with explicit non-tree currents. */
export function treeContinuity(regions:readonly {id:string}[],edges:readonly {from:number,to:number}[],rates:readonly number[],cycleCurrents:readonly number[]){
  const t=fluidTree(regions,edges),q=edges.map(()=>0),remaining=[...rates]
  if(rates.length!==regions.length||cycleCurrents.length!==t.cycles.length||![...rates,...cycleCurrents].every(Number.isFinite))throw Error('Bad primary continuity input')
  for(const [j,e]of t.cycles.entries()){
    q[e]=cycleCurrents[j]!;const edge=edges[e]!;remaining[edge.from]!+=q[e]!;remaining[edge.to]!-=q[e]!
  }
  for(const n of t.order.slice(1).reverse()){
    const e=t.parentEdge[n]!,edge=edges[e]!,sign=edge.to===n?1:-1
    q[e]=remaining[n]!/sign;remaining[t.parent[n]!]!+=remaining[n]!
  }
  if(Math.abs(remaining[t.gauge]!)>1e-10*Math.max(1,sum(rates.map(Math.abs))))throw Error('Nonconservative primary continuity rates')
  return q
}

type PressureRegion={id:string,massPAtEnergy_kg_Pa:number,massEnergyAtPressure_kg_J:number,water:{h:number}}
/** Simultaneous differentiated volume/energy constraints. Energy rates contain
 * the very enthalpy fluxes being solved: this is NOT sequential Pdot then flow.
 * Diagnostic dense elimination is only a finite preparation/rank check. */
export function pressureContinuityProjection(regions:readonly PressureRegion[],edges:readonly {from:number,to:number}[],
  heat_W:readonly number[],externalMass_kg_s:readonly number[],cycleCurrents:readonly number[],donors:readonly number[]){
  const t=fluidTree(regions,edges),N=regions.length,treeEdges=t.parentEdge.filter(e=>e>=0)
  if(heat_W.length!==N||externalMass_kg_s.length!==N||cycleCurrents.length!==t.cycles.length||donors.length!==edges.length
    ||![...heat_W,...externalMass_kg_s,...cycleCurrents].every(Number.isFinite)
    ||regions.some(r=>![r.massPAtEnergy_kg_Pa,r.massEnergyAtPressure_kg_J,r.water?.h].every(Number.isFinite))
    ||edges.some((e,i)=>donors[i]!==e.from&&donors[i]!==e.to))throw Error('Invalid simultaneous pressure projection input')
  const matrix=regions.map((r,i)=>[r.massPAtEnergy_kg_Pa*1e6,...treeEdges.map(e=>{
    const edge=edges[e]!,sign=edge.to===i?1:edge.from===i?-1:0
    return sign*(r.massEnergyAtPressure_kg_J*regions[donors[e]!]!.water.h-1)
  })])
  const rhs=regions.map((r,i)=>externalMass_kg_s[i]!-r.massEnergyAtPressure_kg_J*heat_W[i]!)
  for(const [j,e]of t.cycles.entries()){
    const edge=edges[e]!,h=regions[donors[e]!]!.water.h,q=cycleCurrents[j]!
    for(const [i,sign]of [[edge.from,-1],[edge.to,1]])rhs[i!]!-=sign!*(regions[i!]!.massEnergyAtPressure_kg_J*h-1)*q
  }
  const a=matrix.map((row,i)=>[...row,rhs[i]!]),pivots:number[]=[]
  for(let j=0;j<N;j++){
    let k=j;for(let i=j+1;i<N;i++)if(Math.abs(a[i]![j]!)>Math.abs(a[k]![j]!))k=i
    const pivot=Math.abs(a[k]![j]!),scale=Math.max(...matrix.map(row=>Math.abs(row[j]!)))
    if(!Number.isFinite(pivot)||pivot<=1e-12*Math.max(scale,1e-30))throw Error('Singular simultaneous pressure/continuity chart')
    pivots.push(pivot/scale);[a[j],a[k]]=[a[k]!,a[j]!]
    for(let i=j+1;i<N;i++){
      const f=a[i]![j]!/a[j]![j]!
      for(let c=j;c<=N;c++)a[i]![c]!-=f*a[j]![c]!
    }
  }
  const x=Array<number>(N).fill(0)
  for(let i=N-1;i>=0;i--){let r=a[i]![N]!;for(let j=i+1;j<N;j++)r-=a[i]![j]!*x[j]!;x[i]=r/a[i]![i]!}
  const flows=edges.map(()=>0);for(const [j,e]of treeEdges.entries())flows[e]=x[j+1]!
  for(const [j,e]of t.cycles.entries())flows[e]=cycleCurrents[j]!
  const energyRates=[...heat_W],massRates=[...externalMass_kg_s]
  for(const [e,edge]of edges.entries()){
    const q=flows[e]!,h=regions[donors[e]!]!.water.h
    energyRates[edge.from]!-=q*h;energyRates[edge.to]!+=q*h
    massRates[edge.from]!-=q;massRates[edge.to]!+=q
  }
  const pressureRate=x[0]!*1e6,defects=regions.map((r,i)=>r.massPAtEnergy_kg_Pa*pressureRate+r.massEnergyAtPressure_kg_J*energyRates[i]!-massRates[i]!)
  const donorBranchConsistent=edges.every((edge,e)=>flows[e]===0||donors[e]===(flows[e]!>0?edge.from:edge.to))
  return {pressureRate_Pa_s:pressureRate,flows_kg_s:flows,energyRates_W:energyRates,massRates_kg_s:massRates,donorBranchConsistent,
    maxConstraintDefect_kg_s:Math.max(...defects.map(Math.abs)),minimumScaledPivot:Math.min(...pivots),matrix,treeEdges,
    scope:'Fixed donor active branch and specified cycle currents; not hydraulic resistance/momentum closure or full DAE rank'}
}

/** Bounded preparation-only active-donor selection. No time integration,
 * nonlinear plant solver or clipped flux; a repeated branch fails visibly. */
export function preparePressureContinuity(regions:readonly PressureRegion[],edges:readonly {from:number,to:number}[],
  heat_W:readonly number[],externalMass_kg_s:readonly number[],cycleCurrents:readonly number[]){
  let donors=edges.map(e=>e.from)
  const visited=new Set<string>()
  for(let branchChecks=1;branchChecks<=edges.length+1;branchChecks++){
    const key=donors.join(',')
    if(visited.has(key))throw Error('Pressure preparation donor branch cycle')
    visited.add(key)
    const result=pressureContinuityProjection(regions,edges,heat_W,externalMass_kg_s,cycleCurrents,donors)
    if(result.donorBranchConsistent)return {...result,donors,branchChecks}
    donors=edges.map((e,i)=>result.flows_kg_s[i]!>=0?e.from:e.to)
  }
  throw Error('Pressure preparation donor branch limit')
}

export async function prepareOperatingFluid(directory:string,if97Directory:string,sourceHeat_W:number,solids:SolidPreparation){
  positive(sourceHeat_W)
  const root='world/packs/process-plant/reference-designs/ld-01/',files=['systems/reactor/fuel-construction.md','systems/reactor/fuel-handling-and-pool.md','systems/reactor/control-absorber-and-guide-water.md',
      'model/operating-hot-reference.md','numerical-basis.md','systems/primary-coolant/mechanical-energy-and-geometry.md','model/connected-primary-initialization.md','systems/primary-coolant/surge-route.md',
      sgContactOwner.page],
    documents=await Promise.all(files.map(f=>Bun.file(join(directory,root,f)).text())),
    reference=parseOperatingHotReference(documents[3]!),balance=parseBalanceBasis(documents[4]!),
    mechanics=z.object({pumpPassageInsideDiameter_m:z.number().positive(),pumpPassageVolume_m3:z.number().positive(),
      hotInsideDiameter_m:z.number().positive(),coldHeaderVolume_m3:z.number().positive(),coldReturnLength_m:z.number().positive(),sgDevelopedLength_m:z.number().positive()}).parse(jsonBlock(documents[5]!,'reference-primary-mechanics')),
    volumes=z.object({volumes_m3:z.array(z.number().positive()).length(11)}).parse(jsonBlock(documents[6]!,'reference-initialization')).volumes_m3,
    surge=resolveSurgeRoute(parseSurgeRoute(documents[7]!)),
    // The contact law's area per SG, uniform over the developed fold, on the
    // compiler's four equal metal segments.
    sgContact=parseSgContact(documents[8]!),sgSegment_m=mechanics.sgDevelopedLength_m/4,
    physical:Physical={downVolume_m3:volumes[0]!,hotVolume_m3:volumes[5]!,sgPrimaryVolume_m3:volumes[7]!,
      pumpVolume_m3:mechanics.pumpPassageVolume_m3,coldHeaderVolume_m3:mechanics.coldHeaderVolume_m3,
      pumpDiameter_m:mechanics.pumpPassageInsideDiameter_m,hotDiameter_m:mechanics.hotInsideDiameter_m,
      returnLength_m:mechanics.coldReturnLength_m,sgLength_m:mechanics.sgDevelopedLength_m,
      surgeLength_m:surge.developedLength_m,surgeDiameter_m:surge.internalDiameter_m,surgeElevation_m:surge.volumeMeanElevation_m,
      inlet_K:balance.coreInlet_C+273.15,outlet_K:balance.coreOutlet_C+273.15},
    input={fuel:parseFuelConstruction(documents[0]!),handling:parseFuelHandling(documents[1]!),control:parseControlAbsorber(documents[2]!),achievedRodTravel_m:reference.achievedRodTravel_m,physical},geometry=operatingFluidGeometry(input)
  return withOperatingIf97(if97Directory,async query=>{
    const points=await query([physical.inlet_K,(physical.inlet_K+physical.outlet_K)/2,physical.outlet_K].map(T=>({branch:'liquid' as const,p:reference.primaryPressure_Pa,T}))),
      endpoints=await query([{branch:'sat-liquid',p:balance.secondaryPressure_MPaAbs*1e6,T:0},{branch:'sat-vapor',p:balance.secondaryPressure_MPaAbs*1e6,T:0}]),
      regions=geometry.regions.map(r=>{const q=points.find(q=>q.T===r.temperature_K)!,chart=fixedVolumeChart(r.volume_m3,q);return {...r,pressure_Pa:q.p,water:q,...chart,
        liquidMass_kg:chart.mass_kg,steamMass_kg:0,airMass_kg:0,nitrogenMass_kg:0,
        absorberTracer_kgEq:chart.mass_kg*reference.boronReference_ppmEq/1e6}}),
      sg=saturatedVolumeChart(balance.secondaryVolume_m3,balance.secondaryLiquidVolume_m3,endpoints[0]!,endpoints[1]!),
      referenceFlow=sourceHeat_W/(points[2]!.h-points[0]!.h),A=sum(regions.map(r=>r.massPAtEnergy_kg_Pa)),
      resolved:ResolvedSolids=solids.kind==='steady'?solids:{kind:'provisional',coreSeed_K:physical.outlet_K,sgMetalSeed_K:(physical.inlet_K+sg.temperature_K)/2},
      solidStocks=prepareOperatingMaterials(input.fuel,input.handling,resolved),
      steadyMetal=resolved.kind==='steady'?steadyRows(resolved.steady.sg_metal,'SG metal segment'):undefined,
      // An SG metal segment's energy is C (T - 273.15 K). At the steady state
      // it carries no source, so it lies strictly between the secondary
      // saturation and its SG primary water: a law screen, not a bound.
      metal=(id:string,capacity_J_K:number)=>{
        if(!steadyMetal){const T=(resolved as {sgMetalSeed_K:number}).sgMetalSeed_K;return {temperature_K:T,energy_J:capacity_J_K*(T-273.15)}}
        const st=steadyMetal.get(id),own=capacity_J_K*(st.temperature_k-273.15)
        if(Math.abs(st.energy_j-own)>1e-10*Math.abs(own))throw Error(`Steady SG metal ${id} energy disagrees with C (T - 273.15 K)`)
        if(!(st.temperature_k>sg.temperature_K&&st.temperature_k<physical.inlet_K))
          throw Error(`Steady SG metal ${id} at ${st.temperature_k} K is not between its secondary saturation ${sg.temperature_K} K and primary ${physical.inlet_K} K`)
        return {temperature_K:st.temperature_k,energy_J:st.energy_j}
      },
      steamGenerators=['A','B'].map(id=>({id,...sg,metal:Array.from({length:4},(_,i)=>{
        const capacity_J_K=balance.wallCapacity_MJ_K*1e6/4,segment=`SG.${id}.METAL.${i}`
        return {id:segment,developedStart_m:sgSegment_m*i,developedEnd_m:sgSegment_m*(i+1),capacity_J_K,...metal(segment,capacity_J_K),
          exchangeArea_m2:sgContact.exchangeArea_m2*sgSegment_m/mechanics.sgDevelopedLength_m}}),
        liquidDensity_kg_m3:endpoints[0]!.rho,steamDensity_kg_m3:endpoints[1]!.rho,airMass_kg:0,nitrogenMass_kg:0,absorberTracer_kgEq:0}))
    steadyMetal?.covered()
    if(!Number.isFinite(A)||A===0)throw Error('Singular connected primary inventory pressure')
    return {scope:resolved.kind==='steady'?'Finite prepared hot reference with every solid store at the steady solid state of the reference power (G18); local/chart checks, not balanced circulation or IDA index-1 admission'
      :'SEED ONLY: finite prepared hot reference with every solid store at the stock-IDA settle\'s initial state; never emitted',
      hotReference:reference,sourceCapsule_m:input.handling.sourceCapsule_m,
      provenance:{if97Revision:nativeIf97Revision,headerSha256:nativeIf97HeaderSha256,licenseSha256:nativeIf97LicenseSha256,sourceSha256:hash(await Bun.file(import.meta.path).text()),propertyAdapterSha256:hash(querySource),
        helperSources:await Promise.all(['reference-design-fuel-materials.ts','reference-design-fuel-construction.ts','reference-design-fuel-handling.ts','reference-design-control-absorber.ts','reference-design-surge-route.ts','reference-design-if97-primitives.ts','reference-design-balance.ts'].map(async name=>({name,sha256:hash(await Bun.file(join(import.meta.dir,name)).text())}))),
        consumed:files.map((name,i)=>({name,sha256:hash(documents[i]!)}))},
      primary:{pressure_Pa:reference.primaryPressure_Pa,regions,edges:geometry.edges,tree:fluidTree(regions,geometry.edges),cycleCount:geometry.cycleCount,
        totalMass_kg:sum(regions.map(r=>r.mass_kg)),totalInternalEnergy_J:sum(regions.map(r=>r.internalEnergy_J)),
        totalVolume_m3:geometry.totalVolume_m3,aggregateMassPAtEnergy_kg_Pa:A,
        pressureEnergy_J_inv:regions.map(r=>-r.massEnergyAtPressure_kg_J/A),
        sourceHeat_W,enthalpyReferenceFlow_kg_s:referenceFlow,loopReferenceFlow_kg_s:referenceFlow/2,
        preparedLoopFlow_kg_s:reference.initialLoopMassflow_kg_s,
        simultaneousProjection:pressureContinuityProjection(regions,geometry.edges,regions.map(()=>0),regions.map(()=>0),Array(geometry.cycleCount).fill(0),geometry.edges.map(e=>e.from)),
        sourceBandToCoolant:Array.from({length:24},(_,i)=>2*Math.floor(i/6)+(i%6<3?0:1)),
        hydrostaticRule:'Current face integral g*sum(rho_segment*dz_segment); pi has one gauge, not frozen EOS offsets',
        energyRule:'Decision0012 operating low-Mach: fixed Eulerian Vi, shared thermal enthalpy once; paid shaft work once to pumpwater. Fluid K/PE feedback is diagnosed/bounded, not an exact additional thermal stock. Local budgets and joined momentum/pressure chart remain unadmitted.'},
      materials:{fuelMass_kg:geometry.fuelMass_kg,activeCladMass_kg:geometry.activeCladMass_kg,fullGuideMass_kg:geometry.fullGuideMass_kg,
        plenumCladMass_kg:geometry.plenumCladMass_kg,fittingMass_kg:geometry.fittingMass_kg,coreWetArea_m2:geometry.coreWetArea_m2,
        solidPreparation:resolved,
        solidStores:[...solidStocks.passive,...solidStocks.helium].map(s=>({id:s.id,temperature_K:s.temperature_K,energy_J:s.energy_J,capacity_J_K:s.capacity_J_K})),
        preparedCarriers:solidStocks.carriers},
      steamGenerators,
      geometry,propertyPoints:points,secondaryPropertyPoints:endpoints}
  })
}

if(import.meta.main){
  const [wiki,if97,Q,steady]=Bun.argv.slice(2)
  if(!wiki||!if97||!Q||!steady||Bun.argv.length!==6)
    throw Error('Usage: operating-fluid <wiki root> <pinned IF97 directory> <actual current source heat W> <steady solids JSON of prepare_steady_solids>')
  console.log(JSON.stringify(await prepareOperatingFluid(wiki,if97,Number(Q),{kind:'steady',steady:steadySolidsSchema.parse(await Bun.file(steady).json())})))
}
