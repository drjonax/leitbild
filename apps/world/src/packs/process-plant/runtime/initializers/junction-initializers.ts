import { optionalParameterNumber } from '../component-helpers.ts'
import type { ComponentInitialValueDefinition } from './model.ts'

export const junctionInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'processHeader',
    initialValueFor: (component, localPath) => headerInitialValueFor(component, localPath, false),
  },
  {
    componentKind: 'steamHeader',
    initialValueFor: (component, localPath) => headerInitialValueFor(component, localPath, true),
  },
  {
    componentKind: 'processValve',
    initialValueFor: (component, localPath) => valveInitialValueFor(component, localPath),
  },
  {
    componentKind: 'steamValve',
    initialValueFor: (component, localPath) => valveInitialValueFor(component, localPath),
  },
]

const headerInitialValueFor = (
  component: Parameters<ComponentInitialValueDefinition['initialValueFor']>[0],
  localPath: string,
  steam: boolean,
) => {
  if (localPath === 'inventoryKg') {
    const density = optionalParameterNumber(component, 'nominalDensityKgPerM3', steam ? 35 : 950)
    return optionalParameterNumber(component, 'headerVolumeM3', 1) * density
  }
  if (localPath === 'inletFlowKgPerS') return 0
  if (localPath === 'outletFlowKgPerS') return 0
  if (localPath === 'flowBalanceResidualKgPerS') return 0
  if (localPath === 'mixedTemperatureC') return optionalParameterNumber(component, 'initialTemperatureC', steam ? 285 : 220)
  if (localPath === 'mixedPressureMPa') return optionalParameterNumber(component, 'initialPressureMPa', steam ? 6.9 : 1)
  if (localPath === 'pressureNodeMPa') return optionalParameterNumber(component, 'initialPressureMPa', steam ? 6.9 : 1)
  if (localPath === 'unmetDemandKgPerS') return 0
  return undefined
}

const valveInitialValueFor = (
  component: Parameters<ComponentInitialValueDefinition['initialValueFor']>[0],
  localPath: string,
) => {
  const initialPosition = optionalParameterNumber(component, 'initialPositionFraction', 1)
  const failedPosition = optionalParameterNumber(component, 'failPositionFraction', initialPosition)
  if (localPath === 'positionFraction') return initialPosition
  if (localPath === 'positionFailureActive') return false
  if (localPath === 'isolationSignal') return false
  if (localPath === 'failedPositionFraction') return failedPosition
  if (localPath === 'demandPositionFraction') return initialPosition
  if (localPath === 'effectivePositionFraction') return initialPosition
  if (localPath === 'availablePressureDropMPa') return 0
  if (localPath === 'capacityLimitedFlowKgPerS') return 0
  if (localPath === 'reverseFlowKgPerS') return 0
  if (localPath === 'leakageFlowKgPerS') return 0
  if (localPath === 'autoOpenActive') return false
  if (localPath === 'inletFlowKgPerS') return 0
  if (localPath === 'outletFlowKgPerS') return 0
  if (localPath === 'flowBalanceResidualKgPerS') return 0
  return undefined
}
