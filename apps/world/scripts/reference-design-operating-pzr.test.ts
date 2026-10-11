import {expect,test} from 'bun:test'
import {compileOperatingPzr,metastableSchema,ownedBlock,parseOperatingPzr,parsePzrTaps,prepareOperatingPzr,stratifiedSchema,type PzrSources} from './reference-design-operating-pzr'
import {prepareOperatingFluid} from './reference-design-operating-fluid'

// Test-only owner texts: the selections' shapes, not plant evidence. Bracketed
// contract values ([SELECT]) are arbitrary fixtures here.
const selected={commonPressure_Pa:15e6,liquidTemperature_K:600,vaporTemperature_K:630,phaseBoundaryHeight_m:6,
  bands_m:[0,1,3,6,9,12],interfacialLength_m:.003,solidRoughness_m:.000045,absorberMassFraction:.001},
  stratified={withdrawalScale_m:.3,admittedPreparationThickness_m:.3,inversionExchangeVelocity_m_s:.01,
    liquidRelaxationTime_s:.3,vaporRelaxationTime_s:.5,relaxationSensitivity:[.5,1,2],bubbleDiameter_m:.004,
    bubbleExchangeSensitivity:[.5,1,2],bubbleExchangeDiameterSensitivity_m:.0005,
    sprayDropDiameter_m:.003,dropDiameterSensitivity_m:[.0015,.003,.006],resolvabilityFactor:1000},
  metastable={pressureRange_Pa:[2000000,16000000],lowerBoundExclusive:true,liquidSuperheatMax_K:2,
    vaporSubcoolingMax_K:1.4,trialMax_K:3,creditedMax_K:.5,liquidTemperatureMax_K:623.15,
    liquidPressureCeiling_Pa:17000000,vaporPressureCeiling_Pa:16000000},
  fence=(name:string,value:unknown)=>'```'+name+'\n'+JSON.stringify(value)+'\n```',
  route={source:'LD01.HOT.A',receiver:'LD01.PZR',sourceElevation_m:2.5,receiverElevation_m:6.5,
    developedLength_m:16,firstStraight_m:6,bendRadius_m:.45,internalDiameter_m:.3,wallThickness_m:.025,
    steelDensity_kg_m3:7920,roughness_m:.0000015,entryLoss:.5,elbowLoss:.2,exitLoss:1},
  hot={id:'HOT.A',volume_m3:15,mainFlowArea_m2:Math.PI/4,elevation_m:2.5}
function pzrSources(): PzrSources {
  return {selection:'# PZR\n\n## Fixed-region operational carrier\n\n'+fence('reference-operating-pzr',selected)
      +'\n\n## Stratified PZR cell\n\n### Parameters\n\n'+fence('ld01-pzr-stratified',stratified)+'\n\n## Other\n\nText.\n',
    surge:fence('reference-surge-route',route),
    properties:'# Properties\n\n## Bounded metastable admission\n\n'+fence('ld01-metastable-band',metastable)+'\n',
    measurements:'### PZR electronic differential level\n\n'+fence('ld01-pzr-taps',{pt1Elevation_m:18.5,ltLowElevation_m:6.5,ltHighElevation_m:18.5})+'\n\n### Other\n'}
}

test('one stratified PZR cell from the band data: free area, volume, ports, taps, heaters and strict selections',()=>{
  const g=compileOperatingPzr(pzrSources(),hot),c=g.cell,rods=(n:number,L:number,z:number)=>z<=L?n*Math.PI*.01**2:0,
    band=(z:number)=>(.5-rods(32,1,z)-rods(256,3,z))+4.5
  expect(c.freeArea).toEqual([{from_m:6.5,to_m:7.5,area_m2:band(.5)},{from_m:7.5,to_m:9.5,area_m2:band(2)},{from_m:9.5,to_m:18.5,area_m2:5}])
  expect(c.fluidVolume_m3).toBe(c.freeArea.reduce((v,p)=>v+(p.to_m-p.from_m)*p.area_m2,0))
  expect(c.fluidVolume_m3).toBeCloseTo(59.74867258771282,12)
  expect(c.fluidVolume_m3+c.heaters.displacement_m3).toBeCloseTo(60,12)
  expect(c.heaters).toEqual({bottom_m:6.5,top_m:9.5,displacement_m3:.08*Math.PI})
  expect([c.bottom_m,c.top_m]).toEqual([6.5,18.5])
  expect(c.ports).toEqual([{id:'PZR.SURGE.MOUTH',kind:'surge',elevation_m:6.5,bore_m:.3}])
  expect(c.taps).toEqual([{id:'PT1',elevation_m:18.5},{id:'LT.LOW',elevation_m:6.5},{id:'LT.HIGH',elevation_m:18.5}])
  expect(c.stratified as unknown).toEqual(stratified);expect(c.metastable as unknown).toEqual(metastable)
  expect([c.absorberMassFraction,c.interfacialLength_m]).toEqual([.001,.003])
  expect(g.mouth.jetReceiverArea_m2).toBe(4.5);expect(g.mouth.area_m2).toBeCloseTo(Math.PI*.3**2/4,15)
  expect(g.mouth.withdrawalCdAAtUnitFraction_m2).toBeCloseTo(g.mouth.area_m2/Math.sqrt(1.5),14)
  expect('regions' in g||'faces' in g).toBe(false)
  expect(g.hotPartition.parts.reduce((s,p)=>s+p.volume_m3,0)).toBe(15)
  expect(g.hotPartition.parts[1]!.volume_m3).toBe(Math.PI/4)
  expect(g.surge.pieces.reduce((a,p)=>a+p.volume_m3,0)).toBeCloseTo(g.surge.route.liquidVolume_m3,14)
  expect(g.surge.pieces.filter(p=>p.elbowLoss>0)).toHaveLength(2)
})

