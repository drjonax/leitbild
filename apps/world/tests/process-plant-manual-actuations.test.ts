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
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'

guardPlantTests()

// The control board's protective pushbuttons: a manual reactor trip, a manual turbine trip and manual safety
// injection. Each springs back inside the step it is pressed in, while protection evaluates only after the step,
// so a demand memory holds the press until the actuation has acted: every press is seen, and acted on once.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:manual-actuations', loopCount: 4 }))

const atPower = (tickMs: number) => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const run = (ms: number): void => {
    for (let elapsed = 0; elapsed < ms; elapsed += tickMs) {
      runtime.tick(tickMs)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-manual-actuations' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const press = (path: string): void => runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value: true })
  const read = (path: string) => runtime.readVariable(path as VariablePath)
  const fired = (ruleId: string): number => protection.snapshot().rules.find(rule => rule.ruleId === ruleId)!.firedCount
  /** Each first-out group's first trip that entered after the given time. */
  const firstOuts = (since: number): ReadonlyMap<string, string> => new Map(protection.snapshot().trips
    .filter(trip => trip.firstOut && (trip.firstActiveElapsedMs ?? -1) >= since)
    .map(trip => [trip.annunciator!.firstOutGroup!, trip.id]))
  run(10_000)
  return { runtime, run, press, read, fired, firstOuts }
}

describe('a manual protective pushbutton', () => {
  for (const tickMs of [1_000, 250]) {
    test(`acts exactly once on one press at ${tickMs} ms ticks, its first-out naming it`, () => {
      const cases = [
        { button: 'manualReactorTrip', rule: 'reactor-manual-trip', firstOut: ['reactor-trip', 'trip:reactor-manual-trip:manual-reactor-trip'] },
        { button: 'manualTurbineTrip', rule: 'turbine-manual-trip', firstOut: ['turbine-trip', 'trip:turbine-manual-trip:manual-turbine-trip'] },
        { button: 'manualSafetyInjection', rule: 'safety-injection-manual', firstOut: ['safety-injection', 'trip:safety-injection-manual:safety-injection'] },
      ] as const
      for (const { button, rule, firstOut } of cases) {
        const plantRun = atPower(tickMs)
        const pressedAt = plantRun.runtime.elapsedMs()
        plantRun.press(`${button}.pushbutton`)
        plantRun.run(tickMs)
        // The button sprang back inside the step; its demand held until protection saw it.
        expect(plantRun.read(`${button}.pushbutton`)).toBe(false)
        expect(plantRun.fired(rule)).toBe(1)
        expect(plantRun.firstOuts(pressedAt).get(firstOut[0])).toBe(firstOut[1])
        plantRun.run(30_000)
        // Once its actuation has acted the demand clears, and nothing acts again.
        expect(plantRun.read(`${button}.demanded`)).toBe(false)
        expect(plantRun.fired(rule)).toBe(1)
      }
    }, PLANT_HANG_GUARD_MS)
  }

  test('opens both reactor trip breakers and drops the rods; a further press with the breakers open demands nothing', () => {
    const plantRun = atPower(1_000)
    plantRun.press('manualReactorTrip.pushbutton')
    plantRun.run(5_000)
    expect([plantRun.read('reactorTripBreakerA.closedState'), plantRun.read('reactorTripBreakerB.closedState'), plantRun.read('core.rodsOnBottom')]).toEqual([false, false, true])
    plantRun.press('manualReactorTrip.pushbutton')
    plantRun.run(1_000)
    expect(plantRun.read('manualReactorTrip.demanded')).toBe(false)
    expect(plantRun.fired('reactor-manual-trip')).toBe(1)
  }, PLANT_HANG_GUARD_MS)

  test('the turbine-trip scenario action presses the manual turbine trip: TURB TRIP first out is manual, RX TRIP first out the reactor trip on turbine trip', () => {
    const commands = commandsForProcessPlantAction({ actionId: 'turbine-trip', parameters: {}, graph: plant.graph })
    expect(commands).toEqual([{ path: 'manualTurbineTrip.pushbutton', value: true }] as never)
    const plantRun = atPower(1_000)
    const pressedAt = plantRun.runtime.elapsedMs()
    for (const command of commands) plantRun.runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    plantRun.run(10_000)
    const firstOuts = plantRun.firstOuts(pressedAt)
    expect(firstOuts.get('turbine-trip')).toBe('trip:turbine-manual-trip:manual-turbine-trip')
    expect(firstOuts.get('reactor-trip')).toBe('trip:reactor-turbine-trip:turbine-trip-reactor-trip')
    expect([plantRun.read('turbineStopValve.positionFraction'), plantRun.read('turbine.outputBreakerClosed')]).toEqual([0, false])
  }, PLANT_HANG_GUARD_MS)

  test('is a momentary command its Plant marks and words, and its demand is acted by on/off readings of the Plant', () => {
    const presentation = (id: string) => plant.graph.components[plant.graph.componentIndexById.get(id as never)!]!.metadata?.presentation
    expect(['manualReactorTrip', 'manualTurbineTrip', 'manualSafetyInjection'].map(id => [presentation(id)?.momentary, presentation(id)?.states?.pushbutton?.on]))
      .toEqual([[['pushbutton'], 'TRIP REACTOR'], [['pushbutton'], 'TRIP TURBINE'], [['pushbutton'], 'ACTUATE SI']])
    expect([presentation('safetyInjectionBlockLogic')?.momentary, presentation('safetyInjectionBlockLogic')?.states?.blockPushbutton?.on]).toEqual([['blockPushbutton'], 'BLOCK SI'])
    for (const tagId of ['RX-TRIP-MAN', 'TURB-TRIP-MAN', 'SI-MAN']) {
      const binding = plant.graph.signalBindingByTagId.get(tagId as never)!
      expect([binding.writable, binding.actuation, binding.published]).toEqual([true, 'command', true])
      expect(plant.graph.signalBindingByTagId.get(`${tagId}-DEMAND` as never)!.writable).toBe(false)
    }
    const misdeclared = compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:manual-actuations-misdeclared',
      parameterOverrides: { manualReactorTrip: { actedWhen: [{ path: 'core.powerRangePercent', equals: false }] } },
    }))
    expect(() => createProcessPlantRuntime({ system: misdeclared })).toThrow('manual actuation manualReactorTrip is acted when core.powerRangePercent reads false, which is not an on/off reading')
  })
})
