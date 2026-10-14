/** Compile actual finite material/contact inputs. Physical heat/correlation
 * equations have ONE owner: operating/src/thermal.rs, not this TS module. */
import { z } from 'zod'
import type { parseFuelConstruction } from './reference-design-fuel-construction'
import { fuelGeometry } from './reference-design-fuel-construction'
import { fuelAssemblyPositions, fuelLatticeSites, type parseFuelHandling } from './reference-design-fuel-handling'
import { controlAbsorberGeometry, type ControlAbsorber } from './reference-design-control-absorber'
import { prepareOperatingMaterials, type prepareOperatingFluid } from './reference-design-operating-fluid'
import type { prepareOperatingEnergy } from './reference-design-operating-energy'
import type { parseTransferThermal } from './reference-design-fuel-transfer-thermal'
import type { parseOperatingFuelGap } from './reference-design-fuel-cooling'

const schema = z.object({identity:z.literal('LD01-HOT-THERMAL-1'),guideEmissivity:z.number().finite().positive().max(1),
  sgThermalDiameter_m:z.number().finite().positive()}).strict()
export type OperatingThermalCoefficients = z.infer<typeof schema>
export function parseOperatingThermal(document:string) {
  const blocks=[...document.matchAll(/^```reference-operating-thermal\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-operating-thermal block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
type Fuel=ReturnType<typeof parseFuelConstruction>
type Handling=ReturnType<typeof parseFuelHandling>
type Fluid=Awaited<ReturnType<typeof prepareOperatingFluid>>
type Energy=ReturnType<typeof prepareOperatingEnergy>
const sum=(values:readonly number[])=>values.reduce((a,b)=>a+b,0)
const close=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=2e-11*Math.max(1,Math.abs(a),Math.abs(b))
const shares=(x:number,y:number)=>{
  const e=x===0?.5:x>0?1:0,n=y===0?.5:y>0?1:0
  return [e*n,(1-e)*n,(1-e)*(1-n),e*(1-n)]
}

export function compileOperatingThermal(f:Fuel,h:Handling,control:ControlAbsorber,fluid:Fluid,energy:Energy,
  supplied:OperatingThermalCoefficients,passive:ReturnType<typeof parseTransferThermal>,gap:ReturnType<typeof parseOperatingFuelGap>) {
  const coefficients=schema.parse(supplied),geometry=fuelGeometry(f),regions=fluid.primary.regions,
    material=fluid.materials.preparedCarriers,reference=fluid.hotReference,
    n=f.assemblies,rf=f.pelletDiameter_m/2,ri=f.rodOuterDiameter_m/2-f.cladThickness_m,ro=f.rodOuterDiameter_m/2,
    heliumVolume=f.rodsPerAssembly*Math.PI*((ri*ri-rf*rf)*f.activeLength_m+ri*ri*f.plenumLength_m),
    heliumNr=f.fillPressure_Pa*heliumVolume/f.referenceTemperature_K,
    // G18: the gap law's accommodation at its named fixed basis, never the
    // live helium temperature (operating-hot-reference.md).
    accommodation=.425-2.3e-4*reference.gapAccommodationReferenceTemperature_K,
    assemblies=fuelAssemblyPositions(h,f),pins=fuelLatticeSites(f),body=controlAbsorberGeometry(control,f,h),
    solids=prepareOperatingMaterials(f,h,fluid.materials.solidPreparation),
    index=(id:string)=>{const i=regions.findIndex(r=>r.id===id);if(i<0)throw Error('Missing thermal water recipient '+id);return i}
  if(n!==193||material.length!==386||energy.carriers.length!==386||regions.length!==26||accommodation<=0||
    !close(fluid.materials.fuelMass_kg,geometry.fuelMass_kg)||!close(fluid.materials.activeCladMass_kg,geometry.cladMass_kg))
    throw Error('Incompatible actual compact thermal material allocation')
  for(const [label,ids]of [['materials',material.map(a=>a.id)],['events',energy.carriers.map(a=>a.id)],
    ['water',regions.map(r=>r.id)],['solids',fluid.materials.solidStores.map(s=>s.id)]] as const)
    if(new Set(ids).size!==ids.length)throw Error('Duplicate thermal '+label+' identity')
  if(energy.coolantByRegion_W.length!==24||fluid.primary.sourceBandToCoolant.length!==24||
    fluid.primary.sourceBandToCoolant.some(i=>!Number.isInteger(i)||i<0||i>=regions.length))
    throw Error('Invalid thermal direct-source mapping')
  if(![gap.fuelEmissivity,gap.cladEmissivity].every(x=>Number.isFinite(x)&&x>0&&x<=1))throw Error('Invalid owned gap emissivities')
  const helium=assemblies.map(fa=>{
    const id=fa.id+'/helium',stock=fluid.materials.solidStores.find(s=>s.id===id)
    if(!stock||!close(stock.capacity_J_K,1.5*heliumNr)||!close(stock.energy_J,stock.capacity_J_K*stock.temperature_K))
      throw Error('Shared sealed helium stock mismatch '+id)
    return {id,volume_m3:heliumVolume,nr_j_k:heliumNr,temperature_k:stock.temperature_K,
      energy_j:stock.energy_J,capacity_j_k:stock.capacity_J_K}
  })
  const fuel_bands=material.map((a,i)=>{
    const event=energy.carriers[i]!,original=solids.carriers[i]!,gas=helium.findIndex(g=>g.id===a.faId+'/helium'),masses=a.fuelNodes.map(node=>node.mass_kg)
    if(event.id!==a.id||gas<0||a.fuelNodes.length!==2||!close(masses[0]!,masses[1]!))throw Error('Fuel event/thermal identity mismatch')
    if(a.id!==original.id||a.faId!==original.faId||a.half!==original.half||!close(a.clad.mass_kg,original.clad.mass_kg)||
      a.surfaceSeed_K.some((T,k)=>T!==original.surfaceSeed_K[k])||
      !close(a.clad.energy_J,original.clad.energy_J)||a.fuelNodes.some((node,j)=>node.radial!==j||
        !close(node.mass_kg,original.fuelNodes[j]!.mass_kg)||!close(node.energy_J,original.fuelNodes[j]!.energy_J)||
        !close(node.temperature_K,original.fuelNodes[j]!.temperature_K)))throw Error('Actual prepared fuel caloric identity mismatch')
    return {id:a.id,helium:gas,fuel_store_ids:a.fuelNodes.map(node=>a.id+'/fuel/'+node.radial),clad_store_id:a.id+'/clad',
      fuel_temperatures_k:a.fuelNodes.map(node=>node.temperature_K),clad_temperature_k:a.clad.temperature_K,
      fuel_masses_kg:masses,fuel_energies_j:a.fuelNodes.map(node=>node.energy_J),
      clad_mass_kg:a.clad.mass_kg,clad_energy_j:a.clad.energy_J,
      source_w:masses.map(mass=>event.fuel_W*mass/sum(masses)),
      // The steady surfaces (G18): the consuming DAE still initializes its
      // three residuals at the composed water; these seed that solve.
      surface_seed_k:[...a.surfaceSeed_K],
      geometry:{fuel_radius_m:rf,clad_inner_radius_m:ri,clad_outer_radius_m:ro,rod_length_m:f.activeLength_m/2,
        rods:f.rodsPerAssembly,helium_volume_m3:heliumVolume,helium_nr_j_k:heliumNr,accommodation,
        fuel_emissivity:gap.fuelEmissivity,clad_emissivity:gap.cladEmissivity}}
  })
  const core_contacts=fluid.geometry.materialContacts.map(contact=>{
    const band=material.findIndex(a=>a.id===contact.carrierId)
    if(band<0||contact.coolant<0||contact.coolant>=8||contact.cladArea_m2<=0)throw Error('Invalid actual thermal incidence')
    return {band,water:contact.coolant,area_m2:contact.cladArea_m2,hydraulic_diameter_m:geometry.hydraulicDiameter_m,
      flow_area_m2:regions[contact.coolant]!.mainFlowArea_m2}
  })
  if(!close(sum(core_contacts.map(c=>c.area_m2)),geometry.heatedArea_m2))throw Error('Thermal clad areas do not close')
  if(new Set(core_contacts.map(c=>c.band+':'+c.water)).size!==core_contacts.length||
    fuel_bands.some((_,i)=>!close(sum(core_contacts.filter(c=>c.band===i).map(c=>c.area_m2)),f.rodsPerAssembly*Math.PI*f.rodOuterDiameter_m*f.activeLength_m/2)))
    throw Error('Thermal material/contact incidence mismatch')
  const passive_contacts:{store_id:string,water:number,area_m2:number,liquid_h_w_m2_k:number,
    gas_h_w_m2_k:number,wall_log_radius_m:number,surface:'outside'|'bore'|'fitting'}[]=[]
  const guideRi=h.guideInnerDiameter_m/2,guideRo=f.guideOuterDiameter_m/2,
    guideRm=Math.sqrt((guideRi*guideRi+guideRo*guideRo)/2),
    plenum_contacts:{helium:number,store_id:string,area_m2:number,inner_radius_m:number,conduction_factor:number}[]=[]
  const addPassive=(store_id:string,water:number,area_m2:number,wall_log_radius_m:number,surface:'outside'|'bore'|'fitting')=>{
    if(area_m2>0)passive_contacts.push({store_id,water,area_m2,wall_log_radius_m,surface,
      liquid_h_w_m2_k:passive.nonfuelLiquid_h_W_m2_K,gas_h_w_m2_k:passive.nonfuelGas_h_W_m2_K})
  }
  const spans=[{name:'LOWER',lo:h.seatedBottom_m,hi:-2,water:-1},
    {name:'CORE.1',lo:-2,hi:0,water:0},{name:'CORE.2',lo:0,hi:2,water:1},
    {name:'UPPER',lo:2,hi:2+f.plenumLength_m+h.topFittingLength_m,water:-2}]
  for(const fa of assemblies) {
    for(const span of spans) {
      const length=span.hi-span.lo,outer=[0,0,0,0],inner=[0,0,0,0],
        store_id=fa.id+'/guide/'+span.name
      if(!fluid.materials.solidStores.some(s=>s.id===store_id))throw Error('Missing retained guide span '+store_id)
      for(const pin of pins.filter(pin=>pin.guide)) {
        const own=shares(fa.x_m+pin.x,fa.y_m+pin.y)
        for(let q=0;q<4;q++) {
          outer[q]!+=own[q]!*Math.PI*f.guideOuterDiameter_m*length
          inner[q]!+=own[q]!*Math.PI*h.guideInnerDiameter_m*length
        }
      }
      for(let q=0;q<4;q++) {
        const water=span.water===-1?index('LOWER'):span.water===-2?index('UPPER'):2*q+span.water
        addPassive(store_id,water,outer[q]!,guideRo*Math.log(guideRo/guideRm),'outside')
        addPassive(store_id,water,inner[q]!,guideRi*Math.log(guideRm/guideRi),'bore')
      }
    }
    const store_id=fa.id+'/plenum-clad',area=f.rodsPerAssembly*Math.PI*f.rodOuterDiameter_m*f.plenumLength_m
    if(!fluid.materials.solidStores.some(s=>s.id===store_id))throw Error('Missing plenum clad stock')
    addPassive(store_id,index('UPPER'),area,0,'outside')
    plenum_contacts.push({helium:helium.findIndex(g=>g.id===fa.id+'/helium'),store_id,
      area_m2:f.rodsPerAssembly*2*Math.PI*ri*f.plenumLength_m,inner_radius_m:ri,
      conduction_factor:passive.plenumConductionFactor})
    addPassive(fa.id+'/bottom-fitting',index('LOWER'),passive.fittingContactArea_m2*h.bottomFitting_kg/10,0,'fitting')
    addPassive(fa.id+'/top-fitting',index('UPPER'),passive.fittingContactArea_m2*h.topFitting_kg/10,0,'fitting')
  }
  if(passive_contacts.some(c=>![c.area_m2,c.liquid_h_w_m2_k,c.gas_h_w_m2_k,c.wall_log_radius_m].every(Number.isFinite)||
    c.area_m2<=0||c.liquid_h_w_m2_k<=0||c.gas_h_w_m2_k<=0||c.wall_log_radius_m<0)||
    ![passive.plenumConductionFactor,passive.fittingContactArea_m2].every(x=>Number.isFinite(x)&&x>0)||body.sites.length!==52)
    throw Error('Invalid owned nonfuel contact selection')
  const direct_water_source_w=regions.map(()=>0)
  energy.coolantByRegion_W.forEach((Q,i)=>{direct_water_source_w[fluid.primary.sourceBandToCoolant[i]!]!+=Q})
  const sg_segments=fluid.steamGenerators.flatMap((sg,secondary)=>sg.metal.map(metal=>({
    id:metal.id,primary:index(`SG.${sg.id}.PRIMARY`),secondary,developed_start_m:metal.developedStart_m,
    developed_end_m:metal.developedEnd_m,area_m2:metal.exchangeArea_m2,
    thermal_diameter_m:coefficients.sgThermalDiameter_m,primary_flow_area_m2:regions[index(`SG.${sg.id}.PRIMARY`)]!.mainFlowArea_m2,
    temperature_k:metal.temperature_K,energy_j:metal.energy_J,capacity_j_k:metal.capacity_J_K})))
  if(fluid.steamGenerators.length!==2||new Set(fluid.steamGenerators.map(sg=>sg.id)).size!==2||
    fluid.steamGenerators.some(sg=>!['A','B'].includes(sg.id)||sg.metal.length!==4||sg.metal.some((m,i)=>
      m.id!==`SG.${sg.id}.METAL.${i}`||m.developedStart_m!==5*i||m.developedEnd_m!==5*(i+1)||
      ![m.exchangeArea_m2,m.capacity_J_K,m.temperature_K].every(x=>Number.isFinite(x)&&x>0)||
      !close(m.energy_J,m.capacity_J_K*(m.temperature_K-273.15)))))throw Error('Invalid finite SG thermal stocks')
  const source_total_w=sum(fuel_bands.flatMap(a=>a.source_w))+sum(direct_water_source_w)
  if(!close(source_total_w,energy.totalDeposited_W)||sg_segments.length!==8||
    fluid.steamGenerators.some((sg,i)=>!close(sum(sg_segments.filter(s=>s.secondary===i).map(s=>s.capacity_j_k)),sum(sg.metal.map(m=>m.capacity_J_K)))))
    throw Error('Thermal event/finite SG stock budget mismatch')
  return {identity:coefficients.identity,coefficients,fuel_bands,helium,core_contacts,passive_contacts,plenum_contacts,sg_segments,
    water:regions.map(r=>({id:r.id,pressure_pa:r.water.p,temperature_k:r.water.T,volume_m3:r.volume_m3,
      mass_kg:r.mass_kg,energy_j:r.internalEnergy_J})),
    secondaries:fluid.steamGenerators.map(sg=>({id:sg.id,pressure_pa:sg.pressure_Pa,temperature_k:sg.temperature_K,
      liquid_volume_m3:sg.liquidVolume_m3,volume_m3:sg.volume_m3,mass_kg:sg.mass_kg,energy_j:sg.internalEnergy_J})),
    passive_stores:fluid.materials.solidStores.filter(s=>!s.id.endsWith('/helium')).map(s=>{
      const original=solids.passive.find(p=>p.id===s.id)
      if(!original||!close(original.energy_J,s.energy_J)||!close(original.capacity_J_K,s.capacity_J_K)||original.temperature_K!==s.temperature_K)
        throw Error('Passive caloric identity mismatch '+s.id)
      return {id:s.id,material:'zircaloy' as const,energy_j:s.energy_J,capacity_j_k:s.capacity_J_K,
        temperature_k:s.temperature_K,mass_kg:original.mass_kg}
    }),
    direct_water_source_w,source_total_w,
    surface_algebraic_count:3*fuel_bands.length,
    scope:(fluid.materials.solidPreparation.kind==='steady'?'Actual finite material/contact inputs, every solid store at the steady solid state of the reference power (G18); surface seeds are the steady surfaces, not constraints initialized at the composed water; no achieved thermal trajectory.'
      :'SEED ONLY: every solid store at the stock-IDA settle\'s initial state; never emitted.')+' Existing owned signed250/5 nonfuel contacts, finite fitting areas and shared helium/plenum contact; guides have finite half-wall resistance. Absorber thermal feedback and moved/open-core qualification are uncredited.'}
}
export type OperatingThermalPacket=ReturnType<typeof compileOperatingThermal>
