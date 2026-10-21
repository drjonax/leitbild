import { describe, expect, test } from 'bun:test'
import {
  compilePlantGraph,
  compileProcessPlant,
  createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
  type CompiledPlantGraph,
} from '../src/packs/process-plant/index.ts'
import { component, connect, plantGraph } from '../src/packs/process-plant/graph/builder.ts'
import { overviewScope } from '../src/packs/process-plant/displays/mimic/principal.ts'
import { stubText } from '../src/packs/process-plant/displays/mimic/stub-words.ts'

// The overview's circuits come from where energy goes: a heat source's closed
// circuit, then each closed circuit a transfer feeds. Plants here are built
// from the reference model's parameter sets with other shapes and names.

const reference = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:reference', loopCount: 4 })).sourceGraph
const parameters = (id: string): Record<string, unknown> => ({ ...(reference.components.find(item => String(item.id) === id)!.parameters as Record<string, unknown>) })
// Pipes carry the variables the reference model's pipes of the same fluid carry,
// without the reference Plant's tags, which name its own instruments.
const variablesOf = (id: string) => (reference.connections.find(item => String(item.id) === id)!.variables ?? [])
  .map(({ tagId: _tag, equipmentId: _equipment, externalRefs: _external, ...variable }) => variable) as never
const water = { connectionKind: 'fluidFlow' as const, nominalFluid: 'water' as const, designPhase: 'liquid' as const, solverModel: 'incompressibleLiquid' as const, variables: variablesOf('rcs-hot-leg-a') }
const steam = { connectionKind: 'fluidFlow' as const, nominalFluid: 'steam' as const, designPhase: 'steam' as const, solverModel: 'compressibleSteam' as const, variables: variablesOf('turbine-exhaust-to-condenser') }
const pipe = (id: string, from: string, to: string, service: string, nominalFlowKgPerS?: number) => connect(id, from, to, {
  ...water, service, ...(nominalFlowKgPerS === undefined ? {} : { physical: { nominalFlowKgPerS } as never }),
})
const steamLine = (id: string, from: string, to: string, service: string) => connect(id, from, to, { ...steam, service })
const pump = (id: string, nominalFlowKgPerS: number) => component(id, 'centrifugalPump', id, { nominalFlowKgPerS, nominalHeadPa: 4e5 })
const tank = (id: string, maxOutletFlowKgPerS: number) => component(id, 'processTank', id, { ...parameters('feedwaterTank'), maxOutletFlowKgPerS })

const label = (graph: CompiledPlantGraph, index: number): string => String(graph.components[index]!.id)
const ringsOf = (graph: CompiledPlantGraph) => {
  const result = overviewScope(graph)
  if (!result.ok) throw new Error(result.reason)
  return { ...result, labels: result.rings.map(ring => ring.components.map(index => label(graph, index)).sort()) }
}

// A source loop hands its heat through an intermediate loop to a steam cycle,
// whose condenser rejects it to closed cooling water rated far above them all;
// charging and letdown recirculate a trickle through the source loop.
const intermediatePlant = (coolingWater: 'closed' | 'onceThrough') => compilePlantGraph(plantGraph({
  id: 'intermediate',
  title: 'Intermediate-loop unit',
  fixedStepMs: 100,
  components: [
    component('source', 'reactorCore', 'Source', { ...parameters('core'), primaryLoopIds: ['A'] }),
    component('ihx', 'heatExchanger', 'Intermediate heat exchanger', { uaMwPerC: 60, hotSideDesignFlowKgPerS: 4000, coldSideDesignFlowKgPerS: 3000 }),
    component('primaryPump', 'centrifugalPump', 'Primary pump', parameters('rcpA')),
    pump('intermediatePump', 3000),
    component('boiler', 'steamGenerator', 'Boiler', parameters('sgA')),
    component('engine', 'turbineLoadSink', 'Engine', parameters('turbine')),
    component('cooler', 'condenserSink', 'Cooler', parameters('condenser')),
    pump('feedPump', 600),
    tank('basin', 50_000),
    pump('basinPump', 50_000),
    tank('makeupTank', 5),
    pump('makeupPump', 5),
    component('letdown', 'processValve', 'Letdown', {}),
    ...(coolingWater === 'onceThrough' ? [tank('outfall', 50_000)] : []),
  ],
  connections: [
    pipe('source-out', 'source.hotLegA', 'ihx.hotIn', 'sourceCoolant'),
    pipe('ihx-to-primary-pump', 'ihx.hotOut', 'primaryPump.inlet', 'sourceCoolant'),
    pipe('primary-pump-to-source', 'primaryPump.outlet', 'source.coldLegA', 'sourceCoolant'),
    pipe('ihx-to-boiler', 'ihx.coldOut', 'boiler.primaryInlet', 'intermediateCoolant'),
    pipe('boiler-to-intermediate-pump', 'boiler.primaryOutlet', 'intermediatePump.inlet', 'intermediateCoolant'),
    pipe('intermediate-pump-to-ihx', 'intermediatePump.outlet', 'ihx.coldIn', 'intermediateCoolant'),
    steamLine('boiler-steam', 'boiler.steamOutlet', 'engine.steamInlet', 'liveSteam'),
    steamLine('engine-exhaust', 'engine.exhaustSteamOutlet', 'cooler.steamInlet', 'exhaust'),
    pipe('cooler-to-feed-pump', 'cooler.condensateOutlet', 'feedPump.inlet', 'feed'),
    pipe('feed-pump-to-boiler', 'feedPump.outlet', 'boiler.feedwaterInlet', 'feed'),
    pipe('basin-to-pump', 'basin.outlet', 'basinPump.inlet', 'coolingWater'),
    pipe('basin-pump-to-cooler', 'basinPump.outlet', 'cooler.coolingWater', 'coolingWater'),
    pipe('cooler-cooling-out', 'cooler.coolingWaterOutlet', coolingWater === 'closed' ? 'basin.inlet' : 'outfall.inlet', 'coolingWater'),
    pipe('letdown-in', 'primaryPump.outlet', 'letdown.inlet', 'letdown', 5),
    pipe('letdown-out', 'letdown.outlet', 'makeupTank.inlet', 'letdown', 5),
    pipe('makeup-tank-to-pump', 'makeupTank.outlet', 'makeupPump.inlet', 'makeup'),
    pipe('makeup-to-source', 'makeupPump.outlet', 'source.coldLegA', 'makeup'),
  ],
}), processPlantComponentRegistry)

