/** Case-set packet sections for the stratified PZR cell (lead rulings of
 * 10 October): the S1 cell plus spray and relief ports, and the sibling heater
 * banks and relief calibration, from their owners' strict blocks only. The S1
 * spine compile does not use this module. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {heaterBankBasis,heaterBankGeometry} from './reference-design-pressurizer-heater-banks'
import {compileOperatingPzr,ownedBlock,prepareOperatingPzr,type HotEnvelope} from './reference-design-operating-pzr'

const positive=z.number().finite().positive()
const bankSchema=z.object({id:z.enum(['normal','backup']),equivalentRods:z.number().int().positive(),rodDiameter_m:positive,
  spanBottomAbovePzrBottom_m:z.number().finite().nonnegative(),spanTopAbovePzrBottom_m:positive,
  segments_m:z.array(z.tuple([z.number().finite().nonnegative(),positive])).min(1),nominalCapacity_W:positive,
  lateralContactArea_m2:positive,solidDisplacement_m3:positive,steelMass_kg:positive}).strict()
const banksSchema=z.object({banks:z.array(bankSchema).length(2)}).strict()
const reliefSchema=z.object({openingPressure_Pa:positive,reseatPressure_Pa:positive,fullStrokesPerSecond:positive,
  effectiveAreaPerLift_m2:positive,calibration:z.object({massFlow_kg_s:positive,fluid:z.string().min(1),
    inletPressure_Pa:positive,backPressure_Pa:positive}).strict(),bore_m:positive,elevation_m:positive}).strict()
  .superRefine((r,c)=>{if(!(r.reseatPressure_Pa<r.openingPressure_Pa))c.addIssue({code:'custom',message:'Relief reseat must lie below opening'})})
const sprayPortSchema=z.object({elevation_m:positive,exitCount:z.number().int().positive(),exitBore_m:positive,
  ringRadius_m:positive,effectiveAreaPerExit_m2:positive,aggregateEffectiveArea_m2:positive}).strict()
  .superRefine((s,c)=>{if(Math.abs(s.aggregateEffectiveArea_m2-s.exitCount*s.effectiveAreaPerExit_m2)>1e-12*s.aggregateEffectiveArea_m2)
    c.addIssue({code:'custom',message:'Spray aggregate effective area must be the exits times the per-exit area'})})
export const equipmentOwners={
  heaterBanks:{page:'systems/primary-coolant/heater-equipment.md',heading:'Physical banks and displaced inventory',fence:'ld01-pzr-heater-banks'},
  relief:{page:'systems/primary-coolant/pressure-and-inventory.md',heading:'Independent relief candidate',fence:'ld01-pzr-relief-device'},
  spray:{page:'systems/primary-coolant/pressure-and-inventory.md',heading:'Controlled-spray material path',fence:'ld01-pzr-spray-port'},
} as const
/** The heater-equipment owner's banks, checked against the authored rod
 * geometry: rounded table values must agree within their rounding (volumes
 * below 1e-7 m3, areas and masses below 1e-6), counts, diameters, spans and
 * capacities exactly. The geometry itself is never rounded. */
export function parsePzrHeaterBanks(equipment:string){
  const {banks}=banksSchema.parse(ownedBlock(equipment,equipmentOwners.heaterBanks.heading,equipmentOwners.heaterBanks.fence)),
    hardware=heaterBankBasis,geometry=heaterBankGeometry(hardware.vesselHeight_m)
  if(banks.map(b=>b.id).join()!=='normal,backup')throw Error('Expected the normal and backup heater banks in order')
  for(const b of banks){
    const q=hardware[b.id],g=geometry.banks[b.id]
    if(b.equivalentRods!==q.count||b.rodDiameter_m!==q.diameter_m||b.spanBottomAbovePzrBottom_m!==0
      ||b.spanTopAbovePzrBottom_m!==q.length_m||b.nominalCapacity_W!==q.capacity_W)throw Error(`Heater bank ${b.id} disagrees with the rod geometry`)
    if(Math.abs(b.solidDisplacement_m3-g.solidVolume_m3)>=1e-7||Math.abs(b.lateralContactArea_m2-g.fullSideArea_m2)>=1e-6
      ||Math.abs(b.steelMass_kg-g.steelMass_kg)>=1e-6)throw Error(`Heater bank ${b.id} table values exceed their rounding`)
    if(b.segments_m.some(([lo,hi],i)=>!(lo<hi)||(i>0&&lo!==b.segments_m[i-1]![1]))||b.segments_m[0]![0]!==b.spanBottomAbovePzrBottom_m
      ||b.segments_m.at(-1)![1]!==b.spanTopAbovePzrBottom_m)throw Error(`Heater bank ${b.id} segments must tile its span`)
  }
  if(Math.abs(banks.reduce((v,b)=>v+b.solidDisplacement_m3,0)-geometry.totalSolid_m3)>=1e-7)throw Error('Heater displacements disagree with the rod geometry')
  return banks
}
/** The independent relief device from its pressure-and-inventory owner. */
export function parsePzrRelief(inventory:string){
  return reliefSchema.parse(ownedBlock(inventory,equipmentOwners.relief.heading,equipmentOwners.relief.fence))
}

