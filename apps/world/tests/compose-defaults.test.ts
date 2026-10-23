import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { displaySpecSchema } from '../src/core/observation/spec.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { alertRows, priorityRank } from '../src/features/displays/alerts/rows.ts'
import { sectionLines } from '../src/ui/embed/vignette/alerts.ts'
import type { AlertState } from '../src/core/model/alerts.ts'
import { composeDefault, composeVignette } from '../src/features/displays/compose/compose.ts'
import { leadRefs } from '../src/features/displays/compose/defaults.ts'
import type { VignetteSection, VignetteState } from '../src/features/displays/compose/model.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { guardPlantTests } from './plant-hang-guard.ts'
import { fixtureComposeRun } from './fixtures/compose-runs.ts'

guardPlantTests()

// Architecture A3: the World default of every subject kind, for each of the six Packs of the integrated fixture and the
// fixture Pack, from what they declare: at most four views, each only where its data exists, every number from a read.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const integrated = scenarioDefinitionSchema.parse(await Bun.file(new URL('./fixtures/scenarios/integrated-all-packs.scenario.json', import.meta.url)).json())
const person = { id: 'actor:human:defaults' as ActorId, label: 'Defaults', role: 'operator' as const }
let registry: SimulationRunRegistry
let dataDir: string
let run: ViewRun
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-defaults-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: [...builtinScenarioDefinitions, integrated],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
    // Runs are read long after their last step while other Runs play: none may close as idle.
    idleRuntimeCloseTimer: () => () => {},
  })
  const runtime = await registry.create({ scenarioId: integrated.id })
  await runtime.setClock({ paused: true })
  await runtime.runMaximumPace(new Date(Date.parse(runtime.snapshot().clock!.currentTime) + 60_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  run = await displayRunOf(registry, runtime, person, new Set())
})
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

const kinds = (sections: ReadonlyArray<VignetteSection>) => sections.map(section => section.kind)
const opened = async (viewRun: ViewRun, subject: Parameters<typeof composeDefault>[1]) => {
  const outcome = await composeDefault(viewRun, subject)
  if (!outcome.ok) throw new Error(`${JSON.stringify(subject)}: ${JSON.stringify(outcome.issues)}`)
  const view = await compileVignette(viewRun, outcome.state)
  const sample = await sampleVignette(viewRun, outcome.state, { fromMs: 0 })
  expect(outcome.state.views.length).toBeLessThanOrEqual(4)
  expect(outcome.rows).toBeLessThanOrEqual(40)
  expect(JSON.stringify(outcome.state)).not.toMatch(/"value"|"limits"|coordinates/)
  // Every number on the card is one a read gave: an observation's value, a threshold, or an object's slot.
  return { ...outcome, view, sample }
}
const firstElement = async (objectId: string, cls?: string) => {
  const [declaration] = await run.port.declarations([objectId as ObjectId])
  if (declaration === undefined || 'refused' in declaration) throw new Error(`${objectId} declares nothing`)
  return declaration.elements.find(element => cls === undefined || element.class === cls)!.id
}

