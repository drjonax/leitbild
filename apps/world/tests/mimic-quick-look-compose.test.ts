import { describe, expect, test } from 'bun:test'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { compileDetailDisplay, compileOverviewDisplay, composedDisplaySignals, type ComposedMimicPanel } from '../src/packs/process-plant/displays/compose.ts'
import { mimicQuickLookPaths, QUICK_LOOK_LEADS } from '../src/packs/process-plant/displays/mimic/quick-look.ts'
import { plantNowOf } from '../src/packs/process-plant/displays/overview-key-values.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A generated display carries each drawn item's quick look, chosen with its
// drawing, so opening one compiles nothing; what the display shows (its
// signals, the content an answer may cite) never includes them.

const system = ((): ProcessPlantRuntimeInstance => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:quick-look-compose', loopCount: 4 }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  return {
    plant: compiled,
    runtime,
    ramps: createProcessPlantRampRunner({ runtime }),
    protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }),
    performance: createProcessPlantRuntimePerformance(),
  }
})()
const fullHd = { width: 1896, height: 972 }

const mimicPanel = (display: { readonly panels: ReadonlyArray<{ readonly kind: string }> }): ComposedMimicPanel =>
  display.panels.find((panel): panel is ComposedMimicPanel => panel.kind === 'mimic')!

describe('quick looks of a generated display', () => {
  test('the overview carries each drawn item\'s first detail lead values, each compiled once', () => {
    const compiled = compileOverviewDisplay(system, new Set(), fullHd)
    if (!compiled.ok) throw new Error(compiled.issues.map(issue => issue.message).join('; '))
    const panel = mimicPanel(compiled.display)
    const looks = panel.quickLooks!
    expect(looks.items).toEqual(mimicQuickLookPaths(system.plant, panel.mimic, plantNowOf(system)) as never)
    const pens = new Set(looks.pens.map(pen => String(pen.path)))
    expect(pens.size).toBe(looks.pens.length)
    for (const paths of Object.values(looks.items)) {
      expect(paths.length).toBeLessThanOrEqual(QUICK_LOOK_LEADS)
      for (const path of paths) expect(pens.has(String(path))).toBe(true)
    }
    // Never part of what the display shows: its signals are its lead values' and its drawing's only.
    const shown = new Set(composedDisplaySignals(compiled.display).map(signal => signal.path))
    expect(looks.pens.some(pen => !shown.has(String(pen.path)))).toBe(true)
    for (const signal of shown) expect(compiled.display.panels.some(entry => entry.kind === 'readouts' && entry.pens.some(pen => String(pen.path) === signal))).toBe(true)
  })

  test('equipment opened from it carries its own drawing\'s quick looks', () => {
    const compiled = compileDetailDisplay(system, new Set(), ['sgB'], fullHd)
    if (!compiled.ok) throw new Error(compiled.issues.map(issue => issue.message).join('; '))
    const panel = mimicPanel(compiled.display)
    const sg = panel.mimic.items.find(item => item.components.includes('sgB'))!
    expect(panel.quickLooks?.items[sg.id]?.length).toBeGreaterThan(0)
  })
})
