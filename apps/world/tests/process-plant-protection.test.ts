import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantIcConfigSchema,
  type ProcessPlantIcConfig,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { validateProcessPlantControlWrite } from '../src/packs/process-plant/control-write-validation.ts'
import { icThresholdsForSignal } from '../src/packs/process-plant/displays/ic-thresholds.ts'

// Reactor protection and safety injection of the four-loop reference PWR,
// read from the I&C's trips and alarms and the equipment's feedback. Each
// test runs minutes of plant time, within World's 120 s test watchdog.

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
  /** An operator's write, refused as the I&C's permissives and interlocks refuse it. */
  const operate = (tagId: string, value: boolean | number) => {
    const validation = validateProcessPlantControlWrite({ system: plant, runtime, protection, payload: { plantId: plant.id, tagId, value } as never })
    if (validation.accepted) runtime.writeCommand({ type: 'setVariable', path: validation.targetPath, value })
    return validation
  }
  return { runtime, protection, step, run, act, tag, read, activeIds, trip, secondsUntil, operate }
}

describe('high pressurizer pressure', () => {
  test('trips the reactor when nothing relieves or sprays the pressure down', () => {
    // Pressure control and the PORV's opening left out, the PORV isolated by its block valve, and the heaters full on.
    const automation = withOnlyReactorTrips(['pzr-pressure-high-reactor-trip'])
    const plantRun = started({ ...automation, rules: automation.rules.filter(rule => !rule.id.startsWith('pzr-pressure-') || rule.id === 'pzr-pressure-high-reactor-trip') })
    plantRun.run(5_000)
    plantRun.act('pressurizer-porv-block-valve-close')
    plantRun.run(12_000)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'pressurizer.heaterPowerMw' as VariablePath, value: 30 })
    expect(plantRun.secondsUntil('trip:pzr-pressure-high-reactor-trip:high-pzr-pressure-reactor-trip', 120)).not.toBeNull()
    expect(Number(plantRun.tag('PT-455'))).toBeGreaterThan(16.55)
    plantRun.run(10_000)
    expect(plantRun.tag('TRIP-BKR-A-POS')).toBe(false)
    expect(Number(plantRun.read('core.powerMw'))).toBeLessThan(500)
  })
})

describe('the pressurizer PORV on high pressure', () => {
  const relief = 'trip:pzr-pressure-high-relief:relief-actuation'

  test('opens at 16.18 MPa on every rise, reseats below 15.85 MPa, and holds the pressure below the reactor trip', () => {
    // No spray, and the heaters full on: the pressure rises until the PORV relieves it, again and again.
    const plantRun = started({ ...plant.automation, rules: plant.automation.rules.filter(rule => !rule.id.startsWith('pzr-pressure-high-demand') && !rule.id.startsWith('pzr-pressure-normal-band') && !rule.id.startsWith('pzr-pressure-low-demand')) })
    plantRun.run(5_000)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'pressurizer.heaterPowerMw' as VariablePath, value: 12 })
    let openings = 0
    let wasOpen = false
    let peak = 0
    for (let second = 1; second <= 600; second += 1) {
      plantRun.step()
      const open = Number(plantRun.tag('PORV-456A')) > 0
      if (open && !wasOpen) openings += 1
      wasOpen = open
      peak = Math.max(peak, Number(plantRun.tag('PT-455')))
    }
    expect(openings).toBeGreaterThan(1)
    expect(peak).toBeGreaterThan(16.18)
    expect(peak).toBeLessThan(16.55)
    expect(plantRun.tag('TRIP-BKR-A-POS')).toBe(true)
    expect(plantRun.trip(relief)!.occurrenceCount).toBe(openings)
    expect(plantRun.trip('trip:pzr-pressure-high-reactor-trip:high-pzr-pressure-reactor-trip')!.occurrenceCount).toBe(0)
  }, 120_000)
})

