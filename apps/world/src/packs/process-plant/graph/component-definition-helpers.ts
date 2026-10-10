import { z } from 'zod'
import type { ComponentDefinition, ComponentVariableDescriptor, LocalVariablePath } from './model.ts'
import { componentVariableDescriptorSchema } from './model.ts'

export const normalized = z.number().finite().min(0).max(1)

type ComponentVariableInput = Omit<ComponentVariableDescriptor, 'path'> & {
  readonly path: string
}

export const variable = (descriptor: ComponentVariableInput): ComponentVariableDescriptor => ({
  ...componentVariableDescriptorSchema.parse(descriptor),
  path: descriptor.path as LocalVariablePath,
})

export const defineComponent = (definition: ComponentDefinition): ComponentDefinition => definition

export const headerVariables = (labelPrefix: string): ReadonlyArray<ComponentVariableDescriptor> => [
  variable({ path: 'inventoryKg', label: `${labelPrefix} inventory`, kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
  variable({ path: 'inletFlowKgPerS', label: `${labelPrefix} inlet flow`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'outletFlowKgPerS', label: `${labelPrefix} outlet flow`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'flowBalanceResidualKgPerS', label: `${labelPrefix} flow balance residual`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s' }),
  variable({ path: 'mixedTemperatureC', label: `${labelPrefix} mixed temperature`, kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
  variable({ path: 'mixedPressureMPa', label: `${labelPrefix} mixed pressure`, kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
  variable({ path: 'pressureNodeMPa', label: `${labelPrefix} pressure node`, kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
  variable({ path: 'unmetDemandKgPerS', label: `${labelPrefix} unmet demand`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
]

export const valveVariables = (labelPrefix: string): ReadonlyArray<ComponentVariableDescriptor> => [
  variable({ path: 'positionFraction', label: `${labelPrefix} position demand`, kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', measurand: 'position', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
  variable({ path: 'positionFailureActive', label: `${labelPrefix} position failure active`, kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'faultInjection', quantity: 'boolean', unit: 'boolean' }),
  variable({ path: 'failedPositionFraction', label: `${labelPrefix} failed position`, kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'faultInjection', measurand: 'position', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
  variable({ path: 'demandPositionFraction', label: `${labelPrefix} target position`, kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'position', quantity: 'ratio', unit: 'fraction' }),
  variable({ path: 'effectivePositionFraction', label: `${labelPrefix} effective position`, kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'position', quantity: 'ratio', unit: 'fraction' }),
  variable({ path: 'availablePressureDropMPa', label: `${labelPrefix} available pressure drop`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa' }),
  variable({ path: 'capacityLimitedFlowKgPerS', label: `${labelPrefix} capacity limited flow`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'reverseFlowKgPerS', label: `${labelPrefix} reverse flow`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'leakageFlowKgPerS', label: `${labelPrefix} seat leakage flow`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'autoOpenActive', label: `${labelPrefix} automatic opening active`, kind: 'discrete', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
  variable({ path: 'inletFlowKgPerS', label: `${labelPrefix} inlet flow`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'outletFlowKgPerS', label: `${labelPrefix} outlet flow`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'flowBalanceResidualKgPerS', label: `${labelPrefix} flow balance residual`, kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s' }),
]
