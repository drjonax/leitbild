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
import type { MimicDrawnItem } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { plantControlsFor } from '../src/packs/process-plant/operations/controls.ts'
import { badgeRoom } from '../src/ui/embed/composed-display/mimic/badge-room.ts'
import type { Box } from '../src/ui/embed/vignette/popover.ts'
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'

guardPlantTests()

// QA-20 (badge room): an operated item's badges stand inside the box the
// layout already gave its symbol, so an overview or detail draws exactly as
// it did and nothing the badges carry covers another item. Measured in the
// Full HD display window, on the four-loop reference Plant.

const fullHd: OverviewView = { width: 1896, height: 972 }

const plant = (): ProcessPlantRuntimeInstance => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:badges', loopCount: 4 }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  return { plant: compiled, runtime, ramps: createProcessPlantRampRunner({ runtime }), protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }), performance: createProcessPlantRuntimePerformance() }
}

const inside = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
const overlaps = (left: Box, right: Box): boolean =>
  left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height

/** What else an item draws: its symbol and its text stack. */
const drawnAreas = (item: MimicDrawnItem): ReadonlyArray<Box> => [item.box, ...(item.text === null ? [] : [item.text])]

describe('operation badges on the symbols', () => {
  const system = plant()
  const operable = plantControlsFor(system.plant).items.filter(entry => entry.offered.length > 0)
  /** The drawn items that carry an operable item's badges: its own symbol, or its host's where it is bundled and not drawn. */
  const carriers = (items: ReadonlyArray<MimicDrawnItem>): ReadonlyArray<MimicDrawnItem> => items.filter(item => item.presentation.element !== 'bar' && operable.some(entry =>
    item.binding.item.kind === 'device'
      ? entry.id === `${item.components[0]}.${item.binding.item.device}`
      : item.components.includes(entry.id) || (entry.item.kind === 'device' && item.components.length === 1 && String(system.plant.graph.components[entry.item.component]!.id) === item.components[0])))

  const check = (items: ReadonlyArray<MimicDrawnItem>): number => {
    const carrying = carriers(items)
    for (const item of carrying) {
      for (const badge of badgeRoom(item)) {
        expect(inside(badge, item.box)).toBe(true)
        for (const other of items) {
          if (other === item || other.presentation.element === 'bar') continue
          for (const area of drawnAreas(other)) expect({ item: item.binding.label, other: other.binding.label, overlaps: overlaps(badge, area) }).toEqual({ item: item.binding.label, other: other.binding.label, overlaps: false })
        }
      }
    }
    return carrying.length
  }

  test('on the Full HD unit overview every operable item\'s badges stand inside its own symbol and cover nothing else', () => {
    const result = compileOverviewDisplay(system, new Set(), fullHd)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const items = result.display.panels.flatMap(panel => panel.kind === 'mimic' ? panel.mimic.items : [])
    // The core and the pressurizer, the reactor coolant pumps, the feed and steam valves, the turbine and its valves, the pump groups.
    expect(check(items)).toBeGreaterThanOrEqual(12)
  }, PLANT_HANG_GUARD_MS)

  test('so on an item\'s detail, where a pressurizer carries its bundled relief and block valves', () => {
    const result = compileDetailDisplay(system, new Set(), ['pressurizer'], fullHd)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const items = result.display.panels.flatMap(panel => panel.kind === 'mimic' ? panel.mimic.items : [])
    expect(check(items)).toBeGreaterThanOrEqual(3)
  }, PLANT_HANG_GUARD_MS)
})
