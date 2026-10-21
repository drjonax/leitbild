import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import type { PackProcedureTagValidation } from '../src/core/packs/protocol.ts'
import {
  answerProcessPlantQuery,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { signalMeasuredOn } from '../src/packs/process-plant/signals.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

const plant = (): ProcessPlantRuntimeInstance => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:tag-display' }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  return {
    plant: compiled,
    runtime,
    ramps: createProcessPlantRampRunner({ runtime }),
    protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }),
    performance: createProcessPlantRuntimePerformance(),
  }
}

const system = plant()
const graph = system.plant.graph
const plants = new Map([[system.plant.id, system]])
const ask = (capabilityId: string, input: unknown): unknown => answerProcessPlantQuery({
  request: { capabilityId, input },
  plants,
  objects: new Map(),
  simulationTime: '2026-10-13T10:00:00.000Z' as IsoTimestamp,
  recordedSeriesIds: new Set(),
})
const binding = (tagId: string) => graph.signalBindingByTagId.get(tagId as never)!

describe('the component a signal is measured on', () => {
  test('is the component that owns it, whatever equipment the signal declares', () => {
    expect(String(signalMeasuredOn(graph, binding('PT-455').owner).id)).toBe('pressurizer')
    // The power-range average declares the nuclear instrumentation, which is no component: it measures the core.
    expect(binding('NIS-PR-AVG').equipmentId).toBe('nuclear-instrumentation' as never)
    expect(String(signalMeasuredOn(graph, binding('NIS-PR-AVG').owner).id)).toBe('core')
  })

  test("is, for a line's signal, the equipment the line flows into", () => {
    const hotLeg = binding('TE-411-HOT')
    expect(hotLeg.owner.type).toBe('link')
    if (hotLeg.owner.type !== 'link') throw new Error('expected a line signal')
    const line = graph.links[hotLeg.owner.linkIndex]!
    const measured = signalMeasuredOn(graph, hotLeg.owner)
    expect(measured.index).toBe(line.toComponentIndex)
    expect(String(measured.id)).toBe('sgA')
  })
})

describe('procedure tags validated against a Plant', () => {
  const validated = ask('world.process-plant.procedure-tags.validate', {
    plantId: system.plant.id,
    tags: [{ id: 'PT-455' }, { id: 'NIS-PR-AVG' }, { id: 'TRIP-BKR-A' }, { id: 'DG-A' }, { id: 'SI-SIG' }],
  }) as { readonly tags: ReadonlyArray<PackProcedureTagValidation> }
  const row = (id: string): PackProcedureTagValidation => validated.tags.find(tag => tag.id === id)!

  test('name the component each resolved tag is measured on, and none for a tag the model lacks', () => {
    expect(validated.tags.map(tag => [tag.id, tag.measuredOn])).toEqual([
      ['PT-455', 'pressurizer'],
      ['NIS-PR-AVG', 'core'],
      ['TRIP-BKR-A', 'reactorTripBreakerA'],
      ['DG-A', 'dieselGeneratorA'],
      ['SI-SIG', undefined],
    ])
    expect(row('SI-SIG')).toEqual({ id: 'SI-SIG', status: 'missing', warnings: [] })
  })
})