describe('pressurizer code safety valves', () => {
  test('with the PORV blocked, they hold an overpressure near their 17.24 MPa set pressure, discharging to the relief tank', () => {
    // The same overpressure: no spray, no PORV opening, the PORV isolated and the heaters full on. Full on is the
    // 12 MW the pressure control energizes: more boils the pressurizer dry, which the valves do not test.
    const automation = withOnlyReactorTrips(['pzr-pressure-high-reactor-trip'])
    const plantRun = started({ ...automation, rules: automation.rules.filter(rule => !rule.id.startsWith('pzr-pressure-') || rule.id === 'pzr-pressure-high-reactor-trip') })
    plantRun.run(5_000)
    plantRun.act('pressurizer-porv-block-valve-close')
    plantRun.run(12_000)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'pressurizer.heaterPowerMw' as VariablePath, value: 12 })
    const tankBefore = Number(plantRun.read('pressurizerReliefTank.inventoryKg'))
    let peak = 0
    let liftedAt: number | null = null
    let dischargePeak = 0
    for (let second = 1; second <= 450; second += 1) {
      // Sampled once a second, the lift shows from the pressure the second starts from: the solver's steps within
      // it lift the valves on reaching set pressure, and their discharge lowers it again.
      const startingPressure = Number(plantRun.tag('PT-455'))
      plantRun.step()
      const pressure = Number(plantRun.tag('PT-455'))
      peak = Math.max(peak, pressure)
      if (liftedAt === null && plantRun.tag('PSV-8010-OPEN') === true) liftedAt = startingPressure
      dischargePeak = Math.max(dischargePeak, Number(plantRun.read('pressurizer-relief-header-to-tank.flowKgPerS')))
    }
    // They pop at their set pressure and the pressure never passes their 3 % accumulation.
    expect(liftedAt).not.toBeNull()
    expect(liftedAt!).toBeCloseTo(17.24, 1)
    expect(peak).toBeLessThan(17.24 * 1.03)
    expect(plantRun.tag('MOV-8000A-POS')).toBe(0)
    expect(Number(plantRun.read('pressurizer.reliefFlowKgPerS'))).toBe(0)
    // What they discharge, the steam the heaters raise, about 11 kg/s, reaches the relief tank through the relief header.
    expect(dischargePeak).toBeGreaterThan(8)
    expect(Number(plantRun.read('pressurizerReliefTank.inventoryKg'))).toBeGreaterThan(tankBefore + 1_000)
    expect(plantRun.protection.snapshot().alarms.find(lifecycle => lifecycle.id === 'alarm:pzr-safety-valve-open:safety-valve-open')!.occurrenceCount).toBeGreaterThan(0)
  })

  test('stay shut at normal pressure and through a normal trip', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.act('turbine-trip')
    plantRun.run(60_000)
    expect(plantRun.tag('PSV-8010-OPEN')).toBe(false)
    expect(plantRun.tag('PSV-8010-POS')).toBe(0)
    expect(plantRun.protection.snapshot().alarms.find(lifecycle => lifecycle.id === 'alarm:pzr-safety-valve-open:safety-valve-open')!.occurrenceCount).toBe(0)
  })
})

