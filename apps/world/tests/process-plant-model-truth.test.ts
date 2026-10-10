import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  assemblePwrReferencePlantGraph,
  commandsForProcessPlantAction,
  compileProcessPlant,
  compileResolvedProcessPlant,
  pressurizedWaterReactorReferenceIcForGraph,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantOperatingMode,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { itemBinding, framingRules } from '../src/packs/process-plant/displays/mimic/bindings.ts'
import { indexSample, itemLook } from '../src/packs/process-plant/displays/mimic/evaluate.ts'
import { icThresholdsForSignal } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import { formatQuantity } from '../src/packs/process-plant/displays/display-text.ts'

// The reference PWR reports what its equipment does, beside what it is told
// to do: a feedback tag for each command tag, read from the solved state.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:model-truth', loopCount: 4 }))
const graph = plant.graph

const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const run = (durationMs: number, options: { readonly withIc: boolean } = { withIc: true }) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += 1_000) {
      runtime.tick(1_000)
      if (options.withIc) protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-model-truth' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
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
  return { runtime, protection, run, act, tag, read, activeIds }
}

describe('the pressurizer PORV', () => {
  test('a stuck-open PORV reads open on its position feedback while its demand stays shut', () => {
    const plantRun = started()
    plantRun.run(5_000)
    expect(plantRun.tag('PORV-456A-POS')).toBe(0)
    plantRun.act('pressurizer-relief-open', { positionPercent: 100 })
    plantRun.run(10_000)
    expect(plantRun.tag('PORV-456A')).toBe(0)
    expect(plantRun.tag('PORV-456A-POS')).toBe(1)
    expect(Number(plantRun.read('pressurizer.reliefFlowKgPerS'))).toBeGreaterThan(1)

    // The drawn PORV says it is open and that its demand disagrees.
    const pzr = graph.componentIndexById.get('pressurizer' as never)!
    const binding = itemBinding(plant, { kind: 'device', component: pzr, device: 'reliefValve' }, 'position', framingRules(plant))
    const sample = indexSample([binding.state!.state!.path, binding.state!.command!].map(path => ({ path, value: plantRun.read(path), quality: 'good' })))
    expect(itemLook(binding, sample)).toMatchObject({ state: { kind: 'position', fraction: 1 }, notMeasured: false, mismatch: 'CMD SHUT' })
  })

  test('a partly failed PORV reads the opening it fails to', () => {
    const plantRun = started()
    plantRun.act('pressurizer-relief-open', { positionPercent: 35 })
    plantRun.run(3_000)
    expect(Number(plantRun.tag('PORV-456A-POS'))).toBeCloseTo(0.35, 6)
  })
})

