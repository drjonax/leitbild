import { optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import { latentHeatSteamMjPerKg } from '../thermophysics.ts'
import type { ComponentInitialValueDefinition } from './model.ts'
import { steamGeneratorLevelOnSpanPercent, steamGeneratorOperatingLevel, steamGeneratorWideRange } from '../../steam-generator-operating-level.ts'

export const steamGeneratorInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'steamGenerator',
    initialValueFor: (component, localPath) => {
      const level = steamGeneratorOperatingLevel(component.parameters as Record<string, unknown>)
      const initialSteamFlow = optionalParameterNumber(component, 'nominalSteamFlowKgPerS', 760)
        * optionalParameterNumber(component, 'initialSteamFlowFraction', 0)
      if (localPath === 'levelPercent') return parameterNumber(component, 'nominalLevelPercent') * 100
      if (localPath === 'wideRangeLevelPercent') return steamGeneratorLevelOnSpanPercent(steamGeneratorWideRange(component.parameters as Record<string, unknown>), level.collapsed + level.swell)
      if (localPath === 'pressureMPa') return parameterNumber(component, 'nominalPressureMPa')
      if (localPath === 'heatTransferMw') return initialSteamFlow * latentHeatSteamMjPerKg
      if (localPath === 'primaryInletTemperatureC') return optionalParameterNumber(component, 'initialPrimaryInletTemperatureC', 322)
      if (localPath === 'primaryOutletTemperatureC') return optionalParameterNumber(component, 'initialPrimaryOutletTemperatureC', 290)
      if (localPath === 'tubeMetalTemperatureC') {
        const primary = optionalParameterNumber(component, 'initialPrimaryInletTemperatureC', 322)
        const secondary = optionalParameterNumber(component, 'initialSecondaryTemperatureC', 285)
        return optionalParameterNumber(component, 'tubeMetalInitialTemperatureC', (primary + secondary) / 2)
      }
      if (localPath === 'secondaryTemperatureC') return optionalParameterNumber(component, 'initialSecondaryTemperatureC', 285)
      if (localPath === 'steamFlowKgPerS') return initialSteamFlow
      if (localPath === 'boilingRateKgPerS') return initialSteamFlow
      if (localPath === 'feedwaterFlowKgPerS') return initialSteamFlow
      if (localPath === 'steamOutflowKgPerS') return initialSteamFlow
      if (localPath === 'steamQualityFraction') return 1
      if (localPath === 'secondaryInventoryKg') return optionalParameterNumber(component, 'nominalSecondaryInventoryKg', 56_000) * level.collapsed / 100
      if (localPath === 'collapsedLevelPercent') return level.collapsed
      if (localPath === 'voidFraction') return level.voidFraction
      if (localPath === 'swellLevelPercent') return level.swell
      if (localPath === 'tubeCoverageFraction') return 1
      if (localPath === 'tubeUncoveredFraction') return 0
      if (localPath === 'availableHeatTransferFraction') return 1
      if (localPath === 'steamMassKg') return optionalParameterNumber(component, 'nominalSteamMassKg', 12_000)
      if (localPath === 'pressureTargetMPa') return parameterNumber(component, 'nominalPressureMPa')
      if (localPath === 'steamMassPressureBiasMPa') return 0
      if (localPath === 'temperaturePressureBiasMPa') return 0
      if (localPath === 'inventoryPressureBiasMPa') return 0
      if (localPath === 'secondaryInventoryBalanceResidualKg') return 0
      if (localPath === 'steamMassBalanceResidualKg') return 0
      if (localPath === 'boilingEnergyResidualMw') return 0
      if (localPath === 'tubeLeakFraction') return 0
      if (localPath === 'primaryToSecondaryLeakKgPerS') return 0
      if (localPath === 'secondaryRadiationMSvPerH') return 0.02
      return undefined
    },
  },
]