describe('overtemperature and overpower delta-T', () => {
  test('each loop channel holds its setpoints above its delta-T at rated power', () => {
    const plantRun = started()
    plantRun.run(5_000)
    for (const loop of ['411', '421', '431', '441']) {
      const deltaT = Number(plantRun.tag(`TDI-${loop}`))
      // The core's rated rise from IF97 enthalpy at coolant pressure, about 35 degC.
      expect(deltaT).toBeGreaterThan(33)
      // At rated Tavg and pressure the setpoints are K1 = 1.18 and K4 = 1.10 times the rated delta-T.
      expect(Number(plantRun.tag(`OTDT-${loop}-SP`)) / deltaT).toBeCloseTo(1.18, 1)
      expect(Number(plantRun.tag(`OPDT-${loop}-SP`)) / deltaT).toBeCloseTo(1.10, 1)
      expect(Number(plantRun.tag(`OTDT-${loop}-MARGIN`))).toBeGreaterThan(0)
      expect(Number(plantRun.tag(`OPDT-${loop}-MARGIN`))).toBeGreaterThan(0)
    }
    expect(plantRun.protection.snapshot().trips.filter(lifecycle => lifecycle.active)).toEqual([])
  })

  test('a loss of feedwater at power trips the reactor on overtemperature delta-T when no other trip acts', () => {
    // Low-low steam generator level trips the reactor first, about a minute in. Without it the generators boil down
    // until their tubes uncover, the coolant heats up and overtemperature delta-T trips the reactor as the backup.
    const plantRun = started(withOnlyReactorTrips(['reactor-overtemperature-delta-t-trip']))
    plantRun.run(5_000)
    plantRun.act('loss-main-feedwater')
    const seconds = plantRun.secondsUntil('trip:reactor-overtemperature-delta-t-trip:overtemperature-delta-t-trip', 300)
    expect(seconds).not.toBeNull()
    // It acts as rising Tavg pulls the setpoint down onto the loop delta-T. With the high-pressure trip out of
    // service too, the expanding coolant fills the pressurizer and its pressure, which raises the setpoint, runs up
    // past the safety valves; the trip comes as it falls back, with the core exit at saturation.
    expect(Number(plantRun.tag('TAVG'))).toBeGreaterThan(315.5)
    expect(Number(plantRun.tag('SUB-MARGIN'))).toBeGreaterThan(-2)
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

  test('a stuck-open PORV brings in SI on low pressurizer pressure, and the pressure hangs above the accumulators\' gas', () => {
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

    // The coolant then flashes and the pressure hangs near the hot legs' saturation pressure, as at Three Mile
    // Island: well above the accumulators' gas, so they stay shut while the SI pumps refill the system.
    expect(plantRun.secondsUntil('alarm:accumulator-a-injecting:injecting', 300)).toBeNull()
    for (const loop of accumulators) expect(plantRun.activeIds()).not.toContain(`alarm:accumulator-${loop.toLowerCase()}-injecting:injecting`)
    expect(Number(plantRun.tag('PT-455'))).toBeGreaterThan(7)
    expect(Number(plantRun.read('safetyAccumulatorA.gasPressureMPa'))).toBeCloseTo(4.4, 1)
    expect(Number(plantRun.tag('SI-FLOW'))).toBeGreaterThan(40)
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

describe('the PORV block valve', () => {
  test('closing it isolates a stuck-open PORV: the relief flow stops though the PORV still reads open', () => {
    const plantRun = started()
    plantRun.run(5_000)
    expect(plantRun.tag('MOV-8000A')).toBe(1)
    expect(plantRun.tag('MOV-8000A-POS')).toBe(1)
    plantRun.act('pressurizer-relief-open', { positionPercent: 100 })
    plantRun.run(3_000)
    expect(Number(plantRun.read('pressurizer.reliefFlowKgPerS'))).toBeGreaterThan(30)
    plantRun.act('pressurizer-porv-block-valve-close')
    plantRun.run(5_000)
    // A motor-operated valve: halfway through its stroke it still passes flow.
    expect(Number(plantRun.tag('MOV-8000A-POS'))).toBeGreaterThan(0)
    expect(Number(plantRun.tag('MOV-8000A-POS'))).toBeLessThan(1)
    expect(plantRun.activeIds()).toContain('alarm:pzr-porv-block-valve-not-open:porv-block-valve-not-open')
    plantRun.run(10_000)
    expect(plantRun.tag('MOV-8000A')).toBe(0)
    expect(plantRun.tag('MOV-8000A-POS')).toBe(0)
    expect(plantRun.tag('PORV-456A-POS')).toBe(1)
    expect(Number(plantRun.read('pressurizer.reliefFlowKgPerS'))).toBe(0)
    expect(Number(plantRun.read('pressurizer-relief-to-tank.flowKgPerS'))).toBe(0)
    plantRun.run(3_000)
    expect(plantRun.activeIds()).not.toContain('alarm:pzr-relief-flow-high:relief-flow-high')
  })

  test('without power on its motor it stays where it is', () => {
    const plantRun = started()
    plantRun.run(2_000)
    // Offsite power lost and no diesel started: safety bus A, which feeds the valve's motor, is dead.
    for (const path of ['offsiteGrid.available', 'offsiteBreakerA.closed', 'offsiteBreakerB.closed']) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value: false })
    }
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'dieselGeneratorA.available' as VariablePath, value: false })
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'pressurizer.blockValvePositionFraction' as VariablePath, value: 0 })
    for (let second = 0; second < 15; second += 1) plantRun.runtime.tick(1_000)
    expect(plantRun.read('safetyBusA.energized')).toBe(false)
    expect(plantRun.tag('MOV-8000A')).toBe(0)
    expect(plantRun.tag('MOV-8000A-POS')).toBe(1)
  })

  test('after a loss of offsite power it still closes on its diesel-backed bus, though the heaters\' unit bus is dead', () => {
    const plantRun = started()
    plantRun.run(2_000)
    plantRun.act('loss-offsite-power')
    plantRun.run(30_000)
    expect(plantRun.tag('UNIT-BUS-A-ENERGIZED')).toBe(false)
    expect(plantRun.tag('BUS-A-ENERGIZED')).toBe(true)
    plantRun.act('pressurizer-porv-block-valve-close')
    plantRun.run(15_000)
    expect(plantRun.tag('MOV-8000A-POS')).toBe(0)
  })

  test('its motor\'s supply carries none of the heaters\' load, which stays on their unit bus', () => {
    const plantRun = started()
    plantRun.run(2_000)
    const loads = () => ({ safety: Number(plantRun.read('safetyBusA.servedLoadMw')), unit: Number(plantRun.read('unitBusA.servedLoadMw')) })
    const before = loads()
    // Without the I&C, so no pressure controller takes the heaters back.
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'pressurizer.heaterPowerMw' as VariablePath, value: 1.8 })
    for (let second = 0; second < 3; second += 1) plantRun.runtime.tick(1_000)
    const after = loads()
    expect(after.safety).toBeCloseTo(before.safety, 3)
    expect(after.unit - before.unit).toBeCloseTo(1.8, 1)
  })
})

