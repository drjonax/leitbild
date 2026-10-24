import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DISPLAY_CARD_MAX_TEXT, displayCardTextLength } from '@leitbild/contracts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ObjectId, OperationalObject } from '../src/core/model/index.ts'
import type { Observation } from '../src/core/observation/model.ts'
import { displaySpecSchema } from '../src/core/observation/spec.ts'
import { composeVignette, type ComposeOutcome } from '../src/features/displays/compose/compose.ts'
import type { SetSample, VignetteState } from '../src/features/displays/compose/model.ts'
import { fitSet, sampleSet, SET_ROWS } from '../src/features/displays/compose/sets.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { assembleRunContext } from '../src/features/displays/context/run-context.ts'
import { fleetRun, fleetViewer } from './fixtures/fleet-runs.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Multiunit plan M1.2: a set is named once and resolved again at each sample; a fleet lists every member worst first in
// the rows its frame gives, a comparison matches each quantity per member and says which member does not measure it, a
// set trend draws a band and named outliers, and no unit at caution or above is ever hidden behind "+M more" or a band.

const CLUSTER = { category: 'process-plants', group: 'halden-power-complex' }
const compose = async (run: ViewRun, views: ReadonlyArray<unknown>): Promise<ComposeOutcome> =>
  composeVignette(run, displaySpecSchema.parse({ title: 'Fleet', question: 'How are the units doing?', subjects: [], views }))
const composed = async (run: ViewRun, views: ReadonlyArray<unknown>): Promise<Extract<ComposeOutcome, { ok: true }>> => {
  const outcome = await compose(run, views)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  return outcome
}
const setOf = <Kind extends SetSample['kind']>(sample: { readonly sets?: Readonly<Record<number, SetSample>> }, kind: Kind): Extract<SetSample, { kind: Kind }> => {
  const set = sample.sets?.[0]
  if (set?.kind !== kind) throw new Error(`no ${kind} set in ${JSON.stringify(sample.sets)}`)
  return set as Extract<SetSample, { kind: Kind }>
}
/** Copies of a unit under new ids: members a fleet lists from their projection, with the unit's alerts. */
const clones = (unit: OperationalObject, count: number): ReadonlyArray<OperationalObject> =>
  Array.from({ length: count }, (_, at) => ({ ...unit, id: `plant:copy-${at + 1}` as ObjectId, label: `Copy ${at + 1}` }))

let fleet: Awaited<ReturnType<typeof fleetRun>>
let run: ViewRun
beforeAll(async () => {
  fleet = await fleetRun(12, 10)
  run = await fleet.runOf()
}, 120_000)
afterAll(async () => { await fleet.close() })

