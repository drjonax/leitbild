/** Actual LD-01 circulation geometry/parameter compiler. Rust owns numerical
 * force/work laws. No fine solver, initialization, pressure offsets or new
 * whole-plant framework is imported here. The geometric two-main allocation is
 * explicit, but does not admit the joined pressure/thermal dynamic chart. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {parseFuelConstruction,fuelGeometry} from './reference-design-fuel-construction'
import {parseSurgeRoute,resolveSurgeRoute} from './reference-design-surge-route'

type Region={id:string,volume_m3:number,mainFlowArea_m2:number,elevation_m:number}
type Edge={id:string,from:number,to:number}
export type CirculationGeometry={regions:readonly Region[],edges:readonly Edge[]}
const positive=z.number().finite().positive(),nonnegative=z.number().finite().nonnegative()
const selectionSchema=z.object({referenceDensity_kg_m3:positive,referenceMassflow_kg_s:positive,
  referenceFluidPower_W:positive,referenceHead_Pa:positive,referenceRpm:positive,shapeFraction:positive.max(.9),
  dragFraction:nonnegative,inertiaDecay_s:positive,mixedDegradationDepth:nonnegative.max(1)}).strict()
const gridsSchema=z.object({gridPositions_m:z.array(positive).length(8),blockageFraction:positive.lt(1),
  gridLossFactor:nonnegative,inletLoss:nonnegative,outletLoss:nonnegative}).strict()
// The drive owner selects only these three values; fluid power, drag fraction,
// speed and decay scale remain in the frozen commissioning record above.
const driveSchema=z.object({driveTrackingTime_s:positive,driveTorqueCapFactor:z.number().finite().min(1),
  driveEfficiency:positive.max(1)}).strict()
function block(text:string,name:string):unknown {
  const rows=[...text.matchAll(new RegExp('^```'+name+'\\s*\\n([\\s\\S]*?)^```\\s*$','gm'))]
  if(rows.length!==1)throw Error('Expected exactly one '+name+' block')
  return JSON.parse(rows[0]![1]!)
}
export const parseOperatingHydraulics=(text:string)=>selectionSchema.parse(block(text,'reference-operating-hydraulics'))
export const parseRcpDrive=(text:string)=>driveSchema.parse(block(text,'reference-rcp-drive'))

/** Calibrate once at the explicitly retained original duty. Current rho, q,
 * omega and composition are runtime inputs, never these reference numbers.
 * The drive values are copied once; P_drag0 is drag_Nm_per_rad_s*omega0^2 and
 * is deliberately not emitted as a second owner of the same quantity. */
export function operatingPumpParameters(b:ReturnType<typeof parseOperatingHydraulics>,drive:ReturnType<typeof parseRcpDrive>){
  const omega=b.referenceRpm*2*Math.PI/60,q=b.referenceMassflow_kg_s/b.referenceDensity_kg_m3,
    e=b.referenceFluidPower_W/b.referenceMassflow_kg_s,a=e/((1-b.shapeFraction)*omega**2),
    blade=b.shapeFraction*a*omega/q,resistance=(b.referenceDensity_kg_m3*e-b.referenceHead_Pa)/(b.referenceDensity_kg_m3*q*q),
    dragPower=b.dragFraction*b.referenceFluidPower_W
  if(![a,blade,resistance].every(x=>Number.isFinite(x)&&x>0))throw Error('Incompatible dissipative pump calibration')
  return {a,b:blade,resistance,mixed_degradation_depth:b.mixedDegradationDepth,
    rotorInertia_kg_m2:(b.referenceFluidPower_W+dragPower)*b.inertiaDecay_s/omega**2,
    drag_Nm_per_rad_s:dragPower/omega**2,referenceOmega_rad_s:omega,
    nominalFluidPower_W:b.referenceFluidPower_W,...drive}
}

