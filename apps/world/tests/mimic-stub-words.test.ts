import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import type { MimicStubWord } from '../src/packs/process-plant/displays/mimic/bindings.ts'
import { compileMimic } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { indexSample, type SampleIndex } from '../src/packs/process-plant/displays/mimic/evaluate.ts'
import { MIMIC_MAX_WIDTH, type CompiledMimic } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { chatMimicProfile } from '../src/packs/process-plant/displays/mimic/profiles.ts'
import { drawnLook, pipeStatesLook, rowText, stubWordText, stubWordTexts } from '../src/packs/process-plant/displays/mimic/rows.ts'
import { textWidth } from '../src/packs/process-plant/displays/mimic/text-metrics.ts'
import { formatQuantity } from '../src/packs/process-plant/displays/display-text.ts'
import { processPlantSignalQuality } from '../src/packs/process-plant/signals.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// What a power line's far end says under its name: the state of the
// equipment it names, never of the line towards it (HMI review of run 26:
// "to Bus A DEAD" and "to Bus B DEAD" on a loss of offsite power, through
// the open offsite breakers, while the diesels held both buses at 6.60 kV).
// And a valve that isolates or relieves reads OPEN or SHUT at the ends of
// its travel wherever it is drawn.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:stub-words', loopCount: 4 }))
const chat = { profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: 624 }
const drawing = (intent: Parameters<typeof compileMimic>[1]): CompiledMimic => {
  const result = compileMimic(plant, intent, chat)
  if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
  return result.mimic
}

// The Plant run on its own runtime and protection, as a Run does.
const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const run = (seconds: number): void => {
    for (let second = 0; second < seconds; second++) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-stub-words' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const act = (actionId: string): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: plant.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  // A drawing's sample, as the embed reads it.
  const sampled = (mimic: CompiledMimic): SampleIndex => indexSample(mimic.paths.map(path => {
    const variable = runtime.readVariableSnapshot(path)
    return { path, value: variable.value, quality: processPlantSignalQuality(variable).status }
  }))
  return { run, act, sampled, read: (path: string) => runtime.readVariable(path as VariablePath) }
}

const words = (mimic: CompiledMimic, index: SampleIndex): Record<string, string> =>
  Object.fromEntries(mimic.stubs.flatMap(stub => stub.word === null ? [] : [[stub.text, stubWordText(stub.word, index)]]))

