import { describe, expect, test } from 'bun:test'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { compileDetailDisplay, compileOverviewDisplay, overviewDrawingRoom, type ComposedMimicPanel } from '../src/packs/process-plant/displays/compose.ts'
import { compileMimic, compileMimicScope } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { MIMIC_MAX_WIDTH, type CompiledMimic, type MimicDrawnItem } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { presentationFor } from '../src/packs/process-plant/displays/mimic/presentation.ts'
import { overviewScope } from '../src/packs/process-plant/displays/mimic/principal.ts'
import { chatMimicProfile, detailMimicProfile, overviewMimicProfile } from '../src/packs/process-plant/displays/mimic/profiles.ts'
import { openBridgeDevice, reactorVesselBottom } from '../src/packs/process-plant/displays/mimic/text-metrics.ts'
import { overviewKeyValues } from '../src/packs/process-plant/ic/key-values.ts'
import { recordingSeriesIdFor } from '../src/core/model/index.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The reactor vessel drawn from the model (owner feedback on v0.4.0: "still a
// narrow box"), and vessels that show what their readings did over the last
// ten minutes, on the unit overview and on details, never in a chat answer.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:vessel', loopCount: 4 }))
const system = ((): ProcessPlantRuntimeInstance => {
  const runtime = createProcessPlantRuntime({ system: plant })
  return {
    plant,
    runtime,
    ramps: createProcessPlantRampRunner({ runtime }),
    protection: createProcessPlantProtectionRunner({ system: plant, protection: plant.automation }),
    performance: createProcessPlantRuntimePerformance(),
  }
})()
const fullHd = { width: 1896, height: 972 }
const room = overviewDrawingRoom(fullHd, 'column', {
  readouts: overviewKeyValues(plant, { mode: 'powerOperation', read: path => system.runtime.readVariable(path) }).length,
  annunciators: 9,
  tileWidth: 134,
})!
const overview = ((): CompiledMimic => {
  const principal = overviewScope(plant.graph)
  if (!principal.ok) throw new Error(principal.reason)
  const result = compileMimicScope(plant, principal.scope, { profile: overviewMimicProfile, ...room })
  if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
  return result.mimic
})()
const coreOf = (mimic: CompiledMimic): MimicDrawnItem => mimic.items.find(item => item.components.includes('core'))!
const labelled = (mimic: CompiledMimic, label: string): MimicDrawnItem => mimic.items.find(item => item.binding.label === label)!
const banks = (prefix: string) => ['A', 'B', 'C', 'D'].map(bank => ({ path: `core.${prefix}Bank${bank}StepsWithdrawn`, range: { min: 0, max: 228 } }))

describe('the reactor vessel on a drawing', () => {
  test('a core is drawn as the vessel it heats; a reactor vessel drawn on its own stays a tank', () => {
    const kind = (id: string) => presentationFor(plant.graph.components.find(component => String(component.id) === id)!)
    expect(kind('core')).toEqual({ element: 'vessel', aspect: 'level' })
    expect(kind('vessel')).toEqual({ element: 'tank', tank: 'pressurized', aspect: 'level' })
  })

  test('the Full-HD overview keeps its drawing beside its column with the vessel four cells wide and tall above its nozzles, its bottom below them', () => {
    // Owner on v0.4.0: "still a narrow box". As wide as the rows over it (four cells), in the room an 11 px gutter leaves.
    expect(room.maxWidth).toBe(1585)
    expect(overview.width).toBeLessThanOrEqual(room.maxWidth)
    expect(overview.height).toBeLessThanOrEqual(room.maxHeight)
    const core = coreOf(overview)
    expect(core.presentation.element).toBe('vessel')
    expect(overviewMimicProfile.vessel.cells).toBe(4)
    expect(core.box.width).toBe(96)
    expect(core.box.height).toBeGreaterThanOrEqual(240)
    expect(core.vessel?.span).toEqual({ x: 0, width: 96 })
    // Its core region overlaps its lowest nozzles: the overview has no height for it below them.
    expect(core.vessel?.core).toBe('overlap')
    // Every loop's hot and cold leg reaches it at a collar on its side; none at its head or bottom.
    const nozzles = core.vessel!.nozzles
    expect(nozzles).toHaveLength(8)
    expect(nozzles.every(nozzle => nozzle.face === 'left' && nozzle.x === core.box.x)).toBe(true)
    const ys = nozzles.map(nozzle => nozzle.y)
    expect(Math.min(...ys) - core.box.y).toBeGreaterThanOrEqual(overviewMimicProfile.vessel.head)
    expect(core.box.y + core.box.height - Math.max(...ys)).toBeGreaterThanOrEqual(reactorVesselBottom('overlap'))
    // Its rod banks are sampled with the drawing.
    for (const part of [...banks('shutdown'), ...banks('control')]) expect(overview.paths).toContain(part.path as never)
  })

  test('the core\'s detail draws it four cells wide and keeps its faceplate under the drawing at Full HD', () => {
    const detail = compileDetailDisplay(system, new Set(), ['core'], fullHd)
    if (!detail.ok) throw new Error(JSON.stringify(detail.issues))
    expect(detail.display.panels.map(panel => panel.kind)).toEqual(['mimic', 'faceplate', 'alarms'])
    const mimic = (detail.display.panels[0] as ComposedMimicPanel).mimic
    expect(coreOf(mimic).box.width).toBe(detailMimicProfile.vessel.cells * 24)
    expect(coreOf(mimic).vessel?.core).toBe('overlap')
  })

  test('in a box wider than a vessel stands (a detail whose pipes reach the core from below), it stands taller than wide beside its rows, and a pipe reaching the box beside it continues to its side', () => {
    // HMI verify 44 (SG A detail): the core drawn as a 264 x 96 saucer. Since C2b the steam generator and coolant pump
    // details draw their loop at two links' reach, where the core's box is a vessel's own; the rule is held on each
    // of them, and wherever its box is wider than a vessel stands.
    for (const id of ['sgA', 'sgB', 'sgC', 'sgD', 'rcpA']) {
      const detail = compileDetailDisplay(system, new Set(), [id], fullHd)
      if (!detail.ok) throw new Error(JSON.stringify(detail.issues))
      const mimic = detail.display.panels.find((panel): panel is ComposedMimicPanel => panel.kind === 'mimic')!.mimic
      const core = coreOf(mimic)
      const span = core.vessel!.span
      // Never a saucer: the vessel stands taller than wide.
      expect(span.width, id).toBeLessThan(core.box.height)
      if (core.box.width > core.box.height) {
        // Beside its rows, which stand right of its box.
        expect(core.text?.side, id).toBe('right')
        expect(span.x + span.width, id).toBe(core.box.width)
      }
      // Every pipe that reaches its box ends at one of its nozzles, each on the vessel itself.
      const left = core.box.x + span.x
      const right = left + span.width
      for (const nozzle of core.vessel!.nozzles) expect(nozzle.x >= left - 1e-9 && nozzle.x <= right + 1e-9, id).toBe(true)
      const touching = mimic.pipes.flatMap(pipe => [pipe.points[0]!, pipe.points.at(-1)!])
        .filter(([x, y]) => x >= core.box.x && x <= core.box.x + core.box.width && y >= core.box.y && y <= core.box.y + core.box.height)
      expect(touching.length, id).toBeGreaterThan(0)
      for (const [x, y] of touching) expect(core.vessel!.nozzles.some(nozzle => nozzle.x === x && nozzle.y === y), id).toBe(true)
    }
  })

  test('a chat answer\'s drawing keeps the vessel narrow and shows no trends', () => {
    const result = compileMimic(plant, { from: ['rcpA'], to: ['core'] }, { profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: 624 })
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const core = coreOf(result.mimic)
    expect(core.box.width).toBe(chatMimicProfile.vessel.cells * 24)
    expect(core.vessel).toBeDefined()
    expect(result.mimic.trendPaths).toEqual([])
    expect(result.mimic.items.some(item => item.trend !== undefined || item.rows.some(row => row.kind === 'value' && row.sparkline !== undefined))).toBe(false)
  })
})

