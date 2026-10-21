import { afterAll, describe, expect, test } from 'bun:test'
import type { ObjectId } from '../src/core/model/index.ts'
import { topologyGraphSchema } from '../src/core/observation/topology.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { processPlantElectricalPortDefinitions } from '../src/packs/process-plant/electrical-ports.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { plantTopology, servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { guardPlantTests } from './plant-hang-guard.ts'
import { createSteadyPlantRun, plantOperator, type SteadyPlantRun } from './steady-plant-run.ts'

guardPlantTests()

// P5: the Plant as World's `flow` topology (architecture A5; R35); P2 D1:
// its bindings and boundaries, so a drawing shows it live and joins the grid.

const objectId = 'plant:halden-2' as ObjectId
const plantOf = (loopCount: number) => compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount }))
const plant = plantOf(4)
const graph = plantTopology(objectId, plant.graph, plant.modelDigest)
const served = servedPlantTopology(objectId, plant)
const node = (id: string) => graph.nodes.find(candidate => candidate.id === id)!
const bindings = (id: string) => served.nodes.find(candidate => candidate.id === id)!.bindings.map(binding => `${binding.role} ${binding.ref.slice(binding.ref.indexOf('#') + 1)}`)
let run: SteadyPlantRun | undefined

afterAll(async () => { await run?.remove() })

