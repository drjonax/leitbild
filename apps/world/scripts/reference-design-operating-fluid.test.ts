import {expect,test} from 'bun:test'
import {fuelMaterialPython} from './reference-design-fuel-materials'
import {operatingFuelCaloric,operatingCladCaloric,parseOperatingHotReference,prepareOperatingFluid,
  waterPartials,fixedVolumeChart,saturatedVolumeChart,withOperatingIf97,fluidTree,treeContinuity,pressureContinuityProjection,preparePressureContinuity} from './reference-design-operating-fluid'

const sum=(a:readonly number[])=>a.reduce((x,y)=>x+y,0)
test('caloric laws retain their datum and exact primitive derivatives',()=>{
  for(const T of [290,300,350,600,850,1100,1200,1500,1800]){
    const f=operatingFuelCaloric(T),c=operatingCladCaloric(T),d=.0001
    expect(f.cp_J_kg_K).toBeGreaterThan(0);expect(c.cp_J_kg_K).toBeGreaterThan(0)
    if(T>290&&T<1800){
      expect((operatingFuelCaloric(T+d).specificEnergy_J_kg-operatingFuelCaloric(T-d).specificEnergy_J_kg)/(2*d)).toBeCloseTo(f.cp_J_kg_K,4)
      expect((operatingCladCaloric(T+d).specificEnergy_J_kg-operatingCladCaloric(T-d).specificEnergy_J_kg)/(2*d)).toBeCloseTo(c.cp_J_kg_K,4)
    }
  }
  expect(operatingFuelCaloric(300).specificEnergy_J_kg).toBe(0);expect(operatingCladCaloric(300).specificEnergy_J_kg).toBe(0)
  expect(operatingFuelCaloric(290).specificEnergy_J_kg).toBeLessThan(0);expect(operatingCladCaloric(290).specificEnergy_J_kg).toBeLessThan(0)
  expect(()=>operatingFuelCaloric(2001)).toThrow('domain');expect(()=>operatingCladCaloric(NaN)).toThrow('domain')
})

