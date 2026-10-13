import { describe, expect, test } from 'bun:test'
import {
  assemblePwrReferencePlantGraph,
  compilePlantGraph,
  compileProcessPlant,
  createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
  ratedFlowForLink,
  type ComponentDefinition,
  type ComponentKind,
  type CompiledPlantGraph,
  type PlantGraphSpec,
} from '../src/packs/process-plant/index.ts'
import { component, connect, plantGraph } from '../src/packs/process-plant/graph/builder.ts'
import { fixedSemantics, aspect } from '../src/packs/process-plant/graph/semantics.ts'
import { variable } from '../src/packs/process-plant/graph/component-definition-helpers.ts'
import { processLinkFlowFidelityFor } from '../src/packs/process-plant/runtime/links/link-flow-fidelity.ts'
import { processPlantSignalView } from '../src/packs/process-plant/signals.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

const reference = (loopCount: number) => compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:semantics-${loopCount}`, loopCount }))
const plant = reference(4)
const graph = plant.graph
const componentById = (graph: CompiledPlantGraph, id: string) => graph.components[graph.componentIndexById.get(id as never)!]!
const linkById = (id: string) => graph.links.find(link => String(link.id) === id)!

describe('model semantics declared per component kind', () => {
  test('every writable signal says what writing it does, and every ratio what it measures', () => {
    for (const loopCount of [2, 3, 4, 5, 6]) {
      for (const binding of reference(loopCount).graph.signalBindings) {
        if (binding.writable) expect(binding.actuation, binding.path).toBeDefined()
        if (binding.quantity === 'ratio') expect(binding.measurand, binding.path).toBeDefined()
      }
    }
    const actuation = (path: string) => graph.signalBindingByPath.get(path as never)!.actuation
    expect(actuation('rcpA.running')).toBe('command')
    expect(actuation('pressurizer.reliefValvePositionFraction')).toBe('command')
    expect(actuation('sgB.tubeLeakFraction')).toBe('faultInjection')
    expect(actuation('feedwaterControlValveB.failedPositionFraction')).toBe('faultInjection')
    expect(actuation('offsiteGrid.available')).toBe('boundary')
    expect(actuation('rcs-hot-leg-a.leak.areaFraction')).toBe('faultInjection')
  })

  test('values no plant instrument measures are marked simulator-only, the instruments are not', () => {
    const simulatorOnly = (path: string) => graph.signalBindingByPath.get(path as never)!.simulatorOnly === true
    for (const path of [
      'core.coreHeatRemovalDeficitMw', 'core.fuelHeatupRateCPerS', 'core.fuelTemperatureC', 'core.reactivityPcm',
      'safetyBusA.marginMw', 'safetyBusB.availablePowerMw', 'sgA.primaryToSecondaryLeakKgPerS', 'vessel.tubeLeakFlowKgPerS',
      'pressurizer.reliefFlowKgPerS', 'pressurizer.safetyValveFlowKgPerS', 'pressurizer-relief-to-tank.flowKgPerS', 'rcs-hot-leg-a.leakFlowKgPerS',
    ]) expect(simulatorOnly(path), path).toBe(true)
    for (const path of [
      'pressurizer.pressureMPa', 'pressurizer.levelPercent', 'sgA.levelPercent', 'sgA.wideRangeLevelPercent', 'core.powerRangePercent',
      'core.coreExitTemperatureC', 'rcsInventoryBalance.leakRateKgPerS', 'safetyBusA.energized', 'pressurizer.reliefValveEffectivePositionFraction',
      // What the containment's high-range radiation monitors read, which its critical safety function judges.
      'containment.radiationSourceTermMSvPerH',
    ]) expect(simulatorOnly(path), path).toBe(false)
    // A writable signal is a command or a fault, never a diagnostic.
    for (const binding of graph.signalBindings) if (binding.writable) expect(binding.simulatorOnly, binding.path).toBeUndefined()
    // Signal discovery carries the mark to the agents.
    expect(processPlantSignalView(graph.signalBindingByPath.get('core.coreHeatRemovalDeficitMw' as never)!).simulatorOnly).toBe(true)
    expect(processPlantSignalView(graph.signalBindingByPath.get('pressurizer.pressureMPa' as never)!).simulatorOnly).toBeUndefined()
  })

  test('equipment state comes from a solved signal, and its command only from a writable one', () => {
    for (const compiled of graph.components) {
      const aspects = [...compiled.semantics.aspects, ...compiled.semantics.embedded.flatMap(device => device.aspects)]
      for (const declared of aspects) {
        if (declared.state !== undefined) {
          const state = graph.signalBindingByPath.get(declared.state.path)!
          expect(!state.writable || state.actuation === 'boundary', `${compiled.id} ${declared.aspect}`).toBe(true)
        }
        if (declared.command !== undefined) expect(graph.signalBindingByPath.get(declared.command)!.actuation).toBe('command')
      }
    }
    // A pump runs while its motor is commanded to run and has power, whatever its run command alone says; a valve sits where it actually is.
    expect(componentById(graph, 'rcpA').semantics.aspects).toEqual([{ aspect: 'running', state: { path: 'rcpA.runningState' as never, reading: 'true' }, command: 'rcpA.running' as never, travel: { onS: 0, offS: 0 } }])
    expect(componentById(graph, 'feedwaterControlValveB').semantics.aspects[0]!.state!.path).toBe('feedwaterControlValveB.effectivePositionFraction' as never)
  })

  test('the PORV is a device on the pressurizer relief outlet whose position is the opening the model relieves through', () => {
    const [block, porv] = componentById(graph, 'pressurizer').semantics.embedded
    // Its motor-operated block valve sits before it on the same line, read from its own position feedback.
    expect(block).toMatchObject({ id: 'blockValve', function: 'isolating', port: 'reliefOutlet' })
    expect(block!.aspects).toEqual([
      { aspect: 'position', state: { path: 'pressurizer.blockValveEffectivePositionFraction' as never, reading: 'value' }, command: 'pressurizer.blockValvePositionFraction' as never, travel: { onS: 10, offS: 10 } },
    ])
    expect(porv).toMatchObject({ id: 'reliefValve', function: 'relieving', port: 'reliefOutlet' })
    // The spring-loaded code safety valves relieve on their own outlet, with no command: their lift is all they report.
    const safeties = componentById(graph, 'pressurizer').semantics.embedded[2]!
    expect(safeties).toMatchObject({ id: 'safetyValves', function: 'relieving', port: 'safetyOutlet' })
    expect(safeties.aspects).toEqual([
      { aspect: 'position', state: { path: 'pressurizer.safetyValvesLiftFraction' as never, reading: 'value' } },
      { aspect: 'throughput', state: { path: 'pressurizer.safetyValveFlowKgPerS' as never, reading: 'flow' } },
    ])
    expect(porv!.aspects).toEqual([
      { aspect: 'position', state: { path: 'pressurizer.reliefValveEffectivePositionFraction' as never, reading: 'value' }, command: 'pressurizer.reliefValvePositionFraction' as never, travel: { onS: 0, offS: 0 } },
      { aspect: 'throughput', state: { path: 'pressurizer.reliefFlowKgPerS' as never, reading: 'flow' } },
    ])
  })

  test('a breaker position is its contacts, closed while its solved state reads true', () => {
    expect(componentById(graph, 'offsiteBreakerA').semantics.aspects).toEqual([
      { aspect: 'energized', state: { path: 'offsiteBreakerA.energized' as never, reading: 'true' } },
      { aspect: 'position', state: { path: 'offsiteBreakerA.closedState' as never, reading: 'closedWhileTrue' }, command: 'offsiteBreakerA.closed' as never, travel: { onS: 0, offS: 0 } },
    ])
  })

  test('valves say what they do from their mode', () => {
    const functionOf = (id: string) => componentById(graph, id).semantics.function
    // The behaviour treats a valve without a mode (a feed regulating valve) as a control valve, and so do its semantics.
    expect(functionOf('feedwaterControlValveB')).toBe('modulating')
    expect(functionOf('rhrIsolationValve')).toBe('isolating')
    expect(functionOf('mainSteamSafetyValveA')).toBe('relieving')
    // The main steam isolation valves are trip valves, read open or shut.
    expect(functionOf('mainSteamIsolationValveA')).toBe('isolating')
  })

  test('circuits keep the primary and secondary sides of a steam generator apart', () => {
    const ports = componentById(graph, 'sgB').ports
    expect(ports.primaryInlet!.circuit).toBe('primary')
    expect(ports.primaryOutlet!.circuit).toBe('primary')
    expect(ports.feedwaterInlet!.circuit).toBe('secondary')
    expect(ports.steamOutlet!.circuit).toBe('secondary')
    // A pump's power supply is where a route ends, not a way through the pump.
    expect(componentById(graph, 'rcpA').ports.power!.circuit).toBeUndefined()
    // Ports added per loop join their component's circuit.
    expect(componentById(graph, 'core').ports.hotLegD!.circuit).toBe('coolant')
  })

  test('a kind that names a writable signal as its state is rejected', () => {
    const faulty: ComponentDefinition = {
      ...processPlantComponentRegistry.get('centrifugalPump' as ComponentKind)!,
      semantics: fixedSemantics({ aspects: [aspect('running', { variable: 'running', reading: 'true' })] }),
    }
    const registry = new Map([...processPlantComponentRegistry, ['centrifugalPump' as ComponentKind, faulty]])
    const spec = plantGraph({
      id: 'semantics.faulty',
      title: 'Faulty',
      fixedStepMs: 100,
      components: [component('pump', 'centrifugalPump', 'Pump', { nominalFlowKgPerS: 10, nominalHeadPa: 1e5 })],
      connections: [],
    })
    expect(() => compilePlantGraph(spec, registry)).toThrow('component pump semantics: running state running is writable, so it would draw a demand as the state')
  })

  test('a ratio may measure a flow, a loop\'s flow in percent of its rated flow', () => {
    const base = processPlantComponentRegistry.get('centrifugalPump' as ComponentKind)!
    const withFlowShare: ReadonlyMap<ComponentKind, ComponentDefinition> = new Map([...processPlantComponentRegistry, ['centrifugalPump' as ComponentKind, {
      ...base,
      variables: [...base.variables, variable({ path: 'flowPercent', label: 'Flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'flow', quantity: 'ratio', unit: 'percent' })],
    }]])
    const spec = plantGraph({
      id: 'semantics.flow-share',
      title: 'Flow share',
      fixedStepMs: 100,
      components: [component('pump', 'centrifugalPump', 'Pump', { nominalFlowKgPerS: 10, nominalHeadPa: 1e5 })],
      connections: [],
    })
    const compiled = compilePlantGraph(spec, withFlowShare)
    expect(compiled.variables.find(entry => String(entry.path) === 'pump.flowPercent')!.descriptor).toMatchObject({ quantity: 'ratio', unit: 'percent', measurand: 'flow' })
    expect(() => variable({ path: 'flowPercent', label: 'Flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'throughput' as never, quantity: 'ratio', unit: 'percent' })).toThrow()
  })

  test('an energy role must name circuits the kind\'s ports have', () => {
    const faulty: ComponentDefinition = {
      ...processPlantComponentRegistry.get('centrifugalPump' as ComponentKind)!,
      semantics: fixedSemantics({ energy: [{ role: 'transfer', from: 'flow', to: 'shell' }] }),
    }
    const registry = new Map([...processPlantComponentRegistry, ['centrifugalPump' as ComponentKind, faulty]])
    const spec = plantGraph({
      id: 'semantics.energy',
      title: 'Energy',
      fixedStepMs: 100,
      components: [component('pump', 'centrifugalPump', 'Pump', { nominalFlowKgPerS: 10, nominalHeadPa: 1e5 })],
      connections: [],
    })
    expect(() => compilePlantGraph(spec, registry)).toThrow('component pump semantics: energy transfer names circuit shell, which no port has')
  })

  test('a source or sink states its energy rate as a solved power', () => {
    const faulty: ComponentDefinition = {
      ...processPlantComponentRegistry.get('turbineLoadSink' as ComponentKind)!,
      semantics: fixedSemantics({ energy: [{ role: 'sink', circuit: 'steam', rate: 'steamFlowKgPerS' }] }),
    }
    const registry = new Map([...processPlantComponentRegistry, ['turbineLoadSink' as ComponentKind, faulty]])
    const spec = plantGraph({
      id: 'semantics.rate',
      title: 'Rate',
      fixedStepMs: 100,
      components: [component('engine', 'turbineLoadSink', 'Engine', { nominalElectricMw: 10, initialLoadFraction: 1, nominalSteamFlowKgPerS: 10, electricalTimeConstantS: 5, gridSource: 'grid', generatorPoleCount: 4 })],
      connections: [],
    })
    expect(() => compilePlantGraph(spec, registry)).toThrow('component engine semantics: energy sink rate steamFlowKgPerS must be a solved power')
  })

  test('a flow through a port must be a solved flow on a port the kind has', () => {
    const base = processPlantComponentRegistry.get('steamGenerator' as ComponentKind)!
    const compileWith = (portFlows: ReadonlyArray<{ readonly port: string; readonly variable: string }>) => {
      const registry = new Map([...processPlantComponentRegistry, ['steamGenerator' as ComponentKind, { ...base, semantics: fixedSemantics({ portFlows }) }]])
      return () => compilePlantGraph(plantGraph({
        id: 'semantics.port-flow',
        title: 'Port flow',
        fixedStepMs: 100,
        components: [component('drum', 'steamGenerator', 'Drum', { nominalPressureMPa: 6, designFeedwaterTemperatureC: 220, nominalLevelPercent: 0.5, heatTransferCoefficientMwPerK: 2 })],
        connections: [],
      }), registry)
    }
    expect(compileWith([{ port: 'feedwaterInlet', variable: 'levelPercent' }])).toThrow('component drum semantics: flow through feedwaterInlet names levelPercent, which is not a solved flow')
    expect(compileWith([{ port: 'feedInlet', variable: 'feedwaterFlowKgPerS' }])).toThrow('component drum semantics names unknown port feedInlet')
    expect(componentById(graph, 'sgB').semantics.portFlows.map(flow => [String(flow.port), String(flow.path)])).toEqual([['feedwaterInlet', 'sgB.feedwaterFlowKgPerS'], ['steamOutlet', 'sgB.steamOutflowKgPerS']])
  })

  test('readings are meaningful only while a solved flag says so', () => {
    // The source range counts, and its startup rate measures, while its high voltage is on.
    expect(componentById(graph, 'core').semantics.meaningfulWhile).toEqual([
      { flag: 'core.sourceRangeEnergized', variables: ['core.sourceRangeCountRateCps', 'core.sourceRangeStartupRateDpm'] },
    ] as never)
    const base = processPlantComponentRegistry.get('reactorCore' as ComponentKind)!
    const faulty: ComponentDefinition = { ...base, semantics: fixedSemantics({ meaningfulWhile: [{ flag: 'sourceRangeCountRateCps', variables: ['intermediateRangeCurrentAmps'] }] }) }
    const registry = new Map([...processPlantComponentRegistry, ['reactorCore' as ComponentKind, faulty]])
    expect(() => compilePlantGraph(assemblePwrReferencePlantGraph({ loopCount: 4 }), registry)).toThrow('component core semantics: readings are meaningful while sourceRangeCountRateCps, which is not a solved flag')
  })

  test('a reading\'s program is the equipment\'s own, of the quantity it programs, read on it or through one port', () => {
    // Rod control holds Tavg, as the vessel the core heats reads it, to Tref; level control the pressurizer's level to its program.
    expect(componentById(graph, 'core').semantics.programs).toEqual([{ reading: 'vessel.meanPrimaryCoolantTemperatureC', program: 'core.referenceAverageTemperatureC', deviation: 'core.averageTemperatureDeviationC' }] as never)
    expect(componentById(graph, 'pressurizer').semantics.programs).toEqual([{ reading: 'pressurizer.levelPercent', program: 'pressurizer.levelProgramPercent', deviation: 'pressurizer.levelDeviationPercent' }] as never)
    expect(componentById(graph, 'core').semantics.shutdownReadings).toEqual(['core.rodsOnBottom', 'core.rodStepsWithdrawn', 'core.powerRangePercent', 'core.intermediateRangeCurrentAmps', 'core.intermediateRangeStartupRateDpm'] as never)
    const base = processPlantComponentRegistry.get('reactorCore' as ComponentKind)!
    const compileWith = (semantics: Parameters<typeof fixedSemantics>[0]) => () => compilePlantGraph(assemblePwrReferencePlantGraph({ loopCount: 4 }), new Map([...processPlantComponentRegistry, ['reactorCore' as ComponentKind, { ...base, semantics: fixedSemantics(semantics) }]]))
    expect(compileWith({ programs: [{ reading: 'meanPrimaryCoolantTemperatureC', via: 'vesselThermal', program: 'powerRangePercent' }] }))
      .toThrow('component core semantics: powerRangePercent does not program the quantity vessel.meanPrimaryCoolantTemperatureC reads')
    expect(compileWith({ programs: [{ reading: 'meanPrimaryCoolantTemperatureC', via: 'thermalOut', program: 'referenceAverageTemperatureC' }] }))
      .toThrow('component core semantics: meanPrimaryCoolantTemperatureC is read through unknown port thermalOut')
    expect(compileWith({ programs: [{ reading: 'meanPrimaryCoolantTemperatureC', program: 'referenceAverageTemperatureC' }] }))
      .toThrow('component core semantics names unknown variable core.meanPrimaryCoolantTemperatureC')
    expect(compileWith({ programs: [{ reading: 'meanPrimaryCoolantTemperatureC', via: 'vesselThermal', program: 'rodInsertionFraction' }] }))
      .toThrow('component core semantics: core.rodInsertionFraction must be a solved reading')
    expect(compileWith({ permissives: ['aboveP6'], shutdownReadings: ['aboveP6'] })).toThrow('component core semantics: shutdown reading aboveP6 must be a solved reading, not a command or a permissive')
    expect(compileWith({ shutdownReadings: ['rodInsertionFraction'] })).toThrow('component core semantics: shutdown reading rodInsertionFraction must be a solved reading, not a command or a permissive')
  })

  test('a writable variable without an actuation is rejected', () => {
    const base = processPlantComponentRegistry.get('processTank' as ComponentKind)!
    const undeclared: ComponentDefinition = {
      ...base,
      variables: [...base.variables, variable({ path: 'mystery', label: 'Mystery', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' })],
    }
    const registry = new Map([...processPlantComponentRegistry, ['processTank' as ComponentKind, undeclared]])
    const spec = plantGraph({
      id: 'semantics.undeclared',
      title: 'Undeclared',
      fixedStepMs: 100,
      components: [component('tank', 'processTank', 'Tank', { nominalInventoryKg: 100, initialInventoryFraction: 0.5, initialTemperatureC: 20, makeupFlowKgPerS: 0, maxOutletFlowKgPerS: 1 })],
      connections: [],
    })
    expect(() => compilePlantGraph(spec, registry)).toThrow('writable variable tank.mystery must declare its actuation')
  })
})

describe('operator names', () => {
  test('every component of the reference Plant has a unique short label', () => {
    for (const loopCount of [2, 4, 6]) {
      const labels = reference(loopCount).graph.components.map(compiled => compiled.metadata?.presentation?.shortLabel)
      expect(labels.every(label => label !== undefined)).toBe(true)
      expect(new Set(labels).size).toBe(labels.length)
    }
    expect(componentById(graph, 'feedwaterControlValveB').metadata?.presentation?.shortLabel).toBe('FCV B')
    expect(componentById(graph, 'pressurizer').metadata?.presentation?.embedded).toEqual({ reliefValve: 'PORV', blockValve: 'PORV block', safetyValves: 'Safety valves' })
  })

  test('words for on/off states name an on/off signal of their own component', () => {
    // Being presentation, they leave the Plant's identity alone: the reference PWR's pinned digest (process-plant-graph) holds with them.
    const spec = assemblePwrReferencePlantGraph({ loopCount: 4 })
    const worded = (states: Record<string, { on: string; off: string }>): PlantGraphSpec => ({
      ...spec,
      components: spec.components.map(entry => String(entry.id) === 'core' ? { ...entry, metadata: { ...entry.metadata, presentation: { ...entry.metadata?.presentation, states } } } : entry),
    })
    expect(compilePlantGraph(worded({ sourceRangeEnergized: { on: 'SR HV on', off: 'SR HV off' } }), processPlantComponentRegistry).components.find(entry => String(entry.id) === 'core')!.metadata?.presentation?.states).toEqual({ sourceRangeEnergized: { on: 'SR HV on', off: 'SR HV off' } })
    expect(() => compilePlantGraph(worded({ powerMw: { on: 'at power', off: 'shut down' } }), processPlantComponentRegistry)).toThrow('not one of its on/off signals')
  })

  test('renaming equipment never changes the Plant identity that persisted Runs are bound to', () => {
    const spec = assemblePwrReferencePlantGraph({ loopCount: 4 })
    const renamed: PlantGraphSpec = {
      ...spec,
      components: spec.components.map(entry => ({ ...entry, metadata: { ...entry.metadata, presentation: { shortLabel: `${entry.id} renamed` } } })),
    }
    const definition = createPwrReferencePlantDefinition({ id: 'plant:renamed', loopCount: 4 })
    const original = compileProcessPlant(definition)
    const relabelled = compileProcessPlant({ ...definition, graph: renamed } as never)
    expect(relabelled.modelDigest).toBe(original.modelDigest)
  })

  test('two components may not share a short label', () => {
    const spec = plantGraph({
      id: 'semantics.labels',
      title: 'Labels',
      fixedStepMs: 100,
      components: [
        component('tankA', 'processTank', 'Tank A', { nominalInventoryKg: 100, initialInventoryFraction: 0.5, initialTemperatureC: 20, makeupFlowKgPerS: 0, maxOutletFlowKgPerS: 1 }, [], { presentation: { shortLabel: 'T' } }),
        component('tankB', 'processTank', 'Tank B', { nominalInventoryKg: 100, initialInventoryFraction: 0.5, initialTemperatureC: 20, makeupFlowKgPerS: 0, maxOutletFlowKgPerS: 1 }, [], { presentation: { shortLabel: 'T' } }),
      ],
      connections: [],
    })
    expect(() => compilePlantGraph(spec, processPlantComponentRegistry)).toThrow('duplicate component short label: T')
  })
})

describe('link flow', () => {
  test('only flows the runtime actually solves count as flow, and loop legs carry size without direction', () => {
    const fidelity = new Map(graph.links.filter(link => link.kind === 'fluidFlow').map(link => [String(link.id), processLinkFlowFidelityFor(graph, link)]))
    // Every fluid flow is solved. The letdown line is fed from the vessel; the
    // surge line carries the size of a surge that runs either way.
    expect([...fidelity].filter(([, value]) => value === 'unverified').map(([id]) => id)).toEqual([])
    expect(fidelity.get('rcs-letdown')).toBe('solved')
    expect(fidelity.get('letdown-to-vct')).toBe('solved')
    expect([...fidelity].filter(([, value]) => value === 'magnitudeOnly').map(([id]) => id).sort()).toEqual(
      [...['a', 'b', 'c', 'd'].flatMap(loop => [`rcp-${loop}-to-core`, `rcs-cold-leg-${loop}`, `rcs-hot-leg-${loop}`]), 'pressurizer-surge-line'].sort(),
    )
    expect(fidelity.get('feedwater-control-valve-b-to-sg-b')).toBe('solved')
  })

  test('a link is rated by its own nominal flow or by the equipment that drives it', () => {
    expect(ratedFlowForLink(graph, linkById('rcs-hot-leg-a'))).toBe(4250)
    // Through the MFW header and FCV B, back to one MFW pump: half the feed
    // the pumps pass with the regulating valves wide open, the full-power
    // feed (the steam the core's 3,400 MW and the reactor coolant pumps'
    // 18 MW raise from 227 °C feedwater at 6.9 MPa, 1.80 MJ/kg) over the
    // valves' 75 % full-power opening.
    expect(ratedFlowForLink(graph, linkById('feedwater-control-valve-b-to-sg-b'))).toBeCloseTo(1268, 0)
    expect(ratedFlowForLink(graph, linkById('pressurizer-relief-to-tank'))).toBe(componentById(graph, 'pressurizer').semantics.ratedOutflow[0]!.flowKgPerS)
    // The letdown line carries the vessel's rated letdown, about 75 gpm.
    expect(ratedFlowForLink(graph, linkById('letdown-to-vct'))).toBe(5)
  })

  test('a header joins all its ports, so a rating passes through it', () => {
    const water = {
      connectionKind: 'fluidFlow' as const, service: 'water', nominalFluid: 'water' as const, designPhase: 'liquid' as const, solverModel: 'incompressibleLiquid' as const,
      variables: [
        { path: 'flowKgPerS', label: 'Flow', kind: 'derived' as const, discipline: 'hydraulic' as const, writable: false, publish: 'telemetry' as const, quantity: 'flowRate' as const, unit: 'kg/s' as const, initialValue: 0 },
        { path: 'temperatureC', label: 'Temperature', kind: 'derived' as const, discipline: 'thermal' as const, writable: false, publish: 'telemetry' as const, quantity: 'temperature' as const, unit: 'degC' as const, initialValue: 20 },
      ] as never,
    }
    const spec = plantGraph({
      id: 'semantics.header',
      title: 'Header',
      fixedStepMs: 100,
      components: [
        component('pump', 'centrifugalPump', 'Pump', { nominalFlowKgPerS: 40, nominalHeadPa: 1e5 }),
        component('header', 'processHeader', 'Header', {}),
        component('tank', 'processTank', 'Tank', { nominalInventoryKg: 100, initialInventoryFraction: 0.5, initialTemperatureC: 20, makeupFlowKgPerS: 0, maxOutletFlowKgPerS: 0 }),
      ],
      connections: [
        connect('pump-to-header', 'pump.outlet', 'header.inletA', water),
        connect('header-to-tank', 'header.outletB', 'tank.inlet', water),
      ],
    })
    const compiled = compilePlantGraph(spec, processPlantComponentRegistry)
    expect(ratedFlowForLink(compiled, compiled.links.find(link => String(link.id) === 'header-to-tank')!)).toBe(40)
  })
})
