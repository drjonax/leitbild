import { describe, expect, test } from 'bun:test'
import {
  compilePlantGraph,
  compileProcessPlant,
  createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
  type ComponentDefinition,
  type ComponentKind,
  type InsertionDeclaration,
} from '../src/packs/process-plant/index.ts'

// What equipment inserts, part by part, as its kind declares it: a core's
// rod banks, which a drawing hangs into its core region.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:insertion', loopCount: 4 }))
const banks = (prefix: string) => ['A', 'B', 'C', 'D'].map(bank => ({ path: `core.${prefix}Bank${bank}StepsWithdrawn`, range: { min: 0, max: 228 } }))

describe('what a core inserts', () => {
  test('the core declares its rod banks one by one, the shutdown banks then the control banks, each in at no steps withdrawn', () => {
    const core = plant.graph.components.find(component => String(component.id) === 'core')!
    expect(core.semantics.insertion).toEqual({ reading: 'core.rodStepsWithdrawn' as never, insertedAt: 'min', groups: [banks('shutdown'), banks('control')] as never })
  })

  test('an insertion whose parts do not read what its reading reads, or name no range, is refused', () => {
    const declaring = (insertion: InsertionDeclaration): ReadonlyMap<ComponentKind, ComponentDefinition> => {
      const registry = new Map(processPlantComponentRegistry)
      const base = registry.get('reactorCore' as ComponentKind)!
      registry.set('reactorCore' as ComponentKind, { ...base, semantics: parameters => ({ ...base.semantics(parameters), insertion }) })
      return registry
    }
    const compile = (insertion: InsertionDeclaration) => () => compilePlantGraph(plant.sourceGraph, declaring(insertion))
    expect(compile({ reading: 'rodStepsWithdrawn', insertedAt: 'min', groups: [['powerRangePercent']] })).toThrow('must be a solved reading of what rodStepsWithdrawn reads')
    expect(compile({ reading: 'rodStepsWithdrawn', insertedAt: 'min', groups: [['shutdownBankAStepsWithdrawn', 'shutdownBankAStepsWithdrawn']] })).toThrow('names each part once')
    expect(compile({ reading: 'rodStepsWithdrawn', insertedAt: 'min', groups: [[]] })).toThrow('none empty')
    expect(compile({ reading: 'rodInsertionFraction', insertedAt: 'max', groups: [['rodInsertedFraction']] })).toThrow('must be a solved reading')
  })
})
