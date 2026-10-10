import { componentVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import {
  clamp,
  optionalParameterNumber,
  parameterNumber,
  relaxToward,
} from '../component-helpers.ts'
import { averageIncomingComponentLinkValue as averageIncomingLinkValue } from '../component-link-helpers.ts'
import { inventoryBalanceStep } from '../physics.ts'
import { primarySystemReactorVessel } from '../system-topology.ts'
import { saturationTemperatureCFromPressureMPa, steamFlowKgPerSFromHeatMw } from '../thermophysics.ts'
import { componentHasElectricalPower } from './electrical-behaviors.ts'

export const pressurizerBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'pressurizer-pressure-inventory-state',
    phase: 'updateComponentState',
    componentKind: 'pressurizer',
    reads: [
      'pressureMPa',
      'levelPercent',
      'waterInventoryKg',
      'steamMassKg',
      'steamMassFlowKgPerS',
      'steamVolumeM3',
      'steamPressureMPa',
      'pressureTargetMPa',
      'waterInventoryBalanceResidualKg',
      'steamMassBalanceResidualKg',
      'waterTemperatureC',
      'steamTemperatureC',
      'heaterPowerMw',
      'demandMw',
      'incoming electrical energized?',
      'sprayFlowKgPerS',
      'reliefValvePositionFraction',
      'reliefValveFailureActive',
      'reliefValveFailedPositionFraction',
      'incoming:primaryCoolant.temperatureC',
      'reactor vessel primaryPressureBiasMPa',
    ],
    writes: [
      'pressureMPa',
      'levelPercent',
      'waterInventoryKg',
      'steamMassKg',
      'steamMassFlowKgPerS',
      'steamVolumeM3',
      'steamPressureMPa',
      'pressureTargetMPa',
      'waterInventoryBalanceResidualKg',
      'steamMassBalanceResidualKg',
      'waterTemperatureC',
      'steamTemperatureC',
      'reliefValveEffectivePositionFraction',
      'reliefFlowKgPerS',
      'demandMw',
    ],
    update: ({ system, component, context }): void => {
      const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
      const nominalLevelFraction = parameterNumber(component, 'nominalLevelPercent')
      const nominalInventory = parameterNumber(component, 'nominalWaterInventoryKg')
      const nominalSteamMass = optionalParameterNumber(component, 'nominalSteamMassKg', 1_800)
      const nominalWaterDensity = optionalParameterNumber(component, 'nominalWaterDensityKgPerM3', 700)
      const fullInventory = nominalInventory / Math.max(0.01, nominalLevelFraction)
      const fullVolume = fullInventory / nominalWaterDensity
      const nominalSteamVolume = Math.max(0.1, (fullInventory - nominalInventory) / nominalWaterDensity)
      const reliefSetpoint = optionalParameterNumber(component, 'reliefSetpointMPa', nominalPressure * 1.08)
      const reliefCapacity = optionalParameterNumber(component, 'reliefCapacityKgPerS', 80)
      const currentPressure = context.readNumber(componentVariablePath(component, 'pressureMPa'))
      const heaterPower = componentHasElectricalPower(system, component, context)
        ? clamp(context.readNumber(componentVariablePath(component, 'heaterPowerMw')), 0, 50)
        : 0
      context.write(componentVariablePath(component, 'demandMw'), heaterPower)
      const sprayFlow = clamp(context.readNumber(componentVariablePath(component, 'sprayFlowKgPerS')), 0, 500)
      const reliefValvePosition = clamp(context.readNumber(componentVariablePath(component, 'reliefValvePositionFraction')), 0, 1)
      const reliefValveFailureActive = context.readBoolean(componentVariablePath(component, 'reliefValveFailureActive'))
      const reliefValveFailedPosition = clamp(context.readNumber(componentVariablePath(component, 'reliefValveFailedPositionFraction')), 0, 1)
      const automaticReliefDemand = clamp((currentPressure - reliefSetpoint) / Math.max(0.1, reliefSetpoint * 0.04), 0, 1)
      const reliefOpening = reliefValveFailureActive
        ? reliefValveFailedPosition
        : Math.max(reliefValvePosition, automaticReliefDemand)
      const reliefFlow = reliefCapacity * reliefOpening * clamp(currentPressure / nominalPressure, 0.1, 1.4)

      const surgeTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context, link => link.service === 'primaryCoolant')
        ?? context.readNumber(componentVariablePath(component, 'waterTemperatureC'))
      const waterTemperature = context.readNumber(componentVariablePath(component, 'waterTemperatureC'))
      const nextWaterTemperature = relaxToward(
        waterTemperature,
        clamp(surgeTemperature + heaterPower * 0.35 - sprayFlow * 0.04, 180, 370),
        context.dtSeconds,
        optionalParameterNumber(component, 'thermalTimeConstantS', 20),
      )
      const steamTemperatureTarget = saturationTemperatureCFromPressureMPa(currentPressure) + heaterPower * 0.2 - sprayFlow * 0.02
      const nextSteamTemperature = relaxToward(
        context.readNumber(componentVariablePath(component, 'steamTemperatureC')),
        clamp(steamTemperatureTarget, 100, 370),
        context.dtSeconds,
        optionalParameterNumber(component, 'thermalTimeConstantS', 20),
      )
      const currentSteamMass = context.readNumber(componentVariablePath(component, 'steamMassKg'))
      const heaterSteamGeneration = steamFlowKgPerSFromHeatMw(heaterPower)
      const sprayCondensation = Math.min(
        context.dtSeconds > 0 ? currentSteamMass / context.dtSeconds : currentSteamMass,
        sprayFlow * optionalParameterNumber(component, 'sprayCondensationKgPerKg', 0.08),
      )
      const nextSteamMass = inventoryBalanceStep({
        currentInventory: currentSteamMass,
        inflowKgPerS: heaterSteamGeneration,
        outflowKgPerS: sprayCondensation + reliefFlow,
        dtSeconds: context.dtSeconds,
        minInventory: nominalSteamMass * 0.05,
        maxInventory: nominalSteamMass * 3,
      })
      const steamMassNetFlow = heaterSteamGeneration - sprayCondensation - reliefFlow

      const currentInventory = context.readNumber(componentVariablePath(component, 'waterInventoryKg'))
      const waterNetFlow = sprayFlow + sprayCondensation - heaterSteamGeneration
      const nextInventory = clamp(currentInventory + waterNetFlow * context.dtSeconds, 0, fullInventory)
      const steamVolume = Math.max(0.1, fullVolume - nextInventory / nominalWaterDensity)
      const initialSteamTemperature = optionalParameterNumber(component, 'initialSteamTemperatureC', saturationTemperatureCFromPressureMPa(nominalPressure))
      const steamPressure = nominalPressure
        * (nextSteamMass / nominalSteamMass)
        * ((nextSteamTemperature + 273.15) / Math.max(1, initialSteamTemperature + 273.15))
        * (nominalSteamVolume / steamVolume)
      const reactorVessel = primarySystemReactorVessel(system)
      const inventoryPressureBias = reactorVessel === null || !context.has(componentVariablePath(reactorVessel, 'primaryPressureBiasMPa'))
        ? 0
        : context.readNumber(componentVariablePath(reactorVessel, 'primaryPressureBiasMPa'))
      const pressureTarget = clamp(steamPressure + inventoryPressureBias, 0.2, 18)
      const nextPressure = relaxToward(
        currentPressure,
        pressureTarget,
        context.dtSeconds,
        optionalParameterNumber(component, 'pressureTimeConstantS', 12),
      )

      context.write(componentVariablePath(component, 'reliefValveEffectivePositionFraction'), reliefOpening)
      context.write(componentVariablePath(component, 'reliefFlowKgPerS'), reliefFlow)
      context.write(componentVariablePath(component, 'waterTemperatureC'), nextWaterTemperature)
      context.write(componentVariablePath(component, 'steamTemperatureC'), nextSteamTemperature)
      context.write(componentVariablePath(component, 'waterInventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'steamMassKg'), nextSteamMass)
      context.write(componentVariablePath(component, 'steamMassFlowKgPerS'), steamMassNetFlow)
      context.write(componentVariablePath(component, 'steamVolumeM3'), steamVolume)
      context.write(componentVariablePath(component, 'steamPressureMPa'), clamp(steamPressure, 0.2, 18))
      context.write(componentVariablePath(component, 'pressureTargetMPa'), pressureTarget)
      context.write(componentVariablePath(component, 'waterInventoryBalanceResidualKg'), nextInventory - currentInventory - waterNetFlow * context.dtSeconds)
      context.write(componentVariablePath(component, 'steamMassBalanceResidualKg'), nextSteamMass - currentSteamMass - steamMassNetFlow * context.dtSeconds)
      context.write(componentVariablePath(component, 'levelPercent'), clamp((nextInventory / fullInventory) * 100, 0, 100))
      context.write(componentVariablePath(component, 'pressureMPa'), clamp(nextPressure, 0.2, 18))
    },
  },
]
