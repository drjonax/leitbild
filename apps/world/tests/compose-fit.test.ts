import { DISPLAY_CARD_MAX_TEXT, displayCardTextLength } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { vignetteHeight } from '../src/core/api/display-capabilities.ts'
import type { AlertState } from '../src/core/model/alerts.ts'
import type { OperationalObject } from '../src/core/model/index.ts'
import { observableSchema } from '../src/core/observation/model.ts'
import { displaySpecSchema } from '../src/core/observation/spec.ts'
import { assembleCard, valueItem } from '../src/features/displays/compose/card.ts'
import { composeVignette } from '../src/features/displays/compose/compose.ts'
import type { ViewRun } from '../src/features/displays/compose/view.ts'
import { openRunDefinition } from './fixtures/role-runs.ts'
import { fixtureComposeRun } from './fixtures/compose-runs.ts'

// Architecture A4: completion only adds; the fit holds the caps and never drops a subject, a named signal, an anchor or
// a named medium, else compose refuses.

const fleet = {
  ...openRunDefinition, id: 'fleet', title: 'Fleet',
  packs: [{ id: 'fixture', config: {}, recording: { profileId: 'operations' }, items: [
    { id: 'site:base', label: 'Base', type: 'site', position: [10.7387, 59.9365] },
    ...Array.from({ length: 10 }, (_, index) => ({ id: `unit:u${index}`, label: `Car ${index}`, type: 'unit', position: [10.74 + index / 1000, 59.93], speedMps: 10 + index })),
    { id: 'task:one', label: 'Task One', type: 'task', position: [10.7874, 59.946], priority: 'high' },
  ] }],
}
let fixture: Awaited<ReturnType<typeof fixtureComposeRun>>
let run: ViewRun
beforeAll(async () => { fixture = await fixtureComposeRun(fleet); run = await fixture.runOf() })
afterAll(async () => { await fixture.close() })

const spec = (subjects: ReadonlyArray<unknown>, views: ReadonlyArray<unknown> = []) => displaySpecSchema.parse({ title: 'Fit', question: 'What fits?', subjects, views })
const alert = (id: string, priority: 'caution' | 'alarm' | 'notice'): AlertState => ({
  id, kind: 'test', severity: priority === 'alarm' ? 'critical' : priority === 'caution' ? 'warning' : 'info', message: `${id} raised`, raisedAt: '2026-01-01T08:00:01.000Z' as AlertState['raisedAt'], acknowledged: false, priority, clock: 'simulation',
})
const withAlerts = (alerts: Record<string, ReadonlyArray<AlertState>>): ReadonlyArray<OperationalObject> => run.objects.map(object => ({ ...object, alerts: alerts[object.id] ?? object.alerts }))

describe('completion only adds', () => {
  test('the subjects\' alerts at caution or above join as a view; with four views they are counted instead', async () => {
    const alerted = { ...run, objects: withAlerts({ 'unit:u1': [alert('a1', 'caution')] }) }
    const added = await composeVignette(alerted, spec(['unit:u1'], [{ kind: 'values', signals: ['unit:u1#speed'] }]))
    expect(added.ok && added.state.views.map(view => view.kind)).toEqual(['values', 'alerts'])
    const quiet = await composeVignette({ ...run, objects: withAlerts({ 'unit:u1': [alert('a1', 'notice')] }) }, spec(['unit:u1'], [{ kind: 'values', signals: ['unit:u1#speed'] }]))
    expect(quiet.ok && quiet.state.views.map(view => view.kind)).toEqual(['values'])
    const full = await composeVignette(alerted, spec(['unit:u1'], [{ kind: 'values', signals: ['unit:u1#speed'] }, { kind: 'trend', signals: ['unit:u1#status'] }, { kind: 'map' }, { kind: 'topology' }]))
    expect(full.ok && full.card.adjusted).toEqual([{ kind: 'layout', text: '1 alerts at caution or above not shown' }])
  })

  test('the lead value with the shortest time to act goes first into the first values view', async () => {
    const port: ViewRun['port'] = { ...run.port, read: async request => {
      const read = await run.port.read(request)
      return { ...read, observations: read.observations.map(observation => observation.ref === 'unit:u2#status' ? { ...observation, timeToAct: { threshold: 'x', seconds: 30 } } : observation) }
    } }
    const outcome = await composeVignette({ ...run, port }, spec(['unit:u2'], [{ kind: 'values', signals: ['unit:u2#speed'] }]))
    expect(outcome.ok && outcome.state.views[0]).toMatchObject({ kind: 'values', refs: ['unit:u2#status', 'unit:u2#speed'] })
    expect(outcome.ok && outcome.card.items[1]?.reading).toContain('limit in 30 s')
  })
})

