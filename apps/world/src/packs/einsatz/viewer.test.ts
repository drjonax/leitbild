import { describe, expect, test } from 'bun:test'
import type { ScenarioRole } from '../../core/model/index.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import { einsatzCommandIds as ids } from './capabilities.ts'
import { prepareCommand, type CommandContext } from './commands.ts'
import { einsatzConfigSchema } from './config-validation.ts'
import { executeIntent } from './engine/engine.ts'
import { emptyEngineState, type EngineState } from './engine/model.ts'
import { at, controller, emptyState, low, newTask, newUnit, ports, runAll, start, templates, types } from './fixtures/engine-harness.ts'
import fixture from './fixtures/engine.config.json'
import { recommend } from './recommend.ts'
import { refusalCode } from './refusal.ts'
import { attributionOf, commandsUnit, inPicture, listText, openViewer, queuesTask, resolveViewer, type EinsatzViewer } from './viewer.ts'

/** The fixture configuration with two operator roles: one commands the road carriers and queues load tasks, the other commands the flyers. */
const authorityConfig = einsatzConfigSchema.parse({
  ...fixture,
  authority: [
    { roleId: 'ground', units: { types: [types.roadCarrier] }, taskTemplates: [templates.load] },
    { roleId: 'air', units: { types: [types.directCarrier] }, taskTemplates: [templates.load, templates.report] },
  ],
})

/** The roles of a Run without sides: every role sees everything. */
const declared: ReadonlyArray<ScenarioRole> = [
  { id: 'ground', label: 'Ground lead', class: 'operator' },
  { id: 'air', label: 'Air lead', class: 'operator' },
  { id: 'watch', label: 'Watch', class: 'operator' },
  { id: 'control', label: 'Control', class: 'controller' },
]

const withAuthority = async (): Promise<EngineState> => {
  let state = emptyEngineState({ config: authorityConfig, sides: [], timeMs: start })
  for (const intent of [
    newUnit('c1', types.roadCarrier, at(0.001)),
    newUnit('d1', types.directCarrier, at(0.002)),
    newUnit('g1', types.pairServer, at(0.003)),
    newTask('t1', templates.load, at(0), { [low]: 1 }),
    newTask('n1', templates.report, at(0)),
  ]) {
    const outcome = await executeIntent(state, intent, controller, ports)
    if (!outcome.ok) throw new Error(outcome.reason)
    state = outcome.state
  }
  return state
}

const operatorOf = (...roleIds: string[]): EinsatzViewer => resolveViewer({ roleIds, class: 'operator', sees: 'all' }, declared)
const contextFor = (state: EngineState, viewer: EinsatzViewer): CommandContext => ({ state, viewer, roles: declared, by: attributionOf(viewer, 'actor:tester'), newId: kind => `${kind}:new` })
const refusalOf = (state: EngineState, viewer: EinsatzViewer, kind: Parameters<typeof prepareCommand>[1], payload: unknown): string => {
  const prepared = prepareCommand(contextFor(state, viewer), kind, payload)
  if (prepared.ok) throw new Error(`Expected ${kind} to be refused`)
  return prepared.reason
}

