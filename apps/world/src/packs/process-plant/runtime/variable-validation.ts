import type { CompiledVariable, VariablePath } from '../graph/index.ts'
import type { ProcessPlantValue } from './model.ts'

export const processPlantExpectedValueType = (variable: CompiledVariable): 'boolean' | 'number' =>
  variable.descriptor.quantity === 'boolean' ? 'boolean' : 'number'

export const assertProcessPlantValueMatchesDeclaredType = (
  variable: CompiledVariable,
  value: ProcessPlantValue,
): void => {
  const expectedType = processPlantExpectedValueType(variable)
  if (typeof value !== expectedType) throw new Error(`process plant variable ${variable.path} expects ${expectedType} value`)
}

export const assertProcessPlantValueMatchesCurrentType = (
  path: VariablePath,
  current: ProcessPlantValue,
  next: ProcessPlantValue,
): void => {
  if (typeof current !== typeof next) throw new Error(`process plant variable ${path} expects ${typeof current} value`)
}

export const assertProcessPlantValueWithinPhysicalBounds = (
  variable: CompiledVariable,
  value: ProcessPlantValue,
): void => {
  if (typeof value !== 'number') return
  const path = String(variable.path)
  const quantity = variable.descriptor.quantity
  const hardRange = variable.descriptor.limits?.hardRange
  if (quantity === 'ratio' && variable.descriptor.unit === 'fraction' && (hardRange?.max ?? 1) <= 1 && (value < 0 || value > 1)) {
    throw new Error(`process plant variable ${path} fraction value must be between 0 and 1`)
  }
  // A percent stays within 0 to 100 unless its hard range declares a signed span (a deviation from a program).
  if (quantity === 'ratio' && variable.descriptor.unit === 'percent' && (hardRange?.min ?? 0) >= 0 && (value < 0 || value > 100)) {
    throw new Error(`process plant variable ${path} percent value must be between 0 and 100`)
  }
  if (
    (quantity === 'flowRate'
      || quantity === 'head'
      || quantity === 'mass'
      || quantity === 'power'
      || quantity === 'pressure'
      || quantity === 'radiationDoseRate')
    && value < 0
  ) {
    throw new Error(`process plant variable ${path} ${quantity} value must be non-negative`)
  }
  if (hardRange !== undefined && (value < hardRange.min || value > hardRange.max)) {
    throw new Error(`process plant variable ${path} value ${value} is outside hard range ${hardRange.min}..${hardRange.max}`)
  }
}

export const assertProcessPlantValueIsFinite = (
  path: VariablePath,
  value: ProcessPlantValue,
): void => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`process plant behavior attempted to write non-finite value to ${path}`)
  }
}

export const assertProcessPlantVariableValueValid = (
  variable: CompiledVariable,
  value: ProcessPlantValue,
): void => {
  assertProcessPlantValueMatchesDeclaredType(variable, value)
  assertProcessPlantValueIsFinite(variable.path, value)
  assertProcessPlantValueWithinPhysicalBounds(variable, value)
}
