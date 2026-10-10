import { optionalParameterBoolean, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import type { ComponentInitialValueDefinition } from './model.ts'

export const supportSystemInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'heatExchanger',
    initialValueFor: (component, localPath) => {
      const hot = optionalParameterNumber(component, 'initialHotTemperatureC', 120)
      const cold = optionalParameterNumber(component, 'initialColdTemperatureC', 35)
      if (localPath === 'hotInletTemperatureC') return hot
      if (localPath === 'hotOutletTemperatureC') return hot
      if (localPath === 'coldInletTemperatureC') return cold
      if (localPath === 'coldOutletTemperatureC') return cold
      if (localPath === 'hotSideFlowKgPerS') return 0
      if (localPath === 'coldSideFlowKgPerS') return 0
      if (localPath === 'heatTransferMw') return 0
      if (localPath === 'heatTransferCapacityMw') return 0
      if (localPath === 'approachTemperatureC') return Math.max(0, hot - cold)
      if (localPath === 'effectivenessFraction') return 0
      if (localPath === 'coolingAvailabilityFraction') return 0
      if (localPath === 'hotSidePressureDropMPa') return 0
      if (localPath === 'coldSidePressureDropMPa') return 0
      if (localPath === 'heatBalanceResidualMw') return 0
      return undefined
    },
  },
  {
    componentKind: 'containmentVolume',
    initialValueFor: (component, localPath) => {
      const pressure = optionalParameterNumber(component, 'initialPressureMPa', 0.101325)
      const temperatureC = optionalParameterNumber(component, 'initialTemperatureC', 30)
      const freeVolume = parameterNumber(component, 'freeVolumeM3')
      const temperatureK = temperatureC + 273.15
      const airMass = pressure * 1_000_000 * freeVolume / (287.05 * temperatureK)
      const steamMass = airMass * optionalParameterNumber(component, 'initialHumidityFraction', 0.35) * 0.03
      if (localPath === 'atmosphereMassKg') return airMass + steamMass
      if (localPath === 'airMassKg') return airMass
      if (localPath === 'steamMassKg') return steamMass
      if (localPath === 'sumpInventoryKg') return optionalParameterNumber(component, 'initialSumpInventoryKg', 0)
      if (localPath === 'sumpLevelPercent') {
        const referenceInventory = optionalParameterNumber(component, 'sumpLevelReferenceInventoryKg', 100_000)
        return optionalParameterNumber(component, 'initialSumpInventoryKg', 0) / referenceInventory * 100
      }
      if (localPath === 'pressureMPa') return pressure
      if (localPath === 'temperatureC') return temperatureC
      if (localPath === 'humidityFraction') return optionalParameterNumber(component, 'initialHumidityFraction', 0.35)
      if (localPath === 'incomingMassKgPerS') return 0
      if (localPath === 'sprayFlowKgPerS') return 0
      if (localPath === 'releaseFlowKgPerS') return 0
      if (localPath === 'sumpOutflowKgPerS') return 0
      if (localPath === 'heatRemovalMw') return 0
      if (localPath === 'radiationSourceTermMSvPerH') return 0.02
      if (localPath === 'contaminationInventory') return 0
      return undefined
    },
  },
  {
    componentKind: 'atmosphereBoundary',
    initialValueFor: (component, localPath) => {
      if (localPath === 'pressureMPa') return parameterNumber(component, 'pressureMPa')
      if (localPath === 'releaseFlowKgPerS') return 0
      if (localPath === 'releasedMassKg') return 0
      return undefined
    },
  },
  {
    componentKind: 'accumulator',
    initialValueFor: (component, localPath) => {
      const liquidInventory = parameterNumber(component, 'initialLiquidInventoryKg')
      const density = optionalParameterNumber(component, 'liquidDensityKgPerM3', 950)
      const totalVolume = parameterNumber(component, 'totalVolumeM3')
      const liquidVolume = liquidInventory / density
      const gasVolume = Math.max(0.001, totalVolume - liquidVolume)
      if (localPath === 'dischargeIsolationOpen') return optionalParameterBoolean(component, 'initialDischargeIsolationOpen', true)
      if (localPath === 'liquidInventoryKg') return liquidInventory
      if (localPath === 'gasVolumeM3') return gasVolume
      if (localPath === 'gasPressureMPa') return parameterNumber(component, 'initialGasPressureMPa')
      if (localPath === 'outletFlowKgPerS') return 0
      if (localPath === 'fillFlowKgPerS') return 0
      if (localPath === 'availableInjectionHeadMPa') return 0
      if (localPath === 'depletedFraction') return 0
      if (localPath === 'checkValveOpenFraction') return 0
      if (localPath === 'temperatureC') return optionalParameterNumber(component, 'initialTemperatureC', 35)
      return undefined
    },
  },
]
