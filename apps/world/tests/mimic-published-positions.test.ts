import { describe, expect, test } from 'bun:test'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { compileDetailDisplay, type ComposedMimicPanel } from '../src/packs/process-plant/displays/compose.ts'
import { itemBinding } from '../src/packs/process-plant/displays/mimic/bindings.ts'
import type { EquipmentItem } from '../src/packs/process-plant/equipment/items.ts'
import { indexSample } from '../src/packs/process-plant/displays/mimic/evaluate.ts'
import { drawnLook, rowText } from '../src/packs/process-plant/displays/mimic/rows.ts'
import { formatQuantity } from '../src/packs/process-plant/quantity-text.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A valve's position is drawn only from a signal the Plant publishes (HMI
// review of run 26c: the SG details drew ARV "SHUT" from the model's own
// state, while the turbine faceplate said the ARVs are not measured). Since
// C2b the reference model publishes the relief valves' positions, so they
// read where they stand; the accumulators' check valves still read POS ?.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:published-positions', loopCount: 4 }))
const graph = plant.graph
const published = (path: string): boolean => graph.signalBindingByPath.get(path as never)?.published === true

/** Every valve the Plant has, a component or a bundled device: what declares an equipment function. */
const valves = graph.components.flatMap((component, index): ReadonlyArray<{ readonly item: EquipmentItem; readonly declared: string | undefined }> => [
  ...(component.semantics.function === undefined ? [] : [{ item: { kind: 'component', component: index } as EquipmentItem, declared: component.semantics.aspects.find(entry => entry.aspect === 'position')?.state?.path as string | undefined }]),
  ...component.semantics.embedded.map(device => ({ item: { kind: 'device', component: index, device: device.id } as EquipmentItem, declared: device.aspects.find(entry => entry.aspect === 'position')?.state?.path as string | undefined })),
])

describe('a valve reads the position the Plant publishes, or POS ?', () => {
  test('every valve is drawn from a published position or not measured; the unpublished ones are the accumulators\' check valves', () => {
    const unpublished: string[] = []
    for (const { item, declared } of valves) {
      const binding = itemBinding(plant, item, 'position', new Map())
      const drawn = binding.state?.state?.path
      if (drawn !== undefined) expect({ label: binding.label, published: published(drawn) }).toEqual({ label: binding.label, published: true })
      if (declared !== undefined && !published(declared)) {
        expect(drawn).toBeUndefined()
        unpublished.push(binding.label)
      }
      // What passes a valve judges it only where that too is published.
      if (binding.state?.throughput !== undefined) expect(published(binding.state.throughput.path)).toBe(true)
    }
    expect(unpublished.sort()).toEqual(['ACC A check valve', 'ACC B check valve', 'ACC C check valve', 'ACC D check valve'])
  })

  test('the SG B detail draws ARV B, its safety valves and its TD AFW steam supply where their published positions stand, as its MSIV', () => {
    const runtime = createProcessPlantRuntime({ system: plant })
    const system: ProcessPlantRuntimeInstance = {
      plant, runtime, ramps: createProcessPlantRampRunner({ runtime }),
      protection: createProcessPlantProtectionRunner({ system: plant, protection: plant.automation }), performance: createProcessPlantRuntimePerformance(),
    }
    const detail = compileDetailDisplay(system, new Set(), ['sgB'], { width: 1896, height: 972 })
    if (!detail.ok) throw new Error(JSON.stringify(detail.issues))
    const mimic = detail.display.panels.find((panel): panel is ComposedMimicPanel => panel.kind === 'mimic')!.mimic
    const index = indexSample(mimic.paths.map(path => ({ path, value: runtime.readVariable(path), quality: 'good' })))
    const shown = (label: string) => {
      const item = mimic.items.find(entry => entry.binding.label === label)!
      return item.rows.map(row => rowText(row, drawnLook(item.binding, item.rows, index), index, formatQuantity)).filter(text => text !== '')
    }
    // At power the relief valve, the safety valves and the supply to the turbine-driven AFW pump stand shut.
    expect(shown('ARV B')).toEqual(['SHUT'])
    expect(shown('MSSV B')).toEqual(['SHUT'])
    expect(shown('TD AFW steam B')).toEqual(['SHUT'])
    expect(shown('MSIV B')).toEqual(['OPEN'])
    expect(mimic.summary.unmeasuredStates).not.toContain('ARV B')
  })
})
