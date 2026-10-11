/** Strict S2 SG secondary section of the joined packet, for the native owner
 * (operating/src/sg.rs, the joined spine's `Secondary` block). Every value
 * comes from one owner's strict block; the Rust block derives the relief
 * area and the feed enthalpy with its runtime laws, and takes its prepared
 * stocks from the joined packet's thermal secondaries. No property, law or
 * state is computed here, and nothing is defaulted.
 *
 * `prepareOperatingSecondary` is the one section compiler the joined packet
 * composes under its top-level `secondary` key. `prepareSgProbe` compiles the
 * separate probe section of zero-time receipts and isolated probes only.
 * Usage: bun reference-design-operating-sg.ts <wiki root> <section.json> */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {parseBalanceBasis} from './reference-design-balance'
import {parseCycleBasis} from './reference-design-cycle'
import {parseInitializationBasis} from './reference-design-initialization'
import {parseOperatingHotReference} from './reference-design-operating-fluid'
import {ownedBlock} from './reference-design-operating-pzr'
import {parseOperatingThermal} from './reference-design-operating-thermal'
import {parsePrimaryMechanics} from './reference-design-primary-mechanics'
import {parseSgContact,sgContactOwner} from './reference-design-sg-contact-law'

const positive=z.number().finite().positive()
const exposureSchema=z.object({bottom_m:positive,top_m:positive,horizontalArea_m2:positive,crownTop_m:positive}).strict()
  .refine(e=>e.bottom_m<e.crownTop_m&&e.crownTop_m<e.top_m,'The crown must lie inside the contact span')
const pickupSchema=z.object({pickupBottom_m:positive,pickupTop_m:positive}).strict()
  .refine(p=>p.pickupBottom_m<p.pickupTop_m,'The pickup span must be ordered')
const boundariesSchema=z.object({steamDemand_kg_s:z.object({A:positive,B:positive}).strict(),
  steamDonor:z.literal('pickupGas'),feedRule:z.literal('inventoryHolding')}).strict()
const travelSchema=z.object({sgIsolation_s:positive,turbineStop_s:positive,reheaterIsolation_s:positive,
  admission_s:positive,bypass_s:positive}).strict()
const reliefSchema=z.object({valvesPerSg:z.number().int().positive(),crackPressure_Pa:positive,fullLiftPressure_Pa:positive,
  reseatPressure_Pa:positive,liftLag_s:positive,seatLagTimeConstants:positive,backPressure_Pa:positive,descendingSwitch:z.literal('inletAtFullLift'),
  rating:z.object({fractionOfNominalFlow:positive.max(1),nominalFlow_kg_s:positive,fluid:z.literal('saturatedVapor'),
    inletPressure_Pa:positive}).strict()}).strict()
  .superRefine((r,c)=>{
    if(!(r.backPressure_Pa<r.reseatPressure_Pa&&r.reseatPressure_Pa<r.crackPressure_Pa&&r.crackPressure_Pa<r.fullLiftPressure_Pa))
      c.addIssue({code:'custom',message:'Relief needs receiver < reseat < crack < full lift'})
    if(!(r.rating.inletPressure_Pa>r.backPressure_Pa))c.addIssue({code:'custom',message:'Relief rating inlet must exceed the receiver'})
  })

const root='world/packs/process-plant/reference-designs/ld-01/'
/** Strict blocks that lie under an owning heading. */
export const sgOwners={
  exposure:{page:'systems/steam-generation/thermodynamics.md',heading:'Secondary exposure and local metal storage',fence:'ld01-sg-exposure'},
  pickup:{page:'systems/steam-generation/thermodynamics.md',heading:'Upper pickup, overfill and actual exported material',fence:'ld01-sg-pickup'},
  contact:sgContactOwner,
  boundaries:{page:'systems/steam-generation/thermodynamics.md',heading:'Emergent full-power SG pressure',fence:'ld01-s2-sg-boundaries'},
  relief:{page:'systems/steam-power/admission-and-protection.md',heading:'Turbine trip and reset semantics',fence:'ld01-sg-relief'},
  travel:{page:'systems/steam-power/admission-and-protection.md',heading:'Flow law and nominal sizing',fence:'ld01-steam-valve-travel'},
} as const
export const sectionPages=['systems/steam-generation/thermodynamics.md','systems/steam-power/admission-and-protection.md',
  'numerical-basis.md','systems/steam-power/cycle-basis.md'] as const
