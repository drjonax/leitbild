import { afterAll, describe, expect, test } from 'bun:test'
import type { ObjectId } from '../src/core/model/index.ts'
import { topologyGraphSchema } from '../src/core/observation/topology.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { plantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { guardPlantTests } from './plant-hang-guard.ts'
import { createSteadyPlantRun, plantOperator, type SteadyPlantRun } from './steady-plant-run.ts'

guardPlantTests()

// P5: the Plant as World's `flow` topology (architecture A5; R35).

const objectId = 'plant:halden-2' as ObjectId
const plantOf = (loopCount: number) => compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount }))
const plant = plantOf(4)
const graph = plantTopology(objectId, plant.graph, plant.modelDigest)
const node = (id: string) => graph.nodes.find(candidate => candidate.id === id)!
let run: SteadyPlantRun | undefined

afterAll(async () => { await run?.remove() })

describe('plant topology provider (P5)', () => {
  test('the graph validates against core\'s topology schema for two to six loops', () => {
    for (const loopCount of [2, 4, 6]) {
      const other = plantOf(loopCount)
      const topology = plantTopology(objectId, other.graph, other.modelDigest)
      expect(topologyGraphSchema.parse(topology)).toEqual(topology)
      expect(topology.groups.map(group => group.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F'].slice(0, loopCount))
    }
    expect(graph).toMatchObject({ objectId, revision: plant.modelDigest, family: 'flow', boundaries: [] })
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
    expect(served).toMatchObject({ objectId: run.plantId, family: 'flow' })
    expect(served.nodes).toHaveLength(graph.nodes.length)
    expect(await port.topology(run.plantId)).toEqual(served)
  })
})