describe('a fleet of twelve units', () => {
  test('lists every unit in a chat frame under its count, names the set not its members, and cites each row', async () => {
    const outcome = await composed(run, [{ kind: 'fleet', of: CLUSTER }])
    expect(outcome.state.views[0]).toMatchObject({ kind: 'fleet', of: { packId: 'process-plant', categoryId: 'process-plants', group: 'halden-power-complex' }, rows: 2 + 12 })
    expect(JSON.stringify(outcome.state)).not.toContain('plant:halden-')
    const view = await compileVignette(run, outcome.state)
    expect(view.sections[0]).toMatchObject({ kind: 'fleet', label: 'Process plants', group: { label: 'Cluster', value: 'halden-power-complex' } })
    const set = setOf(await sampleVignette(run, outcome.state), 'fleet')
    expect([set.members, set.rows.length, set.more]).toEqual([12, 12, 0])
    expect(set.rows[0]!.values).toMatchObject({ mode: 'Power operation', safety: 'Satisfied', alarms: 0 })
    expect(outcome.card.items[0]).toMatchObject({ label: 'Process plants · halden-power-complex', reading: '12 units' })
    expect(outcome.card.items.slice(1).map(item => item.subject)).toEqual(Array.from({ length: 12 }, (_, at) => ({ objectId: `plant:halden-${at + 1}` })))
    expect(outcome.card.items[1]!.reading).toMatch(/^Power operation · Satisfied · Thermal power \d+ MW · Electrical output \d+ MW · 0 alarms$/)
    expect(displayCardTextLength(outcome.card)).toBeLessThanOrEqual(DISPLAY_CARD_MAX_TEXT)
  })

  test('refuses a group its Pack does not have, offering those it has', async () => {
    const outcome = await compose(run, [{ kind: 'fleet', of: { category: 'process-plants', group: 'ringhals' } }])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.issues[0]).toMatchObject({ path: 'views.0.of.group', code: 'unknown_name', didYouMean: [{ pack: 'process-plant', suggestions: ['halden-power-complex'] }] })
  })

  test('re-resolves its members at each sample: a unit that leaves the Run leaves the set, and one that joins is listed', async () => {
    const without = { ...run, objects: run.objects.filter(object => object.id !== 'plant:halden-1') }
    const outcome = await composed(without, [{ kind: 'fleet', of: CLUSTER }])
    expect(setOf(await sampleVignette(without, outcome.state), 'fleet')).toMatchObject({ members: 11, more: 0 })
    // Its rows were allotted for eleven: the twelfth is listed in Run order, and the last two in sight give way to "+2 more".
    const joined = setOf(await sampleVignette(run, outcome.state), 'fleet')
    expect(joined).toMatchObject({ members: 12, more: 2, moreAtCaution: 0 })
    expect(joined.rows[0]!.objectId).toBe('plant:halden-1')
    // Alerts of a set follow it the same way.
    const alerts = await composed(without, [{ kind: 'alerts', of: CLUSTER }])
    expect(alerts.state.views[0]).toMatchObject({ kind: 'alerts', objectIds: 'set' })
    expect(setOf(await sampleVignette(without, alerts.state), 'alerts').members).toHaveLength(11)
    expect(setOf(await sampleVignette(run, alerts.state), 'alerts').members).toContain('plant:halden-1')
  })

  test('gives a window twice the rows of a chat answer, then "+M more" with the count at caution or above', async () => {
    const many = { ...run, objects: [...run.objects, ...clones(run.objects.find(object => object.id === 'plant:halden-1')!, 18)] }
    const draft = { kind: 'fleet' as const, of: { packId: 'process-plant', categoryId: 'process-plants', closed: false } }
    expect(fitSet(many, draft, 'chat', 'views.0')).toBe(2 + SET_ROWS.chat + 1)
    expect(fitSet(many, draft, 'window', 'views.0')).toBe(2 + SET_ROWS.window + 1)
    const set = await sampleSet(many, { ...draft, rows: 2 + SET_ROWS.chat + 1 }, () => undefined)
    expect(set).toMatchObject({ kind: 'fleet', members: 30, more: 30 - 12, moreAtCaution: 0 })
  })
})

describe('a fleet of four units', () => {
  test('lists four rows and fits a chat answer with room for alerts', async () => {
    const four = await fleet.registry.create({ scenarioId: 'halden-power-complex' })
    await four.setClock({ paused: true })
    const runFour = await displayRunOf(fleet.registry, four, fleetViewer, new Set())
    const outcome = await composed(runFour, [{ kind: 'fleet', of: CLUSTER }, { kind: 'alerts', of: CLUSTER }])
    expect(outcome.state.views[0]!.rows).toBe(2 + 4)
    const sample = await sampleVignette(runFour, outcome.state)
    expect(setOf(sample, 'fleet').rows.map(row => row.label)).toEqual(['Halden Unit 1', 'Halden Unit 2', 'Halden Unit 3', 'Halden Unit 4'])
    expect(outcome.card.items[0]!.reading).toBe('4 units')
  })
})