describe('steam generator tube leak detection', () => {
  const tubeLeak = (loop: string) => `alarm:sg-${loop}-tube-leak-indication:tube-leak`
  const leakRateHigh = 'alarm:rcs-leak-rate-high:leak-rate-high'

  const conditionPaths = (condition: ProcessPlantIcConfig['rules'][number]['condition']): ReadonlyArray<string> => {
    if (condition.type === 'comparison') return [String(resolveProcessPlantSignalBinding(graph, condition.signal).path)]
    if (condition.type === 'not') return conditionPaths(condition.condition)
    return condition.conditions.flatMap(conditionPaths)
  }

  test('no rule reads the leak a fault injects, and it carries no instrument tag', () => {
    for (const rule of plant.automation.rules) {
      expect(conditionPaths(rule.condition).filter(path => path.endsWith('.tubeLeakFraction')), rule.id).toEqual([])
    }
    expect(graph.signalBindingByTagId.has('SG-A-TUBE-LEAK' as never)).toBe(false)
  })

  test('a tube leak alarms from its steam generator\'s radiation and the RCS inventory balance, which estimates its rate', () => {
    const plantRun = started()
    plantRun.run(10_000)
    expect(Number(plantRun.tag('RCS-LEAK-RATE'))).toBeCloseTo(0, 6)
    plantRun.act('steam-generator-tube-leak-a', { leakPercent: 1.2 })
    expect(plantRun.secondsUntil(tubeLeak('a'), 60)).not.toBeNull()
    expect(Number(plantRun.tag('SG-A-N16'))).toBeGreaterThan(0.03)
    expect(Number(plantRun.tag('RCS-LEAK-RATE'))).toBeGreaterThan(0.063)
    expect(plantRun.activeIds()).toEqual(expect.arrayContaining([leakRateHigh, 'alarm:sg-a-secondary-radiation-high:secondary-radiation-high']))
    for (const loop of ['b', 'c', 'd']) expect(plantRun.activeIds()).not.toContain(tubeLeak(loop))
    // Settled, the balance reads the flow through the tubes.
    plantRun.run(60_000)
    const tubeFlow = Number(plantRun.read('sgA.primaryToSecondaryLeakKgPerS'))
    expect(Number(plantRun.tag('RCS-LEAK-RATE'))).toBeCloseTo(tubeFlow, 1)
  })

  test('after a reactor trip the N-16 reading falls to background, so its alarms clear and the inventory balance alone shows the leak', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.act('steam-generator-tube-leak-a', { leakPercent: 1.2 })
    expect(plantRun.secondsUntil(tubeLeak('a'), 60)).not.toBeNull()
    const atPower = Number(plantRun.tag('SG-A-N16'))
    expect(atPower).toBeGreaterThan(1)
    for (const breaker of ['reactorTripBreakerA', 'reactorTripBreakerB']) plantRun.runtime.writeCommand({ type: 'setVariable', path: `${breaker}.closed` as VariablePath, value: false })
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'core.rodInsertionFraction' as VariablePath, value: 1 })
    plantRun.run(60_000)
    // The leak goes on, but no N-16 rides it on a shut-down core.
    expect(Number(plantRun.read('sgA.primaryToSecondaryLeakKgPerS'))).toBeGreaterThan(1)
    expect(Number(plantRun.tag('SG-A-N16'))).toBeLessThan(0.025)
    expect(plantRun.activeIds()).not.toContain(tubeLeak('a'))
    expect(plantRun.activeIds()).not.toContain('alarm:sg-a-secondary-radiation-high:secondary-radiation-high')
    expect(plantRun.activeIds()).toContain(leakRateHigh)
  })

  test('a tube leak that starts on a shut-down core shows on the inventory balance only', () => {
    const plantRun = started()
    plantRun.run(5_000)
    for (const breaker of ['reactorTripBreakerA', 'reactorTripBreakerB']) plantRun.runtime.writeCommand({ type: 'setVariable', path: `${breaker}.closed` as VariablePath, value: false })
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'core.rodInsertionFraction' as VariablePath, value: 1 })
    plantRun.run(60_000)
    plantRun.act('steam-generator-tube-leak-a', { leakPercent: 1.2 })
    expect(plantRun.secondsUntil(leakRateHigh, 60)).not.toBeNull()
    plantRun.run(30_000)
    expect(Number(plantRun.tag('SG-A-N16'))).toBeLessThan(0.025)
    expect(plantRun.activeIds()).not.toContain(tubeLeak('a'))
  })

  test('a hot-leg leak shows on the inventory balance but on no steam generator', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'rcs-hot-leg-a.leak.areaFraction' as VariablePath, value: 0.01 })
    expect(plantRun.secondsUntil(leakRateHigh, 60)).not.toBeNull()
    plantRun.run(30_000)
    for (const loop of ['a', 'b', 'c', 'd']) expect(plantRun.activeIds()).not.toContain(tubeLeak(loop))
  })

  test('a stuck-open PORV relieves to the relief tank, which the balance counts as identified, not as a leak', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.act('pressurizer-relief-open', { positionPercent: 100 })
    plantRun.run(120_000)
    expect(Math.abs(Number(plantRun.tag('RCS-LEAK-RATE')))).toBeLessThan(0.063)
    expect(plantRun.activeIds()).not.toContain(leakRateHigh)
  })
})