export type FlowTerm={edge:number,weight:number}
export type Section={id:string,region:number,flow:FlowTerm[],force:FlowTerm[],
  parameters:{length_m:number,area_m2:number,hydraulic_diameter_m:number,elevation_change_m:number,gravity_m_s2:number,
    wall:'none'|'rod'|'smooth_pipe'|'annular_churchill'|'circular_churchill',form_loss:number,grid_count:number,grid_factor:number,
    blockage_fraction:number,pump:null|{a:number,b:number,resistance:number,mixed_degradation_depth:number}},
  movingVolume_m3:number,retainedThermalVolume_m3:number,inletElevation_m:number,outletElevation_m:number,
  conversionRecipients:{term:'wall'|'grid'|'form'|'pump_internal'|'braking',region:number,fraction:number}[]}

/** Geometric integrated-momentum allocation, NOT a density-dependent K Hessian.
 * Only the two MAIN columns retain acceleration. Split and expansion-flow
 * acceleration are omitted operating approximations under decision0012. */
export function operatingMainInertance(sections:readonly Section[],cycles:ReturnType<typeof operatingCirculationCycles>){
  if(cycles.columns.length!==7||cycles.ids[0]!=='MAIN.A'||cycles.ids[1]!=='MAIN.B')throw Error('Invalid selected main circulation basis')
  const supports=sections.map(s=>{
    const p=s.parameters
    if(!Number.isFinite(p.length_m)||p.length_m<=0||!Number.isFinite(p.area_m2)||p.area_m2<=0)throw Error('Invalid geometric main inertance')
    const weights=[0,1].map(c=>s.flow.reduce((a,t)=>{
      const v=cycles.columns[c]![t.edge]
      if(!Number.isInteger(t.edge)||!Number.isFinite(t.weight)||v===undefined||!Number.isFinite(v))throw Error('Invalid main inertance incidence')
      return a+t.weight*v
    },0)) as [number,number]
    return {section:s.id,lengthOverArea_per_m:p.length_m/p.area_m2,mainWeights:weights}
  })
  const matrix=supports.reduce((a,s)=>({aa:a.aa+s.lengthOverArea_per_m*s.mainWeights[0]**2,
    ab:a.ab+s.lengthOverArea_per_m*s.mainWeights[0]*s.mainWeights[1],bb:a.bb+s.lengthOverArea_per_m*s.mainWeights[1]**2}),{aa:0,ab:0,bb:0})
  if(!Object.values(matrix).every(Number.isFinite)||matrix.aa<=0||matrix.bb<=0||!(matrix.aa*matrix.bb-matrix.ab**2>0))throw Error('Singular selected main inertance')
  return {matrix,supports}
}

/** Explicit seven-dimensional MASS circulation basis, not volume-flow cycles.
 * The two main columns split uniformly only as a coordinate convention;
 * the five independent split columns remove any actual equal-flow constraint. */
