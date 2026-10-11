import type { CompiledComponent } from '../../graph/index.ts'
import { pressurizerLevelControl, type PressurizerLevelControl } from '../../graph/pressurizer-component-definitions.ts'
import {
  componentVariablePath,
  type ComponentBehaviorDefinition,
  type ComponentInitialReconciliationDefinition,
  type ProcessPlantBehaviorContext,
} from '../behavior-contract.ts'
import { approach, clamp, parameterNumber } from '../component-helpers.ts'
import { primarySystemReactorCore, primarySystemReactorVessel } from '../system-topology.ts'
import { saturationTemperatureCFromPressureMPa } from '../thermophysics.ts'
import {
  compressedWaterState,
  criticalPressureMPa,
  liquidEnthalpyKjPerKg,
  liquidTemperatureCFromEnthalpy,
  saturatedWaterSteam,
  saturationPressureMPaFromLiquidEnthalpy,
  saturationPressureMPaFromTemperatureC,
  saturationPressureMPaFromVapourDensity,
} from '../water-properties.ts'
import { liquidMassFluxKgPerM2S, steamMassFluxKgPerM2S } from '../links/primary-break-flow.ts'
import { componentHasElectricalPower } from './electrical-behaviors.ts'

// The pressurizer is a fixed volume of boiling water under its steam. Every
// solver step it takes the surge the reactor coolant loops push into it or
// draw from it, spray, heater heat and relief, and then:
// - water hotter than saturation at its pressure flashes to steam (quickly),
//   and steam condenses on water colder than saturation (slowly, since the
//   water stratifies under the interface);
// - its pressure is that of saturated steam at the density the steam has in
//   the room the liquid leaves it. Steam trapped in the loops shares that
//   room and that pressure, so a void growing in the loops pushes water in
//   and holds the pressure up, as in a stuck-open PORV.
// The pressurizer's own water flashes fast enough to hold the pressure near
// its saturation pressure while any is left. The loops' water holds it only
// as long as it flashes as fast as relief and breaks carry steam and water
// away: a large break outruns it and depressurizes the system.

/** Spray flow as the pressurizer takes it from the cold legs; the loops lose the same flow. */
export const pressurizerSprayFlowKgPerS = (pressurizer: CompiledComponent, context: Pick<ProcessPlantBehaviorContext, 'readNumber'>): number =>
  clamp(context.readNumber(componentVariablePath(pressurizer, 'sprayFlowKgPerS')), 0, 500)

const saturationPressureFloorMarginC = 2

/** The volume a water's room gives up per MPa it is compressed, m3 per m3 of it. */
const waterCompressibilityPerMPa = (temperatureC: number, pressureMPa: number): number => {
  const density = compressedWaterState(temperatureC, pressureMPa).densityKgPerM3
  return (compressedWaterState(temperatureC, pressureMPa + 0.1).densityKgPerM3 - density) / 0.1 / density
}

/** The system's steam space at a pressure: the room it has at the step's pressure, and what its compressed water gives up. */
interface SteamSpace {
  readonly room: number
  readonly vapourMass: number
  readonly pressure: number
  readonly waterComplianceM3PerMPa: number
}

const steamRoomAt = (space: SteamSpace, pressure: number): number =>
  Math.max(0, space.room + space.waterComplianceM3PerMPa * (pressure - space.pressure))

/**
 * The pressure at which the steam's density in its room is saturated steam's:
 * the room grows with the pressure as the water compresses, so the two are
 * found together. Found from last step's room alone, a small steam space over
 * the whole system's water rings, each step's pressure overshooting the last.
 */
const steamPressureOf = (space: SteamSpace): number => {
  const pressureInRoom = (pressure: number): number => {
    const room = steamRoomAt(space, pressure)
    return room > 0 ? saturationPressureMPaFromVapourDensity(Math.max(0, space.vapourMass) / room) : criticalPressureMPa
  }
  // The answer lies between last step's pressure and the pressure last
  // step's room gives.
  let low = Math.min(space.pressure, pressureInRoom(space.pressure))
  let high = Math.max(space.pressure, pressureInRoom(space.pressure))
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const middle = (low + high) / 2
    if (pressureInRoom(middle) > middle) low = middle
    else high = middle
  }
  return (low + high) / 2
}

/**
 * The highest pressure, up to the floor, that the pressurizer's water can
 * hold its steam space at: the water, flashing down to saturation there,
 * raises at least the steam the space then holds.
 */