describe('blocking low-pressure safety injection below P-11', () => {
  const siActuated = 'trip:safety-injection-low-pzr-pressure:safety-injection'

  test('is refused at power and above P-11', () => {
    const plantRun = started()
    plantRun.run(5_000)
    const refused = plantRun.operate('SI-BLOCK', true)
    expect(refused.accepted).toBe(false)
    if (!refused.accepted) expect(refused.reason).toContain('only below P-11 (13.3 MPa) with the reactor tripped')
    // Tripped, but still above P-11.
    for (const breaker of ['reactorTripBreakerA', 'reactorTripBreakerB']) plantRun.runtime.writeCommand({ type: 'setVariable', path: `${breaker}.closed` as VariablePath, value: false })
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'core.rodInsertionFraction' as VariablePath, value: 1 })
    plantRun.run(10_000)
    expect(plantRun.tag('P-11')).toBe(false)
    expect(plantRun.operate('SI-BLOCK', true).accepted).toBe(false)
    expect(plantRun.tag('SI-BLOCKED')).toBe(false)
  })

  test('lets a planned depressurization in hot standby pass 12.7 MPa without SI, and resets above P-11', () => {
    const plantRun = started()
    plantRun.run(5_000)
    for (const breaker of ['reactorTripBreakerA', 'reactorTripBreakerB']) plantRun.runtime.writeCommand({ type: 'setVariable', path: `${breaker}.closed` as VariablePath, value: false })
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'core.rodInsertionFraction' as VariablePath, value: 1 })
    plantRun.run(30_000)
    // The operators depressurize through the PORV and block SI as soon as P-11 comes in. The pressurizer's
    // saturated water must flash to cool, so the PORV opens to 40 %: at 15 % it took ten minutes to pass 12 MPa.
    expect(plantRun.operate('PORV-456A', 0.4).accepted).toBe(true)
    let blockedAt: number | null = null
    for (let second = 0; second < 120 && blockedAt === null; second += 1) {
      plantRun.step()
      if (plantRun.tag('P-11') === true && plantRun.operate('SI-BLOCK', true).accepted) blockedAt = Number(plantRun.tag('PT-455'))
    }
    expect(blockedAt).not.toBeNull()
    expect(blockedAt!).toBeLessThan(13.3)
    expect(blockedAt!).toBeGreaterThan(12.7)
    plantRun.step()
    expect(plantRun.tag('SI-BLOCKED')).toBe(true)
    // The pushbutton springs back; the block is the logic's memory.
    expect(plantRun.tag('SI-BLOCK')).toBe(false)
    expect(plantRun.activeIds()).toContain('alarm:safety-injection-blocked:blocked')
    plantRun.run(90_000)
    expect(Number(plantRun.tag('PT-455'))).toBeLessThan(11)
    expect(plantRun.activeIds()).not.toContain(siActuated)
    expect(plantRun.tag('SI-PUMP-A-RUNNING')).toBe(false)

    // Repressurized past P-11, the block resets by itself, and SI is armed again.
    expect(plantRun.operate('PORV-456A', 0).accepted).toBe(true)
    let resetAt: number | null = null
    for (let second = 0; second < 300 && resetAt === null; second += 1) {
      plantRun.step()
      if (plantRun.tag('SI-BLOCKED') === false) resetAt = Number(plantRun.tag('PT-455'))
    }
    expect(resetAt).not.toBeNull()
    expect(resetAt!).toBeGreaterThanOrEqual(13.3)
    expect(plantRun.operate('PORV-456A', 0.4).accepted).toBe(true)
    expect(plantRun.secondsUntil(siActuated, 120)).not.toBeNull()
    plantRun.run(5_000)
    expect(plantRun.tag('SI-PUMP-A-RUNNING')).toBe(true)
  })
})

