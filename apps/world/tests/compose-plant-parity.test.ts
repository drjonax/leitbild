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
import { composeDefault, composeVignette } from '../src/features/displays/compose/compose.ts'
import { FLOW_ROOM, overviewOf, scopeWithin, topologyOf } from '../src/features/displays/compose/topology.ts'
import { resolveSubject } from '../src/features/displays/compose/resolve.ts'
import { visibleObject } from '../src/features/displays/compose/declared.ts'
import type { VignetteView } from '../src/features/displays/compose/model.ts'
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
/** The refs a compiled default's values section shows now (a lead request's as it leads). */
const shownIn = (view: VignetteView): ReadonlyArray<string> => {
  const section = view.sections.find(entry => entry.kind === 'values')
  return section?.kind === 'values' ? section.values.map(value => value.ref) : []
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
    // Its lead values are a lead request, read each sample, never refs fixed as it opened (H1).
    expect(state.views[0]).toEqual({ kind: 'values', lead: { objectId: plantId }, rows: 8 })
    expect(shownIn(view).length > 0 && shownIn(view).every(ref => !own.includes(ref))).toBe(true)
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
    expect(shownIn(view).length > 0 && shownIn(view).every(ref => ref.startsWith(`${plantId}#`))).toBe(true)
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

  test('a pump between two drawn process nodes is drawn whatever feeds its motor, so no drawing names it at a stop on each side', async () => {
    const pumps = ['mainFeedwaterPumpA', 'mainFeedwaterPumpB', 'auxFeedwaterPumpMotor', 'auxFeedwaterPumpMotorB', 'chargingPump', 'chargingPumpB',
      'safetyInjectionPumpA', 'safetyInjectionPumpB', 'rhrPumpA', 'rhrPumpB', 'containmentSprayPumpA', 'containmentSprayPumpB']
    const graph = (await topologyOf(run, plantId))!
    const twice: string[] = []
    for (const pump of pumps) {
      const { state } = await opened(`${plantId}#${pump}`)
      const view = state.views.find(entry => entry.kind === 'topology')
      if (view?.kind !== 'topology') throw new Error(`${pump}: no drawing`)
      const scoped = scopeWithin(graph, view.request)
      if (!scoped.ok) throw new Error(scoped.reason)
      // Each stop names its far ends once; a node at two stops is named twice.
      const named = scoped.scoped.stubs.flatMap(stub => [...new Set(stub.others.map(other => other.node))])
      twice.push(...pumps.filter(other => named.filter(node => node === other).length > 1).map(other => `${pump}: ${other}`))
    }
    // Charging pump A takes boric acid at its inlet too, from a valve CHG B's drawing does not reach: a link in the medium
    // that joins it to the drawing leads elsewhere, so by the rule it stays a stop at the tank and at the core.
    expect(twice).toEqual(['chargingPumpB: chargingPump'])
  })

  test('objectId#label names a device its topology draws before any observable search: the PORV, not a tag that abbreviates it', async () => {
    expect(await resolveSubject(run, `${plantId}#PORV`, 'subject')).toEqual({ kind: 'element', objectId: plantId, elementId: 'pressurizer.reliefValve' })
    expect(await resolveSubject(run, `${plantId}#PORV block`, 'subject')).toEqual({ kind: 'element', objectId: plantId, elementId: 'pressurizer.blockValve' })
    // A declared element still resolves as itself, and a tag names its observable.
    expect(await resolveSubject(run, `${plantId}#SG A`, 'subject')).toEqual({ kind: 'element', objectId: plantId, elementId: 'sgA' })
    expect(await resolveSubject(run, `${plantId}#PORV-456A`, 'subject')).toEqual({ kind: 'observable', objectId: plantId, ref: `${plantId}#pressurizer.reliefValvePositionFraction` })
    const { state, view } = await opened(`${plantId}#PORV`)
    expect(view.title).toBe(`${visibleObject(run, plantId)!.label} · PORV`)
    // Its readings (Q22): its measured position first, never its demand or a value only the simulator computes.
    expect(state.views.find(entry => entry.kind === 'values')).toMatchObject({ lead: { objectId: plantId, element: 'pressurizer.reliefValve' } })
    expect(shownIn(view)[0]).toBe(`${plantId}#pressurizer.reliefValveEffectivePositionFraction`)
    expect(shownIn(view)).not.toContain(`${plantId}#pressurizer.reliefValvePositionFraction`)
    const drawing = view.sections.find(section => section.kind === 'topology')
    expect(drawing?.kind === 'topology' && drawing.nodes.map(node => node.id)).toContain('pressurizer.reliefValve')
  })

  // E2 porv-open: once the Plant declares the PORV's host (parent: the pressurizer, p2-plant), its default carries the
  // pressurizer's lead values after its own, its pressure and level among them.
  test('the PORV carries the pressurizer\'s pressure and level after its own readings', async () => {
    const { view } = await opened(`${plantId}#PORV`)
    expect(shownIn(view)).toEqual(expect.arrayContaining([`${plantId}#pressurizer.pressureMPa`, `${plantId}#pressurizer.levelPercent`]))
  })
})

