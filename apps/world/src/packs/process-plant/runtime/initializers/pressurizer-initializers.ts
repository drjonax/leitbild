import { optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import { saturationTemperatureCFromPressureMPa } from '../thermophysics.ts'
import type { ComponentInitialValueDefinition } from './model.ts'

export const pressurizerInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'pressurizer',
    initialValueFor: (component, localPath) => {
      const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
      const nominalLevelFraction = parameterNumber(component, 'nominalLevelPercent')
      if (localPath === 'pressureMPa') return nominalPressure
      if (localPath === 'levelPercent') return nominalLevelFraction * 100
      if (localPath === 'waterInventoryKg') return parameterNumber(component, 'nominalWaterInventoryKg')
      if (localPath === 'steamMassKg') return optionalParameterNumber(component, 'nominalSteamMassKg', 1_800)
      if (localPath === 'steamMassFlowKgPerS') return 0
      if (localPath === 'steamVolumeM3') {
        const density = optionalParameterNumber(component, 'nominalWaterDensityKgPerM3', 700)
        const fullInventory = parameterNumber(component, 'nominalWaterInventoryKg') / Math.max(0.01, nominalLevelFraction)
        return Math.max(0.1, (fullInventory - parameterNumber(component, 'nominalWaterInventoryKg')) / density)
      }
      if (localPath === 'steamPressureMPa') return nominalPressure
      if (localPath === 'pressureTargetMPa') return nominalPressure
      if (localPath === 'waterInventoryBalanceResidualKg') return 0
      if (localPath === 'steamMassBalanceResidualKg') return 0
      if (localPath === 'waterTemperatureC') return optionalParameterNumber(component, 'initialWaterTemperatureC', 345)
      if (localPath === 'steamTemperatureC') return optionalParameterNumber(component, 'initialSteamTemperatureC', saturationTemperatureCFromPressureMPa(nominalPressure))
      if (localPath === 'heaterPowerMw') return 0
      if (localPath === 'demandMw') return 0
      if (localPath === 'sprayFlowKgPerS') return 0
      if (localPath === 'reliefValvePositionFraction') return 0
      if (localPath === 'reliefValveFailureActive') return false
      if (localPath === 'reliefValveFailedPositionFraction') return 1
      if (localPath === 'reliefValveEffectivePositionFraction') return 0
      if (localPath === 'reliefFlowKgPerS') return 0
      return undefined
    },
  },
]
