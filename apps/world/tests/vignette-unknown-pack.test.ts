import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeDefault, composeVignette } from '../src/features/displays/compose/compose.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { displaySpecSchema } from '../src/core/observation/spec.ts'
import { fixtureComposeRun } from './fixtures/compose-runs.ts'

// Plan v4: a Pack World knows nothing about gets vignettes from what it declares, with no World code. The fixture Pack
// stands in for it: units declare speed and status on an engine fed from a tank; sites and tasks are entity-floor objects.

let fixture: Awaited<ReturnType<typeof fixtureComposeRun>>
let run: ViewRun
beforeAll(async () => { fixture = await fixtureComposeRun(); run = await fixture.runOf() })
afterAll(async () => { await fixture.close() })

const opened = async (subject: Parameters<typeof composeDefault>[1]) => {
  const outcome = await composeDefault(run, subject)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  return { ...outcome, view: await compileVignette(run, outcome.state), sample: await sampleVignette(run, outcome.state) }
}

describe('an unknown Pack gets vignettes from its declarations alone', () => {
  test('a declared object: its own states, its lead values, its alerts (none yet) and its whole drawing (a graph this small is its own overview)', async () => {
    const { view, sample, card } = await opened('unit:one')
    expect(view.sections.map(section => section.kind)).toEqual(['values', 'alerts', 'topology'])
    const topology = view.sections[2]
    expect(topology?.kind === 'topology' && [topology.family, topology.packId]).toEqual(['flow', 'fixture'])
    expect(topology?.kind === 'topology' && topology.nodes.map(node => [node.id, node.class])).toEqual([['tank', 'store'], ['engine', 'mover']])
    expect(topology?.kind === 'topology' && topology.nodes[1]?.bindings).toEqual([{ role: 'flow', ref: 'unit:one#speed', quantity: 'speed', unit: 'm/s' }])
    expect(sample.observations.map(observation => observation.ref)).toEqual(['unit:one#status', 'unit:one#speed'])
    expect(card.items.map(item => [item.label, item.reading])).toEqual([['Unit One · Unit One status', expect.any(String)], ['Unit One · Unit One speed', expect.stringMatching(/^\d+\.\d m\/s$/)]])
    expect(card.items[1]?.limits).toEqual([{ value: 40, decimals: 1 }])
  })

  test('an entity-floor object: its core slots in words, numbers only from the object, and its map focus', async () => {
    const { view, sample, card, state } = await opened('site:base')
    expect(view.sections.map(section => section.kind)).toEqual(['slots', 'map'])
    expect(view.sections[0]?.kind === 'slots' && view.sections[0].slots.map(slot => slot.key)).toEqual(['status', 'lifecycle', 'age'])
    expect(sample.slots['site:base']).toMatchObject({ status: { value: 'open' }, lifecycle: { value: 'active' } })
    expect(sample.maps[1]).toMatchObject({ positioned: 1, missing: 0, bounds: [[10.7387, 59.9365], [10.7387, 59.9365]] })
    expect(card.items.map(item => item.label)).toEqual(['Base · Status', 'Base · Lifecycle', 'Base · Position age'])
    expect(state.by).toBeUndefined()
  })

  test('an element, an observable and a collection have their defaults too', async () => {
    expect((await opened('unit:one#engine')).view.sections.map(section => section.kind)).toEqual(['values', 'topology'])
    expect((await opened('unit:one#speed')).view.sections.map(section => section.kind)).toEqual(['values', 'topology'])
    const units = await opened({ of: { category: 'units', closed: false } })
    expect(units.view.sections.map(section => section.kind)).toEqual(['entity', 'map'])
    expect(units.sample.entities[0]?.rows.map(row => row.objectId)).toEqual(['unit:one', 'unit:two'])
    expect(units.view.title).toBe('Units')
  })

  test('the Assistant composes across its objects with named views', async () => {
    const outcome = await composeVignette(run, displaySpecSchema.parse({ title: 'Units now', question: 'Where are the units?', subjects: [{ of: { category: 'units' } }, 'unit:one'],
      views: [{ kind: 'values', of: { category: 'units' } }, { kind: 'map', of: { category: 'units' } }, { kind: 'values', signals: ['unit:one#SPD', 'Unit Two#speed'] }] }))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    expect(outcome.state.views.map(view => view.kind)).toEqual(['collection', 'map', 'values'])
    expect(outcome.card.items.map(item => item.key)).toEqual(outcome.card.items.map((_, index) => `k${index + 1}`))
  })

  test('no World display code names the Pack', () => {
    const dir = join(import.meta.dir, '../src/features/displays/compose')
    expect(readdirSync(dir).filter(name => readFileSync(join(dir, name), 'utf8').includes('fixture'))).toEqual([])
  })
})
