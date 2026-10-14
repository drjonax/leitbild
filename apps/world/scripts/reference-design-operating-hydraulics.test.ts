import {expect,test} from 'bun:test'
import {compileOperatingHydraulics,loadOperatingHydraulics,operatingCirculationCycles,operatingHydraulicFrame,
  operatingMainInertance,operatingPumpParameters,parseOperatingHydraulics,parseRcpDrive,type Section} from './reference-design-operating-hydraulics'
import {prepareOperatingFluid} from './reference-design-operating-fluid'

// Test-only commissioning record. Actual source qualification reads the wiki.
const record={referenceDensity_kg_m3:745.3288701999253,referenceMassflow_kg_s:4424.53961576215,
  referenceFluidPower_W:4188754.3780218355,referenceHead_Pa:600000,referenceRpm:1500,shapeFraction:.2,
  dragFraction:.01,inertiaDecay_s:10,mixedDegradationDepth:.5},document='```reference-operating-hydraulics\n'+JSON.stringify(record)+'\n```',
  driveRecord={driveTrackingTime_s:5,driveTorqueCapFactor:1.5,driveEfficiency:.96},
  driveDocument='```reference-rcp-drive\n'+JSON.stringify(driveRecord)+'\n```',drive=parseRcpDrive(driveDocument)
test('one-time reviewed pump calibration recovers pressure, fluid duty and finite rotor',()=>{
  const p=operatingPumpParameters(parseOperatingHydraulics(document),drive),q=record.referenceMassflow_kg_s/record.referenceDensity_kg_m3,w=p.referenceOmega_rad_s,
    dp=record.referenceDensity_kg_m3*w*(p.a*w-p.b*q)-p.resistance*record.referenceDensity_kg_m3*q*q,
    shaft=record.referenceDensity_kg_m3*q*w*(p.a*w-p.b*q)
  expect(dp).toBeCloseTo(record.referenceHead_Pa,8);expect(shaft).toBeCloseTo(record.referenceFluidPower_W,7)
  expect(p.rotorInertia_kg_m2).toBeCloseTo(1714.614588,5)
  expect(()=>parseOperatingHydraulics(document.replace('600000','1e12'))&&operatingPumpParameters(parseOperatingHydraulics(document.replace('600000','1e12')),drive)).toThrow('Incompatible')
  expect(()=>parseOperatingHydraulics(document.replace('745.3288701999253','0'))).toThrow()
  expect(()=>parseOperatingHydraulics(document+'\n'+document)).toThrow('exactly one')
})

test('drive record adds only its owned values; the consumer can derive drag power and inertia',()=>{
  const p=operatingPumpParameters(parseOperatingHydraulics(document),drive),w=p.referenceOmega_rad_s,dragPower=p.drag_Nm_per_rad_s*w*w
  expect(Object.keys(p)).toEqual(['a','b','resistance','mixed_degradation_depth','rotorInertia_kg_m2','drag_Nm_per_rad_s',
    'referenceOmega_rad_s','nominalFluidPower_W','driveTrackingTime_s','driveTorqueCapFactor','driveEfficiency'])
  expect(p.nominalFluidPower_W).toBe(record.referenceFluidPower_W)
  expect(dragPower).toBeCloseTo(.01*p.nominalFluidPower_W,8)
  expect(p.rotorInertia_kg_m2).toBeCloseTo((p.nominalFluidPower_W+dragPower)*10/w**2,10)
  expect([p.driveTrackingTime_s,p.driveTorqueCapFactor,p.driveEfficiency]).toEqual([5,1.5,.96])
  for(const bad of [{...driveRecord,driveEfficiency:1.2},{...driveRecord,driveTorqueCapFactor:.9},{...driveRecord,driveTrackingTime_s:0},{...driveRecord,extra:1}])
    expect(()=>parseRcpDrive('```reference-rcp-drive\n'+JSON.stringify(bad)+'\n```')).toThrow()
  expect(()=>parseRcpDrive(driveDocument+'\n'+driveDocument)).toThrow('exactly one')
})