describe('breakers', () => {
  const breakerLook = (system: typeof plant, id: string, read: (path: string) => unknown) => {
    const binding = itemBinding(system, { kind: 'component', component: system.graph.componentIndexById.get(id as never)! }, 'position', framingRules(system))
    const paths = [binding.state!.state!.path, binding.state!.command!]
    return itemLook(binding, indexSample(paths.map(path => ({ path, value: read(path), quality: 'good' }))))
  }

  test('a breaker opened by its command reads open', () => {
    const plantRun = started()
    plantRun.run(2_000, { withIc: false })
    expect(plantRun.tag('BRK-OFFSITE-A-POS')).toBe(true)
    expect(breakerLook(plant, 'offsiteBreakerA', plantRun.read)).toMatchObject({ state: { kind: 'closed' }, mismatch: null, words: 'closed' })
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'offsiteBreakerA.closed' as VariablePath, value: false })
    plantRun.run(1_000, { withIc: false })
    expect(plantRun.tag('BRK-OFFSITE-A-CLOSED')).toBe(false)
    expect(plantRun.tag('BRK-OFFSITE-A-POS')).toBe(false)
    expect(plantRun.read('offsiteBreakerA.energized')).toBe(false)
    expect(breakerLook(plant, 'offsiteBreakerA', plantRun.read)).toMatchObject({ state: { kind: 'open' }, mismatch: null, words: 'open' })
  })

  test('a tripped breaker reads open while its close command stays', () => {
    const plantRun = started()
    plantRun.run(2_000, { withIc: false })
    // A protective relay latches the trip; the close command is left as it was.
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'offsiteBreakerA.tripped' as VariablePath, value: true })
    plantRun.run(1_000, { withIc: false })
    expect(plantRun.tag('BRK-OFFSITE-A-CLOSED')).toBe(true)
    expect(plantRun.tag('BRK-OFFSITE-A-POS')).toBe(false)
    expect(plantRun.tag('BRK-OFFSITE-B-POS')).toBe(true)
    expect(plantRun.read('offsiteBreakerA.energized')).toBe(false)
    expect(breakerLook(plant, 'offsiteBreakerA', plantRun.read)).toMatchObject({ state: { kind: 'open' }, mismatch: 'CMD CLOSE', words: 'open; commanded close disagrees' })
  })

  test('a reactor trip opens both reactor trip breakers, read from their position feedback', () => {
    const tripped = compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:reactor-trip',
      valueOverrides: { 'pressurizer.pressureMPa': 10 },
    }))
    const runtime = createProcessPlantRuntime({ system: tripped })
    const protection = createProcessPlantProtectionRunner({ system: tripped, protection: tripped.automation })
    for (let elapsed = 0; elapsed < 5_000; elapsed += 1_000) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-model-truth' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    const tag = (tagId: string) => runtime.readVariable(resolveProcessPlantSignalBinding(tripped.graph, { tagId: tagId as never }).path)
    expect(tag('TRIP-BKR-A-POS')).toBe(false)
    expect(tag('TRIP-BKR-B-POS')).toBe(false)
    // The turbine follows the reactor trip, as the breakers' position reads it.
    expect(Number(runtime.readVariable('turbineStopValve.positionFraction' as VariablePath))).toBe(0)
  })
})

describe('pumps', () => {
  const pumps = graph.components.filter(component => component.kind === 'centrifugalPump').map(component => String(component.id))

  test('under loss of offsite power every pump reads not running while its run command stays', () => {
    const plantRun = started()
    plantRun.run(2_000, { withIc: false })
    const commanded = pumps.filter(id => plantRun.read(`${id}.running`) === true)
    expect(commanded).toEqual(expect.arrayContaining(['rcpA', 'rcpB', 'rcpC', 'rcpD', 'mainFeedwaterPumpA', 'mainFeedwaterPumpB', 'chargingPump']))
    for (const id of pumps) expect(plantRun.read(`${id}.runningState`), id).toBe(plantRun.read(`${id}.running`))

    // Without the I&C no diesel starts, so the safety buses stay dead.
    plantRun.act('loss-offsite-power')
    plantRun.run(3_000, { withIc: false })
    expect(plantRun.read('safetyBusA.energized')).toBe(false)
    expect(plantRun.read('safetyBusB.energized')).toBe(false)
    for (const id of commanded) {
      expect(plantRun.read(`${id}.running`), id).toBe(true)
      expect(plantRun.read(`${id}.runningState`), id).toBe(false)
    }
    for (const loop of ['A', 'B', 'C', 'D']) {
      expect(plantRun.tag(`RCP-${loop}-RUN`)).toBe(true)
      expect(plantRun.tag(`RCP-${loop}-RUNNING`)).toBe(false)
    }
  })

  test('a reactor coolant pump that loses its power alarms as not running, though its run command stands', () => {
    const plantRun = started()
    plantRun.run(2_000)
    plantRun.act('loss-offsite-power')
    plantRun.run(3_000)
    expect(plantRun.tag('RCP-A-RUN')).toBe(true)
    expect(plantRun.activeIds()).toEqual(expect.arrayContaining(['alarm:rcp-a-trip:not-running', 'alarm:rcp-b-trip:not-running', 'alarm:main-feedwater-pump-trip:main-feedwater-pump-unavailable']))
  })
})

