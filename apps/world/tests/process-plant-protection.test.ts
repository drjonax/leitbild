import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type ProcessPlantIcConfig,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'

// Reactor protection and safety injection of the four-loop reference PWR,
// read from the I&C's trips and alarms and the equipment's feedback.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:protection', loopCount: 4 }))
const graph = plant.graph

const opensTripBreakers = (rule: ProcessPlantIcConfig['rules'][number]): boolean =>
  rule.effects.some(effect => effect.type === 'writeSignal' && effect.signal.tagId === 'TRIP-BKR-A')

/** The reference I&C with no reactor trip but the named ones, so a test sees the trip it is about whatever trips act first. */
const withOnlyReactorTrips = (ruleIds: ReadonlyArray<string>): ProcessPlantIcConfig => ({
  ...plant.automation,
  rules: plant.automation.rules.filter(rule => ruleIds.includes(rule.id) || !opensTripBreakers(rule)),
})

const started = (automation: ProcessPlantIcConfig = plant.automation) => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: automation })
  const step = () => {
    runtime.tick(1_000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-protection' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
  }
  const run = (durationMs: number) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += 1_000) step()
  }
  const act = (actionId: string, parameters: Readonly<Record<string, unknown>> = {}) => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters, graph })) {
      runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
  }
  const tag = (tagId: string) => runtime.readVariable(resolveProcessPlantSignalBinding(graph, { tagId: tagId as never }).path)
  const read = (path: string) => runtime.readVariable(path as VariablePath)
  const activeIds = () => {
    const snapshot = protection.snapshot()
    return [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id)
  }
  const trip = (id: string) => protection.snapshot().trips.find(lifecycle => lifecycle.id === id)
  /** Steps until the lifecycle comes in, and returns the seconds it took, or null. */
  const secondsUntil = (id: string, limitS: number): number | null => {
    for (let second = 1; second <= limitS; second += 1) {
      step()
      if (activeIds().includes(id)) return second
    }
    return null
  }
  return { runtime, protection, step, run, act, tag, read, activeIds, trip, secondsUntil }
}

describe('overtemperature and overpower delta-T', () => {
  test('each loop channel holds its setpoints above its delta-T at rated power', () => {
    const plantRun = started()
    plantRun.run(5_000)
    for (const loop of ['411', '421', '431', '441']) {
      const deltaT = Number(plantRun.tag(`TDI-${loop}`))
      expect(deltaT).toBeGreaterThan(40)
      // At rated Tavg and pressure the setpoints are K1 = 1.18 and K4 = 1.10 times the rated delta-T.
      expect(Number(plantRun.tag(`OTDT-${loop}-SP`)) / deltaT).toBeCloseTo(1.18, 1)
      expect(Number(plantRun.tag(`OPDT-${loop}-SP`)) / deltaT).toBeCloseTo(1.10, 1)
      expect(Number(plantRun.tag(`OTDT-${loop}-MARGIN`))).toBeGreaterThan(0)
      expect(Number(plantRun.tag(`OPDT-${loop}-MARGIN`))).toBeGreaterThan(0)
    }
    expect(plantRun.protection.snapshot().trips.filter(lifecycle => lifecycle.active)).toEqual([])
  })

  test('a loss of feedwater at power trips the reactor on overtemperature delta-T before the coolant saturates', () => {
    const plantRun = started(withOnlyReactorTrips(['reactor-overtemperature-delta-t-trip']))
    plantRun.run(5_000)
    plantRun.act('loss-main-feedwater')
    const seconds = plantRun.secondsUntil('trip:reactor-overtemperature-delta-t-trip:overtemperature-delta-t-trip', 300)
    expect(seconds).not.toBeNull()
    // It acts as rising Tavg pulls the setpoint down onto the loop delta-T, with the coolant still subcooled.
    expect(Number(plantRun.tag('TAVG'))).toBeGreaterThan(315.5)
    expect(Number(plantRun.tag('SUB-MARGIN'))).toBeGreaterThan(0)
    expect(plantRun.trip('trip:reactor-overtemperature-delta-t-trip:overtemperature-delta-t-trip')).toMatchObject({ firstOut: true })
    plantRun.run(10_000)
    expect(plantRun.tag('TRIP-BKR-A-POS')).toBe(false)
    expect(plantRun.tag('TRIP-BKR-B-POS')).toBe(false)
    expect(Number(plantRun.read('core.powerMw'))).toBeLessThan(500)
    expect(plantRun.activeIds()).not.toContain('alarm:rcs-subcooling-lost:subcooling-lost')
  })
})

describe('a reactor coolant pump that stops at power', () => {
  const rcpTrip = 'trip:reactor-rcp-breaker-open-trip:rcp-breaker-open-trip'

  test('trips the reactor on the first scan after all pumps trip, before the loop flow coasts down', () => {
    const plantRun = started()
    plantRun.run(5_000)
    const coreExitBefore = Number(plantRun.tag('CET-AVG'))
    plantRun.act('trip-reactor-coolant-pumps')
    expect(plantRun.secondsUntil(rcpTrip, 2)).toBe(1)
    expect(plantRun.trip(rcpTrip)).toMatchObject({ firstOut: true })
    let coreExitPeak = coreExitBefore
    for (let second = 0; second < 30; second += 1) {
      plantRun.step()
      coreExitPeak = Math.max(coreExitPeak, Number(plantRun.tag('CET-AVG')))
    }
    expect(plantRun.tag('TRIP-BKR-A-POS')).toBe(false)
    expect(plantRun.tag('TRIP-BKR-B-POS')).toBe(false)
    // The rods are in while the coasting pumps still move most of the flow, so the core exit barely rises.
    expect(coreExitPeak).toBeLessThan(coreExitBefore + 2)
    expect(plantRun.activeIds()).not.toContain('trip:reactor-low-rcp-flow-trip:low-rcp-flow-trip')
  })

  test('above P-8 one stopped pump trips the reactor', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'rcpC.running' as VariablePath, value: false })
    expect(plantRun.secondsUntil(rcpTrip, 2)).toBe(1)
  })

  test('between P-7 and P-8 one stopped pump leaves the reactor at power and a second trips it', () => {
    const partPower = compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:between-p7-p8',
      loopCount: 4,
      parameterOverrides: { core: { initialPowerFraction: 0.3 } },
    }))
    const runtime = createProcessPlantRuntime({ system: partPower })
    const protection = createProcessPlantProtectionRunner({ system: partPower, protection: partPower.automation })
    const step = () => {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-protection' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    const tripped = () => protection.snapshot().trips.find(lifecycle => lifecycle.id === rcpTrip)?.active === true
    for (let second = 0; second < 5; second += 1) step()
    expect(Number(runtime.readVariable('core.powerMw' as VariablePath))).toBeGreaterThan(340)
    expect(Number(runtime.readVariable('core.powerMw' as VariablePath))).toBeLessThan(1_632)
    runtime.writeCommand({ type: 'setVariable', path: 'rcpA.running' as VariablePath, value: false })
    for (let second = 0; second < 5; second += 1) step()
    expect(tripped()).toBe(false)
    expect(runtime.readVariable('reactorTripBreakerA.closedState' as VariablePath)).toBe(true)
    runtime.writeCommand({ type: 'setVariable', path: 'rcpB.running' as VariablePath, value: false })
    step()
    expect(tripped()).toBe(true)
  })
})
