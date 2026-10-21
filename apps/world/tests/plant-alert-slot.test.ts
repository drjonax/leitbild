import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { alertStateSchema, type AlertState } from '../src/core/model/index.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { isStanding, priorityOrder, standingAfterMs } from '../src/packs/process-plant/ic/alarm-philosophy.ts'
import { safetyFunctionAlerts } from '../src/packs/process-plant/projection.ts'
import type { SafetyFunctionEvaluation } from '../src/packs/process-plant/safety-functions.ts'
import { processPlantIcLifecycleStateSchema } from '../src/packs/process-plant/runtime/index.ts'
import { processPlantRuntimeStateSchema } from '../src/packs/process-plant/sim/runtime-state.ts'
import { guardPlantTests } from './plant-hang-guard.ts'
import { createSteadyPlantRun, plantOperator, plantScenario, type SteadyPlantRun } from './steady-plant-run.ts'

guardPlantTests()

// P4: the Plant's alarms and trips in the core alert slot (plan v3.1 §2.2,
// A2; R11, R21, R27; T14, T36). One Run: the offsite voltage degraded to
// 0.85 raises one warning that stands once acknowledged; then offsite power
// is lost, the unit trips, and offsite power returns. Then (Q7) the
// critical safety functions a challenge raises an alert for: a loss of main
// feedwater takes a steam generator's level below span.

let plant: SteadyPlantRun
const facts: Record<string, any> = {}
const MINUTE = 60_000
const degraded = 'alarm:offsite-grid-degraded-voltage:offsite-grid-degraded-voltage'
const find = (alerts: ReadonlyArray<AlertState>, id: string) => alerts.find(alert => alert.id === id)
const reference = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:standing', loopCount: 4 }))

beforeAll(async () => {
  plant = await createSteadyPlantRun()
  await plant.runTo(10_000)
  facts.steady = plant.unit().alerts
  await plant.invoke(plantScenario, 'world.process-plant.control.write', { path: 'offsiteGrid.voltageFraction', value: 0.85 })
  await plant.runTo(30_000)
  facts.raised = plant.unit().alerts
  await plant.invoke(plantOperator, 'world.process-plant.ic.lifecycle', { lifecycleId: degraded, action: 'acknowledge' })
  await plant.runTo(60_000)
  facts.acknowledged = plant.unit().alerts
  await plant.runTo(11 * MINUTE + 30_000)
  facts.standing = plant.unit().alerts
  // A hundred steps of a third of a second, off the Plant's step: the slot holds while the state does.
  const seen = new Set<string>()
  for (let step = 1; step <= 100; step += 1) {
    await plant.runTo(11 * MINUTE + 30_000 + step * 333)
    seen.add(JSON.stringify(plant.unit().alerts))
  }
  facts.distinctOverSteps = seen.size
  await plant.invoke(plantOperator, 'world.process-plant.action.invoke', { actionId: 'loss-offsite-power', parameters: {} })
  await plant.runTo(13 * MINUTE)
  facts.tripped = plant.unit().alerts
  await plant.invoke(plantScenario, 'world.process-plant.control.write', { path: 'offsiteGrid.voltageFraction', value: 1 })
  await plant.invoke(plantOperator, 'world.process-plant.action.invoke', { actionId: 'restore-offsite-power', parameters: {} })
  await plant.runTo(14 * MINUTE)
  facts.restored = plant.unit().alerts
  await plant.shutdown()
  const runtimes = (await readdir(join(plant.dataDir), { recursive: true })).filter(file => String(file).endsWith('process-plant.local.json'))
  facts.runtimeState = await Bun.file(join(plant.dataDir, String(runtimes[0]))).json()
})

afterAll(async () => { await plant.remove() })

