import { primaryLoopIdForPump } from '../../graph/index.ts'
import { reactorNeutronics, reactorTemperatureProgram } from '../../graph/reactor-component-definitions.ts'
import { clamp, optionalParameterBoolean, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import type { ComponentInitialValueDefinition } from './model.ts'
import { reactorInitialThermalState } from '../../reactor-initial-conditions.ts'
import { nuclearInstrumentationReading } from '../nuclear-instrumentation.ts'
import { controlBankStepsAt, criticalRodInsertionFraction, rodStepsWithdrawn } from '../rod-position-indication.ts'
import { controlRodBanks, rodTravelSteps } from '../../graph/reactor-component-definitions.ts'

export const reactorInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'reactorCore',
    initialValueFor: (component, localPath) => {
      const ratedPowerMw = parameterNumber(component, 'ratedPowerMw')
      const initialPowerFraction = parameterNumber(component, 'initialPowerFraction')
      const initialFissionPower = ratedPowerMw * initialPowerFraction
      const { inlet: initialCoolantInlet, outlet: initialCoolantOutlet, coreExit: initialCoreExit, pumpHeatMw: initialPumpHeat, lower: initialFuelLower, mid: initialFuelMid, upper: initialFuelUpper, average: initialFuelAverage } = reactorInitialThermalState(component.parameters as Record<string, unknown>)
      // At equilibrium each precursor group sustains the fission power, each
      // decay heat group holds its share of it, and the two parts of core
      // thermal power add up to the fission power.
      const neutronics = reactorNeutronics(component)
      const delayedNeutronGroup = /^delayedNeutronGroup(\d+)PowerMw$/u.exec(localPath)
      if (delayedNeutronGroup !== null) return initialFissionPower
      const decayHeatGroup = /^decayHeatGroup(\d+)Mw$/u.exec(localPath)
      if (decayHeatGroup !== null) return initialFissionPower * neutronics.decayHeatGroups[Number(decayHeatGroup[1]) - 1]!.fractionOfFissionPower
      const initialDecayHeat = initialFissionPower * neutronics.decayHeatGroups.reduce((sum, group) => sum + group.fractionOfFissionPower, 0)
      if (localPath === 'powerMw') return initialFissionPower
      if (localPath === 'fissionPowerMw') return initialFissionPower
      if (localPath === 'totalThermalPowerMw') return initialFissionPower
      if (localPath === 'reactivityPcm') return 0
      if (localPath === 'promptReactivityPcm') return 0
      if (localPath === 'temperatureFeedbackPcm') return 0
      if (localPath === 'boronFeedbackPcm') return 0
      if (localPath === 'voidFeedbackPcm') return 0
      if (localPath === 'effectiveReactivityPcm') return 0
      // At a steady initial state the turbine carries the core's power, so its
      // load sets Tref where the initial power puts it.
      const program = reactorTemperatureProgram(component)
      const initialReference = program.noLoadAverageTemperatureC + clamp(initialPowerFraction, 0, 1) * (program.fullLoadAverageTemperatureC - program.noLoadAverageTemperatureC)
      if (localPath === 'referenceAverageTemperatureC') return initialReference
      if (localPath === 'averageTemperatureDeviationC') return (initialCoolantInlet + initialCoolantOutlet) / 2 - initialReference
      if (localPath === 'rodInsertionFraction' || localPath === 'rodInsertedFraction') return optionalParameterNumber(component, 'criticalRodInsertionFraction', clamp(1 - initialPowerFraction, 0, 1))
      if (localPath === 'rodsOnBottom') return optionalParameterNumber(component, 'criticalRodInsertionFraction', clamp(1 - initialPowerFraction, 0, 1)) >= reactorNeutronics(component).scram.rodBottomInsertionFraction
      // The rods in steps where they are demanded, the shutdown banks full out; the initial reconciliation drops
      // them with a trip breaker open.
      if (localPath === 'rodStepsWithdrawn') return rodStepsWithdrawn(criticalRodInsertionFraction(component))
      if (/^shutdownBank[A-D]StepsWithdrawn$/u.test(localPath)) return rodTravelSteps
      const controlBank = /^controlBank([A-D])StepsWithdrawn$/u.exec(localPath)
      if (controlBank !== null) return controlBankStepsAt(component, criticalRodInsertionFraction(component))[controlRodBanks.indexOf(controlBank[1] as typeof controlRodBanks[number])]!
      if (localPath === 'powerRangePercent') return nuclearInstrumentationReading(component, initialFissionPower).powerRangePercent
      if (localPath === 'aboveP10') return nuclearInstrumentationReading(component, initialFissionPower).aboveP10
      if (localPath === 'intermediateRangeCurrentAmps') return nuclearInstrumentationReading(component, initialFissionPower).intermediateRangeCurrentAmps
      // Held at steady power, the flux does not change.
      if (localPath === 'intermediateRangeStartupRateDpm') return 0
      if (localPath === 'aboveP6') return nuclearInstrumentationReading(component, initialFissionPower).aboveP6
      if (localPath === 'sourceRangeEnergized') return nuclearInstrumentationReading(component, initialFissionPower).sourceRangeEnergized
      if (localPath === 'sourceRangeCountRateCps') return nuclearInstrumentationReading(component, initialFissionPower).sourceRangeCountRateCps
      // Its meter has counted through no step yet.
      if (localPath === 'sourceRangeStartupRateDpm') return 0
      if (localPath === 'sourceRangeStartupRateValid') return false
      if (localPath === 'coolantInletTemperatureC') return initialCoolantInlet
      if (localPath === 'coolantOutletTemperatureC') return initialCoolantOutlet
      if (localPath === 'coreExitTemperatureC') return initialCoreExit
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
      if (localPath === 'pumpHeatMw') return initialPumpHeat
      if (localPath === 'heatToCoolantMw') return initialFissionPower + initialPumpHeat
      if (localPath === 'vapourGenerationKgPerS') return 0
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
      if (localPath === 'loopSteamMassKg') return 0
      if (localPath === 'loopSteamVolumeM3') return 0
      if (localPath === 'loopVoidFraction') return 0
      if (localPath === 'surgeFlowKgPerS') return 0
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
      if (localPath === 'loopFlowTargetKgPerS') return primaryLoopId !== null && running ? parameterNumber(component, 'nominalFlowKgPerS') : 0
      if (localPath === 'loopFlowKgPerS') return primaryLoopId !== null && running ? parameterNumber(component, 'nominalFlowKgPerS') : 0
      if (localPath === 'loopReverseFlowKgPerS') return 0
      return undefined
    },
  },
]
