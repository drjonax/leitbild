import { describe, expect, test } from 'bun:test'
import {
  compileProcessPlant,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { derivePlantControls, followAllowanceMs, type OfferedControl } from '../src/packs/process-plant/operations/controls.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A control's travel time is what its kind declares beside its behaviour
// (StateAspectDeclaration.travel), and the equipment does follow within it:
// the display reads a command as not followed only after the travel time
// and a quarter more, at least 2 s more (plan-final I-2). Where the model
// declares no time the state is awaited, never judged.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:travel', loopCount: 4 }))
const controls = derivePlantControls(plant, { notOffered: () => undefined })
const control = (tagId: string): OfferedControl => {
  const path = resolveProcessPlantSignalBinding(plant.graph, { tagId: tagId as never }).path
  return controls.items.flatMap(entry => entry.offered).find(candidate => candidate.path === path)!
}
const option = (tagId: string, word: string) => control(tagId).options.find(candidate => candidate.word === word)!

/** Commands an option and reads its state at the given plant times after it, from a Plant at power. */
const statesAfter = (tagId: string, word: string, atMs: ReadonlyArray<number>): ReadonlyArray<unknown> => {
  const runtime = createProcessPlantRuntime({ system: plant })
  runtime.tick(1_000)
  const commanded = control(tagId)
  runtime.writeCommand({ type: 'setVariable', path: commanded.path, value: option(tagId, word).value })
  let elapsed = 0
  return atMs.map(target => {
    while (elapsed < target) {
      runtime.tick(100)
      elapsed += 100
    }
    return runtime.readVariable(commanded.state as VariablePath)
  })
}

describe('travel times declared beside the behaviour', () => {
  test('the margin is a quarter of the travel, at least 2 s', () => {
    expect(followAllowanceMs(0)).toBe(2_000)
    expect(followAllowanceMs(10_000)).toBe(12_500)
  })

  test('the PORV block valve strokes shut across its stroke time', () => {
    expect(option('MOV-8000A', 'SHUT').travelMs).toBe(10_000)
    const [half, done] = statesAfter('MOV-8000A', 'SHUT', [5_000, followAllowanceMs(10_000)]) as [number, number]
    expect(half).toBeGreaterThan(0.4)
    expect(done).toBeLessThanOrEqual(0.05)
  })

  test('an isolation valve with a stroke time constant comes within 5 % of its demand in its travel time', () => {
    // Toward the end it does not stand at.
    const atPower = createProcessPlantRuntime({ system: plant })
    atPower.tick(1_000)
    const opening = option('RHR-ISOL', Number(atPower.readVariable(control('RHR-ISOL').state as VariablePath)) < 0.5 ? 'OPEN' : 'SHUT')
    const target = Number(opening.value)
    const [early, late] = statesAfter('RHR-ISOL', opening.word, [opening.travelMs! / 3, opening.travelMs!]) as [number, number]
    expect(Math.abs(early - target)).toBeGreaterThan(0.2)
    expect(Math.abs(late - target)).toBeLessThanOrEqual(0.05)
  })

  test('a diesel runs once its start time has passed, and a pump at once', () => {
    expect(option('EDG-A-START', 'START').travelMs).toBe(10_000)
    expect(statesAfter('EDG-A-START', 'START', [8_000, followAllowanceMs(10_000)])).toEqual([false, true])
    expect(option('CHG-PUMP-B', 'START').travelMs).toBe(0)
    expect(statesAfter('CHG-PUMP-B', 'START', [followAllowanceMs(0)])).toEqual([true])
  })

  test('no declared time where the model solves no state, or a pushbutton has none', () => {
    expect(option('ACCUM-1', 'SHUT').travelMs).toBeNull()
    expect(option('RX-TRIP-MAN', 'TRIP REACTOR').travelMs).toBeNull()
  })
})
