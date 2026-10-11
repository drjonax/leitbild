import { parameterNumber } from '../component-helpers.ts'
import { pressurizerLevelControl } from '../../graph/pressurizer-component-definitions.ts'
import { saturatedWaterSteam } from '../water-properties.ts'
import type { ComponentInitialValueDefinition } from './model.ts'

// A pressurizer starts boiling at its nominal pressure and level; its initial
// reconciliation fits the water and steam to any other initial pressure or
// level a Plant sets.
export const pressurizerInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'pressurizer',
    initialValueFor: (component, localPath) => {
      const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
      const nominalLevelFraction = parameterNumber(component, 'nominalLevelPercent')
      const volume = parameterNumber(component, 'volumeM3')
      const saturation = saturatedWaterSteam(nominalPressure)
      if (localPath === 'pressureMPa') return nominalPressure
      if (localPath === 'levelPercent') return nominalLevelFraction * 100
      if (localPath === 'waterInventoryKg') return saturation.liquidDensityKgPerM3 * volume * nominalLevelFraction
      if (localPath === 'steamMassKg') return saturation.vapourDensityKgPerM3 * volume * (1 - nominalLevelFraction)
      if (localPath === 'steamMassFlowKgPerS') return 0
      if (localPath === 'steamVolumeM3') return volume * (1 - nominalLevelFraction)
      if (localPath === 'flashingRateKgPerS') return 0
      if (localPath === 'compressedWaterVolumeM3') return 0
      if (localPath === 'waterInventoryBalanceResidualKg') return 0
      if (localPath === 'steamMassBalanceResidualKg') return 0
      if (localPath === 'waterTemperatureC') return saturation.temperatureC
      if (localPath === 'steamTemperatureC') return saturation.temperatureC
      if (localPath === 'heaterPowerMw') return 0
      // The level program and the charging it sets start at full load,
      // where the plant starts; the initial reconciliation fits the program
      // to the loops' initial temperature.
      if (localPath === 'levelProgramPercent') return pressurizerLevelControl(component).fullLoadLevelPercent
      if (localPath === 'chargingFlowDemandKgPerS') return pressurizerLevelControl(component).nominalChargingFlowKgPerS
      if (localPath === 'heatersCutOff') return nominalLevelFraction * 100 < parameterNumber(component, 'heaterCutoffLevelPercent')
      if (localPath === 'demandMw') return 0
      if (localPath === 'sprayFlowKgPerS') return 0
      if (localPath === 'reliefValvePositionFraction') return 0
      if (localPath === 'reliefValveFailureActive') return false
      if (localPath === 'reliefValveFailedPositionFraction') return 1
      if (localPath === 'reliefValveEffectivePositionFraction') return 0
      if (localPath === 'reliefFlowKgPerS') return 0
      if (localPath === 'blockValvePositionFraction') return 1
      if (localPath === 'blockValveEffectivePositionFraction') return 1
      if (localPath === 'safetyValvesOpen') return false
      if (localPath === 'safetyValvesLiftFraction') return 0
      if (localPath === 'safetyValveFlowKgPerS') return 0
      return undefined
    },
  },
]