export const probePages=['systems/steam-generation/thermodynamics.md','numerical-basis.md','model/operating-hot-reference.md',
  'model/operating-thermal.md','systems/primary-coolant/mechanical-energy-and-geometry.md','model/connected-primary-initialization.md'] as const
export type SectionSources={thermodynamics:string,admission:string,balance:string,cycle:string}
export type ProbeSources={thermodynamics:string,balance:string,hot:string,thermal:string,mechanics:string,initialization:string}
const SGS=['A','B'] as const

export const parseSgRelief=(admission:string)=>reliefSchema.parse(ownedBlock(admission,sgOwners.relief.heading,sgOwners.relief.fence))
export const parseSgBoundaries=(thermodynamics:string)=>
  boundariesSchema.parse(ownedBlock(thermodynamics,sgOwners.boundaries.heading,sgOwners.boundaries.fence))
export const parseSteamValveTravel=(admission:string)=>travelSchema.parse(ownedBlock(admission,sgOwners.travel.heading,sgOwners.travel.fence))
export {parseSgContact}

/** The guard volumes from the contact coordinate: the crown's first
 * uncovery and the pickup's first coverage. The contact span times its area
 * must be the selected free volume exactly. */
function guards(thermodynamics:string,volume_m3:number){
  const exposure=exposureSchema.parse(ownedBlock(thermodynamics,sgOwners.exposure.heading,sgOwners.exposure.fence)),
    pickup=pickupSchema.parse(ownedBlock(thermodynamics,sgOwners.pickup.heading,sgOwners.pickup.fence))
  if((exposure.top_m-exposure.bottom_m)*exposure.horizontalArea_m2!==volume_m3)
    throw Error('Contact coordinate span disagrees with the selected secondary volume')
  if(!(exposure.bottom_m<pickup.pickupBottom_m&&pickup.pickupTop_m<=exposure.top_m))throw Error('Pickup outside the contact span')
  const liquid=(height:number)=>(height-exposure.bottom_m)*exposure.horizontalArea_m2
  return {crown_m3:liquid(exposure.crownTop_m),pickup_m3:liquid(pickup.pickupBottom_m)}
}

/** The joined packet's `secondary` section: per SG (the thermal
 * secondaries' A/B order) its volume, constant demand, guard volumes and
 * valves; the relief characteristic, seat and rating; the feed boundary; the
 * STOP travel of the trip ramp; and the contact law's exchange area and wall
 * constants for the joined solids' films. */
export function compileOperatingSecondary(d:SectionSources){
  const boundaries=parseSgBoundaries(d.thermodynamics),relief=parseSgRelief(d.admission),travel=parseSteamValveTravel(d.admission),
    balance=parseBalanceBasis(d.balance),cycle=parseCycleBasis(d.cycle),g=guards(d.thermodynamics,balance.secondaryVolume_m3),
    prepared=balance.secondaryLiquidVolume_m3,feedPressure=cycle.feedHeaderPressure_MPaAbs*1e6
  if(balance.steamGenerators!==2||cycle.steamGenerators!==2)throw Error('Two steam generators expected')
  if(!(g.crown_m3<prepared&&prepared<g.pickup_m3))throw Error('Prepared liquid volume outside the crown/pickup guard band')
  return {scope:'S2 SG secondaries: one bulk-equilibrium volume per SG with the constant A/B demand and its STOP ramp, the inventory-holding feed and two spring reliefs per SG; Rust owns the laws and derivations, the joined solids the metal and films',
    steamGenerators:SGS.map(id=>({id,volume_m3:balance.secondaryVolume_m3,steamDemand_kg_s:boundaries.steamDemand_kg_s[id],
      crownLiquidVolume_m3:g.crown_m3,pickupLiquidVolume_m3:g.pickup_m3,
      reliefs:Array.from({length:relief.valvesPerSg},(_,i)=>({id:`SG.${id}.RELIEF.${i+1}`}))})),
    relief:{crackPressure_Pa:relief.crackPressure_Pa,fullLiftPressure_Pa:relief.fullLiftPressure_Pa,reseatPressure_Pa:relief.reseatPressure_Pa,
      liftLag_s:relief.liftLag_s,seatLagTimeConstants:relief.seatLagTimeConstants,backPressure_Pa:relief.backPressure_Pa,descendingSwitch:relief.descendingSwitch,
      rating:{massFlow_kg_s:relief.rating.fractionOfNominalFlow*relief.rating.nominalFlow_kg_s,inletPressure_Pa:relief.rating.inletPressure_Pa,
        fluid:relief.rating.fluid}},
    feed:{rule:boundaries.feedRule,pressure_Pa:feedPressure,temperature_K:cycle.feedInlet_C+273.15},
    steamAdmission:{stopTravel_s:travel.turbineStop_s},
    contact:parseSgContact(d.thermodynamics)}
}