describe('what each trip actuates', () => {
  // A display names a limit's function from the trip's annunciator ("LO-LO 20 · AFW START"), never from a plant name.
  const actuatesOf = (ruleId: string) => plant.automation.rules.find(rule => rule.id === ruleId)!.effects
    .flatMap(effect => effect.type === 'trip.enter' ? [effect.annunciator?.actuates] : [])

  test('every trip names the declared actuations it carries out, its own function first', () => {
    const declared = new Map(plant.automation.actuations.map(actuation => [actuation.id, actuation.shortLabel]))
    const trips = plant.automation.rules.flatMap(rule => rule.effects.flatMap(effect => effect.type === 'trip.enter' ? [{ rule, effect }] : []))
    expect(trips.length).toBeGreaterThan(20)
    for (const { rule, effect } of trips) {
      expect(effect.annunciator?.actuates?.length, rule.id).toBeGreaterThan(0)
      for (const id of effect.annunciator!.actuates!) expect(declared.has(id), `${rule.id} ${id}`).toBe(true)
    }
    for (const rule of plant.automation.rules) {
      for (const effect of rule.effects) if (effect.type === 'alarm.enter') expect(effect.annunciator?.actuates, rule.id).toBeUndefined()
    }
    expect(actuatesOf('safety-injection-low-pzr-pressure')).toEqual([['safetyInjection', 'reactorTrip']])
    expect(actuatesOf('sg-b-level-low-low-afw-actuation')).toEqual([['auxiliaryFeedwaterStart']])
    expect(actuatesOf('sg-b-level-low-low-reactor-trip')).toEqual([['reactorTrip']])
    expect(actuatesOf('pzr-pressure-high-relief')).toEqual([['pressurizerReliefOpen']])
    expect(actuatesOf('reactor-trip-low-tavg-feedwater-isolation')).toEqual([['feedwaterIsolation']])
    expect(actuatesOf('sg-b-level-high-high-feedwater-isolation')).toEqual([['feedwaterIsolation', 'turbineTrip']])
    expect([...declared.entries()]).toEqual(expect.arrayContaining([['reactorTrip', 'RX TRIP'], ['safetyInjection', 'SI'], ['auxiliaryFeedwaterStart', 'AFW START']]))
  })

  test('a trip naming an undeclared actuation, or none where actuations are declared, is refused', () => {
    const si = plant.automation.rules.find(rule => rule.id === 'safety-injection-low-pzr-pressure')!
    const withAnnunciator = (actuates: ReadonlyArray<string> | undefined) => ({
      ...plant.automation,
      rules: plant.automation.rules.map(rule => rule.id !== si.id ? rule : {
        ...rule,
        effects: rule.effects.map(effect => effect.type !== 'trip.enter' ? effect : {
          ...effect,
          annunciator: { ...effect.annunciator!, actuates: actuates as never },
        }),
      }),
    })
    expect(() => processPlantIcConfigSchema.parse(withAnnunciator(['coreSpray']))).toThrow('actuates coreSpray, which is not declared')
    expect(() => processPlantIcConfigSchema.parse(withAnnunciator(undefined))).toThrow('names no actuation')
  })

  test('the I&C catalog lists the declared actuations', () => {
    const plantRun = started()
    expect(plantRun.protection.catalog().actuations.map(actuation => actuation.id)).toEqual(plant.automation.actuations.map(actuation => actuation.id))
  })
})