const runOf = async (scenarioId: string, seconds: number): Promise<ViewRun> => {
  const runtime = await registry.create({ scenarioId })
  await runtime.setClock({ paused: true })
  await runtime.runMaximumPace(new Date(Date.parse(runtime.snapshot().clock!.currentTime) + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  return displayRunOf(registry, runtime, person, new Set())
}

describe('a run-wide alerts view', () => {
  const runWide = (subjects: ReadonlyArray<string>) => displaySpecSchema.parse({ title: 'Run-wide alerts', question: 'Does anything need attention?', subjects, views: [{ kind: 'alerts', scope: 'run' }] })
  const drawn = async (viewRun: ViewRun, subjects: ReadonlyArray<string> = []) => {
    const outcome = await composeVignette(viewRun, runWide(subjects))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    return { ...outcome, sample: await sampleVignette(viewRun, outcome.state) }
  }

  test('draws the active alerts of every Pack the caller may see, each object\'s worst first as the Run context ranks them', async () => {
    // Beside the Runs' own alarms (the grid's), an advisory in force and acknowledged alarms of three more Packs: the
    // worry answer's case (G1), where an advisory sorted last left weather out of view.
    const raised = (id: string, priority: 'caution' | 'warning' | 'alarm', facets: Partial<AlertState> = {}): AlertState => ({
      id, kind: 'test', severity: priority === 'alarm' ? 'critical' : 'warning', message: `${id} raised`, raisedAt: run.clock!.currentTime as AlertState['raisedAt'], acknowledged: false, priority, clock: 'simulation', ...facets,
    })
    const extra: Readonly<Record<string, ReadonlyArray<AlertState>>> = {
      'weather-probe:halden-complex': [raised('fog', 'warning', { advisory: true })],
      'plant:halden-2': [raised('sg-level', 'caution', { acknowledged: true }), raised('pzr-pressure', 'alarm', { acknowledged: true })],
      'unit:halden-1': [raised('late', 'caution')],
    }
    const busy: ViewRun = { ...run, objects: run.objects.map(object => ({ ...object, alerts: [...object.alerts, ...extra[object.id] ?? []] })) }
    for (const viewRun of [run, await runOf('halden-normal-operation', 120), busy]) {
      const open = alertRows(viewRun.objects, object => ({ label: object.label, categoryId: '' }))
      const { sample, card } = await drawn(viewRun)
      expect(new Set(sample.alerts.map(row => row.packId))).toEqual(new Set(open.map(row => row.packId)))
      expect(sample.alerts).toHaveLength(open.length)
      const objects = new Set(open.map(row => row.objectId)).size
      const heads = sample.alerts.slice(0, objects)
      expect(new Set(heads.map(row => row.objectId)).size).toBe(objects)
      expect(heads.map(row => priorityRank(row.priority))).toEqual(heads.map(row => priorityRank(row.priority)).sort((left, right) => right - left))
      for (const head of heads) expect(open.filter(row => row.objectId === head.objectId).every(row => priorityRank(row.priority) <= priorityRank(head.priority))).toBe(true)
      expect(card.items.map(item => item.subject)).toEqual(sample.alerts.slice(0, card.items.length).map(row => ({ objectId: row.objectId, alertId: row.alert.id })))
      console.log(`run-wide alerts: ${open.length} alerts of ${[...new Set(open.map(row => row.packId))].join(', ')}; heads ${heads.map(row => `${row.packId}:${row.priority}`).join(' ')}`)
    }
    const { sample } = await drawn(busy)
    expect(sample.alerts.slice(0, 3).map(row => [row.objectId, row.alert.id])).toEqual([['plant:halden-2', 'pzr-pressure'], ['weather-probe:halden-complex', 'fog'], ['unit:halden-1', 'late']])
  })

  test('needs no subject, covers every subject named, and shows nothing of what the caller may not inspect', async () => {
    expect((await drawn(run, ['plant:halden-1', 'grid:halden-four-unit', 'weather-probe:halden-complex'])).state.views.map(view => view.kind)).toEqual(['alerts'])
    expect(displaySpecSchema.safeParse({ title: 't', question: 'q', subjects: [], views: [{ kind: 'alerts' }] }).error?.issues[0]?.message).toBe('name 1 to 6 subjects; only a run-wide alerts view (scope run) needs none')
    const hidden = (await drawn({ ...run, denied: new Set(['grid:halden-four-unit']) })).sample
    expect(hidden.alerts.some(row => row.objectId === 'grid:halden-four-unit')).toBe(false)
  })
})

describe('no card drops a row silently (Q15)', () => {
  test('xp7: the open requests of supply-run at 22 min are all counted: 12 rows on the card, the rest in `more` and said', async () => {
    const supply = await runOf('supply-run', 22 * 60)
    const of = { category: 'einsatz-tasks', status: ['open'], closed: false }
    const outcome = await composeVignette(supply, displaySpecSchema.parse({ title: 'Open supply requests', question: 'Which are open?', subjects: [{ of }], views: [{ kind: 'values', of }] }))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    const open = (await sampleVignette(supply, outcome.state)).entities[0]!
    const total = open.rows.length + open.more
    expect(total).toBeGreaterThan(12)
    const rows = outcome.card.items.filter(item => item.subject !== undefined && 'objectId' in item.subject && !('alertId' in item.subject))
    expect(rows.length + outcome.card.more).toBe(total)
    expect(outcome.card.adjusted).toContainEqual({ kind: 'layout', text: `${total - rows.length} of ${total} Tasks not shown` })
  })

  test('a run-wide alerts card leads with every object\'s worst alert, the reactor trip first out, and counts the rest', async () => {
    // E1 gate-b at 4 min: two Tegneby circuits open, ice on the ground, Unit 2's turbine tripped at 1 min.
    const runtime = await registry.create({ scenarioId: integrated.id })
    await runtime.setClock({ paused: true })
    const start = Date.parse(runtime.snapshot().clock!.currentTime)
    const play = (seconds: number) => runtime.runMaximumPace(new Date(start + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    const invoke = async (capabilityId: string, input: unknown) => {
      const outcome = await runtime.invokeCapability(person, { capabilityId, input })
      if (outcome.kind === 'command' && !outcome.result.ok) throw new Error(JSON.stringify(outcome.result))
    }
    for (const assetId of ['branch:osm-1022cbf125eebbb4', 'branch:osm-50a77b48767677b0']) await invoke('world.electric-grid.open-branch', { gridId: 'grid:halden-four-unit', assetId })
    await invoke('world.weather.intervene-ground', { area: { type: 'Polygon', coordinates: [[[11.2, 59.0], [11.65, 59.0], [11.65, 59.3], [11.2, 59.3], [11.2, 59.0]]] }, surface: { ice: 0.85 } })
    await play(60)
    await invoke('world.process-plant.action.invoke', { plantId: 'plant:halden-2', actionId: 'turbine-trip', parameters: {} })
    await play(240)
    const gate = await displayRunOf(registry, runtime, person, new Set())
    const outcome = await composeVignette(gate, displaySpecSchema.parse({ title: 'Run-wide alerts', question: 'What needs attention?', subjects: [], views: [{ kind: 'alerts', scope: 'run' }] }))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    const alerted = new Set(gate.objects.filter(object => alertRows([object], () => ({ label: '', categoryId: '' })).length > 0).map(object => object.id))
    const heads = outcome.card.items.slice(0, alerted.size).map(item => item.subject !== undefined && 'objectId' in item.subject ? item.subject.objectId : '')
    expect(new Set(heads)).toEqual(alerted)
    expect(outcome.card.items[0]).toMatchObject({ label: 'Halden Unit 2', reading: 'alarm · Reactor trip on turbine trip · first out' })
    const total = alertRows(gate.objects, () => ({ label: '', categoryId: '' })).length
    expect(outcome.card.items.length + outcome.card.more).toBe(total)
    expect(outcome.card.adjusted).toEqual([{ kind: 'layout', text: `${outcome.card.more} of ${total} alerts not shown` }])
  })
})

describe('World defaults of every subject kind', () => {
  test('declared objects lead with their own states, then their Pack\'s lead values (plant, grid, weather)', async () => {
    for (const objectId of ['plant:halden-1', 'grid:halden-four-unit', 'weather-probe:halden-complex']) {
      const { view, card, sample } = await opened(run, objectId)
      expect(kinds(view.sections)[0]).toBe('values')
      expect(card.items.length).toBeGreaterThan(0)
      expect(sample.observations.length).toBeGreaterThan(0)
      const [declaration] = await run.port.declarations([objectId as ObjectId])
      const own = declaration === undefined || 'refused' in declaration ? [] : declaration.observables.filter(observable => observable.quantity === 'state' && observable.element === undefined).map(observable => observable.ref)
      const expected = [...new Set([...own.slice(0, 8), ...await leadRefs(run, objectId as ObjectId)])].slice(0, 2)
      expect(card.items.slice(0, 2).map(item => item.subject)).toEqual(expected.map(ref => ({ ref })))
    }
    const grid = await opened(run, 'grid:halden-four-unit')
    const drawing = grid.view.sections.find(section => section.kind === 'topology')
    expect(drawing?.kind === 'topology' && [drawing.family, drawing.nodes.length > 0]).toEqual(['network', true])
  })

  test('a wider network view takes whole rows though its layout ends on a half grid unit', async () => {
    const [declaration] = await run.port.declarations(['grid:halden-four-unit' as ObjectId])
    const graph = await run.port.topology('grid:halden-four-unit' as ObjectId)
    if (declaration === undefined || 'refused' in declaration || 'refused' in graph) throw new Error('the grid declares nothing')
    const media = graph.media.filter(medium => (medium.level?.value ?? 0) >= 300).map(medium => medium.id)
    const outcome = await composeVignette(run, displaySpecSchema.parse({ title: 'Switchyard', question: 'What feeds the switchyard?', subjects: ['grid:halden-four-unit'],
      views: [{ kind: 'topology', around: ['grid:halden-four-unit#bus:curated-halden-pwr-switchyard@420'], media, reach: 4 }] }))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    const [view] = outcome.state.views
    expect(view?.kind === 'topology' && Number.isInteger(view.rows)).toBe(true)
    const drawn = (await compileVignette(run, outcome.state)).sections[0]
    expect(drawn?.kind === 'topology' && Math.ceil(drawn.layout.height) + 1).toBe(view!.rows)
  })

  test('entity-floor objects show their core slots and a map focus (ambulance, drone, Einsatz)', async () => {
    for (const objectId of ['unit:halden-1', 'drone:halden-search', 'unit:truck-1', 'site:brekke-depot']) {
      const { view, card, sample } = await opened(run, objectId)
      expect(kinds(view.sections)).toEqual(['slots', 'alerts', 'map'])
      expect(card.items.length).toBeGreaterThan(0)
      expect(sample.maps[2]?.positioned).toBe(1)
    }
    const drone = await opened(run, 'drone:halden-search')
    expect(drone.view.sections[0]?.kind === 'slots' && drone.view.sections[0].slots.some(slot => slot.key.startsWith('telemetry:'))).toBe(true)
  })

  test('an answer on three entity objects keeps their map: an alerts view with nothing to list gives way past four views', async () => {
    const subjects = ['drone:halden-search', 'unit:truck-1', 'site:brekke-depot']
    expect(subjects.flatMap(id => run.objects.find(object => object.id === id)!.alerts)).toEqual([])
    const outcome = await composeVignette(run, displaySpecSchema.parse({ title: 'Assets', question: 'Where are the drone, the truck and the depot?', subjects, views: [] }))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    expect(outcome.state.views.map(view => view.kind)).toEqual(['slots', 'slots', 'slots', 'map'])
  })

  test('elements and observables show what is measured on them (plant, grid, weather)', async () => {
    const bus = await opened(run, `grid:halden-four-unit#${await firstElement('grid:halden-four-unit', 'bus')}`)
    expect(kinds(bus.view.sections)).toEqual(expect.arrayContaining(['values', 'topology']))
    expect(kinds((await opened(run, `plant:halden-1#${await firstElement('plant:halden-1')}`)).view.sections)[0]).toBe('values')
    for (const objectId of ['plant:halden-1', 'grid:halden-four-unit', 'weather-probe:halden-complex']) {
      const [ref] = await leadRefs(run, objectId as ObjectId)
      const { card } = await opened(run, ref!)
      expect(card.items[0]?.subject).toEqual({ ref: ref! })
    }
  })

  test('a connection shows both ends\' electric values and its alerts; its title comes from its ends', async () => {
    const tie = await opened(run, 'halden-unit-1-grid')
    expect(kinds(tie.view.sections)[0]).toBe('values')
    expect(new Set(tie.card.items.flatMap(item => item.subject !== undefined && 'ref' in item.subject ? [item.subject.ref.split('#')[0]] : []))).toEqual(new Set(['plant:halden-1', 'grid:halden-four-unit']))
    expect(tie.state.title).toBe(`${run.objects.find(object => object.id === 'plant:halden-1')!.label} – ${run.objects.find(object => object.id === 'grid:halden-four-unit')!.label}`)
  })

  test('every presentation category of every Pack opens as a table with its map', async () => {
    for (const pack of run.packs) {
      for (const category of pack.presentation.categories) {
        const { view, sample } = await opened(run, { of: { category: `${category.label} (${pack.descriptor.id})`, closed: false } })
        expect(kinds(view.sections)).toEqual(expect.arrayContaining(['entity', 'map']))
        expect(sample.entities[0]?.rows.every(row => run.objects.find(object => object.id === row.objectId)?.packId === pack.descriptor.id)).toBe(true)
      }
    }
  })

  test('the fixture Pack, which World knows nothing of, has the same defaults', async () => {
    const fixture = await fixtureComposeRun()
    try {
      const fixtureRun = await fixture.runOf()
      expect(kinds((await opened(fixtureRun, 'unit:one')).view.sections)).toEqual(['values', 'alerts', 'topology'])
      expect(kinds((await opened(fixtureRun, 'site:base')).view.sections)).toEqual(['slots', 'alerts', 'map'])
      expect(kinds((await opened(fixtureRun, 'unit:one#engine')).view.sections)).toEqual(['values', 'alerts', 'topology'])
      expect(kinds((await opened(fixtureRun, { of: { category: 'tasks', closed: false } })).view.sections)).toEqual(['entity', 'alerts', 'map'])
    } finally { await fixture.close() }
  })
})

// UX audit H1: an overview opened before an upset never showed the upset's alerts. Its default listed alerts only where
// the object had some when it was composed, and a sample carried alert rows only for an alerts view, which the drawing's
// item frames and the frame's worst chip read too.
describe('a default opened before an upset', () => {
  test('shows the alerts raised after it within one sample: its alerts view, and its drawing\'s object\'s rows for the frames and the worst chip', async () => {
    const fixture = await fixtureComposeRun()
    try {
      const quiet = await fixture.runOf()
      expect(quiet.objects.find(object => object.id === 'unit:one')!.alerts).toEqual([])
      const outcome = await composeDefault(quiet, 'unit:one')
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
      expect(outcome.state.views.map(view => view.kind)).toEqual(['values', 'alerts', 'topology'])
      // Its alerts keep a head and four lines though none are raised yet: the first to come show, not only their count.
      expect(outcome.state.views.find(view => view.kind === 'alerts')?.rows).toBe(5)
      expect((await sampleVignette(quiet, outcome.state)).alerts).toEqual([])
      // The same state, sampled once the engine alarms.
      const raised: AlertState = { id: 'overspeed', kind: 'test', severity: 'critical', message: 'Engine overspeed', raisedAt: quiet.clock!.currentTime as AlertState['raisedAt'], acknowledged: false, priority: 'alarm', clock: 'simulation', subject: { element: 'engine' } }
      const alarmed = await fixture.runOf({ objects: quiet.objects.map(object => (object.id === 'unit:one' ? { ...object, alerts: [raised] } : object)) })
      expect((await sampleVignette(alarmed, outcome.state)).alerts.map(row => [row.objectId, row.alert.message, row.priority])).toEqual([['unit:one', 'Engine overspeed', 'alarm']])
      // A drawing alone, with no alerts view, still carries its object's rows: its item frames and the worst chip read them.
      const drawn = await composeVignette(quiet, displaySpecSchema.parse({ title: 'Engine', question: 'What feeds the engine?', subjects: ['unit:one'], views: [{ kind: 'topology', around: ['unit:one#engine'], reach: 1 }] }))
      if (!drawn.ok) throw new Error(JSON.stringify(drawn.issues))
      expect(drawn.state.views.map(view => view.kind)).toEqual(['topology'])
      expect((await sampleVignette(alarmed, drawn.state)).alerts.map(row => row.alert.message)).toEqual(['Engine overspeed'])
    } finally { await fixture.close() }
  })

  // Plan §2 rule 3: every other default kind held its alerts view only where there were alerts as it was composed, so
  // a core's or SG's pop-over opened at power showed none of the trip's.
  test('every other default kind holds its alerts too, rows kept, filled each sample: an element (its own, then its object\'s lead alerts), an observable, an entity object, a collection', async () => {
    const fixture = await fixtureComposeRun()
    try {
      const quiet = await fixture.runOf()
      expect(quiet.objects.flatMap(object => object.alerts)).toEqual([])
      const subjects = { element: 'unit:one#engine', observable: 'unit:one#speed', entity: 'site:base', collection: { of: { category: 'units', closed: false } } } as const
      const composed = Object.fromEntries(await Promise.all(Object.entries(subjects).map(async ([kind, subject]) => {
        const outcome = await composeDefault(quiet, subject)
        if (!outcome.ok) throw new Error(`${kind}: ${JSON.stringify(outcome.issues)}`)
        return [kind, { state: outcome.state, view: await compileVignette(quiet, outcome.state) }] as const
      })))
      const at = quiet.clock!.currentTime as AlertState['raisedAt']
      const raised = (id: string, message: string, facets: Partial<AlertState>): AlertState => ({ id, kind: 'test', severity: 'critical', message, raisedAt: at, acknowledged: false, priority: 'alarm', clock: 'simulation', ...facets })
      const alarms: Readonly<Record<string, ReadonlyArray<AlertState>>> = {
        'unit:one': [
          raised('overspeed', 'Engine overspeed', { subject: { element: 'engine' }, observable: 'unit:one#speed' }),
          raised('trip', 'Unit trip on overspeed', { firstOut: { group: 'trip', rank: 1 } }),
          raised('tank-low', 'Tank low', { subject: { element: 'tank' }, priority: 'caution', severity: 'warning' }),
        ],
        'site:base': [raised('gate', 'Base gate open', {})],
      }
      const alarmed = await fixture.runOf({ objects: quiet.objects.map(object => ({ ...object, alerts: alarms[object.id] ?? [] })) })
      const shown: Record<string, ReadonlyArray<string>> = {}
      for (const [kind, { state, view }] of Object.entries(composed)) {
        // Composed with none raised: an alerts view keeping a head and four lines.
        const index = state.views.findIndex(entry => entry.kind === 'alerts')
        expect([kind, state.views[index]?.rows]).toEqual([kind, 5])
        expect((await sampleVignette(quiet, state)).alerts).toEqual([])
        // The same state, sampled once the alerts are raised: the section lists its own.
        const section = view.sections.find(entry => entry.kind === 'alerts')
        if (section?.kind !== 'alerts') throw new Error(`${kind}: no alerts section`)
        shown[kind] = sectionLines((await sampleVignette(alarmed, state)).alerts, section, section.rows - 1).lines.map(line => line.row.alert.message)
      }
      expect(shown).toEqual({
        element: ['Engine overspeed', 'Unit trip on overspeed'],
        observable: ['Engine overspeed'],
        entity: ['Base gate open'],
        collection: ['Engine overspeed', 'Unit trip on overspeed', 'Tank low'],
      })
    } finally { await fixture.close() }
  })
})

// Q22: an element's values lead with what its Pack declares its detail leads with (another element's among them),
// then its own instrument readings and states by rank, then the rest; a demand or a simulator-only value only where a
// request names it. A device carries its host element's values after its own.
describe('an element default leads with its declared lead values (Q22)', () => {
  const ref = (signal: string) => `unit:one#${signal}`
  const number = (signal: string, label: string, element: string, basis?: 'instrument' | 'command' | 'model') =>
    ({ ref: ref(signal), label, quantity: 'speed', unit: 'm/s', valueType: 'number', thresholds: [], series: null, element, ...(basis === undefined ? {} : { basis }) })
  const extra = [
    number('demand', 'Engine speed demand', 'engine', 'command'), number('slip', 'Engine slip (model)', 'engine', 'model'),
    number('vibration', 'Engine vibration', 'engine', 'instrument'), number('fuelFlow', 'Tank outflow', 'tank', 'instrument'),
    { ref: ref('valve'), label: 'Engine valve', quantity: 'state', unit: '', valueType: 'text', thresholds: [], series: null, element: 'engine.valve' },
  ]
  const added = new Set(extra.map(entry => entry.ref))
  const declaring = (base: ViewRun['port']): ViewRun['port'] => ({
    ...base,
    declarations: async (objectIds, elementIds) => (await base.declarations(objectIds, elementIds)).map(declaration => 'refused' in declaration || declaration.objectId !== 'unit:one' ? declaration : {
      ...declaration,
      elements: [...declaration.elements.map(element => element.id === 'engine' ? { ...element, lead: [ref('fuelFlow'), ref('demand'), ref('speed')] } : element),
        { id: 'engine.valve', class: 'valve', label: 'Engine valve', parent: 'engine' }],
      observables: [...declaration.observables, ...extra] as never,
    }),
    read: async request => {
      if (!('refs' in request)) return base.read(request)
      const known = request.refs.filter(entry => !added.has(entry))
      const read = known.length === 0 ? { observations: [], unknown: [], refused: [] } : await base.read({ refs: known })
      return { ...read, observations: [...read.observations, ...request.refs.filter(entry => added.has(entry)).map(entry => ({ ref: entry, at: read.observations[0]?.at ?? '2026-01-01T08:00:00.000Z', clock: 'simulation', value: entry === ref('valve') ? 'open' : 1, quality: 'good', priority: 'none' }) as never)] }
    },
  })
  /** The values a state's values view shows now: its named refs, or what its lead request leads with (compiled). */
  const valuesOf = async (viewRun: ViewRun, state: VignetteState) => {
    const section = (await compileVignette(viewRun, state)).sections.find(entry => entry.kind === 'values')
    return section?.kind === 'values' ? section.values.map(value => value.ref) : undefined
  }

  test('the declared lead first (another element\'s value among them), then readings; no demand or model value; a device after its own, its host\'s', async () => {
    const fixture = await fixtureComposeRun()
    try {
      const run = await fixture.runOf()
      const declared = await fixture.runOf({ port: declaring(run.port) })
      const engine = await composeDefault(declared, 'unit:one#engine')
      if (!engine.ok) throw new Error(JSON.stringify(engine.issues))
      expect(await valuesOf(declared, engine.state)).toEqual([ref('fuelFlow'), ref('speed'), ref('vibration')])
      const valve = await composeDefault(declared, 'unit:one#engine.valve')
      if (!valve.ok) throw new Error(JSON.stringify(valve.issues))
      expect(await valuesOf(declared, valve.state)).toEqual([ref('valve'), ref('fuelFlow'), ref('speed'), ref('vibration')])
      // A request that names the demand shows it.
      const named = await composeVignette(declared, displaySpecSchema.parse({ title: 'Demand', question: 'What is the engine asked for?', subjects: [ref('demand')], views: [{ kind: 'values', signals: [ref('demand'), ref('slip')] }] }))
      if (!named.ok) throw new Error(JSON.stringify(named.issues))
      expect(await valuesOf(declared, named.state)).toEqual([ref('demand'), ref('slip')])
    } finally { await fixture.close() }
  })
})
