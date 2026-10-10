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

describe('safety injection', () => {
  const siActuated = 'trip:safety-injection-low-pzr-pressure:safety-injection'
  const accumulators = ['A', 'B', 'C', 'D'] as const

  test('a stuck-open PORV brings in SI on low pressurizer pressure, then the accumulators below their gas pressure', () => {
    const plantRun = started()
    plantRun.run(5_000)
    expect(plantRun.tag('SI-PUMP-A-RUNNING')).toBe(false)
    plantRun.act('pressurizer-relief-open', { positionPercent: 100 })
    expect(plantRun.secondsUntil(siActuated, 120)).not.toBeNull()
    expect(Number(plantRun.tag('PT-455'))).toBeLessThan(12.7)
    expect(plantRun.secondsUntil('alarm:si-pump-b-running:running', 10)).not.toBeNull()
    expect(plantRun.tag('SI-PUMP-A-RUNNING')).toBe(true)
    expect(plantRun.tag('SI-PUMP-B-RUNNING')).toBe(true)
    // The SI signal trips the reactor too, if nothing has yet.
    expect(plantRun.tag('TRIP-BKR-A-POS')).toBe(false)

    // Each accumulator injects once reactor coolant pressure falls below its gas pressure.
    expect(plantRun.secondsUntil('alarm:accumulator-a-injecting:injecting', 300)).not.toBeNull()
    expect(Number(plantRun.tag('PT-455'))).toBeLessThan(Number(plantRun.read('safetyAccumulatorA.gasPressureMPa')))
    expect(Number(plantRun.read('safetyAccumulatorA.gasPressureMPa'))).toBeLessThan(4.4)
    for (const loop of accumulators) expect(plantRun.activeIds()).toContain(`alarm:accumulator-${loop.toLowerCase()}-injecting:injecting`)
    expect(Number(plantRun.tag('SI-FLOW'))).toBeGreaterThan(Number(plantRun.read('safetyInjectionPumpA.flowKgPerS')) + Number(plantRun.read('safetyInjectionPumpB.flowKgPerS')))
  })

  test('high-head SI pumps deliver less the higher the reactor coolant pressure they pump against', () => {
    const plantRun = started()
    plantRun.run(2_000)
    for (const pump of ['safetyInjectionPumpA', 'safetyInjectionPumpB']) plantRun.runtime.writeCommand({ type: 'setVariable', path: `${pump}.running` as VariablePath, value: true })
    plantRun.run(30_000)
    // At about 15.5 MPa a pump with an 18.5 MPa shutoff and a 35 kg/s runout delivers 35 * sqrt(1 - 15.5 / 18.5), about 14 kg/s.
    const pressure = Number(plantRun.tag('PT-455'))
    const flow = Number(plantRun.read('safetyInjectionPumpA.flowKgPerS'))
    expect(pressure).toBeGreaterThan(14.5)
    expect(flow).toBeCloseTo(35 * Math.sqrt(1 - pressure / 18.5), 0)
    expect(flow).toBeLessThan(20)
  })

  test('acts after a reactor trip, in hot standby, but not on the pressure of a normal trip', () => {
    const qualified = plant.automation.rules.find(rule => rule.id === 'safety-injection-low-pzr-pressure')!
    expect(qualified.modes).toEqual(['powerOperation', 'startup', 'hotStandby'])
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.act('turbine-trip')
    plantRun.run(120_000)
    expect(plantRun.tag('TRIP-BKR-A-POS')).toBe(false)
    expect(plantRun.activeIds()).not.toContain(siActuated)
    expect(plantRun.tag('SI-PUMP-A-RUNNING')).toBe(false)
  })
})

describe('safety injection accumulators', () => {
  test('keep injecting as long as the reactor coolant pressure stays below their expanding gas', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'rcs-hot-leg-a.leak.areaFraction' as VariablePath, value: 0.45 })
    plantRun.run(300_000)
    const gas = Number(plantRun.read('safetyAccumulatorA.gasPressureMPa'))
    const pressure = Number(plantRun.tag('PT-455'))
    // Well below its 4.4 MPa charge, the gas still stands just above the coolant pressure it injects into.
    expect(pressure).toBeLessThan(3.5)
    expect(gas).toBeLessThan(3.5)
    expect(gas).toBeGreaterThan(pressure)
    expect(Number(plantRun.read('safetyAccumulatorA.outletFlowKgPerS'))).toBeGreaterThan(1)
    expect(Number(plantRun.read('safetyAccumulatorA.depletedFraction'))).toBeGreaterThan(0.2)
  })
})