test('missing, misplaced, repeated or malformed owner selections refuse instead of defaulting',()=>{
  const d=pzrSources(),edit=(key:keyof PzrSources,from:string|RegExp,to:string)=>({...d,[key]:d[key].replace(from,to)})
  expect(()=>parseOperatingPzr(d.selection+'\n'+fence('reference-operating-pzr',selected))).toThrow('one')
  expect(()=>parseOperatingPzr(d.selection.replace('"absorberMassFraction":0.001','"absorberMassFraction":1'))).toThrow()
  expect(()=>compileOperatingPzr(edit('selection','## Stratified PZR cell','## Another cell'),hot)).toThrow('Stratified PZR cell')
  expect(()=>compileOperatingPzr(edit('selection','## Other','```ld01-pzr-stratified\n{}\n```\n## Other'),hot)).toThrow('Expected one')
  expect(()=>compileOperatingPzr(edit('selection','"resolvabilityFactor":1000','"resolvabilityFactor":1000,"extra":1'),hot)).toThrow()
  expect(()=>compileOperatingPzr(edit('selection',',"bubbleDiameter_m":0.004',''),hot)).toThrow()
  expect(()=>compileOperatingPzr(edit('properties','"creditedMax_K":0.5','"creditedMax_K":1.5'),hot)).toThrow('credited')
  expect(()=>compileOperatingPzr(edit('properties','## Bounded metastable admission','## Elsewhere'),hot)).toThrow()
  expect(()=>compileOperatingPzr(edit('measurements','"ltLowElevation_m":6.5,',''),hot)).toThrow()
  expect(()=>compileOperatingPzr(edit('measurements','### PZR electronic differential level','### Elsewhere'),hot)).toThrow()
  expect(()=>compileOperatingPzr(edit('measurements','"pt1Elevation_m":18.5','"pt1Elevation_m":19.5'),hot)).toThrow('outside the cell')
  expect(()=>compileOperatingPzr(edit('surge','6.5','7.5'),hot)).toThrow('datum')
  expect(()=>compileOperatingPzr(d,{...hot,elevation_m:3})).toThrow('envelope')
  expect(ownedBlock(d.selection,'Stratified PZR cell','ld01-pzr-stratified')).toEqual(stratified)
  expect(parsePzrTaps(d.measurements).map(t=>t.id)).toEqual(['PT1','LT.LOW','LT.HIGH'])
})

