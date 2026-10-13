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
// instruments reading the same two-phase mixture: the wide range, from the
// tube sheet to its upper tap above the separators at 73.1 % of the
// full-scale inventory, and the narrow range, over the upper quarter of it
// between taps around the normal water level, 55.1 to 73.1 %, as a Model 51
// steam generator's narrow range covers the upper 12 ft of the 48 ft its wide
// range spans (USNRC Westinghouse Technology Systems Manual 3.2). Each reads
// 0 to 100 % of its own span and stays at the end of it off scale.

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
const wideRangeOf = (mixturePercent: number): number => mixturePercent / 0.731
/** The wide-range reading of an on-scale narrow-range one: both read the same mixture. */
const wideRangeOfNarrow = (narrowPercent: number): number => wideRangeOf((0.551 + narrowPercent / 100 * 0.18) * 100)

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

  test('read the same mixture at full power: 55 % narrow range is 88.9 % wide range, and the narrow range covers its upper quarter', () => {
    const plantRun = started()
    plantRun.run(5)
    for (const loop of loops) {
      expect(plantRun.tag(`SG-${loop}-LVL-NR`)).toBeCloseTo(55, 0)
      expect(plantRun.tag(`SG-${loop}-LVL-WR`)).toBeCloseTo(wideRangeOfNarrow(plantRun.tag(`SG-${loop}-LVL-NR`)), 6)
      expect(plantRun.tag(`SG-${loop}-LVL-WR`)).toBeCloseTo(88.9, 0)
    }
    // Steady full power holds its program.
    plantRun.run(115)
    for (const loop of loops) expect(Math.abs(plantRun.tag(`SG-${loop}-LVL-NR`) - 55)).toBeLessThan(1)
    // The narrow range's 0 % is three quarters up the wide range.
    expect(wideRangeOfNarrow(0)).toBeCloseTo(75.4, 1)
    expect((wideRangeOfNarrow(100) - wideRangeOfNarrow(0)) / 100).toBeCloseTo(0.246, 3)
  })

  test('after a loss of main feedwater the narrow range sits at 0 % while the wide range shows the level recovering', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    plantRun.run(120)
    const { read, tag } = plantRun
    // The reactor trips on low-low level with the generators still boiling at full power: the trip's void collapse
    // and the boil-off of the coolant's stored heat on auxiliary feed alone take the mixture below the narrow range's
    // span, which reads its bottom end, while the wide range reads about 64 %, far above the bleed-and-feed region
    // of a heat sink lost.
    const atTwoMinutes = tag('SG-A-LVL-WR')
    expect(tag('SG-A-LVL-NR')).toBe(0)
    expect(atTwoMinutes).toBeGreaterThan(40)
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
    // The narrow range is back on its span, above F-0.3's 10 %, about eleven minutes after the loss of feed.
    plantRun.run(390)
    for (const loop of loops) expect(tag(`SG-${loop}-LVL-NR`)).toBeGreaterThan(10)
  })

  // A real four-loop plant's narrow range bottoms at about 10–25 % a minute or two after a trip from full power, its
  // wide range 5–15 points down, and auxiliary feedwater has it back within 5–15 min (SME review of run 26c). At full
  // power the boiling voids swell the mixture by about a fifth of the narrow range; the trip collapses them, and with
  // their feed isolated the generators boil off the coolant's stored heat until auxiliary feedwater outruns it.
  test('after a turbine trip from full power the narrow range shrinks to near its low-low level, on its span, and auxiliary feedwater refills it', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('turbine-trip')
    const narrow: number[] = []
    const wide: number[] = []
    let afwStartedAt: number | null = null
    for (let second = 1; second <= 480; second += 1) {
      plantRun.run(1)
      narrow.push(plantRun.tag('SG-A-LVL-NR'))
      wide.push(plantRun.tag('SG-A-LVL-WR'))
      if (afwStartedAt === null && plantRun.tag('AFW-PUMP-A-RUNNING') === 1) afwStartedAt = second
    }
    const lowest = Math.min(...narrow)
    const lowestAt = narrow.indexOf(lowest) + 1
    expect(lowest).toBeGreaterThan(10)
    expect(lowest).toBeLessThan(20)
    expect(lowestAt).toBeGreaterThan(45)
    expect(lowestAt).toBeLessThan(120)
    const wideFall = wide[0]! - Math.min(...wide)
    expect(wideFall).toBeGreaterThan(5)
    expect(wideFall).toBeLessThan(15)
    // The shrink passes the 20 % low-low level, which starts the motor-driven pumps, as after most trips from full
    // power; they refill the generators to their 55 % program within eight minutes.
    expect(afwStartedAt).not.toBeNull()
    expect(afwStartedAt!).toBeLessThan(lowestAt)
    for (const loop of loops) expect(plantRun.tag(`SG-${loop}-LVL-NR`)).toBeGreaterThan(50)
  })

  test('a feed regulating valve failed at 35 % trips the reactor on its own generator\'s low-low level, and the intact generators stay on span', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('steam-generator-b-feedwater-runback', { positionPercent: 35 })
    const lowest = Object.fromEntries(loops.map(loop => [loop, 100]))
    for (let second = 1; second <= 300; second += 1) {
      plantRun.run(1)
      for (const loop of loops) lowest[loop] = Math.min(lowest[loop]!, plantRun.tag(`SG-${loop}-LVL-NR`))
    }
    expect(lowest.B).toBe(0)
    for (const loop of ['A', 'C', 'D']) {
      expect(lowest[loop]).toBeGreaterThan(10)
      expect(lowest[loop]).toBeLessThan(25)
    }
  })
})