export function operatingCirculationCycles(g:CirculationGeometry){
  const ids=['MAIN.A','MAIN.B','CORE.NW-minus-NE','CORE.SW-minus-NE','CORE.SE-minus-NE','PUMP.A2-minus-A1','PUMP.B2-minus-B1']
  if(g.regions.length!==26||g.edges.length!==32)throw Error('Unsupported selected circulation graph size')
  if(g.regions.some(r=>!Number.isFinite(r.volume_m3)||r.volume_m3<=0||!Number.isFinite(r.mainFlowArea_m2)||r.mainFlowArea_m2<0||!Number.isFinite(r.elevation_m)))throw Error('Invalid current water geometry')
  if(new Set(g.regions.map(r=>r.id)).size!==g.regions.length||new Set(g.edges.map(e=>e.id)).size!==g.edges.length
    ||g.edges.some(e=>!Number.isInteger(e.from)||!Number.isInteger(e.to)||e.from<0||e.to<0||e.from>=g.regions.length||e.to>=g.regions.length||e.from===e.to))throw Error('Invalid circulation graph')
  const columns=ids.map(()=>g.edges.map(()=>0)),index=(a:string,b:string)=>{
    const list=g.edges.flatMap((e,i)=>g.regions[e.from]!.id===a&&g.regions[e.to]!.id===b?[i]:[])
    if(list.length!==1)throw Error('Missing or duplicate actual circulation port '+a+'->'+b)
    return list[0]!
  },add=(c:number,a:string,b:string,w:number)=>columns[c]![index(a,b)]!+=w,
    core=(c:number,sector:string,w:number)=>{add(c,'LOWER',`CORE.${sector}.1`,w);add(c,`CORE.${sector}.1`,`CORE.${sector}.2`,w);add(c,`CORE.${sector}.2`,'UPPER',w)}
  for(let c=0;c<2;c++){
    const side=c===0?'A':'B';add(c,'DOWN','LOWER',1)
    for(const sector of ['NE','NW','SW','SE'])core(c,sector,.25)
    add(c,'UPPER',`HOT.${side}`,1);add(c,`HOT.${side}`,`SG.${side}.PRIMARY`,1)
    for(const p of [1,2]){add(c,`SG.${side}.PRIMARY`,`PUMP.${side}${p}`,.5);add(c,`PUMP.${side}${p}`,`COLD.${side}`,.5)}
    add(c,`COLD.${side}`,`RETURN.${side}`,1);add(c,`RETURN.${side}`,'DOWN',1)
  }
  for(const [c,sector] of ['NW','SW','SE'].entries()){core(c+2,'NE',-1);core(c+2,sector,1)}
  for(const [i,side] of ['A','B'].entries())for(const p of [1,2]){
    const w=p===1?-1:1;add(i+5,`SG.${side}.PRIMARY`,`PUMP.${side}${p}`,w);add(i+5,`PUMP.${side}${p}`,`COLD.${side}`,w)
  }
  for(const col of columns){
    const b=g.regions.map(()=>0)
    for(const [e,w]of col.entries()){b[g.edges[e]!.from]!-=w;b[g.edges[e]!.to]!+=w}
    if(b.some(v=>v!==0))throw Error('Nonconservative physical circulation column')
  }
  return {ids,columns,incidence:columns.flatMap((col,cycle)=>col.flatMap((weight,edge)=>weight!==0?[{edge,cycle,weight}]:[]))}
}

/** Existing table is the authority, not another hard-coded coefficient copy. */
function lossBudget(text:string,name:string){
  const row=text.split('\n').find(line=>line.startsWith('| '+name+' |'))
  if(!row)throw Error('Missing owned hydraulic loss '+name)
  const cells=row.split('|').map(s=>s.trim()),total=Number(cells[2]),mixing=cells[3]==='None in this channel'?0:Number(cells[3])
  if(!Number.isFinite(total)||!Number.isFinite(mixing)||total<=0||mixing<0||total<mixing)throw Error('Invalid nonnegative loss allocation')
  return {total,mixing,distributed:total-mixing}
}

