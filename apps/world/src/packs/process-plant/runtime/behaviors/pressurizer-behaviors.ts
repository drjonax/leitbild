import type { CompiledComponent } from '../../graph/index.ts'
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
  liquidEnthalpyKjPerKg,
  liquidTemperatureCFromEnthalpy,
  saturatedWaterSteam,
  saturationPressureMPaFromLiquidEnthalpy,
  saturationPressureMPaFromTemperatureC,
  saturationPressureMPaFromVapourDensity,
} from '../water-properties.ts'
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
// No pressure can fall more than a little below the saturation pressure of
// the hottest water exposed to it, which flashes faster than steam escapes.

/** Spray flow as the pressurizer takes it from the cold legs; the loops lose the same flow. */
export const pressurizerSprayFlowKgPerS = (pressurizer: CompiledComponent, context: Pick<ProcessPlantBehaviorContext, 'readNumber'>): number =>
  clamp(context.readNumber(componentVariablePath(pressurizer, 'sprayFlowKgPerS')), 0, 500)

const saturationPressureFloorMarginC = 2

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
      'reactorVessel.loopVoidFraction',
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

      const heaterPower = componentHasElectricalPower(system, component, context, 'heaterPower')
        ? clamp(context.readNumber(componentVariablePath(component, 'heaterPowerMw')), 0, 50)
        : 0
      context.write(componentVariablePath(component, 'demandMw'), heaterPower)
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

      // Insurge brings hot-leg water; outsurge takes the pressurizer's own.
      if (surgeFlow >= 0) {
        water += surgeFlow * dt
        waterEnthalpy += surgeFlow * dt * liquidEnthalpyKjPerKg(hotLegTemperature, pressure)
      } else {
        const outsurge = Math.min(water, -surgeFlow * dt)
        waterEnthalpy *= (water - outsurge) / Math.max(1e-9, water)
        water -= outsurge
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
      // space, water once the pressurizer is solid.
      const reliefMass = (reliefFlow + safetyFlow) * dt
      const steamRelief = Math.min(steam, reliefMass)
      steam -= steamRelief
      const waterRelief = Math.min(water, reliefMass - steamRelief)
      if (waterRelief > 0) {
        waterEnthalpy *= (water - waterRelief) / Math.max(1e-9, water)
        water -= waterRelief
      }

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
      const vapourMass = steam + loopSteamMass
      // Only water still present flashes: the pressurizer's while it holds
      // any, the hot legs' while the loops are not drained.
      const loopVoid = vessel === null ? 1 : context.readNumber(componentVariablePath(vessel, 'loopVoidFraction'))
      const flashingTemperature = Math.max(water > 0 ? nextWaterTemperature : 0, loopVoid < 0.95 ? hotLegTemperature : 0)
      const floor = flashingTemperature > 0 ? saturationPressureMPaFromTemperatureC(flashingTemperature - saturationPressureFloorMarginC) : 0
      const minimumSteamRoom = volume * 0.002
      const waterSolid = steamRoom <= minimumSteamRoom || vapourMass <= 0
      const steamPressure = waterSolid
        // Water-solid: the liquid's compression and the piping's stretch set the pressure.
        ? saturationPressureMPaFromTemperatureC(nextWaterTemperature)
          + (vessel === null ? 0 : parameterNumber(vessel, 'effectiveBulkModulusMPa'))
            * Math.max(0, minimumSteamRoom - steamRoom) / (volume + (vessel === null ? 0 : parameterNumber(vessel, 'primaryCoolantVolumeM3')))
        : saturationPressureMPaFromVapourDensity(vapourMass / steamRoom)
      const nextPressure = Math.max(floor, steamPressure)
      const steamVolume = Math.max(0, volume - waterVolume)
      const perSecond = (mass: number): number => dt > 0 ? mass / dt : 0
      const steamNetFlow = perSecond(phaseChange - sprayCondensation - steamRelief)
      const waterFlows = surgeFlow + sprayFlow + perSecond(sprayCondensation - phaseChange - waterRelief)

      context.write(componentVariablePath(component, 'reliefValveEffectivePositionFraction'), reliefOpening)
      context.write(componentVariablePath(component, 'blockValveEffectivePositionFraction'), nextBlockValvePosition)
      context.write(componentVariablePath(component, 'reliefFlowKgPerS'), reliefFlow)
      context.write(componentVariablePath(component, 'safetyValvesOpen'), safetyValvesOpen)
      context.write(componentVariablePath(component, 'safetyValvesLiftFraction'), safetyLift)
      context.write(componentVariablePath(component, 'safetyValveFlowKgPerS'), safetyFlow)
      context.write(componentVariablePath(component, 'waterTemperatureC'), nextWaterTemperature)
      context.write(componentVariablePath(component, 'steamTemperatureC'), saturationTemperatureCFromPressureMPa(nextPressure))
      context.write(componentVariablePath(component, 'waterInventoryKg'), water)
      context.write(componentVariablePath(component, 'steamMassKg'), steam)
      context.write(componentVariablePath(component, 'steamMassFlowKgPerS'), steamNetFlow)
      context.write(componentVariablePath(component, 'flashingRateKgPerS'), perSecond(phaseChange))
      context.write(componentVariablePath(component, 'steamVolumeM3'), steamVolume)
      context.write(componentVariablePath(component, 'waterInventoryBalanceResidualKg'), water - currentWater - waterFlows * dt)
      context.write(componentVariablePath(component, 'steamMassBalanceResidualKg'), steam - currentSteam - steamNetFlow * dt)
      context.write(componentVariablePath(component, 'levelPercent'), clamp(waterVolume / volume * 100, 0, 100))
      context.write(componentVariablePath(component, 'pressureMPa'), clamp(nextPressure, 0.1, 22))
    },
  },
]

export const pressurizerInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  {
    id: 'pressurizer-saturated-initial-state',
    componentKind: 'pressurizer',
    reads: ['pressureMPa', 'levelPercent'],
    writes: ['waterInventoryKg', 'steamMassKg', 'steamVolumeM3', 'waterTemperatureC', 'steamTemperatureC'],
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
    },
  },
]
