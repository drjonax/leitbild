import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A display opened on a fresh or paused Run reads the initial state. Every
// derived variable must already read what the model derives from that state,
// not an initializer's placeholder: a subcooling margin of 0 °C there reads
// as "subcooling lost". At the steady full-power operating point nothing
// should move in the first second.

// Tolerance: 1% of the value, or this much of its unit, whichever is larger.
const absoluteFloorByUnit: Readonly<Record<string, number>> = {
  'degC': 0.5,
  'degC/s': 0.01,
  'MPa': 0.02,
  'Pa': 500,
  'kg/s': 0.5,
  'kg': 10,
  'MW': 1,
  'MJ': 10,
  'percent': 0.5,
  'fraction': 0.005,
  'pcm': 1,
  // A startup-rate meter reads hundredths of a decade a minute.
  'DPM': 0.01,
  'm3': 0.05,
  'mSv/h': 0.01,
}

describe('the deployed four-loop plant before its first step', () => {
  test('every derived variable already reads what one second of the model derives', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:initial-state', loopCount: 4 }))
    const runtime = createProcessPlantRuntime({ system: plant })
    const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
    const derived = plant.graph.variables.filter(variable => variable.descriptor.kind === 'derived')
    const initial = new Map(derived.map(variable => [variable.path, runtime.readVariable(variable.path as VariablePath)]))

    runtime.tick(1_000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-initial-state' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })

    const differing = derived.flatMap(variable => {
      const before = initial.get(variable.path)
      const after = runtime.readVariable(variable.path as VariablePath)
      if (typeof before !== 'number' || typeof after !== 'number') return before === after ? [] : [`${variable.path}: ${String(before)} -> ${String(after)}`]
      const tolerance = Math.max(Math.abs(after) * 0.01, absoluteFloorByUnit[variable.descriptor.unit] ?? 0)
      return Math.abs(after - before) <= tolerance ? [] : [`${variable.path}: ${before} -> ${after} ${variable.descriptor.unit}`]
    })
    expect(derived.length).toBeGreaterThan(500)
    expect(differing).toEqual([])
  })
})
