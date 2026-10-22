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
import { FLOW_ROOM, overviewOf, scopeWithin, topologyOf } from '../src/features/displays/compose/topology.ts'
import { resolveSubject } from '../src/features/displays/compose/resolve.ts'
import { visibleObject } from '../src/features/displays/compose/declared.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { overlaps } from './helpers/network-layout-measure.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// P9 (swap plan): on four-loop Halden, a whole-plant default carries what today's Unit Overview carries (its own states,
// the reactor trip and its first-out, lead values with trends, the whole-plant flow drawing, alarms) and an equipment
// default what today's detail display carries (its flow neighbourhood, readings, related alarms, the element its actions
// open on), each within the card's limits with every cut stated. The Plant declares its overview (its principal
// circuits) and its operating mode.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:parity' as ActorId, label: 'Parity', role: 'operator' as const }
const plantId = 'plant:halden-2' as ObjectId

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
  run = await displayRunOf(registry, runtime, person, new Set())
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

describe('P9: the plant default carries what the Unit Overview carries', () => {
  test('its own states as chips under the title, its lead values with trends, its alarms with the trip first out, and the whole-plant drawing beside them (Q20)', async () => {
    const { state, view, card, sample } = await opened(plantId)
    expect(state.views.map(entry => entry.kind)).toEqual(['values', 'trend', 'alerts', 'topology'])
    const [declaration] = await run.port.declarations([plantId])
    if (declaration === undefined || 'refused' in declaration) throw new Error('the Plant declares nothing')
    const own = declaration.observables.filter(observable => observable.quantity === 'state' && observable.element === undefined).map(observable => observable.ref)
    // The six safety functions, then the operating mode.
    expect(own.slice(0, 6).every(ref => ref.includes('#csf.'))).toBe(true)
    expect(own).toHaveLength(7)
    expect(state.chips).toEqual(own)
    expect(view.chips?.map(value => value.ref)).toEqual(own)
    const values = state.views[0]
    expect(values?.kind === 'values' && values.refs.length > 0 && values.refs.every(ref => !own.includes(ref))).toBe(true)
    expect(card.items.slice(0, own.length).map(item => item.subject)).toEqual(own.map(ref => ({ ref })))
    // A window stands the drawing beside a column of the other views: rows count as the taller of the two, within 40.
    expect(state.beside).toBe(true)
    expect(view.beside).toBe(true)
    const trend = view.sections[1]
    expect(trend?.kind === 'trend' && trend.strips.flat().length).toBeGreaterThan(0)
    expect(card.items.some(item => item.reading.includes('Reactor trip') && item.reading.includes('first out'))).toBe(true)
    const drawing = view.sections.find(section => section.kind === 'topology')
    expect(drawing?.kind === 'topology' && drawing.family).toBe('flow')
    const graph = await run.port.topology(plantId)
    if ('refused' in graph || graph.overview === undefined) throw new Error('the Plant declares no overview')
    expect(drawing?.kind === 'topology' && drawing.nodes.filter(node => node.class !== 'stop').map(node => node.id).sort()).toEqual([...graph.overview.nodes].sort())
    // Within the flow room and today's overview ceiling of twelve crossings across the loops; no box over another.
    expect(drawing?.kind === 'topology' && drawing.layout.width <= FLOW_ROOM.columns && drawing.layout.height <= FLOW_ROOM.rows).toBe(true)
    expect(drawing?.kind === 'topology' && drawing.layout.crossings).toBeLessThanOrEqual(12)
    expect(drawing?.kind === 'topology' && overlaps(drawing.layout)).toEqual([])
    expect(sample.observations.some(observation => observation.ref.includes('#csf.'))).toBe(true)
    console.log(`plant default: rows ${state.views.map(entry => `${entry.kind} ${entry.rows}`).join(', ')}; drawing ${drawing?.kind === 'topology' ? `${drawing.layout.width}×${drawing.layout.height}, ${drawing.layout.crossings} crossings` : '-'}; card ${card.items.length} items + ${card.more}; ${card.adjusted.map(entry => entry.text).join('; ')}`)
  })
})