// Explicit structural fixture, not production plant data or a hydraulic solve.
function graph(){
  const ids=['DOWN','LOWER','UPPER',...['NE','NW','SW','SE'].flatMap(s=>[`CORE.${s}.1`,`CORE.${s}.2`]),
    ...['A','B'].flatMap(s=>[`HOT.${s}`,`SG.${s}.PRIMARY`,`PUMP.${s}1`,`PUMP.${s}2`,`COLD.${s}`,`RETURN.${s}`]),'HOUSING.MAIN','HOUSING.NECK','SURGE'],
    regions=ids.map(id=>({id,volume_m3:100,mainFlowArea_m2:1,elevation_m:0})),edges:{id:string,from:number,to:number}[]=[],
    add=(a:string,b:string)=>edges.push({id:a+'->'+b,from:ids.indexOf(a),to:ids.indexOf(b)})
  add('DOWN','LOWER');for(const s of ['NE','NW','SW','SE']){add('LOWER',`CORE.${s}.1`);add(`CORE.${s}.1`,`CORE.${s}.2`);add(`CORE.${s}.2`,'UPPER')}
  for(const s of ['A','B']){add('UPPER',`HOT.${s}`);add(`HOT.${s}`,`SG.${s}.PRIMARY`);for(const p of [1,2]){add(`SG.${s}.PRIMARY`,`PUMP.${s}${p}`);add(`PUMP.${s}${p}`,`COLD.${s}`)}add(`COLD.${s}`,`RETURN.${s}`);add(`RETURN.${s}`,'DOWN')}
  add('UPPER','HOUSING.MAIN');add('HOUSING.MAIN','HOUSING.NECK');add('HOT.A','SURGE');return {regions,edges}
}
test('seven independent mass cycles retain unequal core and parallel-pump directions',()=>{
  const g=graph(),c=operatingCirculationCycles(g)
  expect(c.ids).toHaveLength(7);expect(c.columns).toHaveLength(7)
  for(const col of c.columns){
    const net=g.regions.map(()=>0);for(const[e,w]of col.entries()){net[g.edges[e]!.from]!-=w;net[g.edges[e]!.to]!+=w}
    expect(net).toEqual(g.regions.map(()=>0))
  }
  // Unique split-sector/pump edges give seven independent pivot witnesses.
  const row=(id:string)=>g.edges.findIndex(e=>e.id===id)
  expect(c.columns[2]![row('LOWER->CORE.NW.1')]).toBe(1)
  expect(c.columns[5]![row('SG.A.PRIMARY->PUMP.A1')]).toBe(-1)
  expect(c.columns[5]![row('SG.A.PRIMARY->PUMP.A2')]).toBe(1)
  expect(c.columns.every(col=>col.slice(-3).every(v=>v===0))).toBe(true)
  expect(()=>operatingCirculationCycles({...g,edges:g.edges.slice(1)})).toThrow('graph size')
  expect(()=>operatingCirculationCycles({...g,edges:[{id:'bad',from:-1,to:2},...g.edges.slice(1)]})).toThrow('Invalid')
})

test('geometric main inertia includes shared supports once and excludes split inertia',()=>{
  const g=graph(),cycles=operatingCirculationCycles(g),row=(id:string)=>g.edges.findIndex(e=>e.id===id),
    support=(id:string,edge:number,L:number,A:number)=>({id,flow:[{edge,weight:1}],parameters:{length_m:L,area_m2:A}} as Section),
    sections=[support('DOWN',row('DOWN->LOWER'),6,3),support('HOT.A',row('UPPER->HOT.A'),4,2),support('HOT.B',row('UPPER->HOT.B'),9,3)],
    main=operatingMainInertance(sections,cycles)
  expect(main.matrix).toEqual({aa:4,ab:2,bb:5})
  expect(main.supports.map(s=>s.mainWeights)).toEqual([[1,1],[1,0],[0,1]])
  expect(()=>operatingMainInertance([sections[0]!],cycles)).toThrow('Singular')
  expect(()=>operatingMainInertance([support('bad',100,1,1)],cycles)).toThrow('incidence')
  expect(()=>operatingMainInertance([support('bad',0,1,0)],cycles)).toThrow('geometric')
})

