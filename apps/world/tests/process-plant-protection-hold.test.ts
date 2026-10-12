import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type ProcessPlantIcSnapshot,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { opposesActuation, protectionHoldRefusal, throttledUnder, validateOperatorWrite } from '../src/packs/process-plant/operations/command-guard.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A protection actuation writes its effects once, on entering. While it
// stands active or sealed in, a person's or an AI agent's command against
// what it wrote is refused, naming it (plan-final QA-2); once it is reset the
// equipment is the operators' again. The Run itself is not held.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:protection-hold', loopCount: 4 }))
const path = (tagId: string) => resolveProcessPlantSignalBinding(plant.graph, { tagId: tagId as never }).path

const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const step = () => {
    runtime.tick(1_000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-protection-hold' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
  }
  return { runtime, protection, step }
}

/** The I&C snapshot with one rule standing as given. */
const standing = (snapshot: ProcessPlantIcSnapshot, ruleId: string, state: { readonly active: boolean; readonly latched: boolean }): ProcessPlantIcSnapshot => {
  expect(snapshot.rules.some(rule => rule.ruleId === ruleId)).toBe(true)
  return { ...snapshot, rules: snapshot.rules.map(rule => rule.ruleId === ruleId ? { ...rule, ...state } : rule) }
}

describe('a command against a standing protection actuation', () => {
  const atPower = started()
  for (let second = 0; second < 3; second += 1) atPower.step()
  const snapshot = atPower.protection.snapshot()

  test('nothing stands at power: every command is the operators\'', () => {
    for (const [tagId, value] of [['SI-PUMP-A', false], ['MSIV-A', 0], ['TRIP-BKR-A', true]] as const) {
      expect(protectionHoldRefusal(plant, snapshot, { path: path(tagId), value })).toBeNull()
    }
  })

  test('a sealed-in SI signal holds its pumps running: STOP is refused naming it, START is not', () => {
    const sealedIn = standing(snapshot, 'safety-injection-low-pzr-pressure', { active: false, latched: true })
    expect(protectionHoldRefusal(plant, sealedIn, { path: path('SI-PUMP-A'), value: false }))
      .toBe('Safety injection on low pressurizer pressure (SI) stands sealed in and holds SI-PUMP-A: a command against it is refused until it is reset')
    expect(protectionHoldRefusal(plant, sealedIn, { path: path('SI-PUMP-A'), value: true })).toBeNull()
    // Reset, it holds nothing.
    expect(protectionHoldRefusal(plant, standing(snapshot, 'safety-injection-low-pzr-pressure', { active: false, latched: false }), { path: path('SI-PUMP-A'), value: false })).toBeNull()
  })

  test('steam line isolation holds the MSIVs shut, and a reactor trip its breakers open', () => {
    const isolated = standing(snapshot, 'containment-pressure-high-2-steam-line-isolation', { active: true, latched: true })
    expect(protectionHoldRefusal(plant, isolated, { path: path('MSIV-A'), value: 1 })).toContain('stands active and holds MSIV-A')
    expect(protectionHoldRefusal(plant, isolated, { path: path('MSIV-A'), value: 0 })).toBeNull()
    const tripped = standing(snapshot, 'reactor-manual-trip', { active: false, latched: true })
    expect(protectionHoldRefusal(plant, tripped, { path: path('TRIP-BKR-A'), value: true })).toContain('holds TRIP-BKR-A')
    expect(protectionHoldRefusal(plant, tripped, { path: path('TRIP-BKR-A'), value: false })).toBeNull()
  })

  test('feedwater isolation shuts a feed regulating valve through its isolation input: a demand to open it is refused', () => {
    const isolated = standing(snapshot, 'sg-a-level-high-high-feedwater-isolation', { active: false, latched: true })
    expect(protectionHoldRefusal(plant, isolated, { path: path('MFW-A-CV'), value: 0.5 })).toContain('holds MFW-A-CV')
    expect(protectionHoldRefusal(plant, isolated, { path: path('MFW-A-CV'), value: 0 })).toBeNull()
  })
})