describe('feedwater isolation', () => {
  const isolation = 'trip:reactor-trip-low-tavg-feedwater-isolation:feedwater-isolation'
  const loops = ['A', 'B', 'C', 'D']

  test('shuts every feed regulating valve against its level controller while P-4 holds it, though one is stuck', () => {
    const plantRun = started()
    plantRun.run(5_000)
    // Feed regulating valve B fails at 35 %: steam generator B boils down, the reactor trips on its low-low
    // level, and P-4 with Tavg below 564 °F isolates feedwater while B's level controller still calls for 100 %.
    plantRun.act('steam-generator-b-feedwater-runback', { positionPercent: 35 })
    const seconds = plantRun.secondsUntil(isolation, 150)
    expect(seconds).not.toBeNull()
    plantRun.run(2_000)
    for (const loop of loops) {
      expect(plantRun.tag(`MFW-${loop}-CV`), loop).toBe(0)
      expect(plantRun.read(`feedwaterControlValve${loop}.isolationSignal`), loop).toBe(true)
    }
    expect(plantRun.tag('MFW-PUMP-A-RUNNING')).toBe(false)
    expect(plantRun.tag('MFW-PUMP-B-RUNNING')).toBe(false)
    // 80 s on, with both pumps stopped, the demand still reads shut; the stuck valve stays where it failed.
    plantRun.run(80_000)
    for (const loop of loops) expect(plantRun.tag(`MFW-${loop}-CV`), loop).toBe(0)
    expect(Number(plantRun.tag('MFW-A-CV-POS'))).toBe(0)
    expect(Number(plantRun.tag('MFW-B-CV-POS'))).toBeCloseTo(0.35, 6)
    expect(plantRun.trip(isolation)).toMatchObject({ active: true, latched: true })
  }, 120_000)

  test('is released to the level controllers once both reactor trip breakers close; its trip stands until reset', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.act('turbine-trip')
    expect(plantRun.secondsUntil(isolation, 60)).not.toBeNull()
    plantRun.run(5_000)
    expect(plantRun.tag('MFW-A-CV')).toBe(0)
    // Closing one breaker leaves P-4 standing.
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'reactorTripBreakerA.closed' as VariablePath, value: true })
    plantRun.run(3_000)
    expect(plantRun.read('feedwaterControlValveA.isolationSignal')).toBe(true)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'reactorTripBreakerB.closed' as VariablePath, value: true })
    plantRun.run(10_000)
    for (const loop of loops) expect(plantRun.read(`feedwaterControlValve${loop}.isolationSignal`), loop).toBe(false)
    // Back on its controller, the valve opens toward what the shrunk level calls for.
    expect(Number(plantRun.tag('MFW-A-CV'))).toBeGreaterThan(0.5)
    expect(plantRun.trip(isolation)).toMatchObject({ active: true, resettable: true })
  }, 120_000)

  test('on P-14 high-high level shuts the feed regulating valves as it trips the pumps', () => {
    const effects = plant.automation.rules.find(rule => rule.id === 'sg-c-level-high-high-feedwater-isolation')!.effects
    const writes = effects.flatMap(effect => effect.type === 'writeSignal' ? [`${'path' in effect.signal ? effect.signal.path : effect.signal.tagId}=${effect.value}`] : [])
    expect(writes).toEqual(expect.arrayContaining([
      'MFW-PUMP-A-RUN=false',
      'MFW-PUMP-B-RUN=false',
      ...loops.map(loop => `feedwaterControlValve${loop}.isolationSignal=true`),
    ]))
  })
})

