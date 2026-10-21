import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ElectricalConnectionDefinition, ObjectId } from '../src/core/model/index.ts'
import { resolveSubject as resolveTyped, type ComposeRun } from '../src/features/displays/compose/resolve.ts'
import { fixtureComposeRun } from './fixtures/compose-runs.ts'

// Architecture A2: names resolve as the caller, by the rules in order, never by a guess.

const resolveSubject = async (...args: Parameters<typeof resolveTyped>): Promise<unknown> => resolveTyped(...args)

let fixture: Awaited<ReturnType<typeof fixtureComposeRun>>
let run: ComposeRun
const tie: ElectricalConnectionDefinition = {
  id: 'tie-1', type: 'electrical', system: { objectId: 'unit:one' as ObjectId, portId: 'out' }, network: { objectId: 'unit:two' as ObjectId, portId: 'in' },
  nominalKv: 20, maximumSystemExportMw: 10, maximumSystemImportMw: 10,
}
beforeAll(async () => {
  fixture = await fixtureComposeRun()
  run = await fixture.runOf({ connections: [tie] })
})
afterAll(async () => { await fixture.close() })

describe('compose resolution, in rule order', () => {
  test('1. a Pack id is refused with its categories', async () => {
    expect(await resolveSubject(run, 'fixture', 'subjects.0')).toMatchObject({ code: 'pack_is_not_an_object', path: 'subjects.0', didYouMean: [{ pack: 'fixture', suggestions: ['units', 'tasks', 'sites'] }] })
  })

  test('2. a Scenario connection id is a connection; one end hidden from the caller refuses it', async () => {
    expect(await resolveSubject(run, 'tie-1', 'subjects.0')).toEqual({ kind: 'connection', connection: tie })
    expect(await resolveSubject({ ...run, denied: new Set(['unit:two']) }, 'tie-1', 'subjects.0')).toMatchObject({ code: 'agent_access_restricted' })
  })

  test('3. an object id is an object, observed or on the entity floor; a denied one is refused', async () => {
    expect(await resolveSubject(run, 'unit:one', 's')).toEqual({ kind: 'object', objectId: 'unit:one', observed: true })
    expect(await resolveSubject(run, 'site:base', 's')).toEqual({ kind: 'object', objectId: 'site:base', observed: false })
    expect(await resolveSubject({ ...run, denied: new Set(['unit:one']) }, 'unit:one', 's')).toMatchObject({ code: 'agent_access_restricted', message: expect.stringContaining('unit:one') })
  })

  test('4. objectId#x: an exact ref, else an element by id or label, else a qualified name (a tag)', async () => {
    expect(await resolveSubject(run, 'unit:one#speed', 's')).toEqual({ kind: 'observable', objectId: 'unit:one', ref: 'unit:one#speed' })
    expect(await resolveSubject(run, 'unit:one#engine', 's')).toEqual({ kind: 'element', objectId: 'unit:one', elementId: 'engine' })
    expect(await resolveSubject(run, 'unit:one#unit one TANK', 's')).toEqual({ kind: 'element', objectId: 'unit:one', elementId: 'tank' })
    expect(await resolveSubject(run, 'unit:one#SPD', 's')).toEqual({ kind: 'observable', objectId: 'unit:one', ref: 'unit:one#speed' })
    expect(await resolveSubject({ ...run, denied: new Set(['unit:one']) }, 'unit:one#speed', 's')).toMatchObject({ code: 'agent_access_restricted' })
  })

  test('5. any other name is a search match of class 3 or better; a looser one is refused with the nearest names', async () => {
    expect(await resolveSubject(run, 'Unit One#speed', 's')).toEqual({ kind: 'observable', objectId: 'unit:one', ref: 'unit:one#speed' })
    // Every word matched is class 2: World never guesses which one was meant.
    expect(await resolveSubject(run, 'speed of Unit One', 's')).toMatchObject({ code: 'unknown_name' })
    const typo = await resolveSubject(run, 'Unit Oen speed', 'views.0.signals.1')
    expect(typo).toMatchObject({ code: 'unknown_name', path: 'views.0.signals.1', didYouMean: [{ pack: 'fixture', suggestions: expect.arrayContaining(['Unit One speed']) }] })
  })

  test('a free name is searched in the given subjects first, and never finds what the caller may not see', async () => {
    expect(await resolveSubject(run, 'SPD', 's', ['unit:two' as ObjectId])).toEqual({ kind: 'observable', objectId: 'unit:two', ref: 'unit:two#speed' })
    expect(await resolveSubject({ ...run, denied: new Set(['unit:two']) }, 'Unit Two#speed', 's')).toMatchObject({ code: 'unknown_name' })
  })

  test('a collection names one category by id, label or "Label (pack)"; anything else is refused with the categories', async () => {
    const units = { kind: 'collection', of: { packId: 'fixture', categoryId: 'units', closed: false } }
    for (const category of ['units', 'Units', 'Units (fixture)']) expect(await resolveSubject(run, { of: { category, closed: false } }, 's')).toEqual(units)
    expect(await resolveSubject(run, { of: { category: 'tasks', near: 'unit:one', within: '5km', closed: false } }, 's'))
      .toEqual({ kind: 'collection', of: { packId: 'fixture', categoryId: 'tasks', near: 'unit:one', within: '5km', closed: false } })
    expect(await resolveSubject(run, { of: { category: 'vehicles', closed: false } }, 'subjects.1')).toMatchObject({
      code: 'unknown_name', path: 'subjects.1.of.category', didYouMean: [{ pack: 'fixture', suggestions: ['Units (fixture)', 'Tasks (fixture)', 'Sites (fixture)'] }],
    })
    expect(await resolveSubject(run, { of: { category: 'tasks', near: 'unit:one#speed', closed: false } }, 's')).toMatchObject({ code: 'unknown_name', path: 's.of.near' })
  })
})
