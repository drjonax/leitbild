import { describe, expect, test } from 'bun:test'
import {
  assemblePwrReferencePlantGraph,
  compilePlantGraph,
  compileProcessPlant,
  createPwrReferencePlantDefinition,
  energyEnds,
  processGraphPresentationSchema,
  processPlantComponentRegistry,
  type CompiledPlantGraph,
  type ComponentDefinition,
  type ComponentKind,
  type ComponentSemantics,
  type PlantGraphSpec,
  type ProcessGraphPresentation,
} from '../src/packs/process-plant/index.ts'
import { component, connect, plantGraph } from '../src/packs/process-plant/graph/builder.ts'
import { aspect } from '../src/packs/process-plant/graph/semantics.ts'
import { stateTexts } from '../src/packs/process-plant/displays/state-words.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Declarations a kind or a Plant makes so displays can draw it from the model:
// a state another component computes, one quantity read by several
// instruments, words for an aspect, pushbuttons, and the Plant's energy ends.

const reference = assemblePwrReferencePlantGraph({ loopCount: 4 })
const componentById = (graph: CompiledPlantGraph, id: string) => graph.components[graph.componentIndexById.get(id as never)!]!

/** The registry with one kind's semantics extended by what a test declares. */
const declaring = (kind: string, extend: (own: ComponentSemantics) => Partial<ComponentSemantics>): ReadonlyMap<ComponentKind, ComponentDefinition> => {
  const base = processPlantComponentRegistry.get(kind as ComponentKind)!
  const changed: ComponentDefinition = { ...base, semantics: parameters => { const own = base.semantics(parameters); return { ...own, ...extend(own) } } }
  return new Map([...processPlantComponentRegistry, [kind as ComponentKind, changed]])
}
const compileDeclaring = (kind: string, extend: (own: ComponentSemantics) => Partial<ComponentSemantics>, spec: PlantGraphSpec = reference) => () => compilePlantGraph(spec, declaring(kind, extend))

/** The reference Plant with one component's presentation extended. */
const presenting = (id: string, presentation: ProcessGraphPresentation): PlantGraphSpec => ({
  ...reference,
  components: reference.components.map(entry => String(entry.id) === id ? { ...entry, metadata: { ...entry.metadata, presentation: { ...entry.metadata?.presentation, ...presentation } } } : entry),
})

describe('an aspect read through a port', () => {
  test('a core is filled by the coolant level of the vessel it heats', () => {
    const graph = compileDeclaring('reactorCore', () => ({ aspects: [aspect('level', { variable: 'collapsedLiquidLevelPercent', reading: 'value', via: 'vesselThermal' })] }))()
    expect(componentById(graph, 'core').semantics.aspects).toEqual([{ aspect: 'level', state: { path: 'vessel.collapsedLiquidLevelPercent', reading: 'value' } }] as never)
    // The vessel keeps its own aspect on the same reading.
    expect(componentById(graph, 'vessel').semantics.aspects).toEqual([{ aspect: 'level', state: { path: 'vessel.collapsedLiquidLevelPercent', reading: 'value' } }] as never)
  })

  test('the state is a solved reading of the component across the port, readable as declared', () => {
    const declare = (state: Parameters<typeof aspect>[1], command?: string) => compileDeclaring('reactorCore', () => ({ aspects: [aspect('level', state, command)] }))
    expect(declare({ variable: 'collapsedLiquidLevelPercent', reading: 'value', via: 'thermalOut' }))
      .toThrow('component core semantics: level state collapsedLiquidLevelPercent is read through unknown port thermalOut')
    expect(declare({ variable: 'liquidLevelPercent', reading: 'value', via: 'vesselThermal' }))
      .toThrow('component core semantics names unknown variable vessel.liquidLevelPercent')
    expect(declare({ variable: 'collapsedLiquidLevelPercent', reading: 'true', via: 'vesselThermal' }))
      .toThrow('component core semantics: level state collapsedLiquidLevelPercent (ratio) cannot be read as true')
    // The core's own name is not read through the port.
    expect(declare({ variable: 'powerRangePercent', reading: 'value', via: 'vesselThermal' }))
      .toThrow('component core semantics names unknown variable vessel.powerRangePercent')
    expect(declare({ variable: 'collapsedLiquidLevelPercent', reading: 'value', via: 'vesselThermal' }, 'rodInsertionFraction'))
      .toThrow('component core semantics: level is read through port vesselThermal from another component, so it takes no command or isolation input')
  })

  test('aspects keep their declared order, and one read through an unconnected port is not the Plant\'s', () => {
    const water = {
      connectionKind: 'fluidFlow' as const, service: 'water', nominalFluid: 'water' as const, designPhase: 'liquid' as const, solverModel: 'incompressibleLiquid' as const,
      variables: [
        { path: 'flowKgPerS', label: 'Flow', kind: 'derived' as const, discipline: 'hydraulic' as const, writable: false, publish: 'telemetry' as const, quantity: 'flowRate' as const, unit: 'kg/s' as const, initialValue: 0 },
        { path: 'temperatureC', label: 'Temperature', kind: 'derived' as const, discipline: 'thermal' as const, writable: false, publish: 'telemetry' as const, quantity: 'temperature' as const, unit: 'degC' as const, initialValue: 20 },
      ] as never,
    }
    const tank = component('tank', 'processTank', 'Tank', { nominalInventoryKg: 100, initialInventoryFraction: 0.5, initialTemperatureC: 20, makeupFlowKgPerS: 0, maxOutletFlowKgPerS: 1 })
    const pump = component('pump', 'centrifugalPump', 'Pump', { nominalFlowKgPerS: 1, nominalHeadPa: 1e5 })
    const spec = (connected: boolean) => plantGraph({
      id: 'declarations.suction',
      title: 'Suction',
      fixedStepMs: 100,
      components: [tank, pump],
      connections: connected ? [connect('tank-to-pump', 'tank.outlet', 'pump.inlet', water)] : [],
    })
    const suction = (own: ComponentSemantics): Partial<ComponentSemantics> => ({ aspects: [...own.aspects, aspect('level', { variable: 'levelPercent', reading: 'value', via: 'inlet' })] })
    expect(componentById(compileDeclaring('centrifugalPump', suction, spec(true))(), 'pump').semantics.aspects).toEqual([
      { aspect: 'running', state: { path: 'pump.runningState', reading: 'true' }, command: 'pump.running' },
      { aspect: 'level', state: { path: 'tank.levelPercent', reading: 'value' } },
    ] as never)
    expect(componentById(compileDeclaring('centrifugalPump', suction, spec(false))(), 'pump').semantics.aspects.map(entry => entry.aspect)).toEqual(['running'])
  })

  test('a bundled device\'s state is its host\'s own', () => {
    const throughSurgeLine = compileDeclaring('pressurizer', own => ({
      embedded: own.embedded.map((device, index) => index > 0 ? device : { ...device, aspects: device.aspects.map(entry => entry.state === undefined ? entry : { ...entry, state: { ...entry.state, via: 'surgeLine' } }) }),
    }))
    expect(throughSurgeLine).toThrow('component pressurizer semantics: the blockValve position is the device\'s own, never read through a port')
  })
})