describe('containment pressure', () => {
  const entered = (plantRun: ReturnType<typeof started>, ids: ReadonlyArray<string>, seconds: number) => {
    const at = new Map<string, number>()
    for (let second = 1; second <= seconds; second += 1) {
      plantRun.step()
      for (const id of plantRun.activeIds()) if (ids.includes(id) && !at.has(id)) at.set(id, second)
    }
    return at
  }
  const alarm = 'alarm:containment-pressure-high:pressure-high'
  const hi1 = 'trip:safety-injection-containment-pressure-high-1:safety-injection'
  const lowPressureSi = 'trip:safety-injection-low-pzr-pressure:safety-injection'
  const hi2 = 'trip:containment-pressure-high-2-steam-line-isolation:steam-line-isolation'
  const hi3 = 'trip:containment-pressure-high-3-spray:containment-spray'

  test('displays draw the alarm below Hi-1 safety injection, Hi-2 steam line isolation and Hi-3 spray', () => {
    const pressure = resolveProcessPlantSignalBinding(graph, { tagId: 'CTMT-PR' as never }).path
    const actuates = (ruleId: string) => plant.automation.rules.find(rule => rule.id === ruleId)!.effects
      .flatMap(effect => effect.type === 'trip.enter' ? effect.annunciator!.actuates! : [])[0] ?? null
    expect(icThresholdsForSignal(plant, pressure).thresholds.map(threshold => [threshold.value, threshold.kind, actuates(threshold.ruleId)])).toEqual([
      [0.11, 'alarm', null],
      [0.128, 'trip', 'safetyInjection'],
      [0.147, 'trip', 'steamLineIsolation'],
      [0.186, 'trip', 'containmentSpray'],
    ])
    expect(plant.automation.rules.some(rule => rule.id === 'containment-pressure-high-reactor-trip')).toBe(false)
  })

  test('a small break inside containment alarms, then actuates SI on Hi-1 before the pressurizer pressure falls to its SI set point', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'rcs-hot-leg-a.leak.areaFraction' as VariablePath, value: 0.005 })
    const at = entered(plantRun, [alarm, hi1, lowPressureSi], 90)
    expect(at.get(alarm)).toBeLessThan(at.get(hi1)!)
    expect(at.get(hi1)).toBeLessThan(at.get(lowPressureSi) ?? Number.POSITIVE_INFINITY)
    expect(plantRun.trip(hi1)!.firstOut).toBe(true)
    expect(plantRun.tag('SI-PUMP-A-RUNNING')).toBe(true)
    expect(plantRun.tag('TRIP-BKR-A-POS')).toBe(false)
  }, 120_000)

  test('a larger break shuts the steam lines on Hi-2 and starts spray on Hi-3, which brings the pressure back down', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'rcs-hot-leg-a.leak.areaFraction' as VariablePath, value: 0.02 })
    const at = entered(plantRun, [alarm, hi1, hi2, hi3], 110)
    expect([...at.keys()]).toEqual([alarm, hi1, hi2, hi3])
    for (const loop of ['A', 'B', 'C', 'D']) expect(Number(plantRun.tag(`MSIV-${loop}-POS`)), loop).toBe(0)
    expect(plantRun.tag('CSPRAY-A-RUNNING')).toBe(true)
    expect(plantRun.tag('CSPRAY-B-RUNNING')).toBe(true)
    expect(Number(plantRun.tag('SPRAY-FLOW'))).toBeGreaterThan(300)
    const sprayed = Number(plantRun.tag('CTMT-PR'))
    plantRun.run(30_000)
    expect(Number(plantRun.tag('CTMT-PR'))).toBeLessThan(sprayed)
  }, 120_000)
})