describe('after a real safety injection', () => {
  test('a person\'s and an agent\'s pump stop is refused while SI stands; the Run\'s own write is not held', () => {
    const plantRun = started()
    plantRun.runtime.writeCommand({ type: 'setVariable', path: path('PZR-HTR'), value: 0 })
    let seconds = 0
    while (!plantRun.protection.snapshot().rules.find(rule => rule.ruleId === 'safety-injection-low-pzr-pressure')!.latched && seconds < 600) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: path('PORV-456A'), value: 1 })
      plantRun.step()
      seconds += 1
    }
    expect(seconds).toBeLessThan(600)
    const stop = { plantId: plant.id, tagId: 'SI-PUMP-A', value: false } as never
    for (const origin of ['person', 'ai', undefined] as const) {
      const validation = validateOperatorWrite({ system: plant, runtime: plantRun.runtime, protection: plantRun.protection, payload: stop, origin })
      expect(validation.accepted).toBe(false)
      if (!validation.accepted) expect(validation.reason).toMatch(/^Safety injection on low pressurizer pressure \(SI\) stands (active|sealed in) and holds SI-PUMP-A/)
    }
    expect(validateOperatorWrite({ system: plant, runtime: plantRun.runtime, protection: plantRun.protection, payload: stop, origin: 'system' }).accepted).toBe(true)
  })
})

// Where an actuation drove a demand a person sets in its span (a modulating
// valve's position) to one end, only the other end works against it: a
// setting between is a throttle under it, as AFW flow is controlled after AFW
// opened its valves. The actuation writes once, on its edge, so the throttle
// holds.
describe('a throttle under an actuation that drove a demand to an end of its span', () => {
  test('only the other end opposes it; a command without a span, or a demand set between, keeps the rule', () => {
    const span = { min: 0, max: 1 }
    expect([0, 0.4, 1].map(value => opposesActuation(span, 1, value))).toEqual([true, false, false])
    expect([0, 0.4, 1].map(value => opposesActuation(span, 0, value))).toEqual([false, false, true])
    expect([0.4, 0.5].map(value => opposesActuation(span, 0.5, value))).toEqual([true, false])
    expect(opposesActuation(null, 1, 0.4)).toBe(true)
    expect(opposesActuation(null, true, false)).toBe(true)
  })

  test('an MSIV, two-state, refuses a setting between as it refuses OPEN', () => {
    const snapshot = started().protection.snapshot()
    const isolated = standing(snapshot, 'containment-pressure-high-2-steam-line-isolation', { active: true, latched: true })
    expect(protectionHoldRefusal(plant, isolated, { path: path('MSIV-A'), value: 0.5 })).toContain('stands active and holds MSIV-A')
    expect(throttledUnder(plant, isolated, { path: path('MSIV-A'), value: 0.5 })).toEqual([])
  })

  test('after a reactor trip on the four-loop plant, AFW-A-CV takes 0.4 under the AFW actuation, refuses 0, and holds 0.4', () => {
    const plantRun = started()
    for (let second = 0; second < 3; second += 1) plantRun.step()
    plantRun.runtime.writeCommand({ type: 'setVariable', path: path('RX-TRIP-MAN'), value: true })
    const afw = { path: path('AFW-A-CV'), value: 0.4 }
    let seconds = 0
    while (throttledUnder(plant, plantRun.protection.snapshot(), afw).length === 0 && seconds < 300) {
      plantRun.step()
      seconds += 1
    }
    expect(seconds).toBeLessThan(300)
    // Let every steam generator's low-low level actuation enter: each writes the valve open once, on its edge.
    for (let second = 0; second < 60; second += 1) plantRun.step()
    const under = throttledUnder(plant, plantRun.protection.snapshot(), afw)
    const rules = new Map(plant.automation.rules.map(rule => [rule.id, rule]))
    expect(under.length).toBeGreaterThan(0)
    for (const rule of under) expect(rule).toEqual({ ruleId: rule.ruleId, label: rules.get(rule.ruleId)!.label!, action: 'AFW START' })
    const validate = (value: number) => validateOperatorWrite({ system: plant, runtime: plantRun.runtime, protection: plantRun.protection, payload: { plantId: plant.id, tagId: 'AFW-A-CV', value } as never, origin: 'person' })
    expect(validate(0.4).accepted).toBe(true)
    const shut = validate(0)
    expect(shut.accepted).toBe(false)
    if (!shut.accepted) expect(shut.reason).toBe(`${under[0]!.label} (AFW START) stands ${plantRun.protection.snapshot().rules.find(rule => rule.ruleId === under[0]!.ruleId)!.active ? 'active' : 'sealed in'} and holds AFW-A-CV: a command against it is refused until it is reset`)
    expect(validate(1).accepted).toBe(true)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: afw.path, value: 0.4 })
    const position = plant.graph.components.flatMap(component => component.semantics.aspects).find(aspect => aspect.command === afw.path)!.state!.path
    for (let second = 0; second < 12; second += 1) {
      plantRun.step()
      expect(plantRun.runtime.readVariable(afw.path)).toBe(0.4)
      expect(Math.abs(Number(plantRun.runtime.readVariable(position)) - 0.4)).toBeLessThanOrEqual(0.01)
    }
  })
})