describe('fit caps and invariants', () => {
  test('a values view keeps 16, named signals first, and says what it left out', async () => {
    const names = Array.from({ length: 10 }, (_, index) => `unit:u${index}`)
    const outcome = await composeVignette(run, spec(['unit:u9#speed'], [{ kind: 'values', signals: ['unit:u9#speed', ...names] }]))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    const [values] = outcome.state.views
    expect(values?.kind === 'values' && values.refs.length).toBe(16)
    expect(values?.kind === 'values' && values.refs).toContain('unit:u9#speed')
    expect(outcome.card.adjusted).toContainEqual({ kind: 'layout', text: '4 values not shown' })
    expect(values?.rows).toBe(16)
  })

  test('a named signal without a record refuses a trend; recorded pens fill strips of four', async () => {
    expect(await composeVignette(run, spec(['unit:u1'], [{ kind: 'trend', signals: ['unit:u1#speed'] }]))).toMatchObject({ ok: false, issues: [{ code: 'not_observed', path: 'views.0.signals' }] })
    const outcome = await composeVignette(run, spec(['unit:u1'], [{ kind: 'trend', signals: Array.from({ length: 6 }, (_, index) => `unit:u${index}#status`) }]))
    // Six pens of one unit: strips of four and two, each at least three rows, and the axis.
    expect(outcome.ok && outcome.state.views[0]).toMatchObject({ kind: 'trend', horizon: '10m', rows: 4 + 3 + 1 })
  })

  test('a subject no fitted view shows is refused, never dropped', async () => {
    expect(await composeVignette(run, spec(['unit:u1', 'task:one'], [{ kind: 'values', signals: ['unit:u1#speed'] }])))
      .toMatchObject({ ok: false, issues: [{ code: 'not_fitted', path: 'subjects.1' }] })
  })

  test('every issue comes back at once, each with its path', async () => {
    const outcome = await composeVignette(run, spec(['fixture', 'no-such-thing']))
    expect(outcome.ok === false && outcome.issues.map(issue => [issue.path, issue.code])).toEqual([['subjects.0', 'pack_is_not_an_object'], ['subjects.1', 'unknown_name']])
  })

  test('a card holds 48 items and 2,400 characters; what it leaves out is counted', () => {
    const at = { at: '2026-01-01T08:00:00.000Z', clock: 'simulation' } as const
    const items = Array.from({ length: 60 }, (_, index) => ({ label: `Item ${index}`, reading: `${index} m/s`, numbers: [{ value: index, decimals: 0 }] }))
    expect(assembleCard(at, items, []).items).toHaveLength(48)
    expect(assembleCard(at, items, []).more).toBe(12)
    const long = items.map(item => ({ ...item, label: 'L'.repeat(80), reading: 'R'.repeat(120) }))
    const card = assembleCard(at, long, [])
    expect(displayCardTextLength(card)).toBeLessThanOrEqual(DISPLAY_CARD_MAX_TEXT)
    expect(card.items.length + card.more).toBe(60)
  })

  test('a count reads whole on the card, as the readout prints it', () => {
    const object = run.objects.find(entry => entry.id === 'unit:u1')!
    const count = observableSchema.parse({ ref: 'unit:u1#alarms', label: 'Active alarms', quantity: 'count', unit: '1', valueType: 'number', series: null })
    const item = valueItem({ observable: count, object }, { ref: count.ref, at: '2026-01-01T08:00:00.000Z', clock: 'simulation', value: 3, quality: 'good', priority: 'none' })
    expect([item.reading, item.numbers]).toEqual(['3', [{ value: 3, decimals: 0 }]])
  })

  test('the frame height is the rows on the grid, within what an embedder reserves', () => {
    expect([vignetteHeight(2), vignetteHeight(10), vignetteHeight(40), vignetteHeight(41)]).toEqual([120, 240, 960, 960])
  })

  test('the state names refs and object ids only, within its 4,096 characters', async () => {
    const outcome = await composeVignette(run, spec(['unit:u1', 'unit:u2', { of: { category: 'units' } }]))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    const text = JSON.stringify(outcome.state)
    expect(text.length).toBeLessThanOrEqual(4_096)
    expect(text).not.toMatch(/"value"|"limits"|"colou?r"|coordinates/)
    expect(outcome.state.by).toBe('assistant')
    expect(outcome.rows).toBe(2 + outcome.state.views.reduce((sum, view) => sum + view.rows, 0))
  })
})