describe('annunciators', () => {
  test('every annunciator names a component of the Plant as its equipment', () => {
    for (let loopCount = 2; loopCount <= 6; loopCount += 1) {
      const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:annunciators-${loopCount}`, loopCount }))
      const named = system.automation.rules.flatMap(rule => rule.effects.flatMap(effect => effect.type === 'writeSignal' || effect.annunciator?.equipmentId === undefined ? [] : [effect.annunciator.equipmentId]))
      expect(named.length).toBeGreaterThan(40)
      for (const equipmentId of named) expect(system.graph.componentIndexById.has(equipmentId as never), equipmentId).toBe(true)
    }
    expect(plant.automation.rules.find(rule => rule.id === 'main-feedwater-pump-trip')!.effects[0]).toMatchObject({ annunciator: { equipmentId: 'feedwaterHeader' } })
  })

  test('an annunciator that names no component is refused when the Plant is compiled and when its I&C runs', () => {
    const misnamed = (graphOf: Parameters<typeof pressurizedWaterReactorReferenceIcForGraph>[0]) => {
      const config = pressurizedWaterReactorReferenceIcForGraph(graphOf)
      return {
        ...config,
        rules: config.rules.map(rule => rule.id !== 'main-feedwater-pump-trip' ? rule : {
          ...rule,
          effects: rule.effects.map(effect => effect.type === 'alarm.enter' ? { ...effect, annunciator: { ...effect.annunciator!, equipmentId: 'mainFeedwaterHeader' } } : effect),
        }),
      }
    }
    const message = 'process plant I&C rule main-feedwater-pump-trip annunciates main-feedwater-pump-unavailable on equipment mainFeedwaterHeader, which is not a component of the Plant'
    expect(() => compileResolvedProcessPlant({
      id: 'plant:misnamed',
      modelRef: 'test.model',
      operatingPointRef: 'test.operating-point',
      automationRef: 'test.automation',
      graph: assemblePwrReferencePlantGraph({ loopCount: 4 }),
      automationForGraph: misnamed,
    })).toThrow(message)
    expect(() => createProcessPlantProtectionRunner({ system: plant, protection: misnamed(graph) })).toThrow(message)
  })
})

describe('alarms that apply only in power operation', () => {
  const lifecycleOf = (plantRun: ReturnType<typeof started>, id: string) =>
    [...plantRun.protection.snapshot().alarms, ...plantRun.protection.snapshot().trips].find(lifecycle => lifecycle.id === id)!

  test('read power operation from the trip breakers and fission power, never a command', () => {
    const declared = plant.automation.operatingModes.find(mode => mode.id === 'powerOperation')!
    expect(JSON.stringify(declared.condition)).toBe(JSON.stringify({
      type: 'all',
      conditions: [
        { type: 'comparison', signal: { tagId: 'TRIP-BKR-A-POS' }, operator: '==', value: true },
        { type: 'comparison', signal: { tagId: 'TRIP-BKR-B-POS' }, operator: '==', value: true },
        { type: 'comparison', signal: { path: 'core.powerMw' }, operator: '>', value: 100 },
      ],
    }))
    const qualified = plant.automation.rules.filter(rule => rule.modes !== undefined)
    expect(qualified.every(rule => JSON.stringify(rule.modes) === '["powerOperation"]')).toBe(true)
    expect(qualified.map(rule => rule.id)).toEqual(expect.arrayContaining(['generator-output-low', 'turbine-load-low']))
  })

  test('the Plant is in the first declared mode that holds: power operation at power, hot standby once tripped', () => {
    expect(plant.automation.operatingModes.map(mode => mode.label)).toEqual(['Power operation', 'Startup', 'Hot standby', 'Hot shutdown', 'Cold shutdown'])
    const plantRun = started()
    const modeOf = () => processPlantOperatingMode({ system: plant, runtime: plantRun.runtime, modes: plant.automation.operatingModes })?.id
    plantRun.run(2_000)
    expect(modeOf()).toBe('powerOperation')
    // A qualified rule names its modes as declared, and watches what decides them.
    const catalogued = plantRun.protection.catalog().rules.find(rule => rule.id === 'generator-output-low')!
    expect(catalogued.modes).toEqual(['Power operation'])
    expect(catalogued.watchedSignals.map(signal => signal.tagId)).toEqual(expect.arrayContaining(['TRIP-BKR-A-POS', 'TRIP-BKR-B-POS', 'GEN-MW']))
    for (const [path, value] of [['reactorTripBreakerA.closed', false], ['reactorTripBreakerB.closed', false], ['core.rodInsertionFraction', 1]] as const) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value })
    }
    plantRun.run(5_000)
    expect(modeOf()).toBe('hotStandby')
  })

  test('clear after a reactor trip, though their own clear condition still reads abnormal', () => {
    const plantRun = started()
    plantRun.act('steam-generator-b-feedwater-runback')
    plantRun.run(90_000)
    const feedLow = 'alarm:sg-b-feedwater-flow-low:feedwater-flow-low'
    expect(plantRun.activeIds()).toContain(feedLow)

    // A manual reactor trip: both trip breakers open and the rods drop.
    for (const [path, value] of [['reactorTripBreakerA.closed', false], ['reactorTripBreakerB.closed', false], ['core.rodInsertionFraction', 1]] as const) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value })
    }
    plantRun.run(5_000)
    expect(Number(plantRun.read('sgB.feedwaterFlowKgPerS'))).toBeLessThan(180)
    expect(lifecycleOf(plantRun, feedLow)).toMatchObject({ active: false, clearCount: 1 })
    expect(plantRun.activeIds()).not.toContain('alarm:generator-output-low:generator-output-low')
    expect(plantRun.activeIds()).not.toContain('alarm:turbine-load-low:load-low')
  })

  test('the generator alarms clear after a turbine trip', () => {
    const plantRun = started()
    plantRun.run(2_000)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'turbine.loadFraction' as VariablePath, value: 0.3 })
    plantRun.run(30_000)
    expect(Number(plantRun.tag('GEN-MW'))).toBeLessThan(450)
    expect(plantRun.activeIds()).toEqual(expect.arrayContaining(['alarm:generator-output-low:generator-output-low', 'alarm:turbine-load-low:load-low']))

    plantRun.act('turbine-trip')
    plantRun.run(5_000)
    expect(plantRun.tag('TURB-STOP-POS')).toBeLessThan(0.05)
    expect(lifecycleOf(plantRun, 'alarm:generator-output-low:generator-output-low').active).toBe(false)
    expect(lifecycleOf(plantRun, 'alarm:turbine-load-low:load-low').active).toBe(false)
  })
})

describe('RCS subcooling margin', () => {
  test('alarms below the 30 °F minimum of the procedures and at saturation, and displays draw both limits', () => {
    const margin = resolveProcessPlantSignalBinding(graph, { tagId: 'SUB-MARGIN' as never }).path
    expect(icThresholdsForSignal(plant, margin).thresholds.map(threshold => [threshold.ruleId, threshold.operator, threshold.value, threshold.kind, threshold.severity])).toEqual([
      ['rcs-subcooling-lost', '<=', 0, 'alarm', 'critical'],
      ['rcs-subcooling-margin-low', '<', 16.7, 'alarm', 'warning'],
    ])
  })

  test('fires as the margin drops through a stuck-open PORV', () => {
    const plantRun = started()
    plantRun.run(5_000)
    expect(Number(plantRun.tag('SUB-MARGIN'))).toBeGreaterThan(19.5)
    expect(plantRun.activeIds().filter(id => id.includes('subcooling'))).toEqual([])
    plantRun.act('pressurizer-relief-open', { positionPercent: 35 })
    const entered = new Map<string, number>()
    for (let second = 0; second < 300 && entered.size < 2; second += 1) {
      plantRun.run(1_000)
      for (const id of plantRun.activeIds()) if (id.includes('subcooling') && !entered.has(id)) entered.set(id, Number(plantRun.tag('SUB-MARGIN')))
    }
    // Each came in after its delay, past its limit; the low margin alarm first.
    expect([...entered.keys()]).toEqual(['alarm:rcs-subcooling-margin-low:subcooling-margin-low', 'alarm:rcs-subcooling-lost:subcooling-lost'])
    expect(entered.get('alarm:rcs-subcooling-margin-low:subcooling-margin-low')!).toBeLessThan(16.7)
    expect(entered.get('alarm:rcs-subcooling-lost:subcooling-lost')!).toBeLessThanOrEqual(0)
  })
})

describe('a turbine trip', () => {
  test('above P-9 trips the reactor, first out, and leaves no generator alarm', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.act('turbine-trip')
    plantRun.run(10_000)
    const trip = plantRun.protection.snapshot().trips.find(lifecycle => lifecycle.id === 'trip:reactor-turbine-trip:turbine-trip-reactor-trip')!
    expect(trip).toMatchObject({ active: true, firstOut: true })
    expect(plantRun.tag('TRIP-BKR-A-POS')).toBe(false)
    expect(plantRun.tag('TRIP-BKR-B-POS')).toBe(false)
    expect(Number(plantRun.read('core.powerMw'))).toBeLessThan(500)
    // The reactor trip it causes does not trip the reactor again, and no other trip comes in.
    expect(plantRun.protection.snapshot().trips.filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id)).toEqual(['trip:reactor-turbine-trip:turbine-trip-reactor-trip'])
    expect(plantRun.activeIds().filter(id => id.includes('generator-output-low') || id.includes('turbine-load-low'))).toEqual([])
  })

  test('below P-9 leaves the reactor at power', () => {
    const halfPower = compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:below-p9',
      parameterOverrides: { core: { initialPowerFraction: 0.4 } },
    }))
    const runtime = createProcessPlantRuntime({ system: halfPower })
    const protection = createProcessPlantProtectionRunner({ system: halfPower, protection: halfPower.automation })
    const step = () => {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-model-truth' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    for (let second = 0; second < 5; second += 1) step()
    expect(Number(runtime.readVariable('core.powerMw' as VariablePath))).toBeLessThan(1_700)
    for (const command of commandsForProcessPlantAction({ actionId: 'turbine-trip', parameters: {}, graph: halfPower.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    for (let second = 0; second < 10; second += 1) step()
    expect(runtime.readVariable('reactorTripBreakerA.closedState' as VariablePath)).toBe(true)
    expect(protection.snapshot().trips.find(lifecycle => lifecycle.id === 'trip:reactor-turbine-trip:turbine-trip-reactor-trip')!.active).toBe(false)
  })
})

describe('nuclear instrumentation', () => {
  test('at power the intermediate range reads high and the source range is de-energized', () => {
    const plantRun = started()
    plantRun.run(5_000)
    const current = Number(plantRun.tag('NIS-IR'))
    expect(current).toBeGreaterThan(4e-4)
    expect(current).toBeLessThanOrEqual(1e-3)
    expect(formatQuantity(current, 'amps')).toMatch(/^0\.000[1-9]\d A$/)
    expect(plantRun.tag('NIS-SR-HV')).toBe(false)
    expect(plantRun.tag('NIS-SR')).toBe(0)
  })

  test('after a trip the source range is energized below P-6 and counts', () => {
    const tripped = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:nis-trip', valueOverrides: { 'pressurizer.pressureMPa': 10 } }))
    const runtime = createProcessPlantRuntime({ system: tripped })
    const protection = createProcessPlantProtectionRunner({ system: tripped, protection: tripped.automation })
    const tag = (tagId: string) => runtime.readVariable(resolveProcessPlantSignalBinding(tripped.graph, { tagId: tagId as never }).path)
    let energizedAt: number | null = null
    for (let second = 1; second <= 600; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-model-truth' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
      if (energizedAt === null && tag('NIS-SR-HV') === true) {
        energizedAt = second
        // It comes on below P-6 at the top of its range.
        expect(Number(tag('NIS-SR'))).toBeGreaterThan(1_000)
        expect(Number(tag('NIS-SR'))).toBeLessThanOrEqual(100_010)
      }
    }
    expect(energizedAt).not.toBeNull()
    // Shut down, the source range counts the startup source and the intermediate range sits at the bottom of its span.
    expect(Number(tag('NIS-SR'))).toBeGreaterThanOrEqual(10)
    expect(Number(tag('NIS-SR'))).toBeLessThan(100)
    expect(Number(tag('NIS-IR'))).toBe(1e-11)
  })
})

describe('steam generator high level', () => {
  test('displays draw the high alarm and the P-14 high-high limit beside the low ones', () => {
    const level = resolveProcessPlantSignalBinding(graph, { tagId: 'SG-B-LVL-NR' as never }).path
    expect(icThresholdsForSignal(plant, level).thresholds.map(threshold => [threshold.value, threshold.kind, threshold.direction])).toEqual([
      [20, 'trip', 'low'],
      [30, 'alarm', 'low'],
      [75, 'alarm', 'high'],
      [82, 'trip', 'high'],
    ])
  })

  test('high-high level isolates main feedwater and trips the turbine, and so the reactor', () => {
    const overfilled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:sg-high-high', valueOverrides: { 'sgA.secondaryInventoryKg': 70_000 } }))
    const runtime = createProcessPlantRuntime({ system: overfilled })
    const protection = createProcessPlantProtectionRunner({ system: overfilled, protection: overfilled.automation })
    for (let second = 0; second < 10; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-model-truth' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    const tag = (tagId: string) => runtime.readVariable(resolveProcessPlantSignalBinding(overfilled.graph, { tagId: tagId as never }).path)
    expect(Number(tag('SG-A-LVL-NR'))).toBeGreaterThan(82)
    const active = [...protection.snapshot().alarms, ...protection.snapshot().trips].filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id)
    expect(active).toEqual(expect.arrayContaining([
      'alarm:sg-a-level-high:level-high',
      'trip:sg-a-level-high-high-feedwater-isolation:feedwater-isolation',
      'trip:reactor-turbine-trip:turbine-trip-reactor-trip',
    ]))
    expect(tag('MFW-PUMP-A-RUNNING')).toBe(false)
    expect(tag('MFW-PUMP-B-RUNNING')).toBe(false)
    expect(Number(tag('TURB-STOP-POS'))).toBeLessThan(0.05)
    expect(tag('TRIP-BKR-A-POS')).toBe(false)
  })
})

describe('signal labels', () => {
  test('no label in the reference model begins with a kebab-case id; link labels name the link by its ends', () => {
    const kebab = /^[a-z0-9]+(-[a-z0-9]+){2,}\b/u
    for (let loopCount = 2; loopCount <= 6; loopCount += 1) {
      const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:labels-${loopCount}`, loopCount }))
      const labels = [
        ...system.graph.variables.map(variable => variable.descriptor.label),
        ...system.graph.components.map(component => component.label),
      ]
      expect(labels.filter(label => kebab.test(label))).toEqual([])
    }
    const label = (path: string) => graph.signalBindingByPath.get(path as VariablePath)!.label
    expect(label('safety-accumulator-a-to-cold-leg-a.soluteConcentrationPpm')).toBe('Safety Injection Accumulator A to cold leg A boron concentration')
    expect(label('rcp-a-to-core.pressureDropMPa')).toBe('Reactor Coolant Pump A to cold leg A pressure drop')
    expect(label('pressurizer-surge-line.leakFlowKgPerS')).toBe('Hot leg A to Pressurizer leak flow')
  })
})
