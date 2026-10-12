import { describe, expect, test } from 'bun:test'
import {
  commandsForProcessPlantAction,
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
import { createMimicQuickLook, quickLookValue } from '../src/ui/embed/composed-display/mimic/quick-look-source.ts'
import type { ComposedDisplaySample } from '../src/ui/embed/composed-display/composed-display-client.ts'
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

describe('a quick look reads "—" for a reading outside the validity its equipment declares', () => {
  test('after a loss of offsite power the turbine\'s speed and the grid\'s frequency read "—", never 0 rpm or 50 Hz, and the flags they are valid under are sampled', async () => {
    const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:quick-look-validity', loopCount: 4 }))
    const runtime = createProcessPlantRuntime({ system: compiled })
    const protection = createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation })
    const lost: ProcessPlantRuntimeInstance = { plant: compiled, runtime, ramps: createProcessPlantRampRunner({ runtime }), protection, performance: createProcessPlantRuntimePerformance() }
    // Opened at power: the overview's quick looks carry the turbine's speed, the grid's detail's its frequency.
    const overview = compileOverviewDisplay(lost, new Set(), fullHd)
    const grid = compileDetailDisplay(lost, new Set(), ['offsiteGrid'], fullHd)
    if (!overview.ok || !grid.ok) throw new Error('expected the overview and the grid detail')
    const looks = mimicPanel(overview.display).quickLooks!
    const pens = [...looks.pens, ...mimicPanel(grid.display).quickLooks!.pens].filter(pen => pen.tagId === 'TURB-SPEED' || pen.tagId === 'GRID-HZ')
    expect(pens.map(pen => pen.tagId).sort()).toEqual(['GRID-HZ', 'TURB-SPEED'])
    expect(pens.every(pen => pen.validWhile !== undefined)).toBe(true)
    for (const command of commandsForProcessPlantAction({ actionId: 'loss-offsite-power', parameters: {}, graph: compiled.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    for (let second = 0; second < 30; second += 1) {
      runtime.tick(1000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run' as never, sourceRuntimeId: 'test' })
    }
    // What the quick look samples: each reading and the flag it is valid under.
    let asked: ReadonlyArray<string> = []
    const sampleOf = (paths: ReadonlyArray<string>): ComposedDisplaySample => ({
      simulationTime: '2026-10-12T12:00:30.000Z',
      plantElapsedMs: runtime.elapsedMs(),
      values: paths.map(path => ({ path, value: runtime.readVariable(path as never) as number | boolean, quality: 'good' as const })),
    })
    const source = createMimicQuickLook({
      client: { history: async () => ({ series: [] }) as never, sample: async (_run, _plant, paths) => { asked = paths; return sampleOf(paths) } },
      runId: 'run' as never,
      plantId: compiled.id,
      setInterval: () => 0,
      clearInterval: () => undefined,
    })
    const stop = source.open({ pens, sparklineMs: looks.sparklineMs }, () => undefined)
    await Bun.sleep(10)
    stop()
    for (const pen of pens) expect(asked).toContain(String(pen.validWhile))
    const latest = sampleOf(asked)
    for (const pen of pens) {
      expect(runtime.readVariable(pen.validWhile!)).toBe(false)
      expect(quickLookValue(pen, latest).value).toBeUndefined()
    }
  }, 60_000)
})
