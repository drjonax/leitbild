import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { notMeaningfulNow } from '../src/packs/process-plant/displays/overview-key-values.ts'
import { stateTexts } from '../src/packs/process-plant/displays/state-words.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// What the four-loop reference PWR's turbine-generator and its grid publish
// for the turbine-generator element: the main steam header holding its
// steam generators' pressure with no flow, the generator breaker, the load
// demand, grid frequency and availability, turbine load from impulse
// pressure, synchronous speed while on line, and the values that rest on
// the model's uncalibrated secondary energy basis kept off operator displays.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:turbine-generator', loopCount: 4 }))
const binding = (tagId: string) => plant.graph.signalBindingByTagId.get(tagId as never)!
const bindingAt = (path: string) => plant.graph.signalBindingByPath.get(path as VariablePath)!
const componentOf = (id: string) => plant.graph.components[plant.graph.componentIndexById.get(id as never)!]!

const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const read = (path: string): unknown => runtime.readVariable(path as VariablePath)
  const number = (path: string): number => Number(read(path))
  const run = (seconds: number, each?: (second: number) => void): void => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-turbine-generator' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
      each?.(second + 1)
    }
  }
  const act = (actionId: string): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: plant.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  const write = (path: string, value: number | boolean): void => runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value })
  const silenced = (): ReadonlySet<VariablePath> => notMeaningfulNow(plant, { mode: null, read: path => runtime.readVariable(path) })
  return { read, number, run, act, write, silenced }
}

const lowestSteamGeneratorPressure = (number: (path: string) => number): number =>
  Math.min(...['A', 'B', 'C', 'D'].map(loop => number(`sg${loop}.pressureMPa`)))

describe('main steam header pressure', () => {
  test('holds its steam generators\' pressure through the open isolation valves for five minutes after a turbine trip', () => {
    const plantRun = started()
    plantRun.run(60)
    plantRun.act('turbine-trip')
    let worst = Number.POSITIVE_INFINITY
    plantRun.run(300, () => {
      worst = Math.min(worst, plantRun.number('mainSteamHeader.mixedPressureMPa') - lowestSteamGeneratorPressure(plantRun.number))
    })
    // It fell to about 1 MPa within 5 s while the steam generators stood at 7.3 MPa (model audit F-T1).
    expect(worst).toBeGreaterThan(-0.5)
  })
})

describe('turbine-generator signals', () => {
  test('publish the load demand, the generator breaker in on-line words and grid availability, all tagged', () => {
    for (const tagId of ['TURB-LOAD', 'GEN-BKR', 'GRID-AVAIL', 'GRID-HZ', 'TURB-IMP-LOAD', 'TURB-SPEED']) expect(binding(tagId).published).toBe(true)
    expect(String(binding('GEN-BKR').path)).toBe('turbine.outputBreakerClosed')
    expect(stateTexts(plant.graph, binding('GEN-BKR'))).toEqual({ on: 'ON LINE · Turbine', off: 'OFF LINE · Turbine' })
  })

  test('grid frequency reads within its 49 to 51 Hz normal band and only while the grid is energized, by the same path the RfG relays read', () => {
    expect(String(binding('GRID-HZ').path)).toBe('offsiteGrid.frequencyHz')
    expect(binding('GRID-HZ').limits?.normalRange).toEqual({ min: 49, max: 51 })
    expect(binding('GRID-HZ').limits?.hardRange).toEqual({ min: 0, max: 70 })
    expect(componentOf('offsiteGrid').semantics.meaningfulWhile).toEqual([{ flag: 'offsiteGrid.energized', variables: ['offsiteGrid.frequencyHz'] }] as never)
    const plantRun = started()
    plantRun.run(5)
    expect(plantRun.silenced().has('offsiteGrid.frequencyHz' as VariablePath)).toBe(false)
    plantRun.act('loss-offsite-power')
    plantRun.run(2)
    // The boundary keeps its last number; nothing measures it.
    expect(plantRun.number('offsiteGrid.frequencyHz')).toBe(50)
    expect(plantRun.silenced().has('offsiteGrid.frequencyHz' as VariablePath)).toBe(true)
  })

  test('turbine load reads the steam flow over its rated flow in percent, and speed is synchronous with the grid only while on line', () => {
    const plantRun = started()
    expect(plantRun.number('turbine.speedRpm')).toBe(1_500)
    plantRun.run(60)
    expect(plantRun.number('turbine.impulseLoadPercent')).toBeCloseTo(plantRun.number('turbine.steamFlowKgPerS') / Number((componentOf('turbine').parameters as Readonly<Record<string, unknown>>).nominalSteamFlowKgPerS) * 100, 9)
    expect(plantRun.number('turbine.impulseLoadPercent')).toBeCloseTo(100, 1)
    expect(plantRun.number('turbine.speedRpm')).toBe(1_500)
    // Four poles on the grid: 30 rpm per hertz, within the RfG band where no relay acts.
    plantRun.write('offsiteGrid.frequencyHz', 49.5)
    plantRun.run(1)
    expect(plantRun.number('turbine.speedRpm')).toBeCloseTo(1_485, 9)
    expect(plantRun.silenced().has('turbine.speedRpm' as VariablePath)).toBe(false)
    plantRun.act('turbine-trip')
    plantRun.run(2)
    expect(plantRun.read('turbine.outputBreakerClosed')).toBe(false)
    expect(plantRun.number('turbine.impulseLoadPercent')).toBe(0)
    // No rotor is modeled: off line the speed measures nothing, so no coastdown number is shown.
    expect(plantRun.silenced().has('turbine.speedRpm' as VariablePath)).toBe(true)
  })

  test('the turbine stop valves draw as isolating valves under one operator label', () => {
    const valve = componentOf('turbineStopValve')
    expect(valve.semantics.function).toBe('isolating')
    expect(valve.metadata?.presentation?.shortLabel).toBe('Turbine stop valves')
  })

  test('declare the generator\'s span, its shutdown readings, and the values only the simulator computes', () => {
    expect(binding('GEN-MW').limits?.instrumentSpan).toEqual({ min: 0, max: 1_300 })
    expect(componentOf('turbine').semantics.shutdownReadings).toEqual(['turbine.electricMw', 'turbine.outputBreakerClosed'] as never)
    const simulated = [
      'turbine.exhaustTemperatureC',
      'turbine.steamFlowKgPerS',
      'turbine.steamDemandKgPerS',
      'condenser.steamFlowKgPerS',
      'condenser.heatRejectedMw',
      'turbine-stop-valve-to-turbine.flowKgPerS',
      'turbine-exhaust-to-condenser.flowKgPerS',
      'turbine-exhaust-to-condenser.temperatureC',
    ]
    expect(simulated.filter(path => bindingAt(path).simulatorOnly !== true)).toEqual([])
    for (const tagId of ['GEN-MW', 'TURB-IMP-LOAD', 'TURB-SPEED', 'GRID-HZ', 'GEN-BKR']) expect(binding(tagId).simulatorOnly).toBeUndefined()
  })
})