describe('one quantity read by several instruments', () => {
  const ladder = [
    { reading: 'sourceRangeCountRateCps', wider: 'intermediateRangeCurrentAmps', while: 'aboveP6' },
    { reading: 'intermediateRangeCurrentAmps', wider: 'powerRangePercent', while: 'aboveP10' },
  ]

  test('neutron flux reads on the source range, the intermediate range while P-6 holds and the power range while P-10 does', () => {
    const graph = compileDeclaring('reactorCore', () => ({ widerRanges: ladder }))()
    expect(componentById(graph, 'core').semantics.widerRanges).toEqual([
      { reading: 'core.sourceRangeCountRateCps', wider: 'core.intermediateRangeCurrentAmps', while: 'core.aboveP6' },
      { reading: 'core.intermediateRangeCurrentAmps', wider: 'core.powerRangePercent', while: 'core.aboveP10' },
    ] as never)
    // A wider range without a flag still reads in the reading's own unit.
    expect(componentById(graph, 'sgB').semantics.widerRanges).toEqual([{ reading: 'sgB.levelPercent', wider: 'sgB.wideRangeLevelPercent' }] as never)
  })

  test('only a solved flag lets instruments of different units read one quantity', () => {
    const declare = (widerRanges: ComponentSemantics['widerRanges']) => compileDeclaring('reactorCore', () => ({ widerRanges }))
    expect(declare([{ reading: 'sourceRangeCountRateCps', wider: 'intermediateRangeCurrentAmps' }]))
      .toThrow('component core semantics: intermediateRangeCurrentAmps does not read the quantity sourceRangeCountRateCps reads')
    expect(declare([{ reading: 'sourceRangeCountRateCps', wider: 'intermediateRangeCurrentAmps', while: 'powerRangePercent' }]))
      .toThrow('component core semantics: intermediateRangeCurrentAmps reads what sourceRangeCountRateCps reads while powerRangePercent, which is not a solved flag')
    expect(declare([{ reading: 'sourceRangeCountRateCps', wider: 'intermediateRangeCurrentAmps', while: 'sourceRangeDetectorFlag' }]))
      .toThrow('component core semantics names unknown variable sourceRangeDetectorFlag')
    expect(declare([{ reading: 'aboveP6', wider: 'intermediateRangeCurrentAmps', while: 'aboveP6' }]))
      .toThrow('component core semantics: aboveP6 and its wider range intermediateRangeCurrentAmps must be measured values, not on/off signals')
    expect(declare([{ reading: 'sourceRangeCountRateCps', wider: 'coreExitTemperatureC', while: 'aboveP6' }]))
      .toThrow('component core semantics: sourceRangeCountRateCps and its wider range coreExitTemperatureC must declare their instrument spans')
  })

  test('each reading has one wider range, and the ranges never come back to a reading', () => {
    const declare = (widerRanges: ComponentSemantics['widerRanges']) => compileDeclaring('reactorCore', () => ({ widerRanges }))
    expect(declare([...ladder, { reading: 'sourceRangeCountRateCps', wider: 'powerRangePercent', while: 'aboveP10' }]))
      .toThrow('component core semantics: core.sourceRangeCountRateCps has more than one wider range')
    expect(declare([...ladder, { reading: 'powerRangePercent', wider: 'sourceRangeCountRateCps', while: 'sourceRangeEnergized' }]))
      .toThrow('component core semantics: the wider ranges of core.sourceRangeCountRateCps come back to core.sourceRangeCountRateCps')
    expect(declare([{ reading: 'powerRangePercent', wider: 'powerRangePercent', while: 'aboveP10' }]))
      .toThrow('component core semantics: the wider ranges of core.powerRangePercent come back to core.powerRangePercent')
  })
})

