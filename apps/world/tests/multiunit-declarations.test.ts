import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { displaySpecSchema, MAX_COMPARED_SIGNALS, MAX_NAMED_UNITS } from '../src/core/observation/spec.ts'
import { validateWorldAssembly } from '../src/core/packs/assembly.ts'
import type { PackCategoryMembers, PackComparableRole, WorldPack } from '../src/core/packs/protocol.ts'
import { declaredRefs } from '../src/features/displays/compose/declared.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { fixturePack } from './fixtures/fixture-pack.ts'
import { fleetRun } from './fixtures/fleet-runs.ts'
import { createTestPackRuntimeAdapters, testPacks } from './helpers.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T1.1 (multiunit plan §3.1): a set is named, not its units; at most twelve units by name, eight compared quantities.
describe('multiunit display specs', () => {
  const spec = (views: ReadonlyArray<unknown>, subjects: ReadonlyArray<unknown> = []) => displaySpecSchema.safeParse({ title: 'Fleet', question: 'How are the units doing?', subjects, views })
  const fleet = { category: 'process-plants', group: 'halden-power-complex' }
  const units = (count: number) => Array.from({ length: count }, (_, at) => `plant:halden-${at + 1}`)

  test('accepts a fleet, a compare, a trend and alerts of a set, with no subject', () => {
    const parsed = spec([
      { kind: 'fleet', of: fleet },
      { kind: 'compare', of: fleet, signals: ['pressurizer pressure', 'SG A level'] },
      { kind: 'trend', of: fleet, signals: ['pressurizer pressure'] },
      { kind: 'alerts', of: { ...fleet, status: ['Tripped'] } },
    ])
    expect(parsed.success).toBe(true)
    expect(parsed.data!.views[0]).toEqual({ kind: 'fleet', of: { ...fleet, closed: false } })
  })

  test(`accepts up to ${MAX_NAMED_UNITS} named units in a comparison and refuses more, pointing to a set`, () => {
    expect(spec([{ kind: 'compare', of: units(MAX_NAMED_UNITS), signals: ['pressurizer pressure'] }]).success).toBe(true)
    const refused = spec([{ kind: 'compare', of: units(MAX_NAMED_UNITS + 1), signals: ['pressurizer pressure'] }])
    expect(refused.success).toBe(false)
    expect(JSON.stringify(refused.error!.issues)).toContain('for more use a set, {category, group}')
  })

  test(`refuses more than ${MAX_COMPARED_SIGNALS} compared quantities`, () => {
    const refused = spec([{ kind: 'compare', of: fleet, signals: Array.from({ length: MAX_COMPARED_SIGNALS + 1 }, (_, at) => `signal ${at}`) }])
    expect(JSON.stringify(refused.error!.issues)).toContain(`compare at most ${MAX_COMPARED_SIGNALS} quantities`)
  })

  test('refuses a fleet without a set, an alerts view of the run and a set, and set-less views without subjects', () => {
    expect(spec([{ kind: 'fleet' }]).success).toBe(false)
    expect(JSON.stringify(spec([{ kind: 'alerts', scope: 'run', of: fleet }]).error!.issues)).toContain('not both')
    expect(JSON.stringify(spec([{ kind: 'trend', signals: ['pressurizer pressure'] }]).error!.issues)).toContain('a view of a set (of) needs none')
  })

  test('keeps the six-subject and four-view limits', () => {
    expect(spec([{ kind: 'fleet', of: fleet }], units(7)).success).toBe(false)
    expect(spec(Array.from({ length: 5 }, () => ({ kind: 'fleet', of: fleet }))).success).toBe(false)
  })
})