describe('plant alerts in the core slot (P4)', () => {
  test('a steady unit has none; a degraded offsite voltage raises one warning with its facets', () => {
    expect(facts.steady).toEqual([])
    expect(facts.raised).toEqual([{
      id: degraded,
      kind: 'alarm',
      severity: 'warning',
      message: 'Offsite grid degraded voltage',
      raisedAt: '2026-01-01T10:00:11.000Z',
      acknowledged: false,
      subject: { element: 'offsiteGrid' },
      observable: `${plant.plantId}#offsiteGrid.supplyVoltageFraction`,
      threshold: 'offsite-grid-degraded-voltage',
      priority: 'warning',
      clock: 'simulation',
    }])
  })

  test('R11: an acknowledged alert says who acknowledged it; it is not standing until the I&C\'s own window has passed', () => {
    expect(find(facts.acknowledged, degraded)).toMatchObject({ acknowledged: true, acknowledgedBy: 'person', raisedAt: '2026-01-01T10:00:11.000Z' })
    expect(find(facts.acknowledged, degraded)!.standing).toBeUndefined()
  })

  test('standing time is the Plant\'s own: its longest expected-consequence window or confirming delay (Q7)', () => {
    expect(standingAfterMs(reference)).toBe(5 * MINUTE)
    const withinMs = reference.automation.rules.flatMap(rule => rule.effects.flatMap(effect => effect.type === 'writeSignal' ? [] : [effect.annunciator?.expectedAfter?.withinMs ?? 0]))
    expect(Math.max(...withinMs)).toBe(5 * MINUTE)
    const shorter = { ...reference, automation: { ...reference.automation, rules: reference.automation.rules.map(rule => ({ ...rule, effects: rule.effects.map(effect => effect.type === 'writeSignal' || effect.annunciator?.expectedAfter === undefined ? effect : { ...effect, annunciator: { ...effect.annunciator, expectedAfter: { ...effect.annunciator.expectedAfter, withinMs: 30_000 } } }) })) } }
    expect(standingAfterMs(shorter)).toBe(Math.max(30_000, ...reference.automation.rules.flatMap(rule => (rule.delayMs < MINUTE ? [rule.delayMs] : []))))
  })

  test('T14: acknowledged, unchanged and with nothing pending, it stands; a worse entry on the same equipment reverts it', () => {
    expect(find(facts.standing, degraded)).toMatchObject({ acknowledged: true, standing: true })
    expect(find(facts.tripped, degraded)?.standing).toBeUndefined()
    expect(find(facts.tripped, 'alarm:loss-of-offsite-power:loss-of-offsite-power')).toMatchObject({ subject: { element: 'offsiteGrid' }, acknowledged: false })
  })

  test('T14: a consequence pending on what it watches refuses standing (a named delay running down)', () => {
    const lifecycle = processPlantIcLifecycleStateSchema.parse({
      id: degraded, ruleId: 'offsite-grid-degraded-voltage', effectId: 'offsite-grid-degraded-voltage', kind: 'alarm', title: 'Offsite grid degraded voltage',
      message: 'm', severity: 'warning', annunciator: { equipmentId: 'offsiteGrid', priority: 'high' }, active: true, acknowledged: true, latched: false,
      suppressed: false, resettable: false, transitionCount: 2, lastActiveElapsedMs: 0, lastAcknowledgedElapsedMs: 1_000,
    })
    const context = { all: [lifecycle], elapsedMs: 11 * MINUTE, priority: 'warning' as const }
    const watching = reference.automation.rules.find(rule => rule.id === 'loss-of-offsite-power')!
    expect(isStanding(reference, lifecycle, { ...context, pending: [] })).toBe(true)
    expect(isStanding(reference, lifecycle, { ...context, elapsedMs: 4 * MINUTE, pending: [] })).toBe(false)
    expect(isStanding(reference, lifecycle, { ...context, pending: [{ rule: watching, leftMs: 60_000 }] })).toBe(false)
    expect(isStanding(reference, { ...lifecycle, kind: 'trip' }, { ...context, pending: [] })).toBe(false)
    expect(isStanding(reference, { ...lifecycle, firstOut: true }, { ...context, pending: [] })).toBe(false)
    expect(isStanding(reference, lifecycle, { ...context, pending: [], priority: 'emergency' })).toBe(false)
  })

  test('the slot holds while the state does: one alert JSON over a hundred steps off the Plant\'s step (A3)', () => {
    expect(facts.distinctOverSteps).toBe(1)
  })

  test('the trip: priority agrees with severity, trips are latched, the first-out carries its group id and rank (R21)', () => {
    const tripped: ReadonlyArray<AlertState> = facts.tripped
    for (const alert of tripped) expect(alertStateSchema.parse(alert)).toEqual(alert)
    expect(tripped.filter(alert => alert.kind === 'trip').every(alert => alert.latched === true && alert.priority === 'alarm' && alert.severity === 'critical')).toBe(true)
    const firstOuts = tripped.filter(alert => alert.firstOut !== undefined)
    expect(firstOuts.length).toBeGreaterThan(0)
    expect(firstOuts.find(alert => alert.firstOut!.group === 'reactor-trip')?.firstOut).toEqual({ group: 'reactor-trip', rank: 1 })
    expect(tripped.every(alert => alert.clock === 'simulation' && Date.parse(alert.raisedAt) <= Date.parse('2026-01-01T10:13:00.000Z'))).toBe(true)
    expect(tripped.filter(alert => alert.subject !== undefined && !('element' in alert.subject))).toEqual([])
  })

  test('returned to normal still unacknowledged stays in the slot, marked returned', () => {
    const returned = (facts.restored as ReadonlyArray<AlertState>).filter(alert => alert.returned === true)
    expect(returned.length).toBeGreaterThan(0)
    expect(returned.every(alert => !alert.acknowledged)).toBe(true)
  })

  test('T36: priorities per pack, and no undeclared standing alarm at warning or above at steady state', () => {
    const distribution = (alerts: ReadonlyArray<AlertState>) => Object.fromEntries(['notice', 'caution', 'warning', 'alarm'].map(priority => [priority, alerts.filter(alert => alert.priority === priority).length]))
    expect(distribution(facts.standing)).toEqual({ notice: 0, caution: 0, warning: 1, alarm: 0 })
    const undeclared = (facts.standing as ReadonlyArray<AlertState>).filter(alert => priorityOrder[alert.priority!] >= priorityOrder.warning && alert.returned !== true
      && Date.parse('2026-01-01T10:11:30.000Z') - Date.parse(alert.raisedAt) >= standingAfterMs(reference) && alert.standing !== true)
    expect(undeclared).toEqual([])
    console.log('T36 priority distribution after the trip:', JSON.stringify(distribution(facts.tripped)))
  })

  test('plant runtime state v1 is unchanged: the slot is projected, not stored there', () => {
    expect(facts.runtimeState.state.schemaVersion).toBe(1)
    expect(processPlantRuntimeStateSchema.parse(facts.runtimeState.state)).toBeDefined()
    expect(JSON.stringify(facts.runtimeState)).not.toContain('"raisedAt"')
  })
})

