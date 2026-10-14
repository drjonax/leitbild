import {expect,test} from 'bun:test'
import {compileOperatingPzr,type PzrSources} from './reference-design-operating-pzr'
import {caseSetSections,parsePzrHeaterBanks,parsePzrRelief,parsePzrSpray} from './reference-design-operating-pzr-cases'
import {joinedPzrSections} from './reference-design-operating-joined'

// Test-only owner texts in the shapes the compilers read; not plant evidence.
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

test('heater banks and the relief device parse from their owners and agree with the rod geometry',()=>{
  const banks={banks:[{id:'normal',equivalentRods:32,rodDiameter_m:.02,spanBottomAbovePzrBottom_m:0,spanTopAbovePzrBottom_m:1,segments_m:[[0,1]],
      nominalCapacity_W:120000,lateralContactArea_m2:2.010619,solidDisplacement_m3:.0100531,steelMass_kg:79.620524},
    {id:'backup',equivalentRods:256,rodDiameter_m:.02,spanBottomAbovePzrBottom_m:0,spanTopAbovePzrBottom_m:3,segments_m:[[0,1],[1,3]],
      nominalCapacity_W:2880000,lateralContactArea_m2:48.254863,solidDisplacement_m3:.2412743,steelMass_kg:1910.892581}]},
    equipment='## Physical banks and displaced inventory\n\n'+fence('ld01-pzr-heater-banks',banks)+'\n',
    relief={openingPressure_Pa:15800000,reseatPressure_Pa:15600000,fullStrokesPerSecond:20,effectiveAreaPerLift_m2:.00411672057382,
      calibration:{massFlow_kg_s:100,fluid:'saturatedSteam',inletPressure_Pa:15800000,backPressure_Pa:101325},bore_m:.15,elevation_m:18.5},
    spray={elevation_m:18.5,exitCount:16,exitBore_m:.012,ringRadius_m:.6,effectiveAreaPerExit_m2:.0000625,aggregateEffectiveArea_m2:.001},
    inventory='### Independent relief candidate\n\n'+fence('ld01-pzr-relief-device',relief)+'\n\n## Controlled-spray material path\n\n'+fence('ld01-pzr-spray-port',spray)+'\n'
  expect(parsePzrHeaterBanks(equipment).map(b=>b.id)).toEqual(['normal','backup'])
  expect(parsePzrRelief(inventory)).toEqual(relief)
  expect(parsePzrSpray(inventory)).toEqual(spray)
  expect(()=>parsePzrSpray(inventory.replace('"aggregateEffectiveArea_m2":0.001','"aggregateEffectiveArea_m2":0.0011'))).toThrow('aggregate')
  const edit=(from:string,to:string)=>equipment.replace(from,to)
  expect(()=>parsePzrHeaterBanks(edit('"solidDisplacement_m3":0.2412743','"solidDisplacement_m3":0.2412745'))).toThrow('rounding')
  expect(()=>parsePzrHeaterBanks(edit('"equivalentRods":256','"equivalentRods":255'))).toThrow('rod geometry')
  expect(()=>parsePzrHeaterBanks(edit('"spanTopAbovePzrBottom_m":3','"spanTopAbovePzrBottom_m":2.9'))).toThrow('rod geometry')
  expect(()=>parsePzrHeaterBanks(edit('"steelMass_kg":79.620524','"steelMass_kg":79.620524,"extra":1'))).toThrow()
  expect(()=>parsePzrHeaterBanks(edit('[[0,1],[1,3]]','[[0,1],[1.5,3]]'))).toThrow('tile')
  expect(()=>parsePzrRelief(inventory.replace('15600000','15900000'))).toThrow('reseat')
  // Case-set sections: ports appended, siblings on the plant datum, surge port kept.
  const cell=compileOperatingPzr(pzrSources(),hot).cell,
    added=caseSetSections(cell,parsePzrHeaterBanks(equipment),parsePzrRelief(inventory),{relief:{elevation_m:18.5},spray:{elevation_m:18,bore_m:.1}})
  expect(added.cell.ports.map(p=>p.kind)).toEqual(['surge','spray','relief'])
  expect(added.cell.ports[2]).toEqual({id:'PZR.RELIEF',kind:'relief',elevation_m:18.5,face:null,bore_m:.15,
    relief:{opening_Pa:15800000,reseat_Pa:15600000,fullStrokes_per_s:20,effectiveAreaPerLift_m2:.00411672057382}})
  expect(added.heaterBanks.map(b=>[b.bottom_m,b.top_m,b.segments_m])).toEqual([[6.5,7.5,[[6.5,7.5]]],[6.5,9.5,[[6.5,7.5],[7.5,9.5]]]])
  expect(added.reliefCalibration).toEqual(relief.calibration)
  expect({...added.cell,ports:added.cell.ports.slice(0,1)}).toEqual(cell)
  expect(()=>caseSetSections(cell,parsePzrHeaterBanks(equipment),parsePzrRelief(inventory),{relief:{elevation_m:19},spray:{elevation_m:18,bore_m:.1}})).toThrow('outside')
  expect(()=>parsePzrRelief(inventory.replace('### Independent relief candidate','### Elsewhere'))).toThrow()
  // G6's joined sections: the spine cell keeps its index and surge face, the
  // spray and relief take none; the metal owner's blocks pass unchanged and
  // the receiver is the relief calibration's backpressure.
  const pages={equipment:equipment+'\n## Abnormal wall contact and finite heat receivers\n\n'+fence('ld01-pzr-heater-contact',{wet:1})
      +'\n\n### Fixed metal and complementary contact\n\n'+fence('reference-304-caloric',{datum_K:300})+'\n',
    inventory,thermal:'### Shell and head metal\n\n'+fence('ld01-pzr-shell',{grossArea_m2:5})+'\n'},
    g6=joinedPzrSections({...cell,index:28,ports:cell.ports.map(p=>({...p,face:34}))},pages)
  expect(g6.cell.index).toBe(28)
  expect((g6.cell.ports as {kind:string,face:number|null}[]).map(p=>[p.kind,p.face])).toEqual([['surge',34],['spray',null],['relief',null]])
  expect(g6.pzrMetal).toEqual({heaterBanks:{banks:parsePzrHeaterBanks(equipment)},heaterContact:{wet:1},caloric304:{datum_K:300},
    shell:{grossArea_m2:5},reliefBackPressure_Pa:101325})
  expect(()=>joinedPzrSections(cell,{...pages,thermal:'### Elsewhere\n'})).toThrow('Shell and head metal')
})

