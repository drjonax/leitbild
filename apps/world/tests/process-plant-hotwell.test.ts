import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type CompiledProcessPlant,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The condensate side of the four-loop reference PWR: the condensate pumps
// take the hotwell's water to the feedwater tank through the tank's level
// control valve (COND-LCV-POS), which throttles them as the tank fills, and
// the hotwell rejects what rises above 60 % to the condensate storage tank.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:hotwell', loopCount: 4 }))
const hotwellLow = 'alarm:condenser-hotwell-level-low:hotwell-level-low'

const started = (system: CompiledProcessPlant = plant) => {
  const runtime = createProcessPlantRuntime({ system })
  const protection = createProcessPlantProtectionRunner({ system, protection: system.automation })
  const read = (path: string): number => Number(runtime.readVariable(path as VariablePath))
  const tag = (tagId: string): number => Number(runtime.readVariable(resolveProcessPlantSignalBinding(system.graph, { tagId: tagId as never }).path))
  const alarmed = (): ReadonlyArray<string> => protection.snapshot().alarms.filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id)
  const run = (seconds: number, each?: () => void): void => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-hotwell' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
      each?.()
    }
  }
  const act = (actionId: string): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: system.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  return { read, tag, alarmed, run, act }
}

describe('hotwell and feedwater tank level control', () => {
  test('at full power the level control valve stands open, the reject shut, and nothing moves', () => {
    const plantRun = started()
    plantRun.run(120)
    const { read, tag } = plantRun
    expect(tag('COND-LCV-POS')).toBeCloseTo(1, 6)
    expect(tag('HOTWELL-REJECT-POS')).toBe(0)
    expect(tag('HOTWELL-LVL')).toBeCloseTo(55, 3)
    expect(tag('FW-TANK-LVL')).toBeCloseTo(82, 3)
    expect(read('condensate-pump-a-to-feedwater-tank.flowKgPerS') + read('condensate-pump-b-to-feedwater-tank.flowKgPerS')).toBeCloseTo(read('condenser.condensateProductionKgPerS'), 3)
  })

  test('after a turbine trip the level control valve shuts the condensate off, and the hotwell holds without alarm', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('turbine-trip')
    let lowest = 100
    let alarmed = false
    const at = new Map<number, number>()
    let second = 0
    plantRun.run(600, () => {
      second += 1
      lowest = Math.min(lowest, plantRun.tag('HOTWELL-LVL'))
      alarmed ||= plantRun.alarmed().includes(hotwellLow)
      if ([120, 300, 600].includes(second)) at.set(second, plantRun.tag('HOTWELL-LVL'))
    })
    // The feedwater pumps stopped, the tank fills to about 84 %, where its valve has shut.
    expect(plantRun.tag('COND-LCV-POS')).toBeCloseTo(0, 6)
    expect(plantRun.tag('FW-TANK-LVL')).toBeGreaterThan(83)
    expect(plantRun.tag('FW-TANK-LVL')).toBeLessThan(85)
    expect(plantRun.read('condenser-to-condensate-pump-a.flowKgPerS') + plantRun.read('condenser-to-condensate-pump-b.flowKgPerS')).toBeCloseTo(0, 6)
    // The hotwell dips while the valve closes, then holds, and its low alarm never comes in.
    expect(alarmed).toBe(false)
    expect(lowest).toBeGreaterThan(40)
    for (const level of at.values()) {
      expect(level).toBeGreaterThan(40)
      expect(level).toBeLessThan(60)
    }
  })

  test('after a loss of main feedwater the hotwell rejects to the condensate storage tank what it takes in above 60 %', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    let rejected = 0
    plantRun.run(600, () => { rejected += plantRun.tag('HOTWELL-REJECT-FLOW') })
    expect(rejected).toBeGreaterThan(500)
    expect(plantRun.tag('HOTWELL-LVL')).toBeGreaterThan(60)
    expect(plantRun.tag('HOTWELL-LVL')).toBeLessThan(62)
    expect(plantRun.alarmed()).not.toContain(hotwellLow)
  })
})