describe('P9: the whole-plant drawing', () => {
  test('the declared overview stops where today\'s Unit Overview stops: no relief or drive-steam line that only ends, every flow into a store kept', async () => {
    const graph = await run.port.topology(plantId)
    if ('refused' in graph) throw new Error('the Plant draws no topology')
    const scoped = overviewOf(graph)!
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
    if (drawing?.kind !== 'topology') throw new Error('no drawing')
    expect(drawing.layout.width <= FLOW_ROOM.columns && drawing.layout.height <= FLOW_ROOM.rows).toBe(true)
    expect(drawing.layout.crossings).toBeLessThanOrEqual(12)
    expect(overlaps(drawing.layout)).toEqual([])
    expect(drawing.nodes.some(node => node.element === 'sgA')).toBe(true)
    // Today's detail reach: every service of its loop out to three links, so the feed path questions see the AFW
    // pumps and the CST, the main feedwater pumps, the turbine and the condenser.
    const drawn = drawing.nodes.map(node => node.id)
    expect(drawn).toEqual(expect.arrayContaining(['auxFeedwaterTank', 'auxFeedwaterPumpMotor', 'auxFeedwaterPumpMotorB', 'auxFeedwaterPumpTurbine', 'mainFeedwaterPumpA', 'mainFeedwaterPumpB', 'turbine', 'condenser']))
    const topology = state.views.find(entry => entry.kind === 'topology')
    expect(topology?.kind === 'topology' && topology.request).toMatchObject({ around: ['sgA'], groups: ['A'], reach: 3 })
    // Its own alerts first, then the unit's first-outs, the reactor trip among them, within the section's rows.
    const alerts = state.views.find(entry => entry.kind === 'alerts')
    expect(alerts?.kind === 'alerts' && { elements: alerts.elements, lead: alerts.lead }).toEqual({ elements: ['sgA'], lead: true })
    const listed = card.items.filter(item => item.subject !== undefined && 'alertId' in item.subject).map(item => item.reading)
    expect(listed.length).toBeLessThanOrEqual(alerts!.rows - 1)
    const own = listed.findIndex(reading => !reading.includes('Steam generator A'))
    expect(own).toBeGreaterThan(0)
    expect(listed.slice(own).some(reading => reading.includes('Reactor trip') && reading.includes('first out'))).toBe(true)
    console.log(`SG A default: rows ${state.views.map(entry => `${entry.kind} ${entry.rows}`).join(', ')}; ${drawing.layout.width} x ${drawing.layout.height}, ${drawing.layout.crossings} crossings; card ${card.items.length} items + ${card.more}; ${card.adjusted.map(entry => entry.text).join('; ')}`)
  })

  test('a block valve between the drawn pressurizer and its drawn PORV is drawn, not named at a stop on each side', async () => {
    const graph = (await topologyOf(run, plantId))!
    const scoped = scopeWithin(graph, { around: ['pressurizerReliefHeader'], reach: 1 })
    if (!scoped.ok) throw new Error(scoped.reason)
    expect(scoped.scoped.nodes).toEqual(expect.arrayContaining(['pressurizer', 'pressurizer.blockValve', 'pressurizer.reliefValve']))
    const named = scoped.scoped.stubs.flatMap(stub => stub.others.map(other => other.node))
    expect(named.filter((node, at) => named.indexOf(node) !== at)).toEqual([])
  })

  test('objectId#label names a device its topology draws before any observable search: the PORV, not a tag that abbreviates it', async () => {
    expect(await resolveSubject(run, `${plantId}#PORV`, 'subject')).toEqual({ kind: 'element', objectId: plantId, elementId: 'pressurizer.reliefValve' })
    expect(await resolveSubject(run, `${plantId}#PORV block`, 'subject')).toEqual({ kind: 'element', objectId: plantId, elementId: 'pressurizer.blockValve' })
    // A declared element still resolves as itself, and a tag names its observable.
    expect(await resolveSubject(run, `${plantId}#SG A`, 'subject')).toEqual({ kind: 'element', objectId: plantId, elementId: 'sgA' })
    expect(await resolveSubject(run, `${plantId}#PORV-456A`, 'subject')).toEqual({ kind: 'observable', objectId: plantId, ref: `${plantId}#pressurizer.reliefValvePositionFraction` })
    const { state, view } = await opened(`${plantId}#PORV`)
    expect(view.title).toBe(`${visibleObject(run, plantId)!.label} · PORV`)
    // Its readings are what its node binds (it declares no observables of its own): its position and its flow.
    const readings = state.views.find(entry => entry.kind === 'values')
    expect(readings?.kind === 'values' && readings.refs).toContain(`${plantId}#pressurizer.reliefValveEffectivePositionFraction`)
    const drawing = view.sections.find(section => section.kind === 'topology')
    expect(drawing?.kind === 'topology' && drawing.nodes.map(node => node.id)).toContain('pressurizer.reliefValve')
  })
})
