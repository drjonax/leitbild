/** Actual PZR/connection geometry for the one stratified PZR pressure cell
 * (decision 0014). Rust owns the cell's column, zones, laws and preparation;
 * this compiler only copies geometry, ports, taps, heaters and the owners'
 * strict selections. No zone state, region, internal face or held pressure. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {heaterBankBasis,heaterBankGeometry} from './reference-design-pressurizer-heater-banks'
import {parseSurgeRoute,resolveSurgeRoute,routeElevation} from './reference-design-surge-route'

const positive=z.number().finite().positive()
const schema=z.object({commonPressure_Pa:positive,liquidTemperature_K:positive,vaporTemperature_K:positive,
  phaseBoundaryHeight_m:positive,bands_m:z.tuple([z.literal(0),z.literal(1),z.literal(3),z.literal(6),z.literal(9),z.literal(12)]),
  interfacialLength_m:positive,solidRoughness_m:z.number().finite().nonnegative(),
  absorberMassFraction:z.number().finite().min(0).lt(1)}).strict()
/** The owner's PZR selection. P2 consumes only its band data, interfacial
 * length and dissolved absorber fraction (contract amendment 1). */
export function parseOperatingPzr(text:string){
  const blocks=[...text.matchAll(/^```reference-operating-pzr\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-operating-pzr block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
const triple=z.tuple([positive,positive,positive])
const stratifiedSchema=z.object({withdrawalScale_m:positive,admittedPreparationThickness_m:positive,
  inversionExchangeVelocity_m_s:positive,liquidRelaxationTime_s:positive,vaporRelaxationTime_s:positive,
  relaxationSensitivity:triple,bubbleDiameter_m:positive,sprayDropDiameter_m:positive,
  dropDiameterSensitivity_m:triple,resolvabilityFactor:positive}).strict()
const metastableRangeShape={pressureRange_Pa:z.tuple([positive,positive]),lowerBoundExclusive:z.boolean(),
  liquidSuperheatMax_K:positive,vaporSubcoolingMax_K:positive}
export const metastableSchema=z.object({...metastableRangeShape,trialMax_K:positive,creditedMax_K:positive,
  liquidTemperatureMax_K:positive,liquidPressureCeiling_Pa:positive,vaporPressureCeiling_Pa:positive,
  lowPressureBand:z.object({...metastableRangeShape,vaporEquation:z.literal('IF97 Eq. (18)')}).strict()}).strict()
  .superRefine((b,c)=>{
    const l=b.lowPressureBand,admitted=[b.liquidSuperheatMax_K,b.vaporSubcoolingMax_K,l.liquidSuperheatMax_K,l.vaporSubcoolingMax_K]
    if(!(b.pressureRange_Pa[0]<b.pressureRange_Pa[1])||!(l.pressureRange_Pa[0]<l.pressureRange_Pa[1])
      ||!(l.pressureRange_Pa[1]===b.pressureRange_Pa[0]&&b.lowerBoundExclusive)
      ||!(b.creditedMax_K<=Math.min(...admitted))||!(Math.max(...admitted)<=b.trialMax_K))
      c.addIssue({code:'custom',message:'Metastable band needs ordered, adjoining ranges and credited <= band <= trial departures'})
  })

/** Text owned by exactly one heading (to the next heading of the same or a
 * higher level), with headings inside fenced code ignored. */
export function ownedText(text:string,heading:string){
  const lines=text.split('\n'),headings:{index:number,level:number,title:string}[]=[]
  let fenced=false
  for(const [index,line] of lines.entries()){
    if(/^(```|~~~)/.test(line))fenced=!fenced
    const m=fenced?null:/^(#{1,6}) (.+?)\s*$/.exec(line)
    if(m)headings.push({index,level:m[1]!.length,title:m[2]!})
  }
  const own=headings.filter(h=>h.title===heading)
  if(own.length!==1)throw Error('Expected exactly one heading '+heading)
  const next=headings.find(h=>h.index>own[0]!.index&&h.level<=own[0]!.level)
  return lines.slice(own[0]!.index+1,next?.index).join('\n')
}
/** The one strict JSON block of a page; it must lie under its owning heading. */
export function ownedBlock(text:string,heading:string,fence:string):unknown{
  const pattern=new RegExp('^```'+fence+'\\s*\\n([\\s\\S]*?)^```\\s*$','gm'),
    all=[...text.matchAll(pattern)],owned=[...ownedText(text,heading).matchAll(pattern)]
  if(all.length!==1||owned.length!==1)throw Error(`Expected one ${fence} block, under ${heading}`)
  return JSON.parse(owned[0]![1]!)
}
const tapsSchema=z.object({pt1Elevation_m:z.number().finite(),ltLowElevation_m:z.number().finite(),ltHighElevation_m:z.number().finite()}).strict()
export const pzrOwners={
  stratified:{page:'systems/primary-coolant/pressurizer-thermal-state.md',heading:'Stratified PZR cell',fence:'ld01-pzr-stratified'},
  metastable:{page:'model/operating-phase-properties.md',heading:'Bounded metastable admission',fence:'ld01-metastable-band'},
  taps:{page:'systems/instrumentation/phase-dependent-measurements.md',heading:'PZR electronic differential level',fence:'ld01-pzr-taps'},
} as const
/** PT1 roof tap and the two LT pressure interfaces, from the instrumentation owner's block. */
export function parsePzrTaps(measurements:string){
  const t=tapsSchema.parse(ownedBlock(measurements,pzrOwners.taps.heading,pzrOwners.taps.fence))
  return [{id:'PT1',elevation_m:t.pt1Elevation_m},{id:'LT.LOW',elevation_m:t.ltLowElevation_m},{id:'LT.HIGH',elevation_m:t.ltHighElevation_m}]
}