describe('the overview follows the Plant\'s energy, not its names', () => {
  test('the reference PWR: the primary circuit with its pressurizer, then the water–steam cycle; cooling water leaves as a stub', () => {
    for (const loopCount of [4, 6]) {
      const graph = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:rings-${loopCount}`, loopCount })).graph
      const result = ringsOf(graph)
      expect(result.rings.map(ring => ring.carriers)).toEqual([['primaryCoolant'], ['condensate', 'exhaustSteam', 'feedwater', 'mainSteam']])
      expect(result.labels[0]).toContain('pressurizer')
      expect(result.labels[0]!.filter(id => id.startsWith('sg'))).toHaveLength(loopCount)
      expect(result.onceThrough.map(entry => `${label(graph, entry.component)}.${entry.circuit}`)).toEqual(['condenser.cooling'])
      // Safety and auxiliary services join the drawing as stubs.
      expect(result.scope.stubs.filter(stub => label(graph, graph.componentIndexById.get(stub.node as never)!).startsWith('sg')).map(stub => stubText(graph, stub))).toHaveLength(loopCount)
    }
  })

  test('an intermediate loop is a ring of its own, and a closed cooling loop rated above everything is the last ring, not the first', () => {
    const graph = intermediatePlant('closed')
    const result = ringsOf(graph)
    expect(result.labels).toEqual([
      ['ihx', 'primaryPump', 'source'],
      ['boiler', 'ihx', 'intermediatePump'],
      ['boiler', 'cooler', 'engine', 'feedPump'],
      ['basin', 'basinPump', 'cooler'],
    ])
    expect(result.onceThrough).toEqual([])
  })

  test('charging and letdown recirculating a trickle through the source loop are auxiliary: stubs, not ring 0', () => {
    const graph = intermediatePlant('closed')
    const result = ringsOf(graph)
    expect(result.labels[0]).not.toContain('makeupTank')
    expect(result.scope.stubs.map(stub => `${label(graph, graph.componentIndexById.get(stub.node as never)!)} ${stubText(graph, stub)}`).sort()).toEqual([
      'primaryPump to Letdown',
      'source from makeupPump',
    ])
  })

  test('heat handed to once-through cooling water stubs the drawing where it leaves', () => {
    const graph = intermediatePlant('onceThrough')
    const result = ringsOf(graph)
    expect(result.rings).toHaveLength(3)
    expect(result.onceThrough.map(entry => `${label(graph, entry.component)}.${entry.circuit}`)).toEqual(['cooler.cooling'])
    expect(result.scope.stubs.filter(stub => label(graph, graph.componentIndexById.get(stub.node as never)!) === 'cooler').map(stub => stubText(graph, stub)).sort()).toEqual(['from basinPump', 'to outfall'])
  })

  test('a Plant without a heat source, or whose source heats flow that never returns, is refused with the reason', () => {
    const skid = compilePlantGraph(plantGraph({
      id: 'skid',
      title: 'Pump skid',
      fixedStepMs: 100,
      components: [tank('basin', 50), pump('pump', 40), tank('cooler', 50)],
      connections: [pipe('basin-to-pump', 'basin.outlet', 'pump.inlet', 'coolant'), pipe('pump-to-cooler', 'pump.outlet', 'cooler.inlet', 'coolant')],
    }), processPlantComponentRegistry)
    expect(overviewScope(skid)).toEqual({ ok: false, reason: 'skid declares no heat source, so it has no energy path to draw' })
    const openSource = compilePlantGraph(plantGraph({
      id: 'open-source',
      title: 'Once-through source',
      fixedStepMs: 100,
      components: [component('source', 'reactorCore', 'Source', { ...parameters('core'), primaryLoopIds: ['A'] }), tank('drain', 5000)],
      connections: [pipe('source-to-drain', 'source.hotLegA', 'drain.inlet', 'coolant')],
    }), processPlantComponentRegistry)
    expect(overviewScope(openSource)).toEqual({ ok: false, reason: 'no heat source of open-source lies on a closed fluid circuit, so it has no circulating energy path to draw' })
  })
})