// T1.2: World refuses member columns, groups and comparable roles a fleet or compare view could not draw from.
describe('member and comparable declarations', () => {
  const members: PackCategoryMembers = { group: { label: 'Depot', of: () => 'north' }, columns: [{ key: 'speed', label: 'Speed', unit: 'm/s' }, { key: 'state', label: 'State', unit: '', tally: { except: ['Idle'] } }], row: () => ({ speed: 1, state: 'Idle' }) }
  const roles: ReadonlyArray<PackComparableRole> = [{ id: 'speed', label: 'Speed', category: 'units', ref: 'engine.speed' }]
  const withDeclarations = (declared: Partial<PackCategoryMembers> | null, comparable: ReadonlyArray<PackComparableRole> = roles): WorldPack => ({
    ...fixturePack,
    presentation: { ...fixturePack.presentation, categories: fixturePack.presentation.categories.map(category => category.id === 'units' && declared !== null ? { ...category, members: { ...members, ...declared } } : category) },
    observation: { ...fixturePack.observation!, comparable },
  })
  const assemble = (pack: WorldPack) => validateWorldAssembly({ packs: testPacks.map(candidate => candidate === fixturePack ? pack : candidate), runtimeAdapters: createTestPackRuntimeAdapters() })

  test('accepts a group, columns and roles that are well formed', () => {
    expect(assemble(withDeclarations({})).packs.find(pack => pack.descriptor.id === 'fixture')?.observation?.comparable).toEqual(roles)
  })

  test('refuses columns without a core unit, tallied numbers, duplicate or too many columns, and an unlabelled group', () => {
    expect(() => assemble(withDeclarations({ columns: [{ key: 'speed', label: 'Speed', unit: 'knots' }] }))).toThrow('not a core unit code')
    expect(() => assemble(withDeclarations({ columns: [{ key: 'speed', label: 'Speed', unit: 'm/s', tally: { except: [] } }] }))).toThrow('only word columns are tallied')
    expect(() => assemble(withDeclarations({ columns: [members.columns[0]!, members.columns[0]!] }))).toThrow('duplicate member column')
    expect(() => assemble(withDeclarations({ columns: Array.from({ length: 9 }, (_, at) => ({ key: `c${at}`, label: `C${at}`, unit: '' })) }))).toThrow('1 to 8')
    expect(() => assemble(withDeclarations({ group: { label: ' ', of: () => undefined } }))).toThrow('group without a label')
  })

  test('refuses comparable roles for an unobserved category, with an object id in their ref, or duplicated', () => {
    expect(() => assemble(withDeclarations(null, [{ ...roles[0]!, category: 'tasks' }]))).toThrow('declares no observations')
    expect(() => assemble(withDeclarations(null, [{ ...roles[0]!, ref: 'unit:one#engine.speed' }]))).toThrow('local ref')
    expect(() => assemble(withDeclarations(null, [roles[0]!, { ...roles[0]!, id: 'speed-2' }]))).toThrow('duplicate comparable role label')
  })
})

// T1.3: process-plant declares its cluster as the group, a fleet row from the projection and comparable roles every
// Halden unit measures.
describe('process-plant fleet declarations on Halden', () => {
  let fleet: Awaited<ReturnType<typeof fleetRun>>
  beforeAll(async () => { fleet = await fleetRun(8, 5) }, 120_000)
  afterAll(async () => { await fleet.close() })
  const category = () => processPlantPack.presentation.categories.find(entry => entry.id === 'process-plants')!

  test('groups every unit by its cluster', () => {
    const plants = fleet.runtime.snapshot().objects.filter(object => object.packId === 'process-plant')
    expect(plants).toHaveLength(8)
    expect(new Set(plants.map(object => category().members!.group!.of(object)))).toEqual(new Set(['halden-power-complex']))
  })

  test('reads a fleet row from the projection: mode, no trip, satisfied safety functions, energy and alarms', () => {
    const plant = fleet.runtime.snapshot().objects.find(object => object.id === 'plant:halden-5')!
    const row = category().members!.row(plant)
    expect(Object.keys(row)).toEqual(category().members!.columns.map(column => column.key))
    expect(row).toMatchObject({ mode: 'Power operation', trip: null, safety: 'Satisfied', alarms: 0 })
    expect(row.thermal as number).toBeGreaterThan(3_000)
    expect(row.electric as number).toBeGreaterThan(1_000)
  })

  test('declares comparable roles every four-loop unit measures, under one local ref', async () => {
    const roles = processPlantPack.observation!.comparable!
    expect(roles.map(role => role.id)).toContain('pressurizer-pressure')
    const run = await fleet.runOf()
    for (const plantId of ['plant:halden-1', 'plant:halden-8']) {
      const refs = roles.map(role => `${plantId}#${role.ref}`)
      const declared = await declaredRefs(run, refs)
      expect(refs.filter(ref => !declared.has(ref))).toEqual([])
    }
  })
})