describe('a power stub says the state of the equipment it names', () => {
  test('on a loss of offsite power the diesel-held safety buses read LIVE at chat width, while the lines through the open offsite breakers are dead', () => {
    // Run 26's "why did the turbine trip" drawing: the generator, its transformer and the four breakers it feeds.
    const mimic = drawing({ from: ['turbine'], to: ['offsiteBreakerA', 'offsiteBreakerB', 'unitBusBreakerA', 'unitBusBreakerB'] })
    expect(mimic.width).toBeLessThanOrEqual(MIMIC_MAX_WIDTH)
    expect(mimic.stubs.map(stub => stub.text).sort()).toEqual(['from Grid', 'to Bus A', 'to Bus B', 'to Unit Bus A', 'to Unit Bus B'])
    expect(mimic.stubs.every(stub => stub.word?.kind === 'equipment')).toBe(true)

    const plantRun = started()
    plantRun.run(60)
    expect(words(mimic, plantRun.sampled(mimic))).toEqual({ 'from Grid': 'LIVE', 'to Bus A': 'LIVE', 'to Bus B': 'LIVE', 'to Unit Bus A': 'LIVE', 'to Unit Bus B': 'LIVE' })

    plantRun.act('loss-offsite-power')
    plantRun.run(60)
    // The diesels hold both safety buses at their 6.60 kV; the grid and the unit buses are lost.
    expect(plantRun.read('safetyBusA.voltageKv')).toBeCloseTo(6.6, 1)
    expect(plantRun.read('safetyBusB.voltageKv')).toBeCloseTo(6.6, 1)
    const index = plantRun.sampled(mimic)
    expect(words(mimic, index)).toEqual({ 'from Grid': 'DEAD', 'to Bus A': 'LIVE', 'to Bus B': 'LIVE', 'to Unit Bus A': 'DEAD', 'to Unit Bus B': 'DEAD' })
    // The stub's line is still drawn as the line is: dead through the open offsite breaker.
    const busA = mimic.stubs.find(stub => stub.text === 'to Bus A')!
    expect(pipeStatesLook(busA.states, index)).toBe('dead')
    // Every word fits the room its stub keeps for its widest.
    for (const stub of mimic.stubs) {
      expect(stub.textBox).not.toBeNull()
      for (const shown of stubWordTexts(stub.word!)) expect(textWidth('tag', shown)).toBeLessThanOrEqual(stub.textBox!.width)
    }
  })

  test('a stub naming several, or equipment with no energized state of its own, says so', () => {
    const plantRun = started()
    plantRun.run(60)
    plantRun.act('loss-offsite-power')
    plantRun.run(60)
    // Around the auxiliary feedwater pump, its bus's two feeders stop the drawing as one stub naming both breakers:
    // the diesel's live, the offsite one dead, though a line of the two is live.
    const around = drawing({ around: ['auxFeedwaterPumpMotor'], reach: 1 })
    const feeders = around.stubs.find(stub => stub.states.length === 2 && stub.states.every(state => state.kind === 'power'))!
    expect(feeders.word?.kind).toBe('equipment')
    expect(stubWordText(feeders.word!, plantRun.sampled(around))).toBe('LIVE 1/2')
    expect(pipeStatesLook(feeders.states, plantRun.sampled(around))).toBe('live')
    // Around a safety bus its loads, a charging pump among them, are named on one stub: a pump declares running, not
    // energized, so the stub words the lines as supply, never as LIVE or DEAD.
    const bus = drawing({ around: ['safetyBusA'] })
    const loads = bus.stubs.find(stub => /^to .*CCW A/.test(stub.text))!
    expect(loads.word?.kind).toBe('supply')
    expect(stubWordText(loads.word!, plantRun.sampled(bus))).toBe('supplied')
    // A fluid line's stub says nothing under its name.
    const relief = drawing({ from: ['pressurizer'], to: ['pressurizerReliefTank'] })
    expect(relief.stubs.every(stub => stub.word === null)).toBe(true)
  })

  test('each word of one sample', () => {
    const at = (values: Record<string, boolean>, missing: ReadonlyArray<string> = []): SampleIndex =>
      indexSample([...Object.entries(values).map(([path, value]) => ({ path, value, quality: 'good' })), ...missing.map(path => ({ path, value: null, quality: 'bad' }))])
    const one: MimicStubWord = { kind: 'equipment', energized: ['bus.energized' as never] }
    expect(stubWordText(one, at({ 'bus.energized': true }))).toBe('LIVE')
    expect(stubWordText(one, at({ 'bus.energized': false }))).toBe('DEAD')
    expect(stubWordText(one, at({}, ['bus.energized']))).toBe('?')
    const two: MimicStubWord = { kind: 'equipment', energized: ['a.energized' as never, 'b.energized' as never] }
    expect(stubWordText(two, at({ 'a.energized': true, 'b.energized': true }))).toBe('LIVE')
    expect(stubWordText(two, at({ 'a.energized': false, 'b.energized': true }))).toBe('LIVE 1/2')
    expect(stubWordText(two, at({ 'a.energized': false, 'b.energized': false }))).toBe('DEAD')
    expect(stubWordText(two, at({ 'a.energized': true }, ['b.energized']))).toBe('?')
    const supply: MimicStubWord = { kind: 'supply', lines: ['l1.energized' as never, 'l2.energized' as never] }
    expect(stubWordText(supply, at({ 'l1.energized': false, 'l2.energized': true }))).toBe('supplied')
    expect(stubWordText(supply, at({ 'l1.energized': false, 'l2.energized': false }))).toBe('no supply')
    expect(stubWordText(supply, at({ 'l1.energized': false }, ['l2.energized']))).toBe('?')
    // A stub keeps room for each of them.
    expect(stubWordTexts(two)).toEqual(['LIVE', 'DEAD', '?', 'LIVE 1/2'])
    expect(stubWordTexts(supply)).toEqual(['supplied', 'no supply', '?'])
  })
})

describe('a valve that isolates or relieves reads OPEN or SHUT at the ends of its travel', () => {
  test('its position is bound as standing open or shut, a control valve\'s is not', () => {
    const relief = drawing({ from: ['pressurizer'], to: ['pressurizerReliefTank'] })
    const twoState = (mimic: CompiledMimic) => Object.fromEntries(mimic.items.filter(item => item.binding.state?.aspect === 'position').map(item => [item.binding.label, item.binding.state?.twoState === true]))
    expect(twoState(relief)).toEqual({ 'PORV block': true, PORV: true, 'Safety valves': true })
    const feed = drawing({ from: ['mainFeedwaterPumpB'], to: ['sgB'] })
    expect(twoState(feed)['FCV B']).toBe(false)
  })

  test('the PORV block valve on the relief path reads OPEN and SHUT at its ends, its opening only between', () => {
    const relief = drawing({ from: ['pressurizer'], to: ['pressurizerReliefTank'] })
    const block = relief.items.find(item => item.binding.label === 'PORV block')!
    const state = block.binding.state!
    const texts = (position: number, command: number) => {
      const index = indexSample([{ path: state.state!.path, value: position, quality: 'good' }, { path: state.command!, value: command, quality: 'good' }])
      return block.rows.map(row => rowText(row, drawnLook(block.binding, block.rows, index), index, formatQuantity)).filter(text => text !== '')
    }
    expect(texts(1, 1)).toEqual(['OPEN'])
    expect(texts(0, 0)).toEqual(['SHUT'])
    expect(texts(0.4, 0)[0]).toMatch(/^40(\.0)? %$/)
    // Open against a shut command: where it is first, then what it is told.
    expect(texts(1, 0)).toEqual(['OPEN', 'CMD SHUT'])
  })
})