describe('vessels trace their readings over the last minutes', () => {
  test('tanks their fill\'s own level, heat exchangers the level their row reads, the core its value rows', () => {
    expect(labelled(overview, 'PZR').trend).toEqual({ kind: 'fill', path: 'pressurizer.levelPercent' as never })
    expect(labelled(overview, 'FW tank').trend).toEqual({ kind: 'fill', path: 'feedwaterTank.levelPercent' as never })
    for (const label of ['SG A', 'SG B', 'SG C', 'SG D', 'Condenser']) {
      const item = labelled(overview, label)
      const trend = item.trend
      expect(trend?.kind).toBe('strip')
      const row = trend?.kind === 'strip' ? item.rows[trend.row] : undefined
      expect(row?.kind === 'value' && row.path === String(item.binding.state?.state?.path)).toBe(true)
    }
    const core = coreOf(overview)
    expect(core.trend).toBeUndefined()
    // The core-exit temperature's sparkline is large enough to read a rise or a fall (HMI review of run 26c).
    expect(core.rows.filter(row => row.kind === 'value').map(row => row.kind === 'value' ? row.sparkline : undefined)).toEqual([{ width: 80, height: 24 }])
    // What their history is kept for: each fill, each strip's reading and its wide range, the core-exit temperature.
    expect(overview.trendPaths.map(String).sort()).toEqual([
      'condenser.condensateLevelPercent', 'core.coreExitTemperatureC', 'feedwaterTank.levelPercent', 'pressurizer.levelPercent',
      ...['A', 'B', 'C', 'D'].flatMap(sg => [`sg${sg}.levelPercent`, `sg${sg}.wideRangeLevelPercent`]),
    ])
  })

  test('a tank\'s binding names the program its level is held to, sampled with the drawing', () => {
    expect(labelled(overview, 'PZR').binding.program).toBe('pressurizer.levelProgramPercent' as never)
    expect(overview.paths).toContain('pressurizer.levelProgramPercent' as never)
    expect(labelled(overview, 'FW tank').binding.program).toBeUndefined()
  })

  test('a generated display hands its drawing\'s trends their series, over the lead values\' ten minutes, recorded or not', () => {
    const recorded = new Set(['pressurizer.levelPercent', 'core.coreExitTemperatureC'].map(path => recordingSeriesIdFor(plant.id, path as never)))
    const display = compileOverviewDisplay(system, recorded, fullHd)
    if (!display.ok) throw new Error(JSON.stringify(display.issues))
    const panel = display.display.panels.find((entry): entry is ComposedMimicPanel => entry.kind === 'mimic')!
    expect(panel.trends?.windowMs).toBe(10 * 60_000)
    expect(panel.trends?.pens.map(pen => String(pen.path)).sort()).toEqual([...panel.mimic.trendPaths].map(String).sort())
    expect(panel.trends?.pens.filter(pen => pen.recorded).map(pen => String(pen.path)).sort()).toEqual(['core.coreExitTemperatureC', 'pressurizer.levelPercent'])
  })
})