export function compileOperatingHydraulics(g:CirculationGeometry,documents:{selection:string,fuel:string,grids:string,losses:string,barrel:string,surge:string,mechanics:string,pressure:string,drive:string}){
  const selected=parseOperatingHydraulics(documents.selection),pump=operatingPumpParameters(selected,parseRcpDrive(documents.drive)),f=parseFuelConstruction(documents.fuel),
    fg=fuelGeometry(f),grids=gridsSchema.parse(block(documents.grids,'reference-connected-fuel')),
    barrel=z.object({innerRadius_m:positive,outerRadius_m:positive}).strict().parse(block(documents.barrel,'reference-primary-barrel-geometry')),
    surge=resolveSurgeRoute(parseSurgeRoute(documents.surge)),cycles=operatingCirculationCycles(g),
    physical=z.object({sgDevelopedLength_m:positive,downcomerBottom_m:z.number().finite(),downcomerTop_m:z.number().finite()}).passthrough().parse(block(documents.mechanics,'reference-primary-mechanics')),
    basis=z.object({gravity_m_s2:positive}).passthrough().parse(block(documents.losses,'reference-hydraulics')),
    hotA=z.object({lossCoefficient:nonnegative}).strict().parse(block(documents.pressure,'reference-hot-a-distributed-loss')),
    downBudget=lossBudget(documents.losses,'Downcomer / LOWER entry'),
    hot=lossBudget(documents.losses,'HOT path'),sg=lossBudget(documents.losses,'Folded SG primary'),passage=lossBudget(documents.losses,'Each pump passage / COLD entry'),
    sections:Section[]=[],gravity:{edge:number,region:number,delta_z_m:number}[]=[],
    region=(id:string)=>{const i=g.regions.findIndex(r=>r.id===id);if(i<0)throw Error('Missing actual water owner '+id);return i},
    edge=(a:string,b:string)=>{const i=g.edges.findIndex(e=>e.from===region(a)&&e.to===region(b));if(i<0)throw Error('Missing actual port');return i},
    half=(pairs:[string,string][])=>pairs.map(([a,b])=>({edge:edge(a,b),weight:.5})),
    head=(pairs:[string,string][],owner:string,dz:number)=>{for(const[a,b]of pairs)gravity.push({edge:edge(a,b),region:region(owner),delta_z_m:dz})},
    add=(id:string,incoming:[string,string][],outgoing:[string,string][],length:number,dh:number,z0:number,z1:number,wall:Section['parameters']['wall'],K:number,nGrid=0,isPump=false)=>{
      const r=region(id),actual=g.regions[r]!,area=actual.mainFlowArea_m2
      if(!Number.isFinite(area)||area<=0||length<=0||dh<0||((wall!=='none'||nGrid>0)&&dh===0)||area*length>actual.volume_m3*(1+1e-12))throw Error('Invalid once-owned moving water geometry '+id)
      const formRegion=id==='DOWN'?region('LOWER'):id.startsWith('CORE.')&&id.endsWith('.2')?region('UPPER'):r,
        formRecipients=isPump?[{term:'form' as const,region:r,fraction:passage.distributed/passage.total},
          {term:'form' as const,region:region(`COLD.${id.split('.')[1]![0]}`),fraction:passage.mixing/passage.total}]:[{term:'form' as const,region:formRegion,fraction:1}]
      sections.push({id,region:r,flow:[...half(incoming),...half(outgoing)],force:[...half(incoming),...half(outgoing)],
        parameters:{length_m:length,area_m2:area,hydraulic_diameter_m:dh,elevation_change_m:z1-z0,gravity_m_s2:basis.gravity_m_s2,
          wall,form_loss:K,grid_count:nGrid,grid_factor:grids.gridLossFactor,blockage_fraction:grids.blockageFraction,
          pump:isPump?{a:pump.a,b:pump.b,resistance:pump.resistance,mixed_degradation_depth:pump.mixed_degradation_depth}:null},
        movingVolume_m3:area*length,retainedThermalVolume_m3:actual.volume_m3,inletElevation_m:z0,outletElevation_m:z1,
        conversionRecipients:[{term:'wall',region:r,fraction:1},{term:'grid',region:r,fraction:1},...formRecipients,
          ...(isPump?[{term:'pump_internal' as const,region:r,fraction:1},{term:'braking' as const,region:r,fraction:1}]:[])]})
      // Mechanical node pressure is referred to the declared region plane,
      // not the arithmetic average of its two port elevations. For folded SG
      // this is7.7065m while the actual ports are2.5/3m.
      const middle=actual.elevation_m;head(incoming,id,middle-z0);head(outgoing,id,z1-middle)
    }
  if(!(barrel.outerRadius_m>barrel.innerRadius_m)||new Set(grids.gridPositions_m).size!==8||grids.gridPositions_m.some((z,i,a)=>z>=f.activeLength_m||(i>0&&z<=a[i-1]!)))throw Error('Invalid current physical geometry')
  const down=g.regions[region('DOWN')]!,downLength=physical.downcomerTop_m-physical.downcomerBottom_m,outer=Math.sqrt(barrel.outerRadius_m**2+down.volume_m3/(Math.PI*downLength)),downDh=2*(outer-barrel.outerRadius_m)
  add('DOWN',[['RETURN.A','DOWN'],['RETURN.B','DOWN']],[['DOWN','LOWER']],downLength,downDh,physical.downcomerTop_m,physical.downcomerBottom_m,'annular_churchill',downBudget.mixing)
  for(const sector of ['NE','NW','SW','SE']){
    for(const halfIndex of [0,1]){
      const id=`CORE.${sector}.${halfIndex+1}`,incoming: [string,string][]=halfIndex===0?[['LOWER',id]]:[[ `CORE.${sector}.1`,id]],
        outgoing:[string,string][]=halfIndex===0?[[id,`CORE.${sector}.2`]]:[[id,'UPPER']],
        n=grids.gridPositions_m.filter(z=>z>halfIndex*2&&z<=(halfIndex+1)*2).length
      add(id,incoming,outgoing,2,fg.hydraulicDiameter_m,-2+halfIndex*2,halfIndex*2,'rod',halfIndex===0?grids.inletLoss:grids.outletLoss,n)
    }
    head([['LOWER',`CORE.${sector}.1`]],'LOWER',1);head([[`CORE.${sector}.2`,'UPPER']],'UPPER',1)
  }
  for(const side of ['A','B']){
    const h=`HOT.${side}`,s=`SG.${side}.PRIMARY`,cold=`COLD.${side}`,ret=`RETURN.${side}`,
      hotRegion=g.regions[region(h)]!,sgRegion=g.regions[region(s)]!,pumpRegion=g.regions[region(`PUMP.${side}1`)]!,returnRegion=g.regions[region(ret)]!,
      hotD=2*Math.sqrt(hotRegion.mainFlowArea_m2/Math.PI),pumpD=2*Math.sqrt(pumpRegion.mainFlowArea_m2/Math.PI),returnD=2*Math.sqrt(returnRegion.mainFlowArea_m2/Math.PI)
    add(h,[['UPPER',h]],[[h,s]],hotRegion.volume_m3/hotRegion.mainFlowArea_m2,hotD,2.5,2.5,'none',side==='A'?hotA.lossCoefficient:hot.total)
    // Aggregate SG geometry is not a fabricated tube bore. Its empirical K is
    // selected; Dh=0 explicitly means no bore was supplied/used (wall=none).
    add(s,[[h,s]],[[s,`PUMP.${side}1`],[s,`PUMP.${side}2`]],physical.sgDevelopedLength_m,0,2.5,3,'none',sg.total)
    for(const p of [1,2])add(`PUMP.${side}${p}`,[[s,`PUMP.${side}${p}`]],[[`PUMP.${side}${p}`,cold]],
      pumpRegion.volume_m3/pumpRegion.mainFlowArea_m2,pumpD,3,3,'none',passage.total,0,true)
    add(ret,[[cold,ret]],[[ret,'DOWN']],returnRegion.volume_m3/returnRegion.mainFlowArea_m2,returnD,3,3,'smooth_pipe',0)
    head([['UPPER',h]],'UPPER',-.5)
  }
  const forceIncidence=sections.flatMap((s,section)=>s.force.map(t=>({...t,section}))),covered=new Set(forceIncidence.map(t=>t.edge)),
    main=operatingMainInertance(sections,cycles)
  const commissioning={page:'model/operating-hydraulics.md',heading:'Once-calibrated machine, actual current material',block:'reference-operating-hydraulics'},
    driveRecord={page:'systems/primary-coolant/pumps-and-support.md',heading:'Drive parameter record',block:'reference-rcp-drive'}
  return {scope:'Actual force laws and bounded two-main/five-split allocation; joined momentum/thermal-pressure chart NOT admitted',
    selection:selected,pump,
    pumpSources:{nominalFluidPower_W:{...commissioning,field:'referenceFluidPower_W'},driveTrackingTime_s:driveRecord,
      driveTorqueCapFactor:driveRecord,driveEfficiency:driveRecord,
      derivedOnly:'P_drag0=drag_Nm_per_rad_s*referenceOmega_rad_s^2=dragFraction*nominalFluidPower_W; J=(P_fluid0+P_drag0)*inertiaDecay_s/omega0^2'},
    sections,forceIncidence,gravityIncidence:gravity,cycles,
    mainInertance:main.matrix,mainInertanceSupports:main.supports,
    coveredEdges:[...covered].sort((a,b)=>a-b),unclosedTreeEdges:g.edges.flatMap((e,i)=>covered.has(i)?[]:[{edge:i,id:e.id}]),
    unclosedJunctions:['HOT.A finite directional surge midpoint intersection'],
    gravity_m_s2:basis.gravity_m_s2,
    surge:{area_m2:surge.area_m2,length_m:surge.developedLength_m,sourceElevation_m:surge.sourceElevation_m,receiverElevation_m:surge.receiverElevation_m,
      scope:'Geometry only in this circulation compiler; actual PZR/line pressure-work and endpoint laws remain separate'},
    kineticScope:'Uniform-throughflow snapshot per19 channel supports only; geometric main inertance is not its K Hessian; split/expansion acceleration and mixed-reservoir work omitted under bounded0012 convention'}
}