/** Probe inputs of zero-time receipts and isolated probes only: the selected
 * hot preparation, the prepared SG primary cell held with the supplied
 * per-SG flows, and the tube path's diameter and segments; its wall
 * constants are the section's `contact`. */
export function compileSgProbe(d:ProbeSources,primaryMassFlow_kg_s:{A:number,B:number}){
  if(![primaryMassFlow_kg_s.A,primaryMassFlow_kg_s.B].every(m=>Number.isFinite(m)&&m>0))throw Error('Positive primary flows required')
  const balance=parseBalanceBasis(d.balance),hot=parseOperatingHotReference(d.hot),thermal=parseOperatingThermal(d.thermal),
    mechanics=parsePrimaryMechanics(d.mechanics),initialization=parseInitializationBasis(d.initialization),contact=parseSgContact(d.thermodynamics),
    n=hot.sgMetalSegments,L=mechanics.sgDevelopedLength_m
  return {preparation:{secondaryPressure_Pa:balance.secondaryPressure_MPaAbs*1e6,liquidVolume_m3:balance.secondaryLiquidVolume_m3,
      metalColdTemperature_K:balance.coreInlet_C+273.15},
    // The SG primary cell: the hot reference's pressure, its 290 °C start
    // and the folded channel's flow area (volume over developed length).
    primary:{pressure_Pa:hot.primaryPressure_Pa,temperature_K:balance.coreInlet_C+273.15,
      flowArea_m2:initialization.volumes_m3[7]!/L,massFlow_kg_s:SGS.map(id=>primaryMassFlow_kg_s[id])},
    tube:{thermalDiameter_m:thermal.sgThermalDiameter_m},
    segments:Array.from({length:n},(_,i)=>({developedStart_m:i*L/n,developedEnd_m:(i+1)*L/n,
      exchangeArea_m2:contact.exchangeArea_m2/n,capacity_J_K:balance.wallCapacity_MJ_K*1e6/n}))}
}

const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
async function read(wikiRoot:string,pages:readonly string[]){
  const docs=await Promise.all(pages.map(p=>Bun.file(join(wikiRoot,root,p)).text()))
  return {docs,provenance:{sourceSha256:hash(await Bun.file(import.meta.path).text()),
    consumed:pages.map((p,i)=>({name:root+p,sha256:hash(docs[i]!)}))}}
}

/** The joined packet's `secondary` section, read from a wiki checkout. */
export async function prepareOperatingSecondary(wikiRoot:string){
  const {docs,provenance}=await read(wikiRoot,sectionPages),[thermodynamics,admission,balance,cycle]=docs as [string,string,string,string]
  return {...compileOperatingSecondary({thermodynamics,admission,balance,cycle}),provenance}
}

/** The probe section, read from a wiki checkout, with declared flows. */
export async function prepareSgProbe(wikiRoot:string,primaryMassFlow_kg_s:{A:number,B:number}){
  const {docs,provenance}=await read(wikiRoot,probePages),
    [thermodynamics,balance,hot,thermal,mechanics,initialization]=docs as [string,string,string,string,string,string]
  return {...compileSgProbe({thermodynamics,balance,hot,thermal,mechanics,initialization},primaryMassFlow_kg_s),provenance}
}

if(import.meta.main){
  const [wiki,output,...rest]=Bun.argv.slice(2)
  if(!wiki||!output||rest.length)throw Error('Usage: reference-design-operating-sg <wiki root> <section.json>')
  await Bun.write(output,JSON.stringify(await prepareOperatingSecondary(wiki),null,2)+'\n')
}