/** Spray and relief port geometry for case-set packets; each value must come
 * from its owner (lead ruling: no default). */
export type CaseSetPortGeometry={relief:{elevation_m:number},spray:{elevation_m:number,bore_m:number}}
/** Case-set additions to one compiled cell: the spray and relief ports (the
 * relief carries only the four device fields the cell reads), the sibling
 * heater banks with spans and segments on the plant datum, and the relief
 * calibration record. The surge port and every other cell field stay. */
export function caseSetSections(cell:ReturnType<typeof compileOperatingPzr>['cell'],banks:ReturnType<typeof parsePzrHeaterBanks>,
  relief:ReturnType<typeof parsePzrRelief>,geometry:CaseSetPortGeometry){
  const inside=(z:number)=>Number.isFinite(z)&&z>=cell.bottom_m&&z<=cell.top_m
  if(!inside(geometry.relief.elevation_m)||!inside(geometry.spray.elevation_m)||!(geometry.spray.bore_m>0))
    throw Error('Case-set port geometry lies outside the cell')
  const datum=(z:number)=>cell.bottom_m+z
  return {cell:{...cell,ports:[...cell.ports,
      {id:'PZR.SPRAY',kind:'spray' as const,elevation_m:geometry.spray.elevation_m,face:null,bore_m:geometry.spray.bore_m},
      {id:'PZR.RELIEF',kind:'relief' as const,elevation_m:geometry.relief.elevation_m,face:null,bore_m:relief.bore_m,
        relief:{opening_Pa:relief.openingPressure_Pa,reseat_Pa:relief.reseatPressure_Pa,fullStrokes_per_s:relief.fullStrokesPerSecond,
          effectiveAreaPerLift_m2:relief.effectiveAreaPerLift_m2}}]},
    heaterBanks:banks.map(b=>({id:b.id,bottom_m:datum(b.spanBottomAbovePzrBottom_m),top_m:datum(b.spanTopAbovePzrBottom_m),
      segments_m:b.segments_m.map(([lo,hi])=>[datum(lo),datum(hi)] as [number,number]),equivalentRods:b.equivalentRods,
      rodDiameter_m:b.rodDiameter_m,nominalCapacity_W:b.nominalCapacity_W,lateralContactArea_m2:b.lateralContactArea_m2,
      solidDisplacement_m3:b.solidDisplacement_m3,steelMass_kg:b.steelMass_kg})),
    reliefCalibration:{...relief.calibration}}
}
/** The controlled-spray distributor from its pressure-and-inventory owner. */
export function parsePzrSpray(inventory:string){
  return sprayPortSchema.parse(ownedBlock(inventory,equipmentOwners.spray.heading,equipmentOwners.spray.fence))
}
/** Port geometry from the owners' blocks: the relief pickup elevation from
 * the relief device, the spray inlet elevation and its exit bore (one of the
 * distributor's equal tips, not the supply line's bore) from the spray
 * distributor. */
function caseSetPortGeometry(inventory:string):CaseSetPortGeometry{
  const relief=parsePzrRelief(inventory),spray=parsePzrSpray(inventory)
  return {relief:{elevation_m:relief.elevation_m},spray:{elevation_m:spray.elevation_m,bore_m:spray.exitBore_m}}
}
/** Case-set packet section (lead ruling 3): the S1 cell plus the spray and
 * relief ports and the heater-bank and relief-calibration siblings, from
 * their strict blocks only. The S1 spine compile does not call this. */
export async function prepareOperatingPzrCaseSet(wikiRoot:string,hot:HotEnvelope){
  const base=join(wikiRoot,'world/packs/process-plant/reference-designs/ld-01'),s1=await prepareOperatingPzr(wikiRoot,hot),
    paths=[equipmentOwners.heaterBanks.page,equipmentOwners.relief.page],docs=await Promise.all(paths.map(p=>Bun.file(join(base,p)).text())),
    hash=(s:string)=>createHash('sha256').update(s).digest('hex'),
    added=caseSetSections(s1.cell,parsePzrHeaterBanks(docs[0]!),parsePzrRelief(docs[1]!),caseSetPortGeometry(docs[1]!))
  return {...s1,...added,provenance:{...s1.provenance,consumed:[...s1.provenance.consumed,...paths.map((name,i)=>({name,sha256:hash(docs[i]!)}))]}}
}
