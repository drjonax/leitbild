import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  evaluateProcessPlantIcCondition,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { actuationResets, resetRefusal, type ResetContext } from '../src/packs/process-plant/operations/actuation-reset.ts'
import { validateOperatorWrite } from '../src/packs/process-plant/operations/command-guard.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A person resets a latched protection actuation once its initiating
// condition no longer holds and the time its rule declares since it acted
// has passed (C2b R1). The reset clears the latch only: the equipment stays
// as the actuation left it, and the QA-2 hold on what it wrote lifts.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:actuation-reset', loopCount: 4 }))
const path = (tagId: string) => resolveProcessPlantSignalBinding(plant.graph, { tagId: tagId as never }).path

const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const step = (seconds = 1) => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-actuation-reset' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const context = (): ResetContext => ({
    holds: condition => evaluateProcessPlantIcCondition({ system: plant, runtime, condition }).matches,
    elapsedMs: runtime.elapsedMs(),
  })
  const resets = () => actuationResets(plant, protection.snapshot(), context())
  const reset = (ruleId: string) => protection.resetActuation({ ruleId, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-actuation-reset' as SimulationRunId, sourceRuntimeId: 'process-plant.local', actorId: 'actor:human:op' })
  const validate = (tagId: string, value: boolean | number) => validateOperatorWrite({ system: plant, runtime, protection, payload: { plantId: plant.id, tagId, value } as never, origin: 'person' })
  return { runtime, protection, step, context, resets, reset, validate }
}

describe('the RESET of a latched actuation', () => {
  test('nothing stands at power, so nothing is listed', () => {
    const run = started()
    run.step(3)
    expect(run.resets()).toEqual([])
  })

  test('after a manual reactor trip its latch is offered for reset; an actuation whose condition is still present says so', () => {
    const run = started()
    run.step(3)
    run.runtime.writeCommand({ type: 'setVariable', path: path('RX-TRIP-MAN'), value: true })
    run.step(60)
    const resets = run.resets()
    const manual = resets.find(reset => reset.ruleId === 'reactor-manual-trip')!
    expect(manual).toMatchObject({ label: 'Manual reactor trip', word: 'RESET Manual reactor trip', offered: true })
    expect(manual.reason).toBeUndefined()
    // The pushbutton's demand cleared as the breakers opened: its condition no longer holds.
    expect(manual.holds).toContain(path('TRIP-BKR-A'))
    const lowLow = resets.find(reset => reset.ruleId === 'sg-a-level-low-low-afw-actuation')!
    expect(lowLow).toMatchObject({ offered: false, reason: 'condition still present: SG-A-LVL-NR < 20 %' })
    expect(resetRefusal(plant, run.protection.snapshot(), lowLow.ruleId, run.context())).toBe('RESET Steam generator A low-low level auxiliary feedwater actuation is not offered: condition still present: SG-A-LVL-NR < 20 %')
    expect(resetRefusal(plant, run.protection.snapshot(), 'no-such-rule', run.context())).toBe('no-such-rule is no I&C rule of this Plant')
  })

  test('a reset clears the latch only: the breakers stay open, the rods in, and the hold on them lifts', () => {
    const run = started()
    run.step(3)
    run.runtime.writeCommand({ type: 'setVariable', path: path('RX-TRIP-MAN'), value: true })
    run.step(60)
    const before = run.validate('TRIP-BKR-A', true)
    expect(before.accepted).toBe(false)
    if (!before.accepted) expect(before.reason).toContain('Manual reactor trip (RX TRIP) stands sealed in and holds TRIP-BKR-A: a command against it is refused until it is reset; RESET Manual reactor trip is offered')
    const breaker = run.runtime.readVariable(path('TRIP-BKR-A'))
    const rods = run.runtime.readVariable(path('ROD-POS-AVG'))
    run.reset('reactor-manual-trip')
    expect(run.runtime.readVariable(path('TRIP-BKR-A'))).toBe(breaker)
    expect(run.runtime.readVariable(path('ROD-POS-AVG'))).toBe(rods)
    expect(run.protection.snapshot().rules.find(rule => rule.ruleId === 'reactor-manual-trip')).toMatchObject({ active: false, latched: false })
    expect(run.resets().some(reset => reset.ruleId === 'reactor-manual-trip')).toBe(false)
    const after = run.validate('TRIP-BKR-A', true)
    if (!after.accepted) expect(after.reason).not.toContain('Manual reactor trip')
    // It stays reset while nothing presses the pushbutton again.
    run.step(5)
    expect(run.protection.snapshot().rules.find(rule => rule.ruleId === 'reactor-manual-trip')!.latched).toBe(false)
  })

  test('safety injection is reset no sooner than the minute its rule declares, and then its pumps are the operators\' again', () => {
    const run = started()
    run.step(3)
    run.runtime.writeCommand({ type: 'setVariable', path: path('SI-MAN'), value: true })
    run.step(10)
    const early = run.resets().find(reset => reset.ruleId === 'safety-injection-manual')!
    expect(early.offered).toBe(false)
    expect(early.reason).toMatch(/^it may be reset 60 s after it acted: \d+ s to go$/)
    const stop = run.validate('SI-PUMP-A', false)
    expect(stop.accepted).toBe(false)
    if (!stop.accepted) expect(stop.reason).toContain(`; it cannot be reset yet: ${early.reason}`)
    run.step(60)
    expect(run.resets().find(reset => reset.ruleId === 'safety-injection-manual')).toMatchObject({ offered: true, word: 'RESET Manual safety injection' })
    run.reset('safety-injection-manual')
    // The pumps keep running: the reset writes nothing. Stopping one is the operators' again.
    expect(run.runtime.readVariable(path('SI-PUMP-A'))).toBe(true)
    expect(run.validate('SI-PUMP-A', false).accepted).toBe(true)
  })

  test('only a latched protection actuation declares a reset time', () => {
    const declared = plant.automation.rules.filter(rule => rule.resetAfterMs !== undefined)
    expect(declared.map(rule => rule.id).sort()).toEqual(['safety-injection-containment-pressure-high-1', 'safety-injection-low-pzr-pressure', 'safety-injection-manual'])
    for (const rule of declared) expect(rule).toMatchObject({ ruleClass: 'protection', latch: true, resetAfterMs: 60_000 })
  })
})