describe('a comparison across units', () => {
  test('matches each quantity per unit by role, label or tag, and says which unit does not measure one', async () => {
    // Unit 5 as a smaller model would be: no fourth steam generator.
    const smaller: ViewRun = {
      ...run,
      port: {
        ...run.port,
        declarations: async (ids, elements) => (await run.port.declarations(ids, elements)).map(entry => 'observables' in entry && entry.objectId === 'plant:halden-5'
          ? { ...entry, observables: entry.observables.filter(observable => observable.ref !== 'plant:halden-5#sgD.levelPercent') } : entry),
      },
    }
    const outcome = await composed(smaller, [{ kind: 'compare', of: CLUSTER, signals: ['SG D level', 'pressurizer-pressure', 'plant:halden-1#turbine.electricMw'] }])
    const view = outcome.state.views[0]!
    expect(view).toMatchObject({ kind: 'compare', signals: [{ ref: 'sgD.levelPercent', label: 'SG D level' }, { ref: 'pressurizer.pressureMPa', label: 'Pressurizer pressure' }, { ref: 'turbine.electricMw' }], rows: 1 + 12 })
    const set = setOf(await sampleVignette(smaller, outcome.state), 'compare')
    expect(set.band).toBeNull()
    expect(set.missing).toEqual([['Halden Unit 5'], [], []])
    expect(set.rows.find(row => row.objectId === 'plant:halden-5')!.refs).toEqual([null, 'plant:halden-5#pressurizer.pressureMPa', 'plant:halden-5#turbine.electricMw'])
    const columns = (await compileVignette(smaller, outcome.state)).sections[0]
    expect(columns).toMatchObject({ kind: 'compare', columns: [{ label: 'SG D level', unit: '%' }, { label: 'Pressurizer pressure', unit: 'MPa' }, { unit: 'MW' }] })
    expect(outcome.card.items[0]).toMatchObject({ label: 'Process plants · halden-power-complex · 12 units' })
    expect(outcome.card.items.find(item => item.label === 'Halden Unit 5')!.reading).toMatch(/^not measured \| 15\.\d\d MPa \| \d+ MW$/)
    expect(outcome.card.adjusted).toContainEqual({ kind: 'scope', text: 'SG D level not measured on Halden Unit 5' })
  })

  test('refuses a quantity no unit measures, offering the roles its Pack declares', async () => {
    const outcome = await compose(run, [{ kind: 'compare', of: CLUSTER, signals: ['flux capacitor charge'] }])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.issues[0]).toMatchObject({ path: 'views.0.signals.0', code: 'unknown_name', didYouMean: [{ pack: 'process-plant', suggestions: ['Reactor power', 'Core thermal power', 'Electrical output'] }] })
  })

  test('beyond its rows shows the furthest from the median and a band over every unit', async () => {
    const outcome = await composed(run, [{ kind: 'compare', of: CLUSTER, signals: ['reactor-power'] }])
    const narrow: VignetteState = { ...outcome.state, views: [{ ...outcome.state.views[0]!, rows: 6 } as VignetteState['views'][number]] }
    const set = setOf(await sampleVignette(run, narrow), 'compare')
    expect([set.rows.length, set.more]).toEqual([4, 8])
    expect(set.band?.[0]).toMatchObject({ count: 12 })
  })
})

