import type { CompiledProcessLink } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { componentVariablePath, processLinkVariablePath, type ProcessPlantBehaviorContext } from '../behavior-contract.ts'
import { primarySystemContainment, primarySystemReactorVessel } from '../system-topology.ts'
import { compressedWaterState, saturatedWaterSteam, saturationPressureMPaFromTemperatureC } from '../water-properties.ts'

type BreakFlowContext = Pick<ProcessPlantBehaviorContext, 'readNumber' | 'readOptionalNumber' | 'dtSeconds'>

// A break in the reactor coolant system discharges at its critical (choked)
// mass flux, through an opening a fraction of the pipe's own flow area:
// - steam chokes at the speed of sound, sqrt(γ p ρ) times the critical factor
//   for γ = 1.3, or flows as through an orifice where the back pressure is
//   too close for it to choke;
// - liquid adds to the choked flux at its own saturation pressure the flow its
//   subcooling drives, 2ρ(p − psat) in the square, with a sharp-edged
//   discharge coefficient. Saturated liquid flashes in the break and chokes
//   at about the steam's flux, which the homogeneous equilibrium model gives
//   within some 20%;
// - the loops' steam reaches the break in the share of the loops it fills.
// A large break therefore drains the loops in about a minute and a small one
// trickles; the steam leaving takes its latent heat, so the coolant flashes,
// cools and depressurizes as fast as the break carries mass and energy away.

const steamIsentropicExponent = 1.3
const chokedSteamFactor = (2 / (steamIsentropicExponent + 1)) ** ((steamIsentropicExponent + 1) / (2 * (steamIsentropicExponent - 1)))
const liquidDischargeCoefficient = 0.6

const steamMassFluxKgPerM2S = (pressureMPa: number, densityKgPerM3: number, backPressureMPa: number): number =>
  Math.min(
    chokedSteamFactor * Math.sqrt(steamIsentropicExponent * pressureMPa * 1e6 * densityKgPerM3),
    Math.sqrt(2 * densityKgPerM3 * Math.max(0, pressureMPa - backPressureMPa) * 1e6),
  )

const liquidMassFluxKgPerM2S = (pressureMPa: number, temperatureC: number, backPressureMPa: number): number => {
  const density = compressedWaterState(temperatureC, pressureMPa).densityKgPerM3
  const ownSaturationPressure = Math.min(pressureMPa, saturationPressureMPaFromTemperatureC(temperatureC))
  const flashing = ownSaturationPressure > backPressureMPa
    ? steamMassFluxKgPerM2S(ownSaturationPressure, saturatedWaterSteam(ownSaturationPressure).vapourDensityKgPerM3, backPressureMPa)
    : 0
  const subcooling = 2 * density * Math.max(0, pressureMPa - Math.max(ownSaturationPressure, backPressureMPa)) * 1e6
  return Math.sqrt(liquidDischargeCoefficient ** 2 * subcooling + flashing ** 2)
}

export interface PrimaryBreakFlow {
  readonly totalKgPerS: number
  readonly steamKgPerS: number
}

/** The critical flow out of a break in a reactor coolant pipe, and the steam in it. */
export const primaryBreakFlow = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: BreakFlowContext,
): PrimaryBreakFlow => {
  const areaFraction = Math.max(0, Math.min(1, context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0)))
  if (areaFraction <= 0) return { totalKgPerS: 0, steamKgPerS: 0 }
  const diameter = link.physical?.diameterM
  if (diameter === undefined) throw new Error(`reactor coolant link ${link.id} can break but declares no pipe diameter`)
  const area = areaFraction * Math.PI * diameter * diameter / 4
  const pressure = context.readNumber(processLinkVariablePath(link, 'pressureMPa'))
  const containment = primarySystemContainment(system)
  const backPressure = containment === null ? 0.101325 : context.readNumber(componentVariablePath(containment, 'pressureMPa'))
  const vessel = primarySystemReactorVessel(system)
  const voidFraction = vessel === null ? 0 : Math.max(0, Math.min(1, context.readNumber(componentVariablePath(vessel, 'loopVoidFraction'))))
  const liquidFlux = liquidMassFluxKgPerM2S(pressure, context.readNumber(processLinkVariablePath(link, 'temperatureC')), backPressure)
  const steamFlux = voidFraction > 0 ? steamMassFluxKgPerM2S(pressure, saturatedWaterSteam(pressure).vapourDensityKgPerM3, backPressure) : 0
  const steamKgPerS = area * voidFraction * steamFlux
  const totalKgPerS = area * (1 - voidFraction) * liquidFlux + steamKgPerS
  // No more than the loops hold leaves them in a step.
  const available = vessel === null || context.dtSeconds <= 0
    ? Number.POSITIVE_INFINITY
    : Math.max(0, context.readNumber(componentVariablePath(vessel, 'primaryCoolantInventoryKg'))) / context.dtSeconds
  const scale = totalKgPerS > available ? available / totalKgPerS : 1
  return { totalKgPerS: totalKgPerS * scale, steamKgPerS: steamKgPerS * scale }
}