const pressureWaterHolds = (input: {
  readonly floorPressure: number
  readonly steamPressure: number
  readonly water: number
  readonly waterEnthalpy: number
  readonly space: SteamSpace
}): number => {
  const holds = (pressure: number): boolean => {
    const saturation = saturatedWaterSteam(pressure)
    const flashable = Math.max(0, input.waterEnthalpy - input.water * saturation.liquidEnthalpyKjPerKg)
      / (saturation.vapourEnthalpyKjPerKg - saturation.liquidEnthalpyKjPerKg)
    return input.space.vapourMass + flashable >= saturation.vapourDensityKgPerM3 * steamRoomAt(input.space, pressure)
  }
  if (holds(input.floorPressure)) return input.floorPressure
  // At the steam's own pressure the space needs no more steam, so the water
  // holds some pressure between the two.
  let low = Math.min(input.steamPressure, input.floorPressure)
  let high = input.floorPressure
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const middle = (low + high) / 2
    if (holds(middle)) low = middle
    else high = middle
  }
  return low
}

/** The level the program sets for the loops' mean temperature. */
const levelProgramPercent = (control: PressurizerLevelControl, meanTemperatureC: number): number => {
  const fraction = clamp(
    (meanTemperatureC - control.noLoadAverageTemperatureC) / (control.fullLoadAverageTemperatureC - control.noLoadAverageTemperatureC),
    0,
    1,
  )
  return control.noLoadLevelPercent + fraction * (control.fullLoadLevelPercent - control.noLoadLevelPercent)
}

/** The charging flow level control demands for a level against its program. */
const chargingFlowDemand = (control: PressurizerLevelControl, programPercent: number, levelPercent: number): number =>
  clamp(control.nominalChargingFlowKgPerS + control.gainKgPerSPerPercent * (programPercent - levelPercent), 0, control.maxChargingFlowKgPerS)

