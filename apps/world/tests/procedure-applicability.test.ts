import { expect, test } from 'bun:test'
import { assertPwrReferenceProcedureTarget } from '../src/packs/process-plant/procedure-applicability.ts'
import { createPwrReferencePlantDefinition } from '../src/packs/process-plant/plant-definitions.ts'
import { packIdSchema } from '../src/core/model/index.ts'
import { procedureSources } from '../src/procedure-sources.ts'

const definition = createPwrReferencePlantDefinition({ id: 'plant:target' })
const target = { packId: packIdSchema.parse('process-plant'), packData: { type: 'process-plant', schemaVersion: 1,
  model: definition.model, operatingPoint: definition.operatingPoint, automation: definition.automation, electricalPorts: [] } }

test('native archive source has mandatory owner admission and accepts only its actual reference configuration', () => {
  expect(procedureSources[0]!.assertTargetApplicable).toBeFunction()
  expect(() => assertPwrReferenceProcedureTarget(target)).not.toThrow()
  for (const packId of ['fixture', 'electric-grid']) expect(() => assertPwrReferenceProcedureTarget({ ...target, packId: packIdSchema.parse(packId) })).toThrow('actual Process Plant')
  for (const packData of [
    { ...target.packData, model: { ...definition.model, ref: 'process-plant.ld01' } },
    { ...target.packData, model: { ...definition.model, parameters: { loopCount: 2 } } },
    { ...target.packData, operatingPoint: { ref: 'other-initialization' } },
    { ...target.packData, operatingPoint: { ...definition.operatingPoint, valueOverrides: { 'core.powerMw': 0 } } },
    { ...target.packData, automation: { ref: 'custom-automation' } },
  ]) expect(() => assertPwrReferenceProcedureTarget({ ...target, packData })).toThrow('unmodified four-loop')
})
