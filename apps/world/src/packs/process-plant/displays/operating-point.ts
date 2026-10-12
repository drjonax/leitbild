import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { createProcessPlantRuntime, type ProcessPlantRuntime } from '../runtime/index.ts'

// The Plant at the operating point its model declares, before anything has
// run: what a signal reads nominally. A display sizes the step it shows a
// reading in from it where the model declares no span for the signal, so a
// steam flow that tails off after a trip reads 0, not "0.001 kg/s".

const atOperatingPoint = new WeakMap<CompiledProcessPlant, ProcessPlantRuntime>()

/** What a signal reads at the Plant's declared operating point: a number or an on/off state (a breaker closed, the grid available). */
export const operatingPointReading = (plant: CompiledProcessPlant, path: VariablePath): unknown => {
  let runtime = atOperatingPoint.get(plant)
  if (runtime === undefined) {
    runtime = createProcessPlantRuntime({ system: plant })
    atOperatingPoint.set(plant, runtime)
  }
  return runtime.readVariable(path)
}

/** A signal's value at the Plant's declared operating point; undefined for one that is not a number there. */
export const operatingPointValue = (plant: CompiledProcessPlant, path: VariablePath): number | undefined => {
  const value = operatingPointReading(plant, path)
  return typeof value === 'number' ? value : undefined
}