test('the bulk bubble exchange keys of the stratified block are strict: none is defaulted, reread or loosened',()=>{
  // Request 4, K1: the exchange reuses bubbleDiameter_m and adds its factors
  // and its exchange-only diameter. The dropped vapor-side coefficient (K1
  // outcome: the stocks are saturated by construction) is refused.
  const d=pzrSources(),edit=(from:string,to:string)=>({...d,selection:d.selection.replace(from,to)})
  expect(compileOperatingPzr(d,hot).cell.stratified).toEqual(stratifiedSchema.parse(stratified))
  expect(compileOperatingPzr(d,hot).cell.stratified).toMatchObject({bubbleDiameter_m:.004,
    bubbleExchangeSensitivity:[.5,1,2],bubbleExchangeDiameterSensitivity_m:.0005})
  for(const key of ['"bubbleExchangeSensitivity":[0.5,1,2],','"bubbleExchangeDiameterSensitivity_m":0.0005,'])
    expect(()=>compileOperatingPzr(edit(key,''),hot)).toThrow()
  expect(()=>compileOperatingPzr(edit('"bubbleDiameter_m":0.004,','"bubbleDiameter_m":0.004,"bubbleVaporCoefficient_W_m2K":1000,'),hot)).toThrow()
  expect(()=>compileOperatingPzr(edit('"bubbleExchangeSensitivity":[0.5,1,2]','"bubbleExchangeSensitivity":[0.5,1.5,2]'),hot)).toThrow('nominal factor 1')
  expect(()=>compileOperatingPzr(edit('"bubbleExchangeSensitivity":[0.5,1,2]','"bubbleExchangeSensitivity":[0.5,1]'),hot)).toThrow()
  expect(()=>compileOperatingPzr(edit('"bubbleExchangeDiameterSensitivity_m":0.0005','"bubbleExchangeDiameterSensitivity_m":0.004'),hot)).toThrow('must differ')
  expect(()=>compileOperatingPzr(edit('"bubbleExchangeDiameterSensitivity_m":0.0005','"bubbleExchangeDiameterSensitivity_m":[0.0005]'),hot)).toThrow()
  expect(()=>compileOperatingPzr(edit('"bubbleExchangeDiameterSensitivity_m":0.0005','"bubbleExchangeDiameterSensitivity_m":0'),hot)).toThrow()
  expect(()=>compileOperatingPzr(edit('"bubbleExchangeDiameterSensitivity_m":0.0005','"bubbleExchangeDiameterSensitivity_m":"0.0005"'),hot)).toThrow()
})

test('the metastable band is the one H3 range; the superseded two-range block is refused, not read',()=>{
  // Owner decision request 3, H3: one band, 2 < p <= 16 MPa.
  const h3='{"pressureRange_Pa":[2000000,16000000],"lowerBoundExclusive":true,"liquidSuperheatMax_K":2.0,"vaporSubcoolingMax_K":1.4,"trialMax_K":3.0,"creditedMax_K":0.5,"liquidTemperatureMax_K":623.15,"liquidPressureCeiling_Pa":17000000,"vaporPressureCeiling_Pa":16000000}'
  // Request 2, G2 (a): the 10-16 MPa range plus lowPressureBand on Eq. (18).
  const g2='{"pressureRange_Pa":[10000000,16000000],"lowerBoundExclusive":true,"liquidSuperheatMax_K":2.0,"vaporSubcoolingMax_K":1.4,"trialMax_K":3.0,"creditedMax_K":0.5,"liquidTemperatureMax_K":623.15,"liquidPressureCeiling_Pa":17000000,"vaporPressureCeiling_Pa":16000000,"lowPressureBand":{"pressureRange_Pa":[5900000,10000000],"lowerBoundExclusive":true,"liquidSuperheatMax_K":2.0,"vaporSubcoolingMax_K":1.1,"vaporEquation":"IF97 Eq. (18)"}}'
  expect(metastableSchema.parse(JSON.parse(h3))).toEqual(JSON.parse(h3))
  expect(()=>metastableSchema.parse(JSON.parse(g2))).toThrow('lowPressureBand')
  const page=(block:string)=>({...pzrSources(),properties:'# Properties\n\n## Bounded metastable admission\n\n```ld01-metastable-band\n'+block+'\n```\n'})
  expect(compileOperatingPzr(page(h3),hot).cell.metastable).toEqual(JSON.parse(h3))
  expect(()=>compileOperatingPzr(page(g2),hot)).toThrow('lowPressureBand')
})

const wiki=process.env.LD01_WIKI_ROOT,if97=process.env.LD01_IF97_DIRECTORY
if(!!wiki!==!!if97)throw Error('Supply both actual wiki and pinned IF97 directory')
test.skipIf(!wiki||!if97)('actual owner pages compile one stratified PZR cell with traceable provenance',async()=>{
  const f=await prepareOperatingFluid(wiki!,if97!,2.9e9),p=await prepareOperatingPzr(wiki!,f.geometry.regions.find(r=>r.id==='HOT.A')!)
  expect(p.cell.fluidVolume_m3).toBeCloseTo(59.74867258771282,12)
  expect(p.cell.freeArea).toHaveLength(3);expect(p.cell.taps.map(t=>t.id)).toEqual(['PT1','LT.LOW','LT.HIGH'])
  expect([p.cell.absorberMassFraction,p.cell.interfacialLength_m]).toEqual([.001,.003])
  expect(p.provenance.consumed).toHaveLength(4)
},15000)
