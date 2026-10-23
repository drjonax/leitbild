import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { displaySpecSchema } from '../src/core/observation/spec.ts'
import { composeDefault, composeVignette } from '../src/features/displays/compose/compose.ts'
import type { VignetteSample, VignetteState, VignetteView } from '../src/features/displays/compose/model.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { viewWithLeads } from '../src/ui/embed/vignette/vignette-client.ts'
import { fixtureComposeRun } from './fixtures/compose-runs.ts'

// W0.5 (UX audit H1, H2): a default's values view holds a lead request, never refs fixed as it opened. Each sample reads
// the Pack's lead again (an object's mode-aware lead read; an element's declared lead, and once it has been stopped
// what verifies the stop first, D-E) into the rows the view reserved, so a display opened at power leads with the
// trip's readings within one sample and nothing else in it moves. The fixture Pack, which World knows nothing of,
// stands in for a Plant: a "trip" changes its lead read and sets the command its engine's stop is declared by.

const ref = (signal: string) => `unit:one#${signal}`
const reading = (signal: string, label: string, basis: 'instrument' | 'command', quantity: 'speed' | 'state' = 'speed') => ({
  ref: ref(signal), label, quantity, unit: quantity === 'state' ? '' : 'm/s', valueType: quantity === 'state' ? 'boolean' : 'number', thresholds: [], series: null, element: 'engine', basis,
})
const extra = [
  reading('power', 'Engine power', 'instrument'), reading('output', 'Engine output', 'instrument'), reading('flux', 'Engine flux', 'instrument'),
  reading('rodsIn', 'Rods in', 'instrument', 'state'), reading('tripCommand', 'Trip command', 'command', 'state'),
]
const added = new Set(extra.map(entry => entry.ref))

/** The fixture's port with the Plant-like engine: its lead read and trip command follow `tripped`. */
const plantLike = (base: ViewRun['port'], tripped: () => boolean): ViewRun['port'] => ({
  ...base,
  declarations: async (objectIds, elementIds) => (await base.declarations(objectIds, elementIds)).map(declaration => 'refused' in declaration || declaration.objectId !== 'unit:one' ? declaration : {
    ...declaration,
    elements: declaration.elements.map(element => element.id !== 'engine' ? element : {
      ...element, lead: [ref('power'), ref('output')], stopped: { when: [[{ ref: ref('tripCommand'), value: true }]], lead: [ref('rodsIn'), ref('flux')] },
    }),
    observables: [...declaration.observables, ...extra.filter(entry => elementIds === undefined || elementIds.includes(entry.element))] as never,
  }),
  read: async request => {
    const at = (await base.read({ refs: [ref('speed')] })).observations[0]?.at ?? '2026-01-01T08:00:00.000Z'
    const value = (entry: string) => ({ ref: entry, at, clock: 'simulation', quality: 'good', priority: 'none',
      value: entry === ref('tripCommand') || entry === ref('rodsIn') ? tripped() : entry === ref('flux') ? 0.4 : 50 }) as never
    const read = await base.read({ ...request, refs: (request.refs ?? []).filter(entry => !added.has(entry)) })
    // At power the engine's power and output lead the unit; tripped, its flux, then power; then the fixture's own lead.
    const engine = (tripped() ? ['flux', 'power'] : ['power', 'output']).map(ref)
    const leads = (request.leads ?? []).map((lead, at_) => lead.objectId === 'unit:one' ? [...engine, ...read.leads[at_]!] : read.leads[at_]!)
    const extra = [...new Set([...request.refs ?? [], ...leads.flat()])].filter(entry => added.has(entry))
    return { ...read, observations: [...read.observations, ...extra.map(value)], leads }
  },
})

let fixture: Awaited<ReturnType<typeof fixtureComposeRun>>
let tripped = false
let run: ViewRun
beforeAll(async () => {
  fixture = await fixtureComposeRun()
  const base = await fixture.runOf()
  run = await fixture.runOf({ port: plantLike(base.port, () => tripped) })
})
afterAll(async () => { await fixture.close() })

const opened = async (subject: string): Promise<{ readonly state: VignetteState; readonly view: VignetteView }> => {
  tripped = false
  const outcome = await composeDefault(run, subject)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  return { state: outcome.state, view: await compileVignette(run, outcome.state) }
}
const led = (sample: VignetteSample, index = 0): ReadonlyArray<string> => (sample.leads?.[index] ?? []).map(value => value.ref)
const shown = (view: VignetteView): ReadonlyArray<string> => {
  const section = view.sections.find(entry => entry.kind === 'values')
  return section?.kind === 'values' ? section.values.map(value => value.ref) : []
}
const rowsOf = (view: VignetteView) => view.sections.map(section => `${section.kind} ${section.rows}`)