/** Only mapping/validated current input preparation, no numerical force copy.
 * Section pressure drops are actual mechanical ports supplied by the joined
 * pressure owner; a nominal common thermodynamic P is NOT substituted. */
export function operatingHydraulicFrame(model:ReturnType<typeof compileOperatingHydraulics>,g:CirculationGeometry,
  input:{edgeMassflow_kg_s:readonly number[],sectionPressureDrop_Pa:readonly number[],
    water:readonly {rho:number,mu:number,gasVolumeFraction:number}[],omega_rad_s:readonly number[]}){
  if(input.edgeMassflow_kg_s.length!==g.edges.length||input.sectionPressureDrop_Pa.length!==model.sections.length
    ||input.water.length!==g.regions.length||input.omega_rad_s.length!==4
    ||![...input.edgeMassflow_kg_s,...input.sectionPressureDrop_Pa,...input.omega_rad_s].every(Number.isFinite)
    ||input.water.some(w=>![w.rho,w.mu,w.gasVolumeFraction].every(Number.isFinite)||w.rho<=0||w.mu<=0||w.gasVolumeFraction<0||w.gasVolumeFraction>1))throw Error('Invalid current hydraulic material/port input')
  const pumps=['PUMP.A1','PUMP.A2','PUMP.B1','PUMP.B2']
  return model.sections.map((s,i)=>{const w=input.water[s.region]!,p=pumps.indexOf(s.id);return {
    massflow_kg_s:s.flow.reduce((v,t)=>v+t.weight*input.edgeMassflow_kg_s[t.edge]!,0),density_kg_m3:w.rho,
    viscosity_pa_s:w.mu,pressure_drop_pa:input.sectionPressureDrop_Pa[i]!,omega_rad_s:p<0?0:input.omega_rad_s[p]!,gas_volume_fraction:w.gasVolumeFraction}})
}

export async function loadOperatingHydraulics(wikiRoot:string,geometry:CirculationGeometry){
  const base=join(wikiRoot,'world/packs/process-plant/reference-designs/ld-01'),names={selection:'model/operating-hydraulics.md',fuel:'systems/reactor/fuel-construction.md',
    grids:'model/connected-primary-initialization.md',losses:'model/primary-hydraulic-basis.md',barrel:'systems/reactor/core-coolant-delivery.md',surge:'systems/primary-coolant/surge-route.md',mechanics:'systems/primary-coolant/mechanical-energy-and-geometry.md',pressure:'systems/primary-coolant/pressure-and-inventory.md',drive:'systems/primary-coolant/pumps-and-support.md'},
    docs=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,name])=>[key,await Bun.file(join(base,name)).text()]))) as Record<keyof typeof names,string>,
    result=compileOperatingHydraulics(geometry,docs),hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  return {...result,provenance:{sourceSha256:hash(await Bun.file(import.meta.path).text()),consumed:Object.entries(names).map(([key,name])=>({name,sha256:hash(docs[key as keyof typeof docs])}))}}
}
