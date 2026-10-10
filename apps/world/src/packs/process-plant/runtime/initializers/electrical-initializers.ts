import type { ComponentInitialValueDefinition } from './model.ts'
import { optionalParameterBoolean, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'

export const electricalInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'electricalGridSource',
    initialValueFor: (component, localPath) => {
      const available = optionalParameterBoolean(component, 'initialAvailable', true)
      const voltageFraction = optionalParameterNumber(component, 'initialVoltageFraction', 1)
      if (localPath === 'available') return available
      if (localPath === 'frequencyHz') return optionalParameterNumber(component, 'initialFrequencyHz', 50)
      if (localPath === 'energized') return available
      if (localPath === 'availablePowerMw') return available ? parameterNumber(component, 'nominalPowerMw') : 0
      if (localPath === 'voltageFraction') return available ? voltageFraction : 0
      return undefined
    },
  },
  {
    componentKind: 'electricalBus',
    initialValueFor: (component, localPath) => {
      if (localPath === 'energized') return optionalParameterBoolean(component, 'initialEnergized', false)
      if (localPath === 'availablePowerMw') return optionalParameterBoolean(component, 'initialEnergized', false) ? parameterNumber(component, 'nominalPowerMw') : 0
      if (localPath === 'voltageFraction') return optionalParameterBoolean(component, 'initialEnergized', false) ? 1 : 0
      if (localPath === 'servedLoadMw') return 0
      if (localPath === 'marginMw') return optionalParameterBoolean(component, 'initialEnergized', false) ? parameterNumber(component, 'nominalPowerMw') : 0
      if (localPath === 'degraded') return false
      return undefined
    },
  },
  {
    componentKind: 'electricalBreaker',
    initialValueFor: (component, localPath) => {
      if (localPath === 'closed') return optionalParameterBoolean(component, 'initialClosed', true)
      if (localPath === 'tripped') return optionalParameterBoolean(component, 'initialTripped', false)
      if (localPath === 'closedState') return optionalParameterBoolean(component, 'initialClosed', true) && !optionalParameterBoolean(component, 'initialTripped', false)
      if (localPath === 'energized') return false
      if (localPath === 'availablePowerMw') return 0
      if (localPath === 'voltageFraction') return 0
      return undefined
    },
  },
  {
    componentKind: 'electricalTransformer',
    initialValueFor: (component, localPath) => {
      if (localPath === 'energized') return false
      if (localPath === 'availablePowerMw') return 0
      if (localPath === 'voltageFraction') return 0
      if (localPath === 'loadMw') return 0
      return undefined
    },
  },
  {
    componentKind: 'dieselGenerator',
    initialValueFor: (component, localPath) => {
      const running = optionalParameterBoolean(component, 'initialRunning', false)
      if (localPath === 'startCommand') return running
      if (localPath === 'available') return optionalParameterBoolean(component, 'initialAvailable', true)
      if (localPath === 'running') return running
      if (localPath === 'startElapsedS') return running ? optionalParameterNumber(component, 'startDelayS', 10) : 0
      if (localPath === 'energized') return running
      if (localPath === 'availablePowerMw') return running ? parameterNumber(component, 'nominalPowerMw') : 0
      if (localPath === 'voltageFraction') return running ? 1 : 0
      return undefined
    },
  },
  {
    componentKind: 'battery',
    initialValueFor: (component, localPath) => {
      const charge = optionalParameterNumber(component, 'initialStateOfChargeFraction', 1)
      if (localPath === 'stateOfChargeFraction') return charge
      if (localPath === 'energized') return charge > 0
      if (localPath === 'availablePowerMw') return charge > 0 ? parameterNumber(component, 'nominalPowerMw') : 0
      if (localPath === 'voltageFraction') return charge > 0 ? 1 : 0
      if (localPath === 'voltageVdc') return charge > 0 ? optionalParameterNumber(component, 'nominalVoltageVdc', 125) : 0
      return undefined
    },
  },
  {
    componentKind: 'inverter',
    initialValueFor: (_component, localPath) => {
      if (localPath === 'energized') return false
      if (localPath === 'availablePowerMw') return 0
      if (localPath === 'voltageFraction') return 0
      return undefined
    },
  },
  {
    componentKind: 'electricalLoad',
    initialValueFor: (component, localPath) => {
      if (localPath === 'demandMw') return parameterNumber(component, 'nominalLoadMw')
      if (localPath === 'servedMw') return 0
      if (localPath === 'servedFraction') return 0
      if (localPath === 'energized') return false
      return undefined
    },
  },
]