describe('a default holds a lead request, read again each sample (W0.5)', () => {
  test('an object default: its state names the request and the rows it reserves, never refs; each sample leads as the Pack does now', async () => {
    const { state, view } = await opened('unit:one')
    // Its own state (status) is a chip, so its lead is the engine's two and its speed: three rows reserved.
    expect<unknown>(state.views[0]).toEqual({ kind: 'values', lead: { objectId: 'unit:one' }, rows: 3 })
    expect(JSON.stringify(state)).not.toContain(ref('power'))
    expect(shown(view)).toEqual([ref('power'), ref('output'), ref('speed')])
    const atPower = await sampleVignette(run, state)
    expect(led(atPower)).toEqual([ref('power'), ref('output'), ref('speed')])
    tripped = true
    const afterTrip = await sampleVignette(run, state)
    expect(led(afterTrip)).toEqual([ref('flux'), ref('power'), ref('speed')])
    // Every value it leads with is read in the same sample.
    expect(led(afterTrip).every(entry => afterTrip.observations.some(observation => observation.ref === entry))).toBe(true)
    // The view drawn from the samples: the lead rows change in place; every other section is the one it was.
    const before = viewWithLeads(view, atPower)
    const after = viewWithLeads(before, afterTrip)
    expect(before).toBe(view)
    expect(shown(after)).toEqual([ref('flux'), ref('power'), ref('speed')])
    expect(rowsOf(after)).toEqual(rowsOf(view))
    after.sections.forEach((section, index) => { if (section.kind !== 'values') expect<unknown>(section).toBe(view.sections[index]) })
    // A sample that leads as the view does leaves it as it is.
    expect(viewWithLeads(after, afterTrip)).toBe(after)
  })

  test('an element default: its declared lead at power; once its stop\'s commands read as written, what verifies the stop first, in the same rows', async () => {
    const { state, view } = await opened('unit:one#engine')
    expect<unknown>(state.views[0]).toEqual({ kind: 'values', lead: { objectId: 'unit:one', element: 'engine' }, rows: 5 })
    // At power: its declared lead, then its readings (instruments and states) by rank, then the rest; never its command.
    expect(shown(view)).toEqual([ref('power'), ref('output'), ref('flux'), ref('rodsIn'), ref('speed')])
    expect(led(await sampleVignette(run, state))).toEqual(shown(view))
    tripped = true
    const afterTrip = await sampleVignette(run, state)
    expect(led(afterTrip)).toEqual([ref('rodsIn'), ref('flux'), ref('power'), ref('output'), ref('speed')])
    expect(afterTrip.observations.find(observation => observation.ref === ref('rodsIn'))?.value).toBe(true)
    const drawn = viewWithLeads(view, afterTrip)
    expect(rowsOf(drawn)).toEqual(rowsOf(view))
    expect(shown(drawn)).not.toContain(ref('tripCommand'))
    // Reset, it leads as at power again.
    tripped = false
    expect(led(await sampleVignette(run, state))).toEqual(shown(view))
  })

  test('an unrecorded observable reads beside three of its element\'s lead values, as they lead each sample', async () => {
    const { state } = await opened(ref('flux'))
    expect<unknown>(state.views[0]).toEqual({ kind: 'values', refs: [ref('flux')], lead: { objectId: 'unit:one', element: 'engine' }, rows: 4 })
    expect(led(await sampleVignette(run, state))).toEqual([ref('flux'), ref('power'), ref('output'), ref('rodsIn')])
    tripped = true
    expect(led(await sampleVignette(run, state))).toEqual([ref('flux'), ref('rodsIn'), ref('power'), ref('output')])
  })

  test('an answer\'s default shows the values its subjects lead with as it answers: its card and its rows stay the values it cites', async () => {
    tripped = false
    const outcome = await composeVignette(run, displaySpecSchema.parse({ title: 'Unit one', question: 'How is unit one?', subjects: ['unit:one'], views: [] }))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    expect<unknown>(outcome.state.views[0]).toEqual({ kind: 'values', refs: [ref('power'), ref('output'), ref('speed')], rows: 3 })
    expect(outcome.card.items.filter(item => item.subject !== undefined && 'ref' in item.subject).map(item => (item.subject as { ref: string }).ref))
      .toEqual(expect.arrayContaining([ref('power'), ref('output'), ref('speed')]))
    tripped = true
    expect((await sampleVignette(run, outcome.state)).leads).toBeUndefined()
  })
})
