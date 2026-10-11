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
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Each steam generator of the four-loop reference PWR has two level
// instruments reading the same two-phase mixture: the narrow range, spanning
// 32 to 92 % of the full-scale inventory above the tube bundle, and the wide
// range, from the tube sheet to the narrow range's upper tap at 92 %. Each
// reads 0 to 100 % of its own span and stays at the end of it off scale.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:sg-levels', loopCount: 4 }))
const graph = plant.graph
const loops = ['A', 'B', 'C', 'D'] as const

const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const read = (path: string): number => Number(runtime.readVariable(path as VariablePath))
  const tag = (tagId: string): number => Number(runtime.readVariable(resolveProcessPlantSignalBinding(graph, { tagId: tagId as never }).path))
  const run = (seconds: number): void => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-sg-levels' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const act = (actionId: string, parameters: Readonly<Record<string, unknown>> = {}): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters, graph })) {
      runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
  }
  return { read, tag, run, act }
}

/** The wide-range reading of a mixture level in percent of the full-scale inventory. */
const wideRangeOf = (mixturePercent: number): number => mixturePercent / 0.92
/** The wide-range reading of an on-scale narrow-range one: both read the same mixture. */
const wideRangeOfNarrow = (narrowPercent: number): number => wideRangeOf((0.32 + narrowPercent / 100 * 0.6) * 100)

describe('steam generator level instruments', () => {
  test('declare each 0 to 100 % of its own span, tagged like the narrow range', () => {
    for (const loop of loops) {
      for (const [tagId, path] of [[`SG-${loop}-LVL-NR`, `sg${loop}.levelPercent`], [`SG-${loop}-LVL-WR`, `sg${loop}.wideRangeLevelPercent`]] as const) {
        const binding = resolveProcessPlantSignalBinding(graph, { tagId: tagId as never })
        expect(binding.path).toBe(path as VariablePath)
        expect(binding.unit).toBe('percent')
        expect(graph.signalBindingByPath.get(binding.path)!.limits?.hardRange).toEqual({ min: 0, max: 100 })
      }
    }
  })

  test('read the same mixture at full power: 55 % narrow range is 70.7 % wide range', () => {
    const plantRun = started()
    plantRun.run(5)
    for (const loop of loops) {
      expect(plantRun.tag(`SG-${loop}-LVL-NR`)).toBeCloseTo(55, 0)
      expect(plantRun.tag(`SG-${loop}-LVL-WR`)).toBeCloseTo(wideRangeOfNarrow(plantRun.tag(`SG-${loop}-LVL-NR`)), 6)
    }
  })

  test('after a loss of main feedwater the narrow range sits at 0 % while the wide range shows the level recovering', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    plantRun.run(120)
    const { read, tag } = plantRun
    // The trip collapses the voids: the mixture falls below the narrow range's span, which reads its bottom end.
    const atTwoMinutes = tag('SG-A-LVL-WR')
    expect(tag('SG-A-LVL-NR')).toBe(0)
    expect(atTwoMinutes).toBeGreaterThan(15)
    expect(atTwoMinutes).toBeLessThan(wideRangeOfNarrow(0))
    expect(atTwoMinutes).toBeCloseTo(wideRangeOf(read('sgA.collapsedLevelPercent') + read('sgA.swellLevelPercent')), 6)
    // Auxiliary feedwater outruns the decay heat's boil-off, and the wide range shows the generator filling,
    // though not yet back into the narrow range.
    plantRun.run(180)
    expect(tag('SG-A-LVL-NR')).toBe(0)
    expect(tag('SG-A-LVL-WR') - atTwoMinutes).toBeGreaterThan(1.5)
    // Well above the top of the tube bundle, at 12 % of the full-scale inventory: the tubes are covered.
    expect(tag('SG-A-LVL-WR')).toBeGreaterThan(wideRangeOf(12))
    expect(read('sgA.tubeCoverageFraction')).toBe(1)
  })
})
