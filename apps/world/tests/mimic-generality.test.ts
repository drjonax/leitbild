import { describe, expect, test } from 'bun:test'
import {
  compilePlantGraph,
  compileProcessPlant,
  createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
  type CompiledProcessPlant,
  type PlantGraphSpec,
} from '../src/packs/process-plant/index.ts'
import { compileMimic } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { MIMIC_MAX_WIDTH, type CompiledMimic } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { chatMimicProfile } from '../src/packs/process-plant/displays/mimic/profiles.ts'
import type { MimicIntent } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'

// Nothing in a mimic may depend on what the reference PWR happens to call its
// equipment: the same Plant with every component id replaced by an opaque one
// draws the same mimic, symbol for symbol.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:named', loopCount: 4 }))
const opaque = new Map(plant.sourceGraph.components.map((component, index) => [String(component.id), `u${index}`]))

// A component id appears as an id, an equipment id, or the owner of a variable path ("sgB.levelPercent").
const renamedString = (value: string): string => {
  const exact = opaque.get(value)
  if (exact !== undefined) return exact
  const dot = value.indexOf('.')
  const owner = dot > 0 ? opaque.get(value.slice(0, dot)) : undefined
  return owner === undefined ? value : `${owner}${value.slice(dot)}`
}
// Kinds, equipment classes and annunciator groups are vocabulary, not references.
const VOCABULARY = new Set(['kind', 'equipmentClass', 'group', 'system'])
const renamed = <T,>(value: T, key = ''): T => {
  if (typeof value === 'string') return (VOCABULARY.has(key) ? value : renamedString(value)) as T
  if (Array.isArray(value)) return value.map(item => renamed(item)) as T
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, renamed(item, field)])) as T
  return value
}

const anonymous: CompiledProcessPlant = {
  ...plant,
  graph: compilePlantGraph(renamed(plant.sourceGraph) as PlantGraphSpec, processPlantComponentRegistry),
  automation: renamed(plant.automation),
}

const budget = { profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: 624 }
const drawn = (system: CompiledProcessPlant, intent: MimicIntent): CompiledMimic => {
  const result = compileMimic(system, intent, budget)
  if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
  return result.mimic
}
const geometry = (mimic: CompiledMimic) => ({
  size: [mimic.width, mimic.height],
  items: mimic.items.map(item => [item.binding.label, item.presentation, item.box, item.rows.map(row => row.kind), item.binding.frames.map(frame => frame.ruleId)]),
  pipes: mimic.pipes.map(pipe => [pipe.carrier, pipe.points, pipe.state.kind]),
  stubs: mimic.stubs.map(stub => [stub.text, stub.end]),
})

const intents: ReadonlyArray<MimicIntent> = [
  { from: ['dieselGeneratorA'], to: ['auxFeedwaterPumpMotor'] },
  { to: ['safetyBusA'] },
  { services: ['safetyInjection'], loops: ['C'] },
  { from: ['letdownValve'], services: ['letdown', 'charging'] },
  { from: ['pressurizer'], to: ['pressurizerReliefTank'] },
  { services: ['primaryCoolant'] },
  { to: ['sgB'], services: ['feedwater', 'auxFeedwater'] },
  { services: ['auxFeedwater'] },
]
const withOpaqueIds = (intent: MimicIntent): MimicIntent => ({
  ...intent,
  ...(intent.from === undefined ? {} : { from: intent.from.map(renamedString) }),
  ...(intent.to === undefined ? {} : { to: intent.to.map(renamedString) }),
})

describe('a mimic depends on the Plant graph, not on equipment ids', () => {
  test('the renamed Plant has no reference PWR id left', () => {
    expect(anonymous.graph.components.every(component => /^u\d+$/.test(String(component.id)))).toBe(true)
  })

  for (const intent of intents) {
    test(`draws ${JSON.stringify(intent)} identically under opaque ids`, () => {
      const named = drawn(plant, intent)
      const unnamed = drawn(anonymous, withOpaqueIds(intent))
      expect(geometry(unnamed)).toEqual(geometry(named))
      expect(unnamed.hash).toBe(named.hash)
    })
  }
})
