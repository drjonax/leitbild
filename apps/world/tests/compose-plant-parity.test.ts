import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DISPLAY_CARD_MAX_TEXT, displayCardTextLength } from '@leitbild/contracts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { composeDefault } from '../src/features/displays/compose/compose.ts'
import { overviewOf } from '../src/features/displays/compose/topology.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { overlaps } from './helpers/network-layout-measure.ts'
import { principalCircuits } from '../src/packs/process-plant/equipment/circuits.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// P9 (swap plan): on four-loop Halden, an equipment default carries what today's detail display carries (its flow
// neighbourhood, readings, related alarms, the element its actions open on), within the card's limits with every cut
// stated. The whole-plant default's case joins once p2-plant declares the overview and the window frame is settled; until
// p2-plant declares it, this test declares the Plant's principal circuits (equipment/circuits.ts) as the overview.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:parity' as ActorId, label: 'Parity', role: 'operator' as const }
const plantId = 'plant:halden-2' as ObjectId
const reference = compileProcessPlant(createPwrReferencePlantDefinition({ id: plantId, loopCount: 4 }))
const circuits = principalCircuits(reference.graph)
if (!circuits.ok) throw new Error(circuits.reason)
const overview = { nodes: circuits.components.map(index => String(reference.graph.components[index]!.id)), edges: circuits.links.map(index => String(reference.graph.links[index]!.id)) }

let registry: SimulationRunRegistry
let dataDir: string
let runtime: SimulationRunRuntime
let run: ViewRun
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-parity-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  runtime = await registry.create({ scenarioId: 'halden-power-complex' })
  await runtime.setClock({ paused: true })
  const start = Date.parse(runtime.snapshot().clock!.currentTime)
  await runtime.runMaximumPace(new Date(start + 30_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  const tripped = await runtime.invokeCapability(person, { capabilityId: 'world.process-plant.action.invoke', input: { plantId, actionId: 'turbine-trip', parameters: {} } })
  if (tripped.kind === 'command' && !tripped.result.ok) throw new Error(JSON.stringify(tripped.result))
  await runtime.runMaximumPace(new Date(start + 90_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  const base = await displayRunOf(registry, runtime, person, new Set())
  run = { ...base, port: { ...base.port, topology: async objectId => {
    const graph = await base.port.topology(objectId)
    return 'refused' in graph || graph.family !== 'flow' || graph.overview !== undefined ? graph : { ...graph, overview }
  } } }
})
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

const opened = async (subject: string) => {
  const outcome = await composeDefault(run, subject)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  const { card } = outcome
  // The card's limits hold, and every item left out is counted and said.
  expect(displayCardTextLength(card)).toBeLessThanOrEqual(DISPLAY_CARD_MAX_TEXT)
  if (card.more > 0) expect(card.adjusted.length).toBeGreaterThan(0)
  expect(outcome.rows).toBeLessThanOrEqual(40)
  expect(JSON.stringify(outcome.state).length).toBeLessThanOrEqual(4_096)
  return { ...outcome, view: await compileVignette(run, outcome.state), sample: await sampleVignette(run, outcome.state) }
}

describe('P9: the whole-plant drawing', () => {
  test('the declared overview stops where today\'s Unit Overview stops: no relief or drive-steam line that only ends, every flow into a store kept', async () => {
    const graph = await run.port.topology(plantId)
    if ('refused' in graph) throw new Error('the Plant draws no topology')
    const scoped = overviewOf(graph.overview === undefined ? { ...graph, overview } : graph)!
    expect(scoped.stubs.map(stub => `${stub.node}.${stub.port} ${stub.direction}`)).toEqual([
      'core.coldLegA in', 'pressurizer.reliefOutlet out', 'sgA.feedwaterInlet in', 'sgB.feedwaterInlet in', 'sgC.feedwaterInlet in', 'sgD.feedwaterInlet in',
      'condenser.condensateOutlet out', 'condenser.coolingWater in', 'condenser.coolingWaterOutlet out',
    ])
  })
})

describe('P9: an equipment default carries what the detail display carries', () => {
  test('the reactor core: beyond the ceilings at reach 1, its neighbourhood draws one service at a time, and the card names the others', async () => {
    const { view, card } = await opened(`${plantId}#core`)
    const drawing = view.sections.find(section => section.kind === 'topology')
    expect(drawing?.kind === 'topology' && drawing.layout.crossings).toBeLessThanOrEqual(12)
    expect(drawing?.kind === 'topology' && overlaps(drawing.layout)).toEqual([])
    expect(card.adjusted.some(adjustment => adjustment.kind === 'scope' && /^drawn for .+ only; also: /.test(adjustment.text))).toBe(true)
    console.log(`core default: ${card.adjusted.map(entry => entry.text).join('; ')}`)
  })

  test('a steam generator: its flow neighbourhood at the detail scope, its readings, its related alarms, the element its actions open on', async () => {
    const { state, view, card } = await opened(`${plantId}#sgA`)
    expect(state.views.map(entry => entry.kind)).toEqual(expect.arrayContaining(['values', 'topology']))
    const readings = state.views.find(entry => entry.kind === 'values')
    expect(readings?.kind === 'values' && readings.refs.every(ref => ref.startsWith(`${plantId}#`))).toBe(true)
    const drawing = view.sections.find(section => section.kind === 'topology')
    expect(drawing?.kind === 'topology' && drawing.layout.crossings).toBeLessThanOrEqual(12)
    expect(drawing?.kind === 'topology' && overlaps(drawing.layout)).toEqual([])
    expect(drawing?.kind === 'topology' && drawing.nodes.some(node => node.element === 'sgA')).toBe(true)
    const alerts = state.views.find(entry => entry.kind === 'alerts')
    if (alerts !== undefined) expect(alerts.kind === 'alerts' && alerts.elements).toEqual(['sgA'])
    console.log(`SG A default: rows ${state.views.map(entry => `${entry.kind} ${entry.rows}`).join(', ')}; card ${card.items.length} items + ${card.more}; ${card.adjusted.map(entry => entry.text).join('; ')}`)
  })
})