// Q22: an equipment default leads with today's detail key values (equipmentKeyValues, recorded at power on four-loop
// Halden before the swap), in order, once the Plant declares them as each element's lead (p2-plant, per mode).
describe('Q22: equipment defaults lead with today\'s detail key values', () => {
  const recorded: Readonly<Record<string, ReadonlyArray<string>>> = {
    sgA: ['sgA.levelPercent', 'sgA.wideRangeLevelPercent', 'sgA.secondaryRadiationMSvPerH', 'sgA.pressureMPa', 'sgA.feedwaterFlowKgPerS', 'aux-feedwater-valve-a-to-sg-a.flowKgPerS', 'feedwater-control-valve-a-to-sg-a.flowKgPerS'],
    pressurizer: ['pressurizer.pressureMPa', 'pressurizer.reliefValveFlowing', 'pressurizer-relief-to-tank.temperatureC', 'pressurizer.safetyValvesOpen', 'pressurizer.levelDeviationPercent', 'pressurizer.levelPercent', 'pressurizer.levelProgramPercent', 'pressurizer.backupHeaterDemandMw'],
    rcpA: ['rcpA.runningState', 'rcpA.loopFlowKgPerS'],
  }
  test('SG A, the pressurizer and RCP A at power', async () => {
    const atPower = await registry.create({ scenarioId: 'halden-power-complex' })
    await atPower.setClock({ paused: true })
    await atPower.runMaximumPace(new Date(Date.parse(atPower.snapshot().clock!.currentTime) + 30_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    const powerRun = await displayRunOf(registry, atPower, person, new Set())
    for (const [element, values] of Object.entries(recorded)) {
      const outcome = await composeDefault(powerRun, `${plantId}#${element}`)
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
      expect(shownIn(await compileVignette(powerRun, outcome.state)).slice(0, values.length), element).toEqual(values.map(path => `${plantId}#${path}`))
    }
  })
})

// E2 (swap candidate 10cfda49f): every topology the Assistant asked for on the new side, as it asked (show-feed-lineup,
// feed-path-b, op-open-msiv-at-power). A request whose drawing does not verify at its reach draws nearer, and says so;
// a line named by its observable stands for its ends.
describe('E2: the topologies the Assistant asked for draw', () => {
  const asked = (subjects: ReadonlyArray<string>, topology: Record<string, unknown>) => ({ title: 'E2', question: 'E2', subjects: subjects.map(name => `${plantId}#${name}`), views: [{ kind: 'topology', ...Object.fromEntries(Object.entries(topology).map(([key, value]) => [key, Array.isArray(value) ? value.map(name => `${plantId}#${name}`) : value])) }] })
  const cases: ReadonlyArray<readonly [string, ReturnType<typeof asked>, string?]> = [
    ['feed-path-b k1, around the FCV and SG B two links out', asked(['feedwaterControlValveB.effectivePositionFraction', 'sgB.levelPercent'], { around: ['feedwaterControlValveB.effectivePositionFraction', 'sgB.levelPercent'], reach: 2 }), 'drawn 1 link out to fit'],
    ['feed-path-b k1, from the FCV to SG B', asked(['feedwaterControlValveB.effectivePositionFraction', 'sgB.levelPercent'], { from: ['feedwaterControlValveB.effectivePositionFraction'], to: ['sgB.levelPercent'] })],
    ['op-open-msiv-at-power, around MSIV A by its tag', asked(['MSIV-A'], { around: ['MSIV-A'], reach: 1 })],
    ['show-feed-lineup k1, from the feedwater tank to every SG', asked(['feedwaterTank', 'sgA', 'sgB', 'sgC', 'sgD'], { from: ['feedwaterTank'], to: ['sgA', 'sgB', 'sgC', 'sgD'], reach: 4 })],
    ['feed-path-b k2, around a line by its flow and SG B', asked(['sgB.feedwaterFlowKgPerS', 'feedwater-control-valve-b-to-sg-b.flowKgPerS'], { around: ['feedwater-control-valve-b-to-sg-b.flowKgPerS', 'sgB.feedwaterFlowKgPerS'], reach: 3 }), 'drawn 1 link out to fit'],
    ['feed-path-b k2, around SG B three links out', asked(['sgB.feedwaterFlowKgPerS', 'sgB.levelPercent'], { around: ['sgB'], reach: 3 }), 'drawn 1 link out to fit'],
    // Each AFW valve's line into its SG takes a fourth bend where three draw nothing (render, 69a7dce68).
    ['show-feed-lineup k2, from MFW A and the AFW header to every SG', asked(['mainFeedwaterPumpA.runningState', 'auxFeedwaterHeader.outletFlowKgPerS'], { from: ['mainFeedwaterPumpA', 'auxFeedwaterHeader'], to: ['sgA', 'sgB', 'sgC', 'sgD'], reach: 3 })],
  ]
  for (const [name, spec, adjustment] of cases) {
    test(name, async () => {
      const outcome = await composeVignette(run, spec as never)
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
      const drawing = (await compileVignette(run, outcome.state)).sections.find(section => section.kind === 'topology')
      if (drawing?.kind !== 'topology') throw new Error('no drawing')
      expect(drawing.layout.width <= FLOW_ROOM.columns && drawing.layout.height <= FLOW_ROOM.rows).toBe(true)
      expect(overlaps(drawing.layout)).toEqual([])
      if (adjustment !== undefined) expect(outcome.card.adjusted.map(entry => entry.text)).toContain(adjustment)
    })
  }
})