describe('critical safety function challenges in the slot (Q7)', () => {
  const evaluation = (status: SafetyFunctionEvaluation['status'], answers: ReadonlyArray<'yes' | 'no'>, procedure?: string): SafetyFunctionEvaluation => ({
    id: 'heat-sink', label: 'Heat sink', shortLabel: 'HEAT SINK', basis: 'ERG F-0.3', status, ...(procedure === undefined ? {} : { procedure }), meaning: `The tree ends ${status}.`,
    path: answers.map((answer, index) => ({ question: `Question ${index + 1}`, basis: 'ERG', answer, comparisons: [] })), checks: [], expected: [], missingSignals: [],
  })
  const at = '2026-01-01T10:00:30.000Z' as AlertState['raisedAt']
  const later = '2026-01-01T10:05:00.000Z' as AlertState['raisedAt']

  test('each colour path is one alert: yellow a caution, orange a warning, red an alarm, severity agreeing; satisfied, unjudged or unknown none', () => {
    const alerts = safetyFunctionAlerts('plant:u1', [evaluation('yellow', ['yes', 'no'], 'FR-H.5'), { ...evaluation('orange', ['no', 'yes'], 'FR-H.2'), id: 'containment', label: 'Containment' }, { ...evaluation('red', ['no', 'no'], 'FR-H.1'), id: 'core-cooling', label: 'Core cooling' }], [], at)
    for (const alert of alerts) expect(alertStateSchema.parse(alert)).toEqual(alert)
    expect(alerts.map(alert => [alert.id, alert.priority, alert.severity, alert.message, alert.observable])).toEqual([
      ['csf:heat-sink:yn', 'caution', 'warning', 'Heat sink (FR-H.5): The tree ends yellow.', 'plant:u1#csf.heat-sink'],
      ['csf:containment:ny', 'warning', 'warning', 'Containment (FR-H.2): The tree ends orange.', 'plant:u1#csf.containment'],
      ['csf:core-cooling:nn', 'alarm', 'critical', 'Core cooling (FR-H.1): The tree ends red.', 'plant:u1#csf.core-cooling'],
    ])
    expect(alerts.every(alert => alert.kind === 'safety-function' && !alert.acknowledged && alert.raisedAt === at && alert.clock === 'simulation' && alert.threshold === undefined)).toBe(true)
    expect(safetyFunctionAlerts('plant:u1', [evaluation('green', ['yes']), evaluation('unknown', ['yes']), evaluation('not-monitored', [])], [], at)).toEqual([])
  })

  test('an alert keeps the time it came in while its path holds; another path is another occurrence', () => {
    const first = safetyFunctionAlerts('plant:u1', [evaluation('yellow', ['yes', 'no'], 'FR-H.5')], [], at)
    expect(safetyFunctionAlerts('plant:u1', [evaluation('yellow', ['yes', 'no'], 'FR-H.5')], first, later)).toEqual(first)
    expect(safetyFunctionAlerts('plant:u1', [evaluation('orange', ['no', 'yes'], 'FR-H.2')], first, later)).toMatchObject([{ id: 'csf:heat-sink:ny', raisedAt: later }])
  })

  describe('a loss of main feedwater', () => {
    const challenge: Record<string, any> = {}
    let fed: SteadyPlantRun
    beforeAll(async () => {
      fed = await createSteadyPlantRun()
      await fed.runTo(10_000)
      await fed.invoke(plantOperator, 'world.process-plant.action.invoke', { actionId: 'loss-main-feedwater', parameters: {} })
      await fed.runTo(60_000)
      challenge.alerts = fed.unit().alerts.filter(alert => alert.kind === 'safety-function')
      challenge.read = (await fed.run.observations(plantOperator).read({ refs: [`${fed.plantId}#csf.heat-sink`] })).observations[0]
      const seen = new Set<string>()
      for (let step = 1; step <= 100; step += 1) {
        await fed.runTo(60_000 + step * 333)
        seen.add(JSON.stringify(fed.unit().alerts.filter(alert => alert.kind === 'safety-function')))
      }
      challenge.distinctOverSteps = seen.size
    })
    afterAll(async () => { await fed.remove() })

    test('the heat sink goes yellow: its alert names the function, the procedure and where the tree ends, never a value, and colours its status (T05)', () => {
      expect(challenge.alerts).toEqual([{
        id: 'csf:heat-sink:nyyyyn', kind: 'safety-function', severity: 'warning', priority: 'caution', acknowledged: false, clock: 'simulation', raisedAt: '2026-01-01T10:00:34.000Z',
        message: expect.stringMatching(/^Heat sink \(FR-H\.5\): A steam generator's narrow-range level is below span/), observable: `${fed.plantId}#csf.heat-sink`,
      }])
      expect(challenge.read).toMatchObject({ value: 'yellow', priority: 'caution', why: challenge.alerts[0].message })
    })

    test('the challenge holds one alert JSON over a hundred steps off the Plant\'s step', () => {
      expect(challenge.distinctOverSteps).toBe(1)
    })
  })
})
