import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { createProcessPlantRuntimeInstances } from '../src/packs/process-plant/sim/runtime-instance-factory.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A ramp re-queues its value on every advance. An automatic action writes
// once, on entering: before plan-final S2 a ramp on the turbine stop valves
// reopened them one step after the turbine trip shut them.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:ramp-protection', loopCount: 4 }))
const tag = (tagId: string) => resolveProcessPlantSignalBinding(plant.graph, { tagId: tagId as never }).path

const started = () => {
  const instance = createProcessPlantRuntimeInstances({ compiledPlants: [plant], runtimeState: null }).get(plant.id)!
  // As the Pack adapter advances a Plant: ramps, then the solver step, then the I&C.
  const step = () => {
    instance.ramps.apply(instance.runtime.elapsedMs() + 1_000)
    instance.runtime.tick(1_000)
    instance.protection!.evaluate({ runtime: instance.runtime, elapsedMs: instance.runtime.elapsedMs(), simulationRunId: 'run-ramp-protection' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
  }
  return { ...instance, step }
}

describe('an automatic action ends a ramp on what it writes', () => {
  test('the manual turbine trip shuts the stop valves a ramp holds open, and they stay shut', () => {
    const plantRun = started()
    for (let second = 0; second < 3; second += 1) plantRun.step()
    plantRun.ramps.start({ id: 'command:ramp-tsv', path: tag('TURB-STOP'), target: 1, durationMs: 600_000 })
    plantRun.step()
    expect(plantRun.ramps.snapshot().active.map(ramp => ramp.path)).toEqual([tag('TURB-STOP')])
    plantRun.runtime.writeCommand({ type: 'setVariable', path: tag('TURB-TRIP-MAN'), value: true })
    for (let second = 0; second < 60; second += 1) plantRun.step()
    expect(plantRun.protection!.snapshot().rules.find(rule => rule.ruleId === 'turbine-manual-trip')).toMatchObject({ latched: true })
    expect(plantRun.ramps.snapshot().active).toEqual([])
    expect(plantRun.runtime.readVariable(tag('TURB-STOP'))).toBe(0)
  })

  test('a ramp on a variable no rule writes runs to its target', () => {
    const plantRun = started()
    const speed = tag('RCP-A-SPD')
    plantRun.ramps.start({ id: 'command:ramp-rcp', path: speed, target: 0.9, durationMs: 10_000 })
    for (let second = 0; second < 12; second += 1) plantRun.step()
    expect(plantRun.ramps.snapshot().active).toEqual([])
    expect(plantRun.runtime.readVariable(speed)).toBeCloseTo(0.9, 6)
  })
})