export const pressurizerBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'pressurizer-pressure-inventory-state',
    phase: 'updateComponentState',
    componentKind: 'pressurizer',
    reads: [
      'pressureMPa',
      'waterInventoryKg',
      'steamMassKg',
      'waterTemperatureC',
      'heaterPowerMw',
      'backupHeatersOn',
      'incoming electrical energized?',
      'sprayFlowKgPerS',
      'reliefValvePositionFraction',
      'reliefValveFailureActive',
      'reliefValveFailedPositionFraction',
      'blockValvePositionFraction',
      'blockValveEffectivePositionFraction',
      'safetyValvesOpen',
      'levelPercent',
      'reactorVessel.surgeFlowKgPerS',
      'reactorVessel.loopSteamMassKg',
      'reactorVessel.loopSteamVolumeM3',
      'reactorCore.coolantInletTemperatureC',
      'reactorCore.coolantOutletTemperatureC',
    ],
    writes: [
      'pressureMPa',
      'levelPercent',
      'waterInventoryKg',
      'steamMassKg',
      'steamMassFlowKgPerS',
      'steamVolumeM3',
      'flashingRateKgPerS',
      'waterInventoryBalanceResidualKg',
      'steamMassBalanceResidualKg',
      'waterTemperatureC',
      'steamTemperatureC',
      'reliefValveEffectivePositionFraction',
      'blockValveEffectivePositionFraction',
      'reliefFlowKgPerS',
      'safetyValvesOpen',
      'safetyValvesLiftFraction',
      'safetyValveFlowKgPerS',
      'compressedWaterVolumeM3',
      'heatersCutOff',
      'backupHeaterDemandMw',
      'levelProgramPercent',
      'levelDeviationPercent',
      'chargingFlowDemandKgPerS',
      'demandMw',
    ],
    update: ({ system, component, context }): void => {
      const dt = context.dtSeconds
      const volume = parameterNumber(component, 'volumeM3')
      const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
      const reliefSetpoint = parameterNumber(component, 'reliefSetpointMPa')
      const reliefCapacity = parameterNumber(component, 'reliefCapacityKgPerS')
      const flashingTimeConstant = parameterNumber(component, 'flashingTimeConstantS')
      const condensationTimeConstant = parameterNumber(component, 'condensationTimeConstantS')
      const pressure = context.readNumber(componentVariablePath(component, 'pressureMPa'))
      const saturation = saturatedWaterSteam(pressure)
      const latentHeat = saturation.vapourEnthalpyKjPerKg - saturation.liquidEnthalpyKjPerKg

      // Below the low-level cutoff the heaters' breakers open, whatever their
      // command, so that none runs uncovered.
      const heatersCutOff = context.readNumber(componentVariablePath(component, 'levelPercent')) < parameterNumber(component, 'heaterCutoffLevelPercent')
      const controlHeaterPower = !heatersCutOff && componentHasElectricalPower(system, component, context, 'heaterPower')
        ? clamp(context.readNumber(componentVariablePath(component, 'heaterPowerMw')), 0, 50)
        : 0
      // The backup group heats while commanded on and its own supply is live, whatever the control group's bus does.
      const backupHeaterPower = !heatersCutOff
        && context.readBoolean(componentVariablePath(component, 'backupHeatersOn'))
        && componentHasElectricalPower(system, component, context, 'backupHeaterPower')
        ? parameterNumber(component, 'backupHeaterCapacityMw')
        : 0
      const heaterPower = controlHeaterPower + backupHeaterPower
      context.write(componentVariablePath(component, 'heatersCutOff'), heatersCutOff)
      context.write(componentVariablePath(component, 'demandMw'), controlHeaterPower)
      context.write(componentVariablePath(component, 'backupHeaterDemandMw'), backupHeaterPower)
      const sprayFlow = pressurizerSprayFlowKgPerS(component, context)
      const reliefValvePosition = clamp(context.readNumber(componentVariablePath(component, 'reliefValvePositionFraction')), 0, 1)
      const reliefValveFailureActive = context.readBoolean(componentVariablePath(component, 'reliefValveFailureActive'))
      const reliefValveFailedPosition = clamp(context.readNumber(componentVariablePath(component, 'reliefValveFailedPositionFraction')), 0, 1)
      const automaticReliefDemand = clamp((pressure - reliefSetpoint) / Math.max(0.1, reliefSetpoint * 0.04), 0, 1)
      const reliefOpening = reliefValveFailureActive
        ? reliefValveFailedPosition
        : Math.max(reliefValvePosition, automaticReliefDemand)
      // The block valve's motor has its own supply, apart from the heaters'; without it the valve stays where it is.
      const blockValvePosition = context.readNumber(componentVariablePath(component, 'blockValveEffectivePositionFraction'))
      const nextBlockValvePosition = componentHasElectricalPower(system, component, context, 'blockValvePower')
        ? approach(blockValvePosition, clamp(context.readNumber(componentVariablePath(component, 'blockValvePositionFraction')), 0, 1), dt / parameterNumber(component, 'blockValveStrokeTimeS'))
        : blockValvePosition
      const reliefFlow = reliefCapacity * Math.min(reliefOpening, nextBlockValvePosition) * clamp(pressure / nominalPressure, 0, 1.4)
      // The code safety valves pop open at their set pressure, reach full lift
      // with the accumulation above it and stay open until pressure falls by
      // the blowdown below it. Their lift follows pressure between reseat and
      // full lift, and their choked steam flow the pressure upstream.
      const safetySetpoint = parameterNumber(component, 'safetyValveSetpointMPa')
      const safetyFullLiftPressure = safetySetpoint * (1 + parameterNumber(component, 'safetyValveAccumulationFraction'))
      const safetyReseatPressure = safetySetpoint * (1 - parameterNumber(component, 'safetyValveBlowdownFraction'))
      const safetyValvesOpen = context.readBoolean(componentVariablePath(component, 'safetyValvesOpen'))
        ? pressure > safetyReseatPressure
        : pressure >= safetySetpoint
      const safetyLift = safetyValvesOpen
        ? clamp((pressure - safetyReseatPressure) / (safetyFullLiftPressure - safetyReseatPressure), 0, 1)
        : 0
      const safetyFlow = parameterNumber(component, 'safetyValvesCapacityKgPerS') * safetyLift * pressure / safetyFullLiftPressure

      const vessel = primarySystemReactorVessel(system)
      const core = primarySystemReactorCore(system)
      const surgeFlow = vessel === null ? 0 : context.readNumber(componentVariablePath(vessel, 'surgeFlowKgPerS'))
      const loopSteamMass = vessel === null ? 0 : context.readNumber(componentVariablePath(vessel, 'loopSteamMassKg'))
      const loopSteamVolume = vessel === null ? 0 : context.readNumber(componentVariablePath(vessel, 'loopSteamVolumeM3'))
      const hotLegTemperature = core === null ? saturation.temperatureC : context.readNumber(componentVariablePath(core, 'coolantOutletTemperatureC'))
      const coldLegTemperature = core === null ? saturation.temperatureC : context.readNumber(componentVariablePath(core, 'coolantInletTemperatureC'))

      const currentWater = context.readNumber(componentVariablePath(component, 'waterInventoryKg'))
      const currentSteam = context.readNumber(componentVariablePath(component, 'steamMassKg'))
      const currentSpecificVolume = currentWater > 0
        ? context.readNumber(componentVariablePath(component, 'levelPercent')) / 100 * volume / currentWater
        : 1 / saturation.liquidDensityKgPerM3
      let water = currentWater
      let steam = currentSteam
      let waterEnthalpy = water * liquidEnthalpyKjPerKg(context.readNumber(componentVariablePath(component, 'waterTemperatureC')), pressure)

      // Insurge brings hot-leg water; outsurge takes the pressurizer's own,
      // and its steam once it holds no water to seal the surge line.
      let waterSurge = surgeFlow * dt
      let steamOutsurge = 0
      if (surgeFlow >= 0) {
        water += waterSurge
        waterEnthalpy += waterSurge * liquidEnthalpyKjPerKg(hotLegTemperature, pressure)
      } else {
        const outsurge = Math.min(water, -surgeFlow * dt)
        waterEnthalpy *= (water - outsurge) / Math.max(1e-9, water)
        water -= outsurge
        waterSurge = -outsurge
        steamOutsurge = Math.min(steam, -surgeFlow * dt - outsurge)
        steam -= steamOutsurge
      }
      // Spray heats to saturation by condensing steam, and falls as water.
      let sprayCondensation = 0
      if (sprayFlow > 0) {
        const sprayEnthalpy = liquidEnthalpyKjPerKg(coldLegTemperature, pressure)
        sprayCondensation = Math.min(steam, sprayFlow * dt * Math.max(0, saturation.liquidEnthalpyKjPerKg - sprayEnthalpy) / latentHeat)
        steam -= sprayCondensation
        water += sprayFlow * dt + sprayCondensation
        waterEnthalpy += sprayFlow * dt * sprayEnthalpy + sprayCondensation * saturation.vapourEnthalpyKjPerKg
      }
      waterEnthalpy += heaterPower * 1_000 * dt
      // The PORV and the safety valves relieve steam while there is a steam
      // space, water once the pressurizer is solid. Rated for steam, they pass
      // water at its own critical flux, flashing as it chokes in the valve:
      // some two to three times the mass of steam through the same throat.
      const ratedReliefMass = (reliefFlow + safetyFlow) * dt
      const steamRelief = Math.min(steam, ratedReliefMass)
      steam -= steamRelief
      const unusedReliefShare = ratedReliefMass > 0 ? 1 - steamRelief / ratedReliefMass : 0
      const waterRelief = unusedReliefShare > 0 && water > 0
        ? Math.min(water, ratedReliefMass * unusedReliefShare
          * liquidMassFluxKgPerM2S(pressure, liquidTemperatureCFromEnthalpy(pressure, waterEnthalpy / water), 0)
          / steamMassFluxKgPerM2S(pressure, saturation.vapourDensityKgPerM3, 0))
        : 0
      if (waterRelief > 0) {
        waterEnthalpy *= (water - waterRelief) / Math.max(1e-9, water)
        water -= waterRelief
      }
      const reliefMassFactor = ratedReliefMass > 0 ? (steamRelief + waterRelief) / ratedReliefMass : 1

      // Flashing and condensation at the steam-water interface, each no
      // further than brings the steam to the water's own saturation pressure.
      const specificEnthalpy = water > 0 ? waterEnthalpy / water : saturation.liquidEnthalpyKjPerKg
      const superheat = specificEnthalpy - saturation.liquidEnthalpyKjPerKg
      const steamAtWaterSaturation = saturatedWaterSteam(saturationPressureMPaFromLiquidEnthalpy(specificEnthalpy)).vapourDensityKgPerM3
        * (volume - water * currentSpecificVolume + loopSteamVolume)
      const steamToWaterSaturation = steamAtWaterSaturation - steam - loopSteamMass
      let phaseChange = 0
      if (superheat > 0) {
        // No more than the water there is: heater heat in the last few
        // kilograms of a draining pressurizer superheats them without bound.
        phaseChange = Math.min(water, water * superheat / latentHeat * Math.min(1, dt / flashingTimeConstant), Math.max(0, steamToWaterSaturation))
      } else if (steam > 0) {
        phaseChange = -Math.min(steam, water * -superheat / latentHeat * Math.min(1, dt / condensationTimeConstant), Math.max(0, -steamToWaterSaturation))
      }
      water -= phaseChange
      steam += phaseChange
      waterEnthalpy -= phaseChange * saturation.vapourEnthalpyKjPerKg
      const nextWaterTemperature = water > 0
        ? liquidTemperatureCFromEnthalpy(pressure, waterEnthalpy / water)
        : saturation.temperatureC

      // The pressure the steam and liquid volumes settle at.
      const waterVolume = water / compressedWaterState(nextWaterTemperature, pressure).densityKgPerM3
      const steamRoom = volume - waterVolume + loopSteamVolume
      const loopVolume = vessel === null ? 0 : parameterNumber(vessel, 'primaryCoolantVolumeM3')
      const space: SteamSpace = {
        room: steamRoom,
        vapourMass: steam + loopSteamMass,
        pressure,
        waterComplianceM3PerMPa: waterVolume * waterCompressibilityPerMPa(nextWaterTemperature, pressure)
          + (loopVolume - loopSteamVolume) * waterCompressibilityPerMPa((hotLegTemperature + coldLegTemperature) / 2, pressure),
      }
      const minimumSteamRoom = volume * 0.002
      // Water-solid, the system's water compresses, and the piping stretches,
      // by the volume it has outgrown its room since the last step. With room
      // but no steam left in it (a drained system), the pressure is what the
      // little steam there is gives, until water flashes into it.
      const compressedWater = Math.max(0, minimumSteamRoom - steamRoom)
      const steamPressure = steamRoom <= minimumSteamRoom
        ? pressure
          + (vessel === null ? 0 : parameterNumber(vessel, 'effectiveBulkModulusMPa'))
            * (compressedWater - context.readNumber(componentVariablePath(component, 'compressedWaterVolumeM3')))
            / (volume + loopVolume)
        : steamPressureOf(space)
      // The pressurizer's own water, near saturation, flashes faster than any
      // relief or break carries steam off: the pressure stays at about that
      // water's saturation pressure or above, as far as the water holds the
      // heat to raise the steam that takes. The last few kilograms in a
      // drained pressurizer hold too little to keep up its steam space.
      const nextPressure = water > 0
        ? Math.max(steamPressure, pressureWaterHolds({
          floorPressure: saturationPressureMPaFromTemperatureC(nextWaterTemperature - saturationPressureFloorMarginC),
          steamPressure,
          water,
          waterEnthalpy,
          space,
        }))
        : steamPressure
      const steamVolume = Math.max(0, volume - waterVolume)
      const perSecond = (mass: number): number => dt > 0 ? mass / dt : 0
      const steamNetFlow = perSecond(phaseChange - sprayCondensation - steamRelief - steamOutsurge)
      const waterFlows = perSecond(waterSurge) + sprayFlow + perSecond(sprayCondensation - phaseChange - waterRelief)

      context.write(componentVariablePath(component, 'reliefValveEffectivePositionFraction'), reliefOpening)
      context.write(componentVariablePath(component, 'blockValveEffectivePositionFraction'), nextBlockValvePosition)
      context.write(componentVariablePath(component, 'reliefFlowKgPerS'), reliefFlow * reliefMassFactor)
      context.write(componentVariablePath(component, 'safetyValvesOpen'), safetyValvesOpen)
      context.write(componentVariablePath(component, 'safetyValvesLiftFraction'), safetyLift)
      context.write(componentVariablePath(component, 'safetyValveFlowKgPerS'), safetyFlow * reliefMassFactor)
      context.write(componentVariablePath(component, 'waterTemperatureC'), nextWaterTemperature)
      context.write(componentVariablePath(component, 'steamTemperatureC'), saturationTemperatureCFromPressureMPa(nextPressure))
      context.write(componentVariablePath(component, 'waterInventoryKg'), water)
      context.write(componentVariablePath(component, 'steamMassKg'), steam)
      context.write(componentVariablePath(component, 'steamMassFlowKgPerS'), steamNetFlow)
      context.write(componentVariablePath(component, 'flashingRateKgPerS'), perSecond(phaseChange))
      context.write(componentVariablePath(component, 'steamVolumeM3'), steamVolume)
      context.write(componentVariablePath(component, 'waterInventoryBalanceResidualKg'), water - currentWater - waterFlows * dt)
      context.write(componentVariablePath(component, 'steamMassBalanceResidualKg'), steam - currentSteam - steamNetFlow * dt)
      // Level control: the program sets the level for the loops' mean
      // temperature, and the controller runs normal charging on the program,
      // more for a level below it and less for one above, within what the
      // charging can deliver.
      const level = clamp(waterVolume / volume * 100, 0, 100)
      const levelControl = pressurizerLevelControl(component)
      const program = levelProgramPercent(levelControl, (hotLegTemperature + coldLegTemperature) / 2)
      context.write(componentVariablePath(component, 'levelPercent'), level)
      context.write(componentVariablePath(component, 'levelProgramPercent'), program)
      context.write(componentVariablePath(component, 'levelDeviationPercent'), level - program)
      context.write(componentVariablePath(component, 'chargingFlowDemandKgPerS'), chargingFlowDemand(levelControl, program, level))
      context.write(componentVariablePath(component, 'compressedWaterVolumeM3'), compressedWater)
      context.write(componentVariablePath(component, 'pressureMPa'), clamp(nextPressure, 0.1, 22))
    },
  },
]

