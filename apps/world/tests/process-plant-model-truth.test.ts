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
import { itemBinding, flapText, framingRules } from '../src/packs/process-plant/displays/mimic/bindings.ts'
import { indexSample, itemLook } from '../src/packs/process-plant/displays/mimic/evaluate.ts'
import { icThresholdsForSignal } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import { formatQuantity } from '../src/packs/process-plant/displays/display-text.ts'
import { compileMimic } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { MIMIC_MAX_WIDTH } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { chatMimicProfile } from '../src/packs/process-plant/displays/mimic/profiles.ts'
import { itemRowTexts, pipeStatesLook } from '../src/packs/process-plant/displays/mimic/rows.ts'

// The reference PWR reports what its equipment does, beside what it is told
// to do: a feedback tag for each command tag, read from the solved state.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:model-truth', loopCount: 4 }))
const graph = plant.graph

const started = (system = plant) => {
  const runtime = createProcessPlantRuntime({ system })
  const protection = createProcessPlantProtectionRunner({ system, protection: system.automation })
  const run = (durationMs: number, options: { readonly withIc: boolean } = { withIc: true }) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += 1_000) {
      runtime.tick(1_000)
      if (options.withIc) protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-model-truth' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const act = (actionId: string, parameters: Readonly<Record<string, unknown>> = {}) => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters, graph: system.graph })) {
      runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
  }
  const tag = (tagId: string) => runtime.readVariable(resolveProcessPlantSignalBinding(system.graph, { tagId: tagId as never }).path)
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

  test('a standby diesel output breaker stands open and closes onto its dead bus only once the diesel runs', () => {
    const plantRun = started()
    plantRun.run(2_000)
    for (const train of ['A', 'B']) {
      expect(plantRun.tag(`EDG-${train}-RUN`), train).toBe(false)
      expect(plantRun.tag(`BRK-EDG-${train}-POS`), train).toBe(false)
    }
    expect(breakerLook(plant, 'dieselBreakerA', plantRun.read)).toMatchObject({ state: { kind: 'open' }, mismatch: null, words: 'open' })

    plantRun.act('loss-offsite-power')
    const firstTrue: Record<string, number> = {}
    for (let second = 1; second <= 30; second += 1) {
      plantRun.run(1_000)
      for (const train of ['A', 'B']) {
        // Never closed onto the bus before its diesel runs.
        if (plantRun.tag(`BRK-EDG-${train}-POS`) === true) expect(plantRun.tag(`EDG-${train}-RUN`), `${train} at ${second} s`).toBe(true)
        for (const tagId of [`EDG-${train}-RUN`, `BRK-EDG-${train}-POS`, `BUS-${train}-ENERGIZED`]) {
          if (plantRun.tag(tagId) === true) firstTrue[tagId] ??= second
        }
      }
    }
    for (const train of ['A', 'B']) {
      // The dead bus starts its diesel; it runs after its 10 s start, and then the sequencer closes its breaker.
      expect(firstTrue[`EDG-${train}-RUN`]!).toBeGreaterThanOrEqual(10)
      expect(firstTrue[`BRK-EDG-${train}-POS`]!).toBeGreaterThan(firstTrue[`EDG-${train}-RUN`]!)
      expect(firstTrue[`BRK-EDG-${train}-POS`]!).toBeLessThanOrEqual(15)
      expect(firstTrue[`BUS-${train}-ENERGIZED`]).toBe(firstTrue[`BRK-EDG-${train}-POS`])
    }
    expect(breakerLook(plant, 'dieselBreakerA', plantRun.read)).toMatchObject({ state: { kind: 'closed' }, mismatch: null, words: 'closed' })

    // The safety loads run on the diesels when demanded.
    const safetyPumps = ['AFW-PUMP-A', 'AFW-PUMP-B', 'SI-PUMP-A', 'SI-PUMP-B', 'CHG-PUMP-A', 'CHG-PUMP-B', 'RHR-PUMP-A', 'RHR-PUMP-B', 'CSPRAY-A', 'CSPRAY-B']
    for (const tagId of safetyPumps) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: resolveProcessPlantSignalBinding(graph, { tagId: tagId as never }).path, value: true })
    }
    plantRun.run(2_000)
    for (const tagId of safetyPumps) expect(plantRun.tag(`${tagId}-RUNNING`), tagId).toBe(true)

    // A diesel that fails opens its breaker, as its generator protection would;
    // back in service, it starts again and its breaker closes again onto the dead bus.
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'dieselGeneratorA.available' as VariablePath, value: false })
    plantRun.run(2_000)
    expect(plantRun.tag('EDG-A-RUN')).toBe(false)
    expect(plantRun.tag('BRK-EDG-A-CLOSED')).toBe(false)
    expect(plantRun.tag('BRK-EDG-A-POS')).toBe(false)
    expect(plantRun.tag('BUS-A-ENERGIZED')).toBe(false)
    expect(plantRun.tag('SI-PUMP-A-RUNNING')).toBe(false)
    expect(plantRun.tag('SI-PUMP-B-RUNNING')).toBe(true)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'dieselGeneratorA.available' as VariablePath, value: true })
    plantRun.run(15_000)
    expect(plantRun.tag('BRK-EDG-A-POS')).toBe(true)
    expect(plantRun.tag('SI-PUMP-A-RUNNING')).toBe(true)
  })

  test('a power line reads energized from what feeds it, and a drawn bus feeder from all its lines', () => {
    const plantRun = started()
    plantRun.run(2_000)
    const live = (linkId: string) => plantRun.read(`${linkId}.energized`)
    expect(live('offsite-breaker-a-to-safety-bus-a')).toBe(true)
    expect(live('diesel-generator-a-to-breaker-a')).toBe(false)
    expect(live('diesel-breaker-a-to-safety-bus-a')).toBe(false)
    expect(live('turbine-generator-to-unit-aux-transformer')).toBe(true)

    plantRun.act('loss-offsite-power')
    plantRun.run(60_000)
    // The open offsite breaker's line is dead, though the transformer feeding it is still live from the coasting generator's tail.
    expect(live('unit-aux-transformer-to-offsite-breaker-a')).toBe(plantRun.read('unitAuxTransformer.energized'))
    expect(live('offsite-breaker-a-to-safety-bus-a')).toBe(false)
    expect(live('diesel-generator-a-to-breaker-a')).toBe(true)
    expect(live('diesel-breaker-a-to-safety-bus-a')).toBe(true)
    expect(live('unit-bus-a-to-rcpA')).toBe(false)

    const drawn = (intent: Parameters<typeof compileMimic>[1]) => {
      const drawing = compileMimic(plant, intent, { profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: 900 })
      if (!drawing.ok) throw new Error(JSON.stringify(drawing.issues))
      return { mimic: drawing.mimic, sample: indexSample(drawing.mimic.paths.map(path => ({ path, value: plantRun.read(path), quality: 'good' }))) }
    }
    // Drawn from the diesel to its pump, every line between them reads live.
    const route = drawn({ from: ['dieselGeneratorA'], to: ['auxFeedwaterPumpMotor'] })
    const lines = route.mimic.pipes.filter(pipe => !route.mimic.stubs.some(stub => pipe.id.startsWith(`${stub.id}.`)))
    expect(lines.map(pipe => pipeStatesLook([pipe.state], route.sample))).toEqual(lines.map(() => 'live'))
    // Around the pump, the bus's two feeders stop the drawing as one stub: live, as its diesel feeder is.
    const around = drawn({ around: ['auxFeedwaterPumpMotor'], reach: 1 })
    const feeders = around.mimic.stubs.find(stub => stub.states.length === 2 && stub.states.every(state => state.kind === 'power'))!
    expect(feeders.states.map(state => pipeStatesLook([state], around.sample)).sort()).toEqual(['dead', 'live'])
    expect(pipeStatesLook(feeders.states, around.sample)).toBe('live')
  })

  test('a drawn bus reads its voltage, and a drawn diesel its running state from its run feedback', () => {
    const plantRun = started()
    plantRun.run(2_000)
    const drawing = compileMimic(plant, { from: ['dieselGeneratorA'], to: ['auxFeedwaterPumpMotor'] }, { profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: 900 })
    if (!drawing.ok) throw new Error(JSON.stringify(drawing.issues))
    const rowsOf = (label: string) => {
      const item = drawing.mimic.items.find(candidate => candidate.binding.label === label)!
      const sample = indexSample(drawing.mimic.paths.map(path => ({ path, value: plantRun.read(path), quality: 'good' })))
      return itemRowTexts(item.binding, item.presentation, item.rows, sample, formatQuantity)
    }
    expect(drawing.mimic.items.find(item => item.binding.label === 'EDG A')!.binding.state).toMatchObject({ aspect: 'running', state: { path: 'dieselGeneratorA.running' }, command: 'dieselGeneratorA.startCommand' })
    expect(rowsOf('Bus A')).toEqual(['100 %'])
    expect(rowsOf('EDG A')).toEqual(['STOP'])
    plantRun.act('loss-offsite-power')
    plantRun.run(5_000)
    // Started on the dead bus and not yet up to speed: its start command shows beside it.
    expect(rowsOf('EDG A')).toEqual(['CMD RUN'])
    expect(rowsOf('Bus A')).toEqual(['0 %'])
    plantRun.run(20_000)
    // Running, the symbol shows it, as a pump's does.
    expect(rowsOf('EDG A')).toEqual([''])
    expect(rowsOf('Bus A')).toEqual(['100 %'])
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

describe('offsite power alarms', () => {
  test('each names one cause: a grid with no voltage is lost, a sagging grid degraded', () => {
    const flap = (ruleId: string) => flapText(plant, plant.automation.rules.find(rule => rule.id === ruleId)!, undefined)
    expect(flap('loss-of-offsite-power')).toBe('V LO-LO')
    expect(flap('offsite-grid-degraded-voltage')).toBe('V LO')
    const plantRun = started()
    plantRun.run(2_000)
    plantRun.act('loss-offsite-power')
    plantRun.run(5_000)
    expect(plantRun.activeIds()).toContain('alarm:loss-of-offsite-power:loss-of-offsite-power')
  })
})

describe('auxiliary feedwater on a loss of offsite power', () => {
  test('starts: the turbine-driven pump with its bus, each motor-driven pump on its diesel\'s sequencer, every steam generator fed', () => {
    const plantRun = started()
    plantRun.run(2_000)
    plantRun.act('loss-offsite-power')
    const firstTrue: Record<string, number> = {}
    for (let second = 1; second <= 40; second += 1) {
      plantRun.run(1_000)
      for (const tagId of ['BRK-EDG-A-POS', 'BRK-EDG-B-POS', 'AFW-PUMP-A-RUNNING', 'AFW-PUMP-B-RUNNING', 'AFW-PUMP-T-RUNNING']) {
        if (plantRun.tag(tagId) === true) firstTrue[tagId] ??= second
      }
    }
    // The motor-driven pumps come on in the sequencer's step 5 s after their diesel's breaker closes, not with it.
    expect(firstTrue['AFW-PUMP-A-RUNNING']! - firstTrue['BRK-EDG-A-POS']!).toBeGreaterThanOrEqual(5)
    expect(firstTrue['AFW-PUMP-B-RUNNING']! - firstTrue['BRK-EDG-B-POS']!).toBeGreaterThanOrEqual(5)
    expect(firstTrue['AFW-PUMP-A-RUNNING']!).toBeLessThanOrEqual(25)
    expect(firstTrue['AFW-PUMP-T-RUNNING']!).toBeLessThanOrEqual(firstTrue['AFW-PUMP-A-RUNNING']!)
    expect(plantRun.activeIds()).toContain('trip:loss-of-offsite-power-afw-actuation:afw-actuation')
    // The main feedwater pumps stop with their unit buses, which is no main feedwater pump trip: it would start the
    // motor-driven pumps with the block of loads, ahead of their sequencer step.
    expect(plantRun.activeIds()).not.toContain('trip:main-feedwater-pumps-tripped-afw-start:afw-start')
    // Lined up wide open, the pumps rated like a 4-loop PWR's feed each steam generator about its share of the design flow.
    for (const loop of ['a', 'b', 'c', 'd']) {
      const flow = Number(plantRun.read(`aux-feedwater-valve-${loop}-to-sg-${loop}.flowKgPerS`))
      expect(flow, loop).toBeGreaterThan(15)
      expect(flow, loop).toBeLessThan(40)
    }
  })

  test('in a station blackout only the turbine-driven pump feeds, as ECA-0.0 expects', () => {
    const plantRun = started()
    plantRun.run(2_000)
    for (const train of ['A', 'B']) plantRun.runtime.writeCommand({ type: 'setVariable', path: `dieselGenerator${train}.available` as VariablePath, value: false })
    plantRun.act('loss-offsite-power')
    plantRun.run(60_000)
    expect(plantRun.tag('BUS-A-ENERGIZED')).toBe(false)
    expect(plantRun.tag('BUS-B-ENERGIZED')).toBe(false)
    expect(plantRun.tag('AFW-PUMP-T-RUNNING')).toBe(true)
    expect(plantRun.tag('AFW-PUMP-A-RUNNING')).toBe(false)
    expect(plantRun.tag('AFW-PUMP-B-RUNNING')).toBe(false)
    expect(Number(plantRun.read('aux-feedwater-valve-a-to-sg-a.flowKgPerS'))).toBeGreaterThan(5)
  })

  test('a turbine trip with offsite power available does not start it', () => {
    const plantRun = started()
    plantRun.run(2_000)
    plantRun.act('turbine-trip')
    plantRun.run(30_000)
    expect(plantRun.tag('UNIT-BUS-A-ENERGIZED')).toBe(true)
    expect(plantRun.tag('RCP-A-RUNNING')).toBe(true)
    expect(plantRun.tag('AFW-PUMP-A-RUNNING')).toBe(false)
    expect(plantRun.activeIds()).not.toContain('trip:loss-of-offsite-power-afw-actuation:afw-actuation')
  })
})

describe('emergency diesel ratings', () => {
  const trainASafetyPumps = ['AFW-PUMP-A', 'SI-PUMP-A', 'CHG-PUMP-A', 'RHR-PUMP-A', 'CSPRAY-A']
  const onDieselWithTrainALoads = (plantRun: ReturnType<typeof started>, system: typeof plant) => {
    plantRun.run(2_000)
    plantRun.act('loss-offsite-power')
    plantRun.run(30_000)
    for (const tagId of trainASafetyPumps) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: resolveProcessPlantSignalBinding(system.graph, { tagId: tagId as never }).path, value: true })
    }
    plantRun.run(10_000)
  }

  test('a diesel is rated as a 4-loop PWR EDG and carries every safety load of its train', () => {
    for (const id of ['dieselGeneratorA', 'dieselGeneratorB']) {
      expect(graph.components[graph.componentIndexById.get(id as never)!]!.parameters).toMatchObject({ nominalPowerMw: 7 })
    }
    const plantRun = started()
    onDieselWithTrainALoads(plantRun, plant)
    for (const tagId of trainASafetyPumps) expect(plantRun.tag(`${tagId}-RUNNING`), tagId).toBe(true)
    expect(Number(plantRun.read('safetyBusA.servedLoadMw'))).toBeGreaterThan(1)
    expect(Number(plantRun.tag('BUS-A-MARGIN'))).toBeGreaterThan(3)
    expect(plantRun.activeIds().filter(id => id.includes('overload'))).toEqual([])
  })

  test('a diesel loaded to its rating annunciates overload', () => {
    const small = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:small-diesel', parameterOverrides: { dieselGeneratorA: { nominalPowerMw: 1.5 } } }))
    const plantRun = started(small)
    onDieselWithTrainALoads(plantRun, small)
    expect(Number(plantRun.tag('BUS-A-MARGIN'))).toBe(0)
    expect(plantRun.activeIds()).toContain('alarm:diesel-generator-a-overload:overload')
    expect(plantRun.activeIds()).not.toContain('alarm:diesel-generator-b-overload:overload')
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

  test('after a loss of offsite power the non-safety pumps coast down and stay off while the diesels carry the safety buses', () => {
    const plantRun = started()
    plantRun.run(2_000)
    plantRun.act('loss-offsite-power')
    plantRun.run(60_000)
    // The safety buses are back on their diesels; the unit buses, fed only from offsite through the UAT, stay dead.
    expect(plantRun.tag('BUS-A-ENERGIZED')).toBe(true)
    expect(plantRun.tag('BUS-B-ENERGIZED')).toBe(true)
    expect(plantRun.tag('UNIT-BUS-A-ENERGIZED')).toBe(false)
    expect(plantRun.tag('UNIT-BUS-B-ENERGIZED')).toBe(false)
    for (const loop of ['A', 'B', 'C', 'D']) {
      expect(plantRun.tag(`RCP-${loop}-RUN`), loop).toBe(true)
      expect(plantRun.tag(`RCP-${loop}-RUNNING`), loop).toBe(false)
      expect(Number(plantRun.tag(`RCP-${loop}-FLOW`)), loop).toBeLessThan(600)
    }
    for (const id of ['mainFeedwaterPumpA', 'mainFeedwaterPumpB', 'condensatePumpA', 'condensatePumpB', 'circulatingWaterPump']) {
      expect(plantRun.read(`${id}.runningState`), id).toBe(false)
    }
    // The pressurizer heaters are a unit bus load too: they draw nothing until offsite power returns.
    expect(plantRun.read('pressurizer.demandMw')).toBe(0)
    // The reactor trips on the pumps' run feedback as their bus goes dead; with its trip breakers open the Plant is out
    // of power operation, where the low-flow trip acts, so that trip never comes in.
    expect(plantRun.activeIds()).toEqual(expect.arrayContaining(['alarm:rcp-a-trip:not-running', 'trip:reactor-rcp-breaker-open-trip:rcp-breaker-open-trip']))
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
    // The steam generator low-low level trips and the auxiliary feedwater start on
    // a main feedwater pump trip act wherever the reactor can be critical, safety
    // injection down to hot standby, the feedwater isolation after a trip in hot
    // standby; every other qualified rule only at power.
    const notOnlyAtPower = Object.fromEntries(qualified.filter(rule => JSON.stringify(rule.modes) !== '["powerOperation"]').map(rule => [rule.id, rule.modes]))
    expect(notOnlyAtPower).toEqual({
      ...Object.fromEntries(['a', 'b', 'c', 'd'].map(loop => [`sg-${loop}-level-low-low-reactor-trip`, ['powerOperation', 'startup']])),
      'safety-injection-low-pzr-pressure': ['powerOperation', 'startup', 'hotStandby'],
      'main-feedwater-pumps-tripped-afw-start': ['powerOperation', 'startup'],
      'reactor-trip-low-tavg-feedwater-isolation': ['hotStandby'],
    })
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
    // Long enough for the flow alarm, short of the low-low level trip the runback leads to.
    plantRun.run(40_000)
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
    // Safety injection comes in about a minute after the reactor trips and slows the fall, so the coolant
    // reaches saturation some six minutes in.
    for (let second = 0; second < 600 && entered.size < 2; second += 1) {
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

  test('isolates main feedwater on P-4 and low Tavg; steam generator level shrinks and the steam dumps hold pressure', () => {
    const plantRun = started()
    plantRun.run(5_000)
    const levelBefore = Number(plantRun.tag('SG-A-LVL-NR'))
    plantRun.act('turbine-trip')
    let highestLevel = levelBefore
    let highestPressure = 0
    let dumpOpening = 0
    let safetyValveOpening = 0
    for (let second = 0; second < 60; second += 1) {
      plantRun.run(1_000)
      highestLevel = Math.max(highestLevel, Number(plantRun.tag('SG-A-LVL-NR')))
      highestPressure = Math.max(highestPressure, Number(plantRun.tag('SG-A-PRESS')))
      dumpOpening = Math.max(dumpOpening, Number(plantRun.tag('TURB-BYP-POS')))
      safetyValveOpening = Math.max(safetyValveOpening, Number(plantRun.read('mainSteamSafetyValve.effectivePositionFraction')))
    }
    expect(plantRun.activeIds()).toContain('trip:reactor-trip-low-tavg-feedwater-isolation:feedwater-isolation')
    expect(plantRun.tag('MFW-PUMP-A-RUNNING')).toBe(false)
    expect(plantRun.tag('MFW-PUMP-B-RUNNING')).toBe(false)
    // The voids collapse as steaming falls: the level shrinks, it does not swell.
    expect(highestLevel).toBeLessThan(levelBefore + 1)
    expect(Number(plantRun.tag('SG-A-LVL-NR'))).toBeLessThan(levelBefore - 20)
    // The dumps open to the condenser and the safety valves stay shut.
    expect(dumpOpening).toBeGreaterThan(0.3)
    expect(highestPressure).toBeLessThan(8.1)
    expect(safetyValveOpening).toBe(0)
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
  }, 120_000) // A tripped Run held for minutes, the same watchdog as the runtime's long trajectories.
})

describe('flows declared through a port', () => {
  // A kind's declared port flow is what every link on that port carries together; displays judge a line by it.
  const portFlowsHold = (system: typeof plant, read: (path: VariablePath) => unknown) => {
    for (const component of system.graph.components) {
      for (const flow of component.semantics.portFlows) {
        const links = system.graph.links.filter(link => (link.toComponentIndex === component.index && link.toPortName === flow.port) || (link.fromComponentIndex === component.index && link.fromPortName === flow.port))
        expect(links.length).toBeGreaterThan(0)
        const carried = links.reduce((sum, link) => sum + Number(read(link.variables.find(variable => String(variable.path).endsWith('.flowKgPerS'))!.path)), 0)
        expect(Number(read(flow.path)), String(flow.path)).toBeCloseTo(carried, 6)
      }
    }
  }

  test('a steam generator\'s feedwater inflow is what its main and auxiliary feed lines bring in', () => {
    const plantRun = started()
    plantRun.run(5_000)
    portFlowsHold(plant, path => plantRun.read(path))
    // Main feed lost, auxiliary feed starts, and the inflow is still both lines together. The main feedwater pump trip
    // starts the motor-driven pumps at once, low-low level the turbine-driven one about a minute in; all three, rated
    // like a 4-loop PWR's, feed each steam generator some 30 kg/s.
    plantRun.act('loss-main-feedwater')
    plantRun.run(120_000)
    expect(Number(plantRun.read('aux-feedwater-valve-b-to-sg-b.flowKgPerS'))).toBeGreaterThan(25)
    portFlowsHold(plant, path => plantRun.read(path))
  })
})

describe('steam generator high level', () => {
  test('displays draw the high alarm and the P-14 high-high limit beside the low ones', () => {
    const level = resolveProcessPlantSignalBinding(graph, { tagId: 'SG-B-LVL-NR' as never }).path
    expect(icThresholdsForSignal(plant, level).thresholds.map(threshold => [threshold.value, threshold.kind, threshold.direction])).toEqual([
      // Low-low starts auxiliary feedwater and, at the same set point, trips the reactor.
      [20, 'trip', 'low'],
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

describe('steam generator low-low level', () => {
  const lifecycleOf = (plantRun: ReturnType<typeof started>, id: string) =>
    plantRun.protection.snapshot().trips.find(lifecycle => lifecycle.id === id)!
  const reactorTripOf = (loop: string) => `trip:sg-${loop}-level-low-low-reactor-trip:low-low-level-reactor-trip`

  // Run until the trip breakers read open, and say when and at what level.
  const runToReactorTrip = (plantRun: ReturnType<typeof started>) => {
    for (let second = 1; second <= 300; second += 1) {
      plantRun.run(1_000)
      if (plantRun.tag('TRIP-BKR-A-POS') === false) return { second, level: Number(plantRun.tag('SG-A-LVL-NR')), tubeCoverage: Number(plantRun.read('sgA.tubeCoverageFraction')) }
    }
    throw new Error('the reactor did not trip within 300 s of the loss of main feedwater')
  }

  test('a loss of main feedwater trips the reactor first out on low-low level, and the turbine with it', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.act('loss-main-feedwater')
    const tripped = runToReactorTrip(plantRun)
    // The trip comes in as the level crosses the 20 % set point, not later on another limit.
    expect(tripped.level).toBeLessThan(20)
    expect(tripped.level).toBeGreaterThan(18)
    // The narrow range sits above the tube bundle: at the trip the tubes are still covered.
    expect(tripped.tubeCoverage).toBe(1)
    plantRun.run(30_000)
    expect(lifecycleOf(plantRun, reactorTripOf('a'))).toMatchObject({ active: true, firstOut: true })
    const active = plantRun.protection.snapshot().trips.filter(lifecycle => lifecycle.active)
    expect(active.filter(lifecycle => lifecycle.firstOut).map(lifecycle => lifecycle.id)).toEqual([reactorTripOf('a')])
    // The turbine trip the reactor trip causes does not trip the reactor again.
    expect(active.map(lifecycle => lifecycle.id)).not.toContain('trip:reactor-turbine-trip:turbine-trip-reactor-trip')
    expect(plantRun.tag('TRIP-BKR-B-POS')).toBe(false)
    expect(Number(plantRun.read('core.powerMw'))).toBeLessThan(100)
    expect(Number(plantRun.tag('TURB-STOP-POS'))).toBeLessThan(0.05)
    expect(Number(plantRun.tag('GEN-MW'))).toBeLessThan(25)
  })

  test('auxiliary feedwater starts with the pumps tripping, then refills the generators with their tubes covered', () => {
    const plantRun = started()
    plantRun.run(5_000)
    plantRun.act('loss-main-feedwater')
    plantRun.run(3_000)
    // Losing both main feedwater pumps starts the motor-driven pumps at once.
    expect(plantRun.activeIds()).toContain('trip:main-feedwater-pumps-tripped-afw-start:afw-start')
    expect(plantRun.tag('AFW-PUMP-A-RUNNING')).toBe(true)
    expect(plantRun.tag('AFW-PUMP-B-RUNNING')).toBe(true)
    runToReactorTrip(plantRun)
    plantRun.run(30_000)
    // Low-low level starts the turbine-driven pump too.
    expect(plantRun.tag('AFW-PUMP-T-RUNNING')).toBe(true)
    // The voids collapse with the trip: the narrow range shrinks off scale low,
    // while the full-height water inventory stays above the tube bundle.
    const collapsedAfterTrip = ['A', 'B', 'C', 'D'].map(loop => Number(plantRun.read(`sg${loop}.collapsedLevelPercent`)))
    let leastCoverage = 1
    for (let second = 0; second < 300; second += 10) {
      plantRun.run(10_000)
      leastCoverage = Math.min(leastCoverage, ...['A', 'B', 'C', 'D'].map(loop => Number(plantRun.read(`sg${loop}.tubeCoverageFraction`))))
    }
    expect(leastCoverage).toBe(1)
    for (const [index, loop] of ['A', 'B', 'C', 'D'].entries()) {
      expect(Number(plantRun.read(`sg${loop}.feedwaterFlowKgPerS`)), loop).toBeGreaterThan(20)
      expect(Number(plantRun.read(`sg${loop}.collapsedLevelPercent`)), loop).toBeGreaterThan(collapsedAfterTrip[index]! + 2)
    }
    expect(Number(plantRun.read('core.powerMw'))).toBeLessThan(1)
  })
})

describe('main steam safety valves', () => {
  test('lift to the atmosphere outside containment, which does not pressurize', () => {
    const discharge = graph.links.find(link => graph.components[link.fromComponentIndex]!.id === 'mainSteamSafetyValve')!
    expect(String(graph.components[discharge.toComponentIndex]!.kind)).toBe('atmosphereBoundary')

    const overpressured = compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:mssv-lift',
      valueOverrides: Object.fromEntries(['A', 'B', 'C', 'D'].map(loop => [`sg${loop}.pressureMPa`, 10])),
    }))
    const runtime = createProcessPlantRuntime({ system: overpressured })
    const protection = createProcessPlantProtectionRunner({ system: overpressured, protection: overpressured.automation })
    const read = (path: string) => Number(runtime.readVariable(path as VariablePath))
    runtime.tick(1_000)
    const containmentPressure = read('containment.pressureMPa')
    let lift = 0
    let containmentInflow = 0
    for (let second = 0; second < 30; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-model-truth' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
      lift = Math.max(lift, read('mainSteamSafetyValve.effectivePositionFraction'))
      containmentInflow = Math.max(containmentInflow, read('containment.incomingMassKgPerS'))
    }
    expect(lift).toBeGreaterThan(0.9)
    expect(read('atmosphere.releasedMassKg')).toBeGreaterThan(1_000)
    expect(protection.snapshot().alarms.find(lifecycle => lifecycle.id === 'alarm:main-steam-safety-valve-open:safety-valve-open')!.firstActiveElapsedMs).toBeDefined()
    expect(containmentInflow).toBe(0)
    expect(read('containment.pressureMPa')).toBeCloseTo(containmentPressure, 9)
  })
})

describe('steam generator atmospheric relief valves', () => {
  test('with the condenser lost, they hold steam pressure near their set point and the coolant subcooled on natural circulation', () => {
    const plantRun = started()
    plantRun.run(5_000)
    // A loss of offsite power as the steam side sees it: the coolant pumps, the
    // main feedwater pumps and circulating water all stop.
    for (const path of ['rcpA.running', 'rcpB.running', 'rcpC.running', 'rcpD.running', 'mainFeedwaterPumpA.running', 'mainFeedwaterPumpB.running', 'circulatingWaterPump.running']) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value: false })
    }
    let leastSubcooling = Number.POSITIVE_INFINITY
    let dumpOpening = 0
    let safetyValveOpening = 0
    const pressures: number[] = []
    for (let second = 1; second <= 1_200; second += 1) {
      plantRun.run(1_000)
      leastSubcooling = Math.min(leastSubcooling, Number(plantRun.tag('SUB-MARGIN')))
      if (second > 120) dumpOpening = Math.max(dumpOpening, Number(plantRun.tag('TURB-BYP-POS')))
      safetyValveOpening = Math.max(safetyValveOpening, Number(plantRun.read('mainSteamSafetyValve.effectivePositionFraction')))
      if (second > 900) pressures.push(Number(plantRun.tag('SG-A-PRESS')))
    }
    expect(plantRun.tag('TRIP-BKR-A-POS')).toBe(false)
    // Without circulating water the dumps are blocked (C-9); the relief valves vent to the atmosphere instead.
    expect(dumpOpening).toBeLessThan(0.01)
    expect(Number(plantRun.tag('SG-A-ARV-POS'))).toBeGreaterThan(0.05)
    expect(plantRun.activeIds()).toContain('alarm:sg-a-atmospheric-relief-valve-open:atmospheric-relief-valve-open')
    expect(Number(plantRun.read('atmosphere.releasedMassKg'))).toBeGreaterThan(1_000)
    expect(Math.min(...pressures)).toBeGreaterThan(7.86)
    expect(Math.max(...pressures)).toBeLessThan(8.1)
    expect(safetyValveOpening).toBe(0)
    expect(leastSubcooling).toBeGreaterThan(15)
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