describe('presentation of states and pushbuttons', () => {
  test('words for an aspect\'s state replace the aspect\'s own: a generator on its output breaker reads ON LINE', () => {
    const spec = presenting('turbine', { states: { outputBreakerClosed: { on: 'ON LINE', off: 'OFF LINE' } } })
    const graph = compilePlantGraph(spec, declaring('turbineLoadSink', () => ({ aspects: [aspect('running', { variable: 'outputBreakerClosed', reading: 'true' })] })))
    expect(componentById(graph, 'turbine').semantics.aspects).toEqual([{ aspect: 'running', state: { path: 'turbine.outputBreakerClosed', reading: 'true' } }] as never)
    expect(stateTexts(graph, graph.signalBindingByPath.get('turbine.outputBreakerClosed' as never)!)).toEqual({ on: 'ON LINE · Turbine', off: 'OFF LINE · Turbine' })
  })

  test('a pushbutton is an on/off command of its own component that no state aspect holds', () => {
    const marked = (id: string, momentary: ReadonlyArray<string>) => () => compilePlantGraph(presenting(id, { momentary: [...momentary] }), processPlantComponentRegistry)
    expect(componentById(marked('safetyInjectionBlockLogic', ['blockPushbutton'])(), 'safetyInjectionBlockLogic').metadata?.presentation?.momentary).toEqual(['blockPushbutton'])
    expect(marked('safetyInjectionBlockLogic', ['blocked'])).toThrow('component safetyInjectionBlockLogic marks blocked momentary, which is not one of its on/off commands')
    expect(marked('safetyInjectionBlockLogic', ['pushbutton'])).toThrow('component safetyInjectionBlockLogic marks pushbutton momentary, which is not one of its on/off commands')
    expect(marked('turbine', ['loadFraction'])).toThrow('component turbine marks loadFraction momentary, which is not one of its on/off commands')
    expect(marked('rcpA', ['running'])).toThrow('component rcpA marks running momentary, but it is the input of a state aspect, which holds what it demands')
    expect(marked('safetyInjectionBlockLogic', ['blockPushbutton', 'blockPushbutton'])).toThrow('duplicate component safetyInjectionBlockLogic momentary input: blockPushbutton')
    expect(processGraphPresentationSchema.safeParse({ momentary: [] }).success).toBe(false)
  })

  test('pushbutton marks and aspect words leave the Plant identity that persisted Runs are bound to', () => {
    const definition = createPwrReferencePlantDefinition({ id: 'plant:declarations', loopCount: 4 })
    const spec = presenting('safetyInjectionBlockLogic', { momentary: ['blockPushbutton'] })
    const worded = { ...spec, components: spec.components.map(entry => String(entry.id) === 'turbine' ? { ...entry, metadata: { ...entry.metadata, presentation: { ...entry.metadata?.presentation, states: { outputBreakerClosed: { on: 'ON LINE', off: 'OFF LINE' } } } } } : entry) }
    expect(compileProcessPlant({ ...definition, graph: worded } as never).modelDigest).toBe(compileProcessPlant(definition).modelDigest)
  })
})

describe('the Plant\'s energy ends', () => {
  test('its sources come first, then its sinks, with the circuit each works and the rate that measures it', () => {
    const ends = (graph: CompiledPlantGraph) => energyEnds(graph).map(end => [String(end.component.id), end.role, end.circuit, String(end.rate)])
    const expected = [['core', 'source', 'coolant', 'core.totalThermalPowerMw'], ['turbine', 'sink', 'steam', 'turbine.electricMw']]
    expect(ends(compilePlantGraph(reference, processPlantComponentRegistry))).toEqual(expected)
    // Whatever order the Plant lists its components in.
    const sinkFirst = { ...reference, components: [...reference.components].sort((left, right) => (String(right.id) === 'turbine' ? 1 : 0) - (String(left.id) === 'turbine' ? 1 : 0)) }
    expect(String(sinkFirst.components[0]!.id)).toBe('turbine')
    expect(ends(compilePlantGraph(sinkFirst, processPlantComponentRegistry))).toEqual(expected)
  })
})