describe('a trend across units', () => {
  const at = '2026-07-12T04:10:00.000Z'
  const toMs = Date.parse(at)
  const level = (unit: number): number => unit === 7 ? 92 : unit === 3 ? 104 : unit === 9 ? 101 : 100
  const value = (ref: string): Observation | undefined => {
    const unit = Number(/^plant:halden-(\d+)#/.exec(ref)?.[1])
    return Number.isNaN(unit) ? undefined : { ref, value: level(unit), quality: 'good', priority: 'none' } as unknown as Observation
  }
  // Each unit's synthetic record: flat at 100 until two minutes ago, then at its level now.
  const series = (seriesId: string) => ({ holdMs: 5_000, points: [{ t: toMs - 600_000, v: 100 }, { t: toMs - 120_000, v: level(Number(seriesId.split('|')[1])) }] })

  test('draws a pen per unit up to four, then a band and the three furthest from its median, its history computed here', async () => {
    const outcome = await composed(run, [{ kind: 'trend', of: CLUSTER, signals: ['Reactor power'] }])
    const view = outcome.state.views[0]!
    expect(view).toMatchObject({ kind: 'set-trend', horizon: '10m', rows: 4 + 1 })
    const set = await sampleSet(run, view as Parameters<typeof sampleSet>[1], value, { fromMs: toMs - 600_000, at, series: () => series('x|1') })
    if (set.kind !== 'set-trend') throw new Error('not a set trend')
    const strip = set.strips[0]!
    expect(strip.pens.map(pen => pen.label)).toEqual(['Halden Unit 7', 'Halden Unit 3', 'Halden Unit 9'])
    expect(strip.band).toEqual({ min: 92, median: 100, max: 104, count: 12, minAt: 'Halden Unit 7', maxAt: 'Halden Unit 3' })
    expect(set.history?.[0]?.length).toBe(121)
  })

  test('band history: min, median and max of every unit held at each instant', async () => {
    const outcome = await composed(run, [{ kind: 'trend', of: CLUSTER, signals: ['Reactor power'] }])
    const ids = new Map<string, number>()
    const set = await sampleSet(run, outcome.state.views[0] as Parameters<typeof sampleSet>[1], value, {
      fromMs: toMs - 600_000, at,
      series: seriesId => { if (!ids.has(seriesId)) ids.set(seriesId, ids.size + 1); return series(`x|${ids.get(seriesId)}`) },
    })
    if (set.kind !== 'set-trend') throw new Error('not a set trend')
    const history = set.history![0]!
    expect(history[0]).toEqual({ t: toMs - 600_000, min: 100, median: 100, max: 100 })
    expect(history.at(-1)).toEqual({ t: toMs, min: 92, median: 100, max: 104 })
  })

  test('named units up to four draw a pen each, with no band', async () => {
    const outcome = await composed(run, [{ kind: 'trend', of: ['plant:halden-1', 'plant:halden-2'], signals: ['Reactor power'] }])
    expect(outcome.state.views[0]).toMatchObject({ kind: 'set-trend', of: { objectIds: ['plant:halden-1', 'plant:halden-2'] }, rows: 3 + 1 })
    const set = setOf(await sampleVignette(run, outcome.state), 'set-trend')
    expect(set.strips[0]!.band).toBeNull()
    expect(set.strips[0]!.pens.map(pen => pen.label)).toEqual(['Halden Unit 1', 'Halden Unit 2'])
  })

  test('a trend of a set holds at most four quantities', async () => {
    const outcome = await compose(run, [{ kind: 'trend', of: CLUSTER, signals: ['Reactor power', 'Tavg', 'SG A level', 'SG B level', 'SG C level'] }])
    expect(!outcome.ok && outcome.issues[0]!.code).toBe('not_fitted')
  })
})

describe('honesty after a trip', () => {
  test('a tripped unit leads the fleet and its tally, and too many units at caution or above are refused, never hidden', async () => {
    const before = await composed(run, [{ kind: 'fleet', of: CLUSTER }])
    const tripped = await fleet.runtime.invokeCapability(fleetViewer, { capabilityId: 'world.process-plant.action.invoke', input: { plantId: 'plant:halden-3', actionId: 'turbine-trip', parameters: {} } })
    if (tripped.kind === 'command' && !tripped.result.ok) throw new Error(JSON.stringify(tripped.result))
    await fleet.play(70)
    const after = await fleet.runOf()
    const set = setOf(await sampleVignette(after, before.state), 'fleet')
    expect(set.rows[0]!.objectId).toBe('plant:halden-3')
    expect(set.tallies.find(tally => tally.column === 'trip')).toEqual({ column: 'trip', word: 'Tripped', count: 1, labels: ['Halden Unit 3'] })
    const unit = after.objects.find(object => object.id === 'plant:halden-3')!
    expect(set.rows[0]!.priority).not.toBeNull()
    const urgent = { ...after, objects: [...after.objects, ...clones(unit, 13)] }
    const draft = { packId: 'process-plant', categoryId: 'process-plants', closed: false }
    expect(fitSet(urgent, { kind: 'fleet', of: draft }, 'chat', 'views.0')).toMatchObject({ code: 'not_fitted', path: 'views.0' })
    expect(typeof fitSet(urgent, { kind: 'fleet', of: draft }, 'window', 'views.0')).toBe('number')
    expect(fitSet(urgent, { kind: 'set-trend', of: draft, signals: [{ ref: 'core.powerRangePercent', label: 'Reactor power' }], horizon: '10m' }, 'window', 'views.0')).toMatchObject({ code: 'not_fitted' })
  }, 120_000)

  test('the Run context names the cluster as a set in one line within its 8,000 characters', async () => {
    const current = await fleet.runOf()
    const { text } = await assembleRunContext({ title: 'Halden fleet', objects: current.objects, denied: new Set(), clock: current.clock, packs: current.packs, port: current.port })
    expect(text.length).toBeLessThanOrEqual(8_000)
    expect(text.split('\n').length).toBeLessThanOrEqual(40)
    const line = text.split('\n').find(entry => entry.startsWith('- Cluster halden-power-complex'))!
    expect(line).toContain('(Process plants, process-plant): 12 units')
    expect(line).toContain('{"of": {"category": "process-plants", "group": "halden-power-complex"}}')
    expect(line).toContain('1 Tripped (Halden Unit 3)')
  })
})