describe('Einsatz viewer', () => {
  test('no stamped viewer is open mode or the timeline, a truth view commanding everything; a stamped viewer holds its declared roles', () => {
    expect(resolveViewer(undefined, declared)).toBe(openViewer)
    expect(openViewer).toEqual({ class: 'controller', sees: 'all', roles: [] })
    expect(resolveViewer({ roleIds: ['ground', 'air'], class: 'operator', sees: 'all' }, declared))
      .toEqual({ class: 'operator', sees: 'all', roles: declared.slice(0, 2) })
    expect(() => resolveViewer({ roleIds: ['ghost'], class: 'operator', sees: 'all' }, declared)).toThrow('The caller holds role ghost, which this Run does not declare')
  })

  test('lastAction.by names the held roles by label, and the core actor only without roles', () => {
    expect(attributionOf(openViewer, 'actor:operator')).toBe('actor:operator')
    expect(attributionOf(operatorOf('ground'), 'actor:operator')).toBe('Ground lead')
    expect(attributionOf(operatorOf('ground', 'air', 'watch'), 'actor:operator')).toBe('Ground lead, Air lead and Watch')
    expect(listText(['A', 'B'])).toBe('A and B')
  })

  test('the commandable set and the queue follow the roles\' authority entries; a role-less operator commands nothing', async () => {
    const state = await withAuthority()
    const unit = (id: string) => state.units.get(id)!
    const task = (id: string) => state.tasks.get(id)!
    expect(['c1', 'd1', 'g1'].filter(id => commandsUnit(state.catalog, openViewer, unit(id)))).toEqual(['c1', 'd1', 'g1'])
    expect(['c1', 'd1', 'g1'].filter(id => commandsUnit(state.catalog, operatorOf('ground'), unit(id)))).toEqual(['c1'])
    expect(['c1', 'd1', 'g1'].filter(id => commandsUnit(state.catalog, operatorOf('ground', 'air'), unit(id)))).toEqual(['c1', 'd1'])
    expect(['c1', 'd1', 'g1'].filter(id => commandsUnit(state.catalog, operatorOf(), unit(id)))).toEqual([])
    expect(['t1', 'n1'].filter(id => queuesTask(state.catalog, operatorOf('ground'), task(id)))).toEqual(['t1'])
    expect(['t1', 'n1'].filter(id => queuesTask(state.catalog, operatorOf('air'), task(id)))).toEqual(['t1', 'n1'])
  })

  test('commands name the role a unit belongs to, send to tasks outside the queue but close only queued ones, and keep creating and adjusting to controllers', async () => {
    const state = await withAuthority()
    const ground = operatorOf('ground')
    expect(refusalOf(state, ground, ids.send, { units: ['d1'], to: { taskId: 't1' } })).toBe('unit_not_authorized: Ground lead does not command D1. It belongs to Air lead: add that role to command it')
    expect(refusalOf(state, operatorOf('watch'), ids.send, { units: ['c1', 'd1'], to: { taskId: 't1' } })).toBe('unit_not_authorized: Watch does not command C1. It belongs to Ground lead: add that role to command it')
    expect(refusalOf(state, ground, ids.hold, { unitId: 'g1' })).toBe('unit_not_authorized: Ground lead does not command G1, and no operator role does')
    expect(prepareCommand(contextFor(state, ground), ids.send, { units: ['c1'], to: { taskId: 'n1' } }).ok).toBe(true)
    expect(refusalOf(state, ground, ids.taskClose, { taskId: 'n1' })).toBe('task_not_in_role_queue: N1 is not in the queue of Ground lead')
    expect(prepareCommand(contextFor(state, ground), ids.taskClose, { taskId: 't1' }).ok).toBe(true)
    expect(prepareCommand(contextFor(state, operatorOf('air')), ids.taskClose, { taskId: 'n1' }).ok).toBe(true)
    expect(refusalOf(state, ground, ids.send, { units: [], to: { taskId: 't1' } })).toStartWith('invalid_input: units: ')
    expect(refusalOf(state, ground, ids.unitCreate, { type: types.roadCarrier, at: at(0) })).toBe('role_controller_only: Creating a unit needs a controller role')
    expect(refusalCode(refusalOf(state, ground, ids.taskCreate, { template: templates.load, at: at(0), loads: { [low]: 1 }, label: 'X' }))).toBe('role_controller_only')
    expect(refusalCode(refusalOf(state, ground, ids.unitAdjust, { unitId: 'c1', properties: { liftKg: 600 }, reason: 'Test' }))).toBe('role_controller_only')
    const allowed = prepareCommand(contextFor(state, ground), ids.send, { units: ['c1'], to: { taskId: 't1' } })
    expect(allowed.ok && allowed.actor.commandable(state.units.get('d1')!)).toBe(false)
    const created = prepareCommand(contextFor(state, openViewer), ids.unitCreate, { type: types.roadCarrier, at: at(0) })
    expect(created.ok && created.intent).toMatchObject({ kind: 'unit.create', id: 'unit:new', label: 'Carrier 2' })
  })

  test('a viewer holding one side\'s picture sees that side and public records; other sides\' records are not in the picture and never echoed', async () => {
    const state = await runAll(emptyState(['north', 'south']), [
      newUnit('n1', types.roadCarrier, at(0), { side: 'north' }),
      newUnit('s1', types.roadCarrier, at(0), { side: 'south' }),
      newUnit('site', types.publicSite, at(0.01)),
    ])
    const north = resolveViewer({ roleIds: ['north-ground'], class: 'operator', sees: ['north'] }, [{ id: 'north-ground', label: 'North ground', class: 'operator', sees: ['north'] }])
    expect(['n1', 's1', 'site'].filter(id => inPicture(state.catalog, north, state.units.get(id)!))).toEqual(['n1', 'site'])
    expect(refusalOf(state, north, ids.hold, { unitId: 's1' })).toBe('not_in_picture: Not in your picture')
  })

  test('a side role never commands a public unit, though its selector names the type; a role seeing the truth and a controller do', async () => {
    const config = einsatzConfigSchema.parse({
      ...fixture,
      authority: [
        { roleId: 'north-ground', units: { types: [types.roadCarrier, types.publicSite] }, taskTemplates: [] },
        { roleId: 'umpire', units: { types: [types.publicSite] }, taskTemplates: [] },
      ],
    })
    let state = emptyEngineState({ config, sides: ['north', 'south'], timeMs: start })
    for (const intent of [newUnit('n1', types.roadCarrier, at(0), { side: 'north' }), newUnit('site', types.publicSite, at(0.01))]) {
      const outcome = await executeIntent(state, intent, controller, ports)
      if (!outcome.ok) throw new Error(outcome.reason)
      state = outcome.state
    }
    const sidedRoles: ReadonlyArray<ScenarioRole> = [
      { id: 'north-ground', label: 'North ground', class: 'operator', sees: ['north'] },
      { id: 'umpire', label: 'Umpire', class: 'operator', sees: 'all' },
      { id: 'control', label: 'Control', class: 'controller', sees: 'all' },
    ]
    const viewerOf = (roleId: string, sees: EinsatzViewer['sees'], kind: EinsatzViewer['class'] = 'operator') => resolveViewer({ roleIds: [roleId], class: kind, sees }, sidedRoles)
    const north = viewerOf('north-ground', ['north'])
    const site = state.units.get('site')!
    expect(inPicture(state.catalog, north, site)).toBe(true)
    expect(['n1', 'site'].filter(id => commandsUnit(state.catalog, north, state.units.get(id)!))).toEqual(['n1'])
    expect(commandsUnit(state.catalog, viewerOf('umpire', 'all'), site)).toBe(true)
    expect(commandsUnit(state.catalog, viewerOf('control', 'all', 'controller'), site)).toBe(true)
    const prepared = prepareCommand({ state, viewer: north, roles: sidedRoles, by: attributionOf(north, 'actor:tester'), newId: kind => `${kind}:new` }, ids.siteSet, { siteId: 'site', accepting: false })
    expect(prepared.ok ? null : prepared.reason).toBe('unit_not_authorized: North ground does not command SITE. It belongs to Umpire: add that role to command it')
  })

  test('a role set commands and queues the union of what each role commands within its own picture, never one role\'s selector across another\'s side', async () => {
    const sidedConfig = einsatzConfigSchema.parse({
      ...fixture,
      authority: [
        { roleId: 'north-ground', units: { types: [types.roadCarrier] }, taskTemplates: [templates.load] },
        { roleId: 'south-air', units: { types: [types.directCarrier] }, taskTemplates: [templates.report] },
      ],
    })
    let state = emptyEngineState({ config: sidedConfig, sides: ['north', 'south'], timeMs: start })
    for (const intent of [
      newUnit('nc', types.roadCarrier, at(0), { side: 'north' }),
      newUnit('nd', types.directCarrier, at(0), { side: 'north' }),
      newUnit('sc', types.roadCarrier, at(0), { side: 'south' }),
      newUnit('sd', types.directCarrier, at(0), { side: 'south' }),
      newTask('nl', templates.load, at(0), { [low]: 1 }, { side: 'north' }),
      newTask('nr', templates.report, at(0), undefined, { side: 'north' }),
      newTask('sl', templates.load, at(0), { [low]: 1 }, { side: 'south' }),
      newTask('sr', templates.report, at(0), undefined, { side: 'south' }),
    ]) {
      const outcome = await executeIntent(state, intent, controller, ports)
      if (!outcome.ok) throw new Error(outcome.reason)
      state = outcome.state
    }
    const sidedRoles: ReadonlyArray<ScenarioRole> = [
      { id: 'north-ground', label: 'North ground', class: 'operator', sees: ['north'] },
      { id: 'south-air', label: 'South air', class: 'operator', sees: ['south'] },
    ]
    const both = resolveViewer({ roleIds: ['north-ground', 'south-air'], class: 'operator', sees: ['north', 'south'] }, sidedRoles)
    expect(['nc', 'nd', 'sc', 'sd'].filter(id => commandsUnit(state.catalog, both, state.units.get(id)!))).toEqual(['nc', 'sd'])
    expect(['nl', 'nr', 'sl', 'sr'].filter(id => queuesTask(state.catalog, both, state.tasks.get(id)!))).toEqual(['nl', 'sr'])
    const prepared = prepareCommand({ state, viewer: both, roles: sidedRoles, by: attributionOf(both, 'actor:tester'), newId: kind => `${kind}:new` }, ids.hold, { unitId: 'sc' })
    expect(prepared.ok ? null : prepared.reason).toBe('unit_not_authorized: North ground and South air do not command SC, and no operator role does')
  })

  test('recommendations take candidates only from the viewer\'s commandable set', async () => {
    const state = await withAuthority()
    const routing = createDirectRoutingAdapter()
    const asGround = await recommend({ state, viewer: operatorOf('ground'), taskId: 't1', routing })
    expect([...asGround.proposal.units, ...asGround.alternatives].map(entry => entry.unitId)).toEqual(['c1'])
    const asBoth = await recommend({ state, viewer: operatorOf('ground', 'air'), taskId: 't1', routing })
    expect([...asBoth.proposal.units, ...asBoth.alternatives].map(entry => entry.unitId).sort()).toEqual(['c1', 'd1'])
    const outside = await recommend({ state, viewer: operatorOf('ground'), taskId: 'n1', routing }).then(() => '', (error: Error) => error.message)
    expect(refusalCode(outside)).toBe('task_not_in_role_queue')
  })
})
