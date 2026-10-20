import { describe, expect, test } from 'bun:test'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { compileDetailDisplay, compileOverviewDisplay, type OverviewView } from '../src/packs/process-plant/displays/compose.ts'
import { costsInReferences, referenceQuietMs } from './cpu-cost.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A generated display's drawings are laid out once per scope, independent of
// the window (diagramCandidates, mimicScopeDrawing); a window's size only
// chooses among them. So a resize, or opening the same equipment again,
// costs a lookup, and only a scope's first drawing lays it out. Budgets are
// main-thread CPU against the reference computation (cpu-cost.ts); before
// this, the overview took 448 to 543 ms and SG B's detail 310 ms at these
// untuned sizes (layout audit, 19 Oct), every time.

const plant = (): ProcessPlantRuntimeInstance => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:display-cost', loopCount: 4 }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  return {
    plant: compiled,
    runtime,
    ramps: createProcessPlantRampRunner({ runtime }),
    protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }),
    performance: createProcessPlantRuntimePerformance(),
  }
}

const recorded = new Set<string>()
const fullHd: OverviewView = { width: 1896, height: 972 }
const untuned: ReadonlyArray<OverviewView> = [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]
const ROUNDS = 5

describe('a generated display is laid out once per scope, whatever its window', () => {
  test('a resized overview chooses among the drawings laid out: within 80 ms quiet at untuned sizes', () => {
    const system = plant()
    expect(compileOverviewDisplay(system, recorded, fullHd).ok).toBe(true)
    const costs = costsInReferences(untuned.map(view => () => compileOverviewDisplay(system, recorded, view)), ROUNDS)
    for (const cost of costs) expect(cost).toBeLessThan(80 / referenceQuietMs)
  })

  test("SG B's detail opened again at 1280 x 720 within 60 ms quiet", () => {
    const system = plant()
    expect(compileDetailDisplay(system, recorded, ['sgB'], fullHd).ok).toBe(true)
    const [cost] = costsInReferences([() => compileDetailDisplay(system, recorded, ['sgB'], untuned[1]!)], ROUNDS)
    expect(cost).toBeLessThan(60 / referenceQuietMs)
  })

  test("a Plant's first overview, laid out from nothing at 1280 x 720, within 250 ms quiet", () => {
    // A fresh Plant per round: nothing of it is laid out yet.
    const fresh = Array.from({ length: ROUNDS }, plant)
    const [cost] = costsInReferences([() => compileOverviewDisplay(fresh.pop()!, recorded, untuned[1]!)], ROUNDS)
    expect(cost).toBeLessThan(250 / referenceQuietMs)
  })

  test('eight window sizes lay the overview out once: every size after the first is a lookup', () => {
    const system = plant()
    const sizes: ReadonlyArray<OverviewView> = [
      fullHd, { width: 2536, height: 1332 }, { width: 1920, height: 1080 }, { width: 1600, height: 900 },
      { width: 1366, height: 768 }, { width: 1280, height: 800 }, { width: 1280, height: 720 }, { width: 1024, height: 768 },
    ]
    expect(compileOverviewDisplay(system, recorded, sizes[0]!).ok).toBe(true)
    // Laying the principal circuits out again would cost over 60 ms quiet; a lookup a few.
    const costs = costsInReferences(sizes.slice(1).map(view => () => compileOverviewDisplay(system, recorded, view)), ROUNDS)
    for (const cost of costs) expect(cost).toBeLessThan(25 / referenceQuietMs)
  })
})
