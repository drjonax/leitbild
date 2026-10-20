import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { compileMimic, planMimicDiagram, type MimicCompileResult } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { MIMIC_MAX_WIDTH, type CompiledMimic } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { chatMimicProfile } from '../src/packs/process-plant/displays/mimic/profiles.ts'
import { resolveMimicScope } from '../src/packs/process-plant/displays/mimic/scope.ts'
import type { MimicIntent } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The mimic an agent asks for in chat (800 x 624 on the 4-loop reference
// PWR): what it draws, and what a refusal offers instead (layout audit,
// 19 Oct: Bad 1, 2 and 4).

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:agent-path', loopCount: 4 }))
const chat = { profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: 624 }
const compiled = (intent: MimicIntent): MimicCompileResult => compileMimic(plant, intent, chat)
const drawn = (intent: MimicIntent): CompiledMimic => {
  const result = compiled(intent)
  if (!result.ok) throw new Error(`${JSON.stringify(intent)} refused: ${result.issues.map(issue => issue.message).join('; ')}`)
  return result.mimic
}
const refusal = (intent: MimicIntent): string => {
  const result = compiled(intent)
  if (result.ok) throw new Error(`${JSON.stringify(intent)} drew`)
  return result.issues.map(issue => issue.message).join(' | ')
}
const drawsEquipment = (mimic: CompiledMimic, id: string): boolean => mimic.summary.equipment.some(entry => entry.id === id)

describe('loops never narrow a drawing past what it is about', () => {
  test('loops that leave out a named item are refused, saying which loop it lies on', () => {
    expect(refusal({ around: ['sgA'], reach: 2, loops: ['B'] })).toBe('loop B leaves out sgA, which the drawing is about; it lies on loop A: name that loop too, or drop "loops"')
    expect(refusal({ from: ['rcpA'], to: ['core'], loops: ['B'] })).toContain('loop B leaves out rcpA')
    // Of alike items named in the plural, the loop's own stays.
    expect(drawsEquipment(drawn({ to: ['steam generators'], services: ['feedwater'], loops: ['A'] }), 'sgA')).toBe(true)
  })

  test('a refusal offers only narrower drawings that keep every item named', () => {
    for (const subject of ['sgA', 'sgB', 'sgC', 'sgD', 'rcpA', 'rcpB', 'rcpC', 'rcpD']) {
      const message = refusal({ around: [subject], reach: 2 })
      for (const offered of [...message.matchAll(/"loops":(\[[^\]]*\])/g)].map(match => JSON.parse(match[1]!) as string[])) {
        expect(drawsEquipment(drawn({ around: [subject], reach: 2, loops: offered }), subject)).toBe(true)
      }
    }
    expect(refusal({ around: ['sgA'], reach: 2 })).toEndWith('it fits with "reach":1')
  })
})

describe('one loop drawn alone', () => {
  test('answers to the symbol limit only: a steam generator with everything it feeds and is fed by draws in chat', () => {
    for (const subject of ['sgA', 'sgD']) {
      const mimic = drawn({ around: [subject], reach: 1 })
      expect(mimic.zones.map(zone => zone.lane)).toEqual([subject.slice(-1)])
      expect(mimic.items.filter(item => item.presentation.element !== 'bar').length).toBeGreaterThan(chatMimicProfile.layout.limits.symbolsPerPartition)
    }
  })
})

describe('a valve the model gives no loop', () => {
  test("is drawn in its steam generator's lane, read from the drawing alone", () => {
    const scope = resolveMimicScope(plant.graph, { services: ['mainSteam'] })
    if (!scope.ok) throw new Error('mainSteam has a scope')
    const planned = planMimicDiagram(plant, scope.scope, chatMimicProfile)
    if (!planned.ok) throw new Error('mainSteam is planned')
    const partitionOf = (id: string) => planned.graph.nodes.find(node => node.id === `c${plant.graph.componentIndexById.get(id as never)}`)?.partition?.key
    for (const loop of ['A', 'B', 'C', 'D']) {
      expect(plant.graph.components[plant.graph.componentIndexById.get(`mainSteamSafetyValve${loop}` as never)!]!.metadata?.loopId).toBeUndefined()
      expect(partitionOf(`mainSteamSafetyValve${loop}`)).toBe(loop)
    }
    // A valve between a loop and shared equipment stays shared: the drive steam to the turbine-driven AFW pump.
    expect(partitionOf('auxFeedwaterTurbineSteamValveB')).toBeUndefined()
  })
})

describe('around an item', () => {
  test('draws its process, and where its power joins as a stop; power itself only where services name it', () => {
    const pump = drawn({ around: ['rcpA'], reach: 1 })
    expect(pump.summary.carriers).toEqual(['primaryCoolant'])
    expect(drawsEquipment(pump, 'unitBusA')).toBe(false)
    expect(pump.summary.stops).toContain('RCP A from Unit Bus A')
    const roomy = compileMimic(plant, { around: ['rcpA'], reach: 1, services: ['primaryCoolant', 'electricalPower'] }, { ...chat, maxHeight: 2000, maxWidth: 2000 })
    if (!roomy.ok) throw new Error('drawn with its power where there is room')
    expect(drawsEquipment(roomy.mimic, 'unitBusA')).toBe(true)
  })

  test('draws power for equipment that carries nothing else', () => {
    expect(drawn({ around: ['dieselGeneratorA'], reach: 1 }).summary.carriers).toEqual(['electricalPower'])
  })
})
