/** The SG contact law's strict block (`ld01-sg-contact`): the effective
 * exchange area per SG, uniform over the developed fold, and the tube steel's
 * emissivity and material constants. A leaf module, so that the fluid
 * compiler (the SG metal's segment areas) and the SG section compiler read
 * the same parse without importing each other. */
import {z} from 'zod'
import {ownedBlock} from './reference-design-operating-pzr'

const positive=z.number().finite().positive()
export const sgContactOwner={page:'systems/steam-generation/thermodynamics.md',heading:'Selected pure-water secondary contact law',fence:'ld01-sg-contact'} as const
const contactSchema=z.object({exchangeArea_m2:positive,emissivity:positive.max(1),steelConductivity_W_mK:positive,
  steelDensity_kg_m3:positive,steelCp_J_kgK:positive}).strict()
/** The SG contact law's exchange area and wall constants (`ld01-sg-contact`). */
export const parseSgContact=(thermodynamics:string)=>contactSchema.parse(ownedBlock(thermodynamics,sgContactOwner.heading,sgContactOwner.fence))