describe('plant topology provider (P5)', () => {
  test('the graph validates against core\'s topology schema for two to six loops', () => {
    for (const loopCount of [2, 4, 6]) {
      const other = plantOf(loopCount)
      const topology = servedPlantTopology(objectId, other)
      expect(topologyGraphSchema.parse(topology)).toEqual(topology)
      expect(topology.groups.map(group => group.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F'].slice(0, loopCount))
    }
    expect(served).toMatchObject({ objectId, revision: plant.modelDigest, family: 'flow' })
  })

  test('D1: nodes and lines are bound to what the Plant publishes, each binding a declared observable of the Plant', () => {
    expect({
      pressurizer: bindings('pressurizer'), rcp: bindings('rcpA'), bus: bindings('safetyBusA'), valve: bindings('mainSteamIsolationValveA'), header: bindings('feedwaterHeader'),
    }).toEqual({
      pressurizer: ['level pressurizer.levelPercent', 'value pressurizer.pressureMPa', 'value pressurizer.levelPercent'],
      rcp: ['running rcpA.runningState'],
      bus: ['conducting safetyBusA.energized', 'value safetyBusA.voltageKv'],
      valve: ['value mainSteamIsolationValveA.effectivePositionFraction'],
      header: ['flow feedwaterHeader.outletFlowKgPerS'],
    })
    // An operated item whose own signal is not published says what it does through its state observable: a breaker's contacts, a pump running.
    expect([bindings('offsiteBreakerA'), bindings('condensatePumpA')]).toEqual([['conducting offsiteBreakerA.state'], ['running condensatePumpA.state']])
    expect(served.edges.find(edge => edge.id === 'rcs-hot-leg-a')?.bindings).toEqual([{ role: 'flow', ref: `${objectId}#rcs-hot-leg-a.flowKgPerS` }])
    const declared = new Map(plantDeclaration(objectId, plant, null).observables.map(observable => [observable.ref, observable]))
    const refs = [...served.nodes, ...served.edges].flatMap(item => item.bindings.map(binding => binding.ref))
    expect(refs.filter(ref => !declared.has(ref))).toEqual([])
    // Q8: a running or conducting binding reads a boolean (true is on) or a state reading that marks its on state.
    const switching = served.nodes.flatMap(entry => entry.bindings.filter(binding => binding.role === 'running' || binding.role === 'conducting')).map(binding => declared.get(binding.ref)!)
    expect(switching.filter(observable => observable.valueType !== 'boolean' && !observable.states?.some(state => state.active === true)).map(observable => observable.ref)).toEqual([])
    expect(new Set(served.nodes.flatMap(entry => entry.bindings.map(binding => binding.role)))).toEqual(new Set(['level', 'running', 'conducting', 'flow', 'value']))
  })

  test('D1: the grid source is the boundary a Scenario connection joins, by the port id the Plant\'s electrical ports name', () => {
    expect(served.boundaries).toEqual([{ node: 'offsiteGrid', port: 'outlet', externalPortId: 'grid-420kv' }])
    expect(processPlantElectricalPortDefinitions(plant).map(port => port.id)).toEqual(['grid-420kv'])
    expect(bindings('offsiteGrid')).toEqual(['conducting offsiteGrid.energized'])
  })

  test('nodes are the equipment that pipes or cables join, in the model\'s order, named and labelled as the unit names them', () => {
    const order = plant.graph.components.map(component => String(component.id))
    expect(graph.nodes.map(entry => order.indexOf(entry.id))).toEqual([...graph.nodes.map(entry => order.indexOf(entry.id))].sort((a, b) => a - b))
    expect(graph.nodes.every(entry => entry.element === entry.id)).toBe(true)
    expect(new Set(graph.nodes.map(entry => entry.label)).size).toBe(graph.nodes.length)
    expect(node('pressurizer')).toMatchObject({ label: 'Pressurizer', shortLabel: 'PZR', rank: 'pressurizer|pressurizer|pressure-control' })
    expect(node('sgA')).toMatchObject({ class: 'transfer', group: 'A' })
    // Every node is an element the declaration names, so alert subjects and observables meet the drawing.
    const elements = new Set(plantDeclaration(objectId, plant, null).elements.map(element => element.id))
    expect(graph.nodes.filter(entry => !elements.has(entry.id)).map(entry => entry.id)).toEqual([])
  })

  test('ports carry their circuit and every service on them; media are the services, groups the loops', () => {
    expect(node('core').ports.find(port => port.id === 'coldLegA')).toEqual({ id: 'coldLegA', rank: 'coldLegA', media: ['charging', 'primaryCoolant', 'primaryInjection', 'safetyInjection'], direction: 'in', circuit: 'coolant' })
    expect(node('sgA').ports.map(port => [port.id, port.circuit, port.media.join('+')])).toEqual([
      ['primaryInlet', 'primary', 'primaryCoolant'], ['primaryOutlet', 'primary', 'primaryCoolant'], ['feedwaterInlet', 'secondary', 'auxFeedwater+feedwater'],
      ['steamOutlet', 'secondary', 'mainSteam'], ['steamReliefOutlet', 'relief', 'mainSteam'],
    ])
    expect(graph.media.find(medium => medium.id === 'electricalPower')?.kind).toBe('electric-ac')
    expect(graph.media.find(medium => medium.id === 'mainSteam')?.kind).toBe('steam')
    expect(graph.media.find(medium => medium.id === 'feedwater')).toEqual({ id: 'feedwater', label: 'Feedwater', kind: 'fluid' })
  })

  test('an edge carries its own loop where it has one, apart from its ends\' (the charging line into cold leg A)', () => {
    const groupOf = (id: string) => node(id).group
    const own = graph.edges.filter(edge => edge.group !== undefined && edge.group !== (groupOf(edge.from.node) ?? groupOf(edge.to.node)))
    expect(own).toHaveLength(13)
    expect(graph.edges.find(edge => edge.id === 'charging-pump-to-cold-leg-a')).toMatchObject({ group: 'A', medium: 'charging', from: { node: 'chargingPump' }, to: { node: 'core', port: 'coldLegA' } })
  })

  test('the Run serves it to World as the caller, the same graph, unchanged when the caller holds its revision', async () => {
    run = await createSteadyPlantRun()
    const port = run.run.observations(plantOperator)
    const served = await port.topology(run.plantId)
    expect('refused' in served).toBe(false)
    if ('refused' in served) return
    expect(served).toMatchObject({ objectId: run.plantId, family: 'flow', boundaries: [{ node: 'offsiteGrid', port: 'outlet', externalPortId: 'grid-420kv' }] })
    expect(served.nodes).toHaveLength(graph.nodes.length)
    expect(await port.topology(run.plantId)).toEqual(served)
    // Every binding reads, as the caller, at the Run's time: the drawing has live state.
    const refs = [...new Set([...served.nodes, ...served.edges].flatMap(item => item.bindings.map(binding => binding.ref)))]
    const reads = await Promise.all(Array.from({ length: Math.ceil(refs.length / 64) }, (_, at) => port.read({ refs: refs.slice(64 * at, 64 * at + 64) })))
    expect(reads.flatMap(read => [...read.unknown, ...read.refused])).toEqual([])
    const observations = reads.flatMap(read => read.observations)
    expect(observations).toHaveLength(refs.length)
    expect(observations.find(observation => observation.ref === `${run!.plantId}#offsiteBreakerA.state`)).toMatchObject({ value: 'on', quality: 'good' })
  })
})