export type HotEnvelope={id:string,volume_m3:number,mainFlowArea_m2:number,elevation_m:number}
export type PzrSources={selection:string,surge:string,properties:string,measurements:string}
export function compileOperatingPzr(d:PzrSources,hot:HotEnvelope){
  const b=parseOperatingPzr(d.selection),hardware=heaterBankBasis,bank=heaterBankGeometry(hardware.vesselHeight_m),
    stratified=stratifiedSchema.parse(ownedBlock(d.selection,pzrOwners.stratified.heading,pzrOwners.stratified.fence)),
    metastable=metastableSchema.parse(ownedBlock(d.properties,pzrOwners.metastable.heading,pzrOwners.metastable.fence)),
    route=resolveSurgeRoute(parseSurgeRoute(d.surge)),banks=(['normal','backup'] as const).map(k=>hardware[k]),
    rodArea=(z:number)=>banks.reduce((sum,q)=>sum+(z<=q.length_m?q.count*Math.PI*(q.diameter_m/2)**2:0),0),
    bottom=hardware.bottom_m,top=bottom+hardware.vesselHeight_m
  if(route.receiverElevation_m!==bottom||route.internalDiameter_m!==.3)throw Error('PZR mouth/route datum mismatch')
  if(hot.id!=='HOT.A'||![hot.volume_m3,hot.mainFlowArea_m2,hot.elevation_m].every(Number.isFinite)
    ||hot.mainFlowArea_m2<=0||hot.volume_m3<=hot.mainFlowArea_m2||hot.elevation_m!==route.sourceElevation_m)throw Error('Invalid actual HOT.A envelope/datum')
  if(b.bands_m.at(-1)!==hardware.vesselHeight_m)throw Error('PZR bands must span the vessel')
  // Existing band data: inner heater-lane free area plus outer annulus per
  // band. A rod end inside a band would make its area nonuniform.
  for(const q of banks)if(b.bands_m.some((lo,i)=>i<b.bands_m.length-1&&lo<q.length_m&&q.length_m<b.bands_m[i+1]!))
    throw Error('A heater rod end lies inside a PZR band')
  const bands=b.bands_m.slice(0,-1).map((lo,i)=>{const hi=b.bands_m[i+1]!,mid=(lo+hi)/2
    return {from_m:bottom+lo,to_m:bottom+hi,area_m2:(hardware.upflowArea_m2-rodArea(mid))+(hardware.vesselArea_m2-hardware.upflowArea_m2)}})
  // Adjacent bands of identical free area are one piece of V(z).
  const freeArea=bands.reduce<typeof bands>((pieces,band)=>{const last=pieces.at(-1)
    if(last&&last.area_m2===band.area_m2)last.to_m=band.to_m;else pieces.push({...band});return pieces},[])
  const fluidVolume=freeArea.reduce((v,p)=>v+(p.to_m-p.from_m)*p.area_m2,0)
  if(Math.abs(fluidVolume+bank.totalSolid_m3-hardware.vesselArea_m2*hardware.vesselHeight_m)>1e-12)throw Error('PZR displaced volume mismatch')
  const taps=parsePzrTaps(d.measurements)
  if(taps.some(t=>!Number.isFinite(t.elevation_m)||t.elevation_m<bottom||t.elevation_m>top))throw Error('A PZR tap lies outside the cell')
  const area=route.area_m2,
    mouth={id:'PZR.SURGE.MOUTH',area_m2:area,elevation_m:bottom,normal:[0,0,1] as [number,number,number],
      receiptConvention:'signed thermal enthalpy into the receiving zone of the stratified cell',
      withdrawalCdAAtUnitFraction_m2:area/Math.sqrt(1.5),receiptArea_m2:area,radiusFromAxis_m:.8,
      // Borda-Carnot receiving area of the face-34 loss: the outer annulus
      // the mouth at r=0.8 m discharges into (contract amendment 1).
      jetReceiverArea_m2:hardware.vesselArea_m2-hardware.upflowArea_m2,
      bottomOuterContactArea_m2:hardware.vesselArea_m2-hardware.upflowArea_m2-area},
    hotArea=hot.mainFlowArea_m2,junctionVolume=hotArea,stubVolume=(hot.volume_m3-junctionVolume)/2,
    lengths=route.lengths_m,ends=lengths.reduce<number[]>((a,L)=>[...a,a[a.length-1]!+L],[0]),
    pieces=lengths.map((L,i)=>({id:`SURGE.PHYSICAL.${i}`,length_m:L,area_m2:area,volume_m3:L*area,
      start_m:ends[i]!,end_m:ends[i+1]!,inletElevation_m:routeElevation(route,ends[i]!),outletElevation_m:routeElevation(route,ends[i+1]!),
      wallRoughness_m:route.roughness_m,elbowLoss:i===1||i===3?route.elbowLoss:0}))
  return {scope:'One stratified PZR pressure cell (vapor zone, admitted and resident liquid layers, bubble/drop transit stocks); Rust owns its column, laws and preparation',
    cell:{bottom_m:bottom,top_m:top,fluidVolume_m3:fluidVolume,freeArea,
      ports:[{id:mouth.id,kind:'surge' as const,elevation_m:mouth.elevation_m,bore_m:route.internalDiameter_m}],
      taps,heaters:{bottom_m:bottom,top_m:bottom+Math.max(...banks.map(q=>q.length_m)),displacement_m3:bank.totalSolid_m3},
      stratified,metastable,absorberMassFraction:b.absorberMassFraction,interfacialLength_m:b.interfacialLength_m},
    material:'NC-free water EOS with finite passive dissolved absorber; any air/nitrogen amount or arrival explicitly refuses',
    mouth,
    hotPartition:{sourceOwner:'HOT.A',totalVolume_m3:hot.volume_m3,parts:[{id:'HOT.A.UPSTREAM',volume_m3:stubVolume,length_m:stubVolume/hotArea},
      {id:'HOT.A.JUNCTION',volume_m3:junctionVolume,length_m:1},{id:'HOT.A.DOWNSTREAM',volume_m3:stubVolume,length_m:stubVolume/hotArea}],
      area_m2:hotArea,surgeArea_m2:area,elevation_m:route.sourceElevation_m,
      junctionPorts:[{id:'HOT.A.JUNCTION.UPSTREAM',area_m2:hotArea,normal:[-1,0,0]as [number,number,number]},
        {id:'HOT.A.JUNCTION.DOWNSTREAM',area_m2:hotArea,normal:[1,0,0]as [number,number,number]},
        {id:'HOT.A.JUNCTION.SURGE',area_m2:area,normal:[0,1,0]as [number,number,number]}],
      reflectingSideAreas_m2:{positiveY:Math.sqrt(hotArea)-area,negativeY:Math.sqrt(hotArea)},
      scope:'Distinct finite thermal owners; carve existing15m³, do not append water or keep an off-centre merged stub'},
    surge:{route,pieces,scope:'Five physical geometry supports, NOT five selected fluid pressure cells; remove existingSURGE from primary territory exactlyonce; retain finite line with own currentpressure/material'}}
}

export async function prepareOperatingPzr(wikiRoot:string,hot:HotEnvelope){
  const base=join(wikiRoot,'world/packs/process-plant/reference-designs/ld-01'),
    paths=[pzrOwners.stratified.page,'systems/primary-coolant/surge-route.md',pzrOwners.metastable.page,pzrOwners.taps.page],
    docs=await Promise.all(paths.map(p=>Bun.file(join(base,p)).text())),
    g=compileOperatingPzr({selection:docs[0]!,surge:docs[1]!,properties:docs[2]!,measurements:docs[3]!},hot),
    hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  return {...g,provenance:{sourceSha256:hash(await Bun.file(import.meta.path).text()),consumed:paths.map((name,i)=>({name,sha256:hash(docs[i]!)})),
    geometryHelperSha256:hash(await Bun.file(new URL('./reference-design-pressurizer-heater-banks.ts',import.meta.url)).text()),
    surgeHelperSha256:hash(await Bun.file(new URL('./reference-design-surge-route.ts',import.meta.url)).text())}}
}