export const pressurizerInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  {
    id: 'pressurizer-level-program-initial-state',
    componentKind: 'pressurizer',
    // The program reads the loops' temperatures once the links are solved.
    afterLinks: true,
    reads: ['pressureMPa', 'levelPercent', 'reactorCore.coolantInletTemperatureC', 'reactorCore.coolantOutletTemperatureC'],
    writes: ['levelProgramPercent', 'levelDeviationPercent', 'chargingFlowDemandKgPerS'],
    reconcile: ({ system, component, context }): void => {
      const core = primarySystemReactorCore(system)
      const meanTemperature = core === null
        ? saturationTemperatureCFromPressureMPa(context.readNumber(componentVariablePath(component, 'pressureMPa')))
        : (
          context.readNumber(componentVariablePath(core, 'coolantInletTemperatureC'))
          + context.readNumber(componentVariablePath(core, 'coolantOutletTemperatureC'))
        ) / 2
      const levelControl = pressurizerLevelControl(component)
      const program = levelProgramPercent(levelControl, meanTemperature)
      const level = context.readNumber(componentVariablePath(component, 'levelPercent'))
      context.write(componentVariablePath(component, 'levelProgramPercent'), program)
      context.write(componentVariablePath(component, 'levelDeviationPercent'), level - program)
      context.write(componentVariablePath(component, 'chargingFlowDemandKgPerS'), chargingFlowDemand(levelControl, program, level))
    },
  },
  {
    id: 'pressurizer-saturated-initial-state',
    componentKind: 'pressurizer',
    reads: ['pressureMPa', 'levelPercent'],
    writes: ['waterInventoryKg', 'steamMassKg', 'steamVolumeM3', 'waterTemperatureC', 'steamTemperatureC', 'heatersCutOff'],
    // A pressurizer starts boiling at its initial pressure, so an initial
    // pressure set on its own is a state the plant can hold.
    reconcile: ({ component, context }): void => {
      const volume = parameterNumber(component, 'volumeM3')
      const pressure = context.readNumber(componentVariablePath(component, 'pressureMPa'))
      const levelFraction = clamp(context.readNumber(componentVariablePath(component, 'levelPercent')) / 100, 0, 1)
      const saturation = saturatedWaterSteam(pressure)
      context.write(componentVariablePath(component, 'waterInventoryKg'), saturation.liquidDensityKgPerM3 * volume * levelFraction)
      context.write(componentVariablePath(component, 'steamMassKg'), saturation.vapourDensityKgPerM3 * volume * (1 - levelFraction))
      context.write(componentVariablePath(component, 'steamVolumeM3'), volume * (1 - levelFraction))
      context.write(componentVariablePath(component, 'waterTemperatureC'), saturation.temperatureC)
      context.write(componentVariablePath(component, 'steamTemperatureC'), saturation.temperatureC)
      context.write(componentVariablePath(component, 'heatersCutOff'), levelFraction * 100 < parameterNumber(component, 'heaterCutoffLevelPercent'))
    },
  },
]
