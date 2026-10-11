import { optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import type { ComponentInitialValueDefinition } from './model.ts'
import { condenserThermalBalance } from '../condenser-thermodynamics.ts'

export const balanceOfPlantInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'processTank',
    initialValueFor: (component, localPath) => {
      const nominalInventory = parameterNumber(component, 'nominalInventoryKg')
      const initialFraction = parameterNumber(component, 'initialInventoryFraction')
      if (localPath === 'inventoryKg') return nominalInventory * initialFraction
      if (localPath === 'levelPercent') return initialFraction * 100
      if (localPath === 'temperatureC') return parameterNumber(component, 'initialTemperatureC')
      if (localPath === 'soluteConcentrationPpm') return optionalParameterNumber(component, 'initialSoluteConcentrationPpm', 0)
      if (localPath === 'makeupFlowKgPerS') return parameterNumber(component, 'makeupFlowKgPerS')
      if (localPath === 'availableOutletFlowKgPerS') return parameterNumber(component, 'maxOutletFlowKgPerS')
      return undefined
    },
  },
  {
    componentKind: 'turbineLoadSink',
    initialValueFor: (component, localPath) => {
      const initialLoadFraction = parameterNumber(component, 'initialLoadFraction')
      if (localPath === 'electricMw') return parameterNumber(component, 'nominalElectricMw') * initialLoadFraction
      if (localPath === 'outputBreakerClosed') return initialLoadFraction > 0
      if (localPath === 'loadFraction') return initialLoadFraction
      if (localPath === 'steamFlowKgPerS') return parameterNumber(component, 'nominalSteamFlowKgPerS') * initialLoadFraction
      if (localPath === 'steamDemandKgPerS') return parameterNumber(component, 'nominalSteamFlowKgPerS') * initialLoadFraction
      if (localPath === 'steamAvailabilityFraction') return 1
      if (localPath === 'exhaustTemperatureC') {
        const noLoad = optionalParameterNumber(component, 'exhaustTemperatureAtNoLoadC', 105)
        const fullLoad = optionalParameterNumber(component, 'exhaustTemperatureAtFullLoadC', 145)
        return noLoad + (fullLoad - noLoad) * initialLoadFraction
      }
      return undefined
    },
  },
  {
    componentKind: 'condenserSink',
    initialValueFor: (component, localPath) => {
      const flow = parameterNumber(component, 'nominalSteamFlowKgPerS') * optionalParameterNumber(component, 'initialSteamFlowFraction', 0)
      const balance = condenserThermalBalance({ steamFlow: flow, steamTemperature: optionalParameterNumber(component, 'initialSteamTemperatureC', 145), nominalSteamFlow: parameterNumber(component, 'nominalSteamFlowKgPerS'), coolingWaterFlow: parameterNumber(component, 'nominalCoolingWaterFlowKgPerS'), coolingWaterInletTemperature: parameterNumber(component, 'coolingWaterTemperatureC'), coolingWaterDesignDeltaT: parameterNumber(component, 'coolingWaterDesignDeltaTK'), condensateApproach: parameterNumber(component, 'condensateApproachTemperatureK') })
      if (localPath === 'steamFlowKgPerS') return flow
      if (localPath === 'condensateProductionKgPerS') return balance.condensateProduction
      if (localPath === 'heatRejectedMw') return balance.heatRejected
      if (localPath === 'condensateInventoryKg') return parameterNumber(component, 'nominalCondensateInventoryKg') * parameterNumber(component, 'initialCondensateInventoryFraction')
      if (localPath === 'condensateLevelPercent') return parameterNumber(component, 'initialCondensateInventoryFraction') * 100
      if (localPath === 'availableCondensateOutletFlowKgPerS') return parameterNumber(component, 'maxCondensateOutletFlowKgPerS')
      if (localPath === 'condensateTemperatureC') return balance.targetCondensateTemperature
      if (localPath === 'backPressurePa') return balance.targetBackPressure
      if (localPath === 'coolingWaterFlowKgPerS') return parameterNumber(component, 'nominalCoolingWaterFlowKgPerS')
      if (localPath === 'coolingWaterInletTemperatureC') return parameterNumber(component, 'coolingWaterTemperatureC')
      if (localPath === 'coolingWaterOutletTemperatureC') return balance.coolingWaterOutletTemperature
      if (localPath === 'coolingWaterHeatCapacityMw') {
        return balance.coolingWaterHeatCapacity
      }
      if (localPath === 'coolingWaterAvailabilityFraction') return 1
      return undefined
    },
  },
]
