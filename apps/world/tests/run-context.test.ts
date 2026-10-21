import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ActorId, AlertState, IsoTimestamp, OperationalObject } from '../src/core/model/index.ts'
import type { WorldPack } from '../src/core/packs/protocol.ts'
import type { SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { assembleRunContext } from '../src/features/displays/context/run-context.ts'
import { createFixtureObject, fixturePack } from './fixtures/fixture-pack.ts'
import { createRoleRunRegistry, openRunDefinition } from './fixtures/role-runs.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import { weatherAdvisories } from '../src/packs/weather/conditions.ts'
import { weatherItemSchema, weatherPackConfigSchema, weatherPackDataSchema } from '../src/packs/weather/model.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { createWeatherObject } from '../src/packs/weather/scenario.ts'

// The Run context (plan v3.1 §2.4, architecture A4): its line rules and caps, the count of what AI restrictions hide,
// and one number, one source: nothing from a presentation summary or field reaches it.

const units = Array.from({ length: 11 }, (_, index) => ({ id: `unit:u${index}`, label: `Unit ${index}`, type: 'unit', position: [10.7 + index / 100, 59.9], speedMps: 13.37 }))
const definition = {
  ...openRunDefinition, id: 'context-run', title: 'Context drill',
  packs: [{ id: 'fixture', config: {}, items: [
    { id: 'site:base', label: 'Base', type: 'site', position: [10.7387, 59.9365] },
    { id: 'task:north', label: 'North pickup', type: 'task', position: [10.7874, 59.946], priority: 'high' },
    { id: 'task:south', label: 'South pickup', type: 'task', position: [10.7874, 59.846], priority: 'low' },
    ...units,
  ] }],
}
const person = { id: 'actor:human:context' as ActorId, label: 'Context', role: 'operator' as const }
const at = '2026-01-01T08:00:00.000Z' as IsoTimestamp
const alert = (id: string, extra: Partial<AlertState> = {}): AlertState => ({ id, kind: 'k', severity: 'warning', message: `Message ${id}`, raisedAt: at, acknowledged: false, ...extra })

let registry: SimulationRunRegistry
let run: SimulationRunRuntime
beforeAll(async () => {
  registry = await createRoleRunRegistry([definition])
  run = await registry.create({ scenarioId: 'context-run' })
  await run.setClock({ paused: true })
})
afterAll(async () => { await registry.shutdown() })

const contextFor = async (change: { objects?: (objects: ReadonlyArray<OperationalObject>) => ReadonlyArray<OperationalObject>; denied?: ReadonlyArray<string>; packs?: ReadonlyArray<WorldPack> } = {}) => {
  const objects = run.snapshot().objects
  return await assembleRunContext({
    title: 'Context drill', objects: change.objects?.(objects) ?? objects, denied: new Set(change.denied ?? []),
    clock: run.snapshot().clock, packs: change.packs ?? run.packs(), port: run.observations(person),
  })
}

describe('Run context', () => {
  test('a header, up to 8 assets worst first with their lead refs, then a line per category for every other object', async () => {
    const withAlerts = (objects: ReadonlyArray<OperationalObject>) => objects.map(object =>
      object.id === 'unit:u7' ? { ...object, alerts: [alert('a1', { severity: 'critical', priority: 'alarm', firstOut: { group: 'g', rank: 1 } }), alert('a2', { acknowledged: true })] }
        : object.id === 'unit:u9' ? { ...object, alerts: [alert('a3', { priority: 'caution' })] }
          : object.id === 'unit:u10' ? { ...object, alerts: [alert('a4')] } : object)
    const context = await contextFor({ objects: withAlerts })
    const lines = context.text.split('\n')
    expect(context).toMatchObject({ at: run.snapshot().clock!.currentTime, clock: 'simulation' })
    expect(lines[0]).toBe(`Context drill · simulation time ${run.snapshot().clock!.currentTime} · PAUSED`)
    const assets = lines.filter(entry => entry.startsWith('- unit:'))
    expect(assets).toHaveLength(8)
    expect(assets.slice(0, 3).map(entry => entry.split(' · ')[0])).toEqual(['- unit:u7', '- unit:u9', '- unit:u10'])
    expect(assets[0]).toBe('- unit:u7 · Unit 7 · available · alerts 2 (1 unacknowledged; worst alarm) · first out: Message a1 · lead: unit:u7#speed, unit:u7#status')
    expect(assets[2]).toContain('worst warning (priority not declared)')
    expect(assets[3]).toBe('- unit:u0 · Unit 0 · available · no alerts · lead: unit:u0#speed, unit:u0#status')
    expect(lines).toContain('- Units (fixture): 3 · available 3')
    expect(lines).toContain('- Tasks (fixture): 2 · open 2')
    expect(lines).toContain('- Sites (fixture): 1 · open 1')
    expect(lines.at(-1)).toBe('Dashboards: none stored (cannot change dashboards yet)')
  })

  test('takes no number from a presentation summary or field', async () => {
    const { text } = await contextFor()
    // The fixture presents each unit's speed as a field, "13.37 m/s"; the context's words come from presentation only.
    expect(text).not.toContain('13.37')
    expect(text).not.toContain('m/s')
  })

  test('counts what the AI may not see and never names it', async () => {
    const { text } = await contextFor({ denied: ['unit:u3', 'task:north'] })
    expect(text).toContain('2 objects hidden by this Run\'s AI restrictions')
    expect(text).not.toContain('unit:u3')
    expect(text).not.toContain('North pickup')
  })

  test('adds one fenced guidance line per Pack and a line per record-only Pack', async () => {
    const records = { ...fixturePack, descriptor: { ...fixturePack.descriptor, id: 'records', name: 'Records' }, presentation: { ...fixturePack.presentation, categories: [] } } as WorldPack
    const guided = { ...fixturePack, knowledge: { wikiRefs: [], guidance: 'Read the unit\'s status before its speed.' } }
    const lines = (await contextFor({ packs: [guided, records] })).text.split('\n')
    expect(lines).toContain('- Records (records): records, no operational objects')
    expect(lines).toContain('```guidance fixture: Read the unit\'s status before its speed.```')
  })

  test('holds 40 lines and 8,000 characters: categories give way first, named by count', async () => {
    const many: WorldPack = {
      ...fixturePack,
      descriptor: { ...fixturePack.descriptor, id: 'many' },
      presentation: {
        categories: Array.from({ length: 60 }, (_, index) => ({ id: `c${index}`, label: `Category ${index} ${'x'.repeat(150)}`, emptyLabel: 'none', matches: () => false })),
        presentObject: object => ({ categoryId: `c${Number(object.id.split(':')[1])}`, icon: 'i', color: '#000', summary: 'unused', fields: [] }),
      },
    }
    const objects = Array.from({ length: 60 }, (_, index) => ({ ...createFixtureObject({ type: 'site', id: `site:${index}` as never, label: `Site ${index}`, position: [10, 59] }, { at, objectById: () => undefined }), packId: 'many' as never }))
    const { text } = await assembleRunContext({ title: 'Many', objects, denied: new Set(), clock: run.snapshot().clock, packs: [many], port: run.observations(person) })
    const lines = text.split('\n')
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(text.length).toBeLessThanOrEqual(8_000)
    expect(lines.find(entry => entry.startsWith('+'))).toMatch(/^\+\d+ more categories/)
    expect(lines.every(entry => entry.length <= 400)).toBe(true)
  })

  test('a weather advisory counts apart with its priority and never as unacknowledged, yet ranks its probe first (R42a, R43)', async () => {
    const probe = createWeatherObject(weatherItemSchema.parse({ pack: 'weather', type: 'weather_probe', id: 'weather-probe:halden', label: 'Halden probe', point: geoPointFromLonLat(11.39, 59.12).coordinates }), at, weatherPackConfigSchema.parse({}), at)
    const state = weatherPackDataSchema.parse(probe.packData).sample.state
    // A hazard: visibility under the hazard rung, so one hazard and one adverse advisory hold.
    const advisories = weatherAdvisories(probe, { ...state, atmosphere: { ...state.atmosphere, visibilityM: 500 } }, at)
    expect(advisories.map(alert => [alert.advisory, alert.acknowledged, alert.priority])).toEqual([[true, false, 'warning'], [true, false, 'caution']])
    const calm = { ...probe, id: 'weather-probe:calm' as never, label: 'Calm probe' }
    const port = { declarations: async () => [], read: async () => ({ observations: [], unknown: [], refused: [] }), topology: async () => { throw new Error('unused') } }
    const { text } = await assembleRunContext({ title: 'Fog', objects: [calm, { ...probe, alerts: advisories }], denied: new Set(), clock: run.snapshot().clock, packs: [weatherPack], port: port as never })
    const assets = text.split('\n').filter(line => line.startsWith('- weather-probe:'))
    expect(assets[0]).toStartWith('- weather-probe:halden · Halden probe · ')
    expect(assets[0]).toContain('alerts 2 (0 unacknowledged, 2 advisories (warning); worst warning)')
    expect(assets[1]).toContain('weather-probe:calm · Calm probe · ')
  })
})

