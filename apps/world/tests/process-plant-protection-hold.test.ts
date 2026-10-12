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
import { protectionHoldRefusal, validateOperatorWrite } from '../src/packs/process-plant/operations/command-guard.ts'
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