const wiki=process.env.LD01_WIKI_ROOT,if97=process.env.LD01_IF97_DIRECTORY
if(!!wiki!==!!if97)throw Error('Supply both LD01_WIKI_ROOT and LD01_IF97_DIRECTORY for actual hydraulic input tests')
test.skipIf(!wiki||!if97)('actual19 circulation supports,29 covered contacts, owned finite receivers and current input map',async()=>{
  const f=await prepareOperatingFluid(wiki!,if97!,2.9e9,{kind:'provisional'}),h=await loadOperatingHydraulics(wiki!,f.geometry),g=f.geometry
  expect(h.sections).toHaveLength(19);expect(h.coveredEdges).toHaveLength(29);expect(h.unclosedTreeEdges).toHaveLength(3)
  expect(h.cycles.columns).toHaveLength(7)
  expect(h.mainInertance.aa).toBeGreaterThan(h.mainInertance.ab)
  expect(h.mainInertance.bb).toBeCloseTo(h.mainInertance.aa,12)
  expect(h.mainInertance.ab).toBeGreaterThan(0)
  expect(h.mainInertance.aa).toBeCloseTo(70.629211610045,11)
  expect(h.mainInertance.ab).toBeCloseTo(2.654786439092273,12)
  expect(h.mainInertanceSupports.find(s=>s.section==='DOWN')!.mainWeights).toEqual([1,1])
  expect(h.mainInertanceSupports.find(s=>s.section==='PUMP.A1')!.mainWeights).toEqual([.5,0])
  expect(h.mainInertanceSupports.find(s=>s.section==='CORE.NE.1')!.mainWeights).toEqual([.25,.25])
  expect(h.sections.filter(s=>s.parameters.pump)).toHaveLength(4)
  expect([h.pump.nominalFluidPower_W,h.pump.driveTrackingTime_s,h.pump.driveTorqueCapFactor,h.pump.driveEfficiency]).toEqual([4188754.3780218355,5,1.5,.96])
  expect(h.pump.rotorInertia_kg_m2).toBeCloseTo((h.pump.nominalFluidPower_W+h.pump.drag_Nm_per_rad_s*h.pump.referenceOmega_rad_s**2)*10/h.pump.referenceOmega_rad_s**2,10)
  expect(h.pumpSources.driveEfficiency.page).toBe('systems/primary-coolant/pumps-and-support.md')
  expect(h.sections.filter(s=>s.parameters.wall==='rod').every(s=>s.parameters.grid_count===4)).toBe(true)
  expect(h.sections.find(s=>s.id==='DOWN')!.parameters.wall).toBe('annular_churchill')
  expect(h.sections.find(s=>s.id==='DOWN')!.parameters.form_loss).toBe(1)
  expect(h.sections.find(s=>s.id==='SG.A.PRIMARY')!.parameters.hydraulic_diameter_m).toBe(0)
  expect(h.sections.find(s=>s.id==='HOT.A')!.parameters.form_loss).toBe(.49504493)
  expect(h.sections.find(s=>s.id==='HOT.B')!.parameters.form_loss).toBe(.499095)
  expect(h.unclosedJunctions).toHaveLength(1)
  const sgA=f.geometry.regions.findIndex(r=>r.id==='SG.A.PRIMARY'),sgHeads=h.gravityIncidence.filter(t=>t.region===sgA)
  expect(sgHeads.some(t=>t.delta_z_m>5)).toBe(true);expect(sgHeads.filter(t=>t.delta_z_m< -4)).toHaveLength(2)
  const rates=h.cycles.columns[0]!.map((a,i)=>a*8000+h.cycles.columns[1]![i]!*6000+h.cycles.columns[5]![i]!*500),
    frame=operatingHydraulicFrame(h,g,{edgeMassflow_kg_s:rates,sectionPressureDrop_Pa:h.sections.map(()=>0),
      water:f.primary.regions.map(r=>({rho:r.water.rho,mu:r.water.mu,gasVolumeFraction:0})),omega_rad_s:[157,0,157,157]})
  expect(frame[h.sections.findIndex(s=>s.id==='PUMP.A1')]!.massflow_kg_s).toBe(3500)
  expect(frame[h.sections.findIndex(s=>s.id==='PUMP.A2')]!.massflow_kg_s).toBe(4500)
  expect(frame[h.sections.findIndex(s=>s.id==='PUMP.A2')]!.omega_rad_s).toBe(0)
  expect(frame[h.sections.findIndex(s=>s.id==='DOWN')]!.massflow_kg_s).toBe(14000)
  for(const s of h.sections){
    expect(s.movingVolume_m3).toBeLessThanOrEqual(s.retainedThermalVolume_m3*(1+1e-12))
    for(const term of ['wall','grid','form'] as const)expect(s.conversionRecipients.filter(r=>r.term===term).reduce((a,b)=>a+b.fraction,0)).toBeCloseTo(1,14)
  }
  // Constant density hydrostatic head around each closed geometric path is0;
  // actual unequal densities are NOT replaced by that limit during evaluation.
  for(const col of h.cycles.columns){
    expect(h.gravityIncidence.reduce((a,t)=>a+col[t.edge]!*t.delta_z_m,0)).toBeCloseTo(0,13)
  }
  const bad={edgeMassflow_kg_s:rates,sectionPressureDrop_Pa:[],water:[],omega_rad_s:[]}
  expect(()=>operatingHydraulicFrame(h,g,bad)).toThrow('Invalid')
  // No nominal-flow recipe can silently turn into the current initialized flow.
  const zero=operatingHydraulicFrame(h,g,{edgeMassflow_kg_s:rates.map(()=>0),sectionPressureDrop_Pa:h.sections.map(()=>0),
    water:f.primary.regions.map(r=>({rho:r.water.rho,mu:r.water.mu,gasVolumeFraction:0})),omega_rad_s:[0,0,0,0]})
  expect(zero.every(r=>r.massflow_kg_s===0)).toBe(true)
},15000)
