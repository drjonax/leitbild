import { primaryLoopIdForPump } from '../../graph/index.ts'
import { clamp, optionalParameterBoolean, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import type { ComponentInitialValueDefinition } from './model.ts'
import { reactorInitialThermalState } from '../../reactor-initial-conditions.ts'
import { nuclearInstrumentationReading } from '../nuclear-instrumentation.ts'

export const reactorInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'reactorCore',
    initialValueFor: (component, localPath) => {
      const ratedPowerMw = parameterNumber(component, 'ratedPowerMw')
      const initialPowerFraction = parameterNumber(component, 'initialPowerFraction')
      const initialFissionPower = ratedPowerMw * initialPowerFraction
      const { inlet: initialCoolantInlet, outlet: initialCoolantOutlet, lower: initialFuelLower, mid: initialFuelMid, upper: initialFuelUpper, average: initialFuelAverage } = reactorInitialThermalState(component.parameters as Record<string, unknown>)
      const initialDecayHeat = initialFissionPower * optionalParameterNumber(component, 'decayHeatFractionAtPower', 0.06)
      if (localPath === 'powerMw') return initialFissionPower
      if (localPath === 'fissionPowerMw') return initialFissionPower
      if (localPath === 'totalThermalPowerMw') return initialFissionPower + initialDecayHeat
      if (localPath === 'reactivityPcm') return 0
      if (localPath === 'promptReactivityPcm') return 0
      if (localPath === 'temperatureFeedbackPcm') return 0
      if (localPath === 'boronFeedbackPcm') return 0
      if (localPath === 'effectiveReactivityPcm') return 0
      if (localPath === 'rodInsertionFraction') return optionalParameterNumber(component, 'criticalRodInsertionFraction', clamp(1 - initialPowerFraction, 0, 1))
      if (localPath === 'sourceRangeEnergized') return nuclearInstrumentationReading(component, initialFissionPower).sourceRangeEnergized
      if (localPath === 'sourceRangeCountRateCps') return nuclearInstrumentationReading(component, initialFissionPower).sourceRangeCountRateCps
      if (localPath === 'intermediateRangeCurrentAmps') return nuclearInstrumentationReading(component, initialFissionPower).intermediateRangeCurrentAmps
      if (localPath === 'coolantInletTemperatureC') return initialCoolantInlet
      if (localPath === 'coolantOutletTemperatureC') return initialCoolantOutlet
      if (localPath === 'averageHotLegFlowKgPerS') return optionalParameterNumber(component, 'nominalPrimaryFlowKgPerS', 0)
      if (localPath === 'fuelTemperatureC') return initialFuelAverage
      if (localPath === 'fuelLowerTemperatureC') return initialFuelLower
      if (localPath === 'fuelMidTemperatureC') return initialFuelMid
      if (localPath === 'fuelUpperTemperatureC') return initialFuelUpper
      if (localPath === 'fuelStoredEnergyMj') return Math.max(0, initialFuelAverage - initialCoolantOutlet) * parameterNumber(component, 'fuelThermalCapacityMjPerC')
      if (localPath === 'coreCoolingAvailabilityFraction') return 1
      if (localPath === 'coreHeatRemovalDeficitMw') return 0
      if (localPath === 'fuelHeatupRateCPerS') return 0
      if (localPath === 'decayHeatMw') return initialDecayHeat
      if (localPath === 'heatToCoolantMw') return initialFissionPower + initialDecayHeat
      return undefined
    },
  },
  {
    componentKind: 'reactorVessel',
    initialValueFor: (component, localPath) => {
      const nominalInventory = parameterNumber(component, 'nominalPrimaryCoolantInventoryKg')
      const initialFraction = parameterNumber(component, 'initialPrimaryCoolantInventoryFraction')
      if (localPath === 'primaryCoolantInventoryKg') return nominalInventory * initialFraction
      if (localPath === 'primaryCoolantInventoryDeviationKg') return nominalInventory * (initialFraction - 1)
      if (localPath === 'collapsedLiquidLevelPercent') return clamp(initialFraction / optionalParameterNumber(component, 'collapsedLevelReferenceInventoryFraction', 1) * 100, 0, 100)
      if (localPath === 'meanPrimaryCoolantTemperatureC') return parameterNumber(component, 'referencePrimaryCoolantTemperatureC')
      if (localPath === 'subcoolingMarginC') return 0
      if (localPath === 'compressibilityPressureBiasMPa') return 0
      if (localPath === 'thermalExpansionPressureBiasMPa') return 0
      if (localPath === 'primaryPressureBiasMPa') return 0
      if (localPath === 'chargingFlowKgPerS') return 0
      if (localPath === 'safetyInjectionFlowKgPerS') return 0
      if (localPath === 'letdownFlowKgPerS') return optionalParameterNumber(component, 'normalLetdownFlowKgPerS', 0)
      if (localPath === 'reliefOutflowKgPerS') return 0
      if (localPath === 'primaryLeakFlowKgPerS') return 0
      if (localPath === 'tubeLeakFlowKgPerS') return 0
      if (localPath === 'netInventoryFlowKgPerS') return -optionalParameterNumber(component, 'normalLetdownFlowKgPerS', 0)
      if (localPath === 'primaryInventoryBalanceResidualKg') return 0
      if (localPath === 'boronConcentrationPpm') return optionalParameterNumber(component, 'initialBoronConcentrationPpm', 1_200)
      if (localPath === 'primaryReleaseRadiationMSvPerH') return optionalParameterNumber(component, 'primaryReleaseRadiationMSvPerH', 0.02)
      return undefined
    },
  },
  {
    componentKind: 'centrifugalPump',
    initialValueFor: (component, localPath) => {
      const running = optionalParameterBoolean(component, 'initialRunning', true)
      const primaryLoopId = primaryLoopIdForPump(component)
      if (localPath === 'running') return running
      if (localPath === 'runningState') return running
      if (localPath === 'speedFraction') return 1
      if (localPath === 'speedRpm') return running ? optionalParameterNumber(component, 'nominalSpeedRpm', 3600) : 0
      if (localPath === 'flowKgPerS') return running ? parameterNumber(component, 'nominalFlowKgPerS') : 0
      if (localPath === 'developedHeadPa') return running ? parameterNumber(component, 'nominalHeadPa') : 0
      if (localPath === 'demandMw') return running
        ? parameterNumber(component, 'nominalFlowKgPerS') * parameterNumber(component, 'nominalHeadPa') / optionalParameterNumber(component, 'fluidDensityKgPerM3', 800) / optionalParameterNumber(component, 'hydraulicEfficiencyFraction', 0.82) / 1_000_000
        : 0
      if (localPath === 'loopFlowTargetKgPerS') return primaryLoopId === null ? 0 : running ? parameterNumber(component, 'nominalFlowKgPerS') : optionalParameterNumber(component, 'minimumNaturalCirculationFlowKgPerS', 0)
      if (localPath === 'loopFlowKgPerS') return primaryLoopId === null ? 0 : running ? parameterNumber(component, 'nominalFlowKgPerS') : optionalParameterNumber(component, 'minimumNaturalCirculationFlowKgPerS', 0)
      return undefined
    },
  },
]