test('SI caloric port agrees with the original reviewed Python primitives',async()=>{
  // Independent original-source implementation, not a production test double.
  // hc/cpf/hf need only the standard library; unused quad/np functions are not called.
  const python=`import math,json\n${fuelMaterialPython}\nprint(json.dumps([[t,hf(t)-hf(300),cpf(t),hc(t)] for t in [300,350,600,850,1100,1200,1500,1800]]))`
  const child=Bun.spawn(['python3','-c',python],{stdout:'pipe',stderr:'pipe'}),
    [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw Error(err)
  for(const [T,e,cp,ec]of JSON.parse(out) as number[][]){
    expect(operatingFuelCaloric(T!).specificEnergy_J_kg).toBeCloseTo(e!,8)
    expect(operatingFuelCaloric(T!).cp_J_kg_K).toBeCloseTo(cp!,10)
    expect(operatingCladCaloric(T!).specificEnergy_J_kg).toBeCloseTo(ec!,8)
  }
})

test('one-gauge incidence preserves prescribed cycle current and rejects material creation',()=>{
  const r=[{id:'A'},{id:'B'},{id:'C'}],e=[{from:0,to:1},{from:1,to:2},{from:2,to:0}],t=fluidTree(r,e)
  expect(t.cycles).toHaveLength(1)
  const q=treeContinuity(r,e,[-3,1,2],[5]),net=[0,0,0]
  for(const [i,x]of e.entries()){net[x.from]!-=q[i]!;net[x.to]!+=q[i]!}
  expect(net).toEqual([-3,1,2]);expect(q[t.cycles[0]!]).toBe(5)
  expect(()=>treeContinuity(r,e,[1,1,1],[0])).toThrow('Nonconservative')
  expect(()=>fluidTree(r,[{from:0,to:1}])).toThrow('Disconnected')
  expect(()=>parseOperatingHotReference('```reference-operating-hot\n{"primaryPressure_Pa":0}\n```')).toThrow()
})

const wiki=process.env.LD01_WIKI_ROOT,if97=process.env.LD01_IF97_DIRECTORY
if(!!wiki!==!!if97)throw Error('Supply both LD01_WIKI_ROOT and LD01_IF97_DIRECTORY for native hot-reference tests')
const native=!!wiki&&!!if97

test.skipIf(!native)('actual wiki geometry, finite caloric recipients, wet SG stocks and simultaneous chart',async()=>{
  const r=await prepareOperatingFluid(wiki!,if97!,2.9e9,{kind:'provisional'}),p=r.primary
  expect(p.regions).toHaveLength(26);expect(p.edges).toHaveLength(32);expect(p.cycleCount).toBe(7)
  // The 52 stems displace water through the full 8.00–8.05 m cap bore as
  // well as the neck above it; the independent housing geometry test checks
  // this 52*pi*(.012 m)^2/4*.05 m displacement, not just this total snapshot.
  expect(p.totalVolume_m3).toBeCloseTo(233.19728869977425,10)
  expect(r.geometry.coreWaterVolume_m3).toBeCloseTo(20.423884517141808,11)
  expect(sum(p.regions.map(r=>r.volume_m3))).toBeCloseTo(p.totalVolume_m3,12)
  expect(p.totalMass_kg).toBeCloseTo(168011.41631687203,6)
  expect(p.totalInternalEnergy_J).toBeCloseTo(222483183392.0793,2)
  expect(p.preparedLoopFlow_kg_s).toBe(0);expect(p.enthalpyReferenceFlow_kg_s).toBeGreaterThan(17000)
  expect(p.simultaneousProjection.minimumScaledPivot).toBeGreaterThan(.2)
  expect(p.simultaneousProjection.donorBranchConsistent).toBe(true)
  expect(r.hotReference.boronReference_ppmEq).toBe(1000)
  expect(r.sourceCapsule_m).toBe(-1)
  expect(r.materials.preparedCarriers).toHaveLength(386)
  expect(r.materials.solidStores).toHaveLength(1544)
  expect(new Set(r.materials.solidStores.map(s=>s.id)).size).toBe(1544)
  expect(r.materials.solidStores.every(s=>Number.isFinite(s.energy_J)&&s.capacity_J_K>0)).toBe(true)
  expect(sum(r.materials.preparedCarriers.flatMap(c=>c.fuelNodes.map(n=>n.mass_kg)))).toBeCloseTo(r.materials.fuelMass_kg,8)
  expect(sum(r.materials.preparedCarriers.map(c=>c.clad.mass_kg))).toBeCloseTo(r.materials.activeCladMass_kg,8)
  expect(r.geometry.materialContacts).toHaveLength(448)
  expect(sum(r.geometry.materialContacts.map(c=>c.cladArea_m2))).toBeCloseTo(193*264*Math.PI*.0095*4,8)
  for(const sg of r.steamGenerators){
    expect(sg.mass_kg).toBeCloseTo(56054.76789328862,7)
    expect(sg.derivative.pressureEnergy).toBeGreaterThan(0)
    expect(sum(sg.metal.map(m=>m.capacity_J_K))).toBe(150e6)
    expect(sum(sg.metal.map(m=>m.exchangeArea_m2))).toBe(5000)
  }
  // Nonzero held source into CORE and equal removal from the two SG primary
  // owners is an algebraic fixture, NOT current solid→fluid heat or steady flow.
  const heat=p.regions.map((_,i)=>i<8?1e6/8:0)
  for(const [i,x]of p.regions.entries())if(x.id.startsWith('SG.'))heat[i]=-5e5
  const t=p.tree,cycles=t.cycles.map(()=>0)
  const projection=preparePressureContinuity(p.regions,p.edges,heat,p.regions.map(()=>0),cycles)
  expect(projection.donorBranchConsistent).toBe(true)
  expect(projection.maxConstraintDefect_kg_s).toBeLessThan(1e-8)
  expect(Math.abs(sum(projection.energyRates_W))).toBeLessThan(1e-7)
  expect(Math.abs(sum(projection.massRates_kg_s))).toBeLessThan(1e-10)
  expect(Math.abs(projection.pressureRate_Pa_s)).toBeGreaterThan(0)
  expect(()=>pressureContinuityProjection(p.regions,p.edges,heat,p.regions.map(()=>0),cycles,[])).toThrow('Invalid')
  expect(()=>pressureContinuityProjection([{...p.regions[0]!,massPAtEnergy_kg_Pa:NaN},...p.regions.slice(1)],p.edges,heat,p.regions.map(()=>0),cycles,p.edges.map(e=>e.from))).toThrow('Invalid')
  expect(()=>fluidTree(p.regions,[...p.edges,{from:-1,to:0}])).toThrow('Invalid')
},15000)

test.skipIf(!native)('maintained R1/R2 partials and saturation chart agree with forward perturbations',async()=>{
  await withOperatingIf97(if97!,async query=>{
    for(const [branch,p,T]of [['liquid',15.2e6,593.15],['vapor',6e6,600]] as const){
      const dp=100,dT=.001,[q,pp,pm,tp,tm]=await query([
        {branch,p,T},{branch,p:p+dp,T},{branch,p:p-dp,T},{branch,p,T:T+dT},{branch,p,T:T-dT}]),d=waterPartials(q!)
      for(const [actual,expected]of [[(pp!.rho-pm!.rho)/(2*dp),d.rhoP],[(tp!.rho-tm!.rho)/(2*dT),d.rhoT],
        [(pp!.u-pm!.u)/(2*dp),d.uP],[(tp!.u-tm!.u)/(2*dT),d.uT]])
        expect(Math.abs(actual!/expected!-1)).toBeLessThan(2e-7)
      expect(fixedVolumeChart(2,q!).mass_kg).toBe(2*q!.rho)
    }
    const dp=100,[l,v,lp,vp,lm,vm]=await query([
      {branch:'sat-liquid',p:6e6,T:0},{branch:'sat-vapor',p:6e6,T:0},
      {branch:'sat-liquid',p:6e6+dp,T:0},{branch:'sat-vapor',p:6e6+dp,T:0},
      {branch:'sat-liquid',p:6e6-dp,T:0},{branch:'sat-vapor',p:6e6-dp,T:0}]),
      c=saturatedVolumeChart(120,72,l!,v!),cp=saturatedVolumeChart(120,72,lp!,vp!),cm=saturatedVolumeChart(120,72,lm!,vm!)
    expect(Math.abs((cp.mass_kg-cm.mass_kg)/(2*dp)/c.derivative.mP-1)).toBeLessThan(2e-7)
    expect(Math.abs((cp.internalEnergy_J-cm.internalEnergy_J)/(2*dp)/c.derivative.eP-1)).toBeLessThan(2e-7)
    expect(saturatedVolumeChart(120,0,l!,v!).liquidMass_kg).toBe(0)
    expect(saturatedVolumeChart(120,120,l!,v!).steamMass_kg).toBe(0)
    expect(()=>saturatedVolumeChart(120,-1,l!,v!)).toThrow('Invalid')
    await expect(query([{branch:'liquid',p:17e6,T:500}])).rejects.toThrow('pressure domain')
    await expect(query([{branch:'liquid',p:6e6,T:600}])).rejects.toThrow('stable')
  })
},15000)
