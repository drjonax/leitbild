import { describe, expect, test } from 'bun:test'
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
import { commandsUnit, inPicture, openViewer, queuesTask, resolveViewer, type EinsatzViewer } from './viewer.ts'

/** The fixture configuration with two operator roles: one commands the road carriers and queues load tasks, the other commands the flyers. */
const authorityConfig = einsatzConfigSchema.parse({
  ...fixture,
  authority: [
    { roleId: 'ground', units: { types: [types.roadCarrier] }, taskTemplates: [templates.load] },
    { roleId: 'air', units: { types: [types.directCarrier] }, taskTemplates: [templates.load, templates.report] },
  ],
})

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

const operatorOf = (...roleIds: string[]): EinsatzViewer => ({ roleIds, class: 'operator', sees: 'all' })
const contextFor = (state: EngineState, viewer: EinsatzViewer): CommandContext => ({ state, viewer, by: 'tester', newId: kind => `${kind}:new` })
const refusalOf = (state: EngineState, viewer: EinsatzViewer, kind: Parameters<typeof prepareCommand>[1], payload: unknown): string => {
  const prepared = prepareCommand(contextFor(state, viewer), kind, payload)
  if (prepared.ok) throw new Error(`Expected ${kind} to be refused`)
  return prepared.reason
}

describe('Einsatz viewer', () => {
  test('core passes nothing in open mode, which is a truth view commanding everything; a role set reaching Einsatz is an error', () => {
    expect(resolveViewer({})).toBe(openViewer)
    expect(openViewer).toEqual({ roleIds: [], class: 'controller', sees: 'all' })
    expect(() => resolveViewer({ roleIds: ['ground'] })).toThrow('Einsatz is not role-aware, so no role Run can call it (roles ground)')
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

  test('commands name the role a unit belongs to, take tasks outside the queue and keep creating and adjusting to controllers', async () => {
    const state = await withAuthority()
    const ground = operatorOf('ground')
    expect(refusalOf(state, ground, ids.send, { units: ['d1'], to: { taskId: 't1' } })).toBe('unit_not_authorized: D1 belongs to air. Add that role to command it')
    expect(refusalOf(state, ground, ids.hold, { unitId: 'g1' })).toBe('unit_not_authorized: G1 is commanded by no role')
    expect(prepareCommand(contextFor(state, ground), ids.send, { units: ['c1'], to: { taskId: 'n1' } }).ok).toBe(true)
    expect(prepareCommand(contextFor(state, ground), ids.taskClose, { taskId: 'n1' }).ok).toBe(true)
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
    const north: EinsatzViewer = { roleIds: [], class: 'controller', sees: ['north'] }
    expect(['n1', 's1', 'site'].filter(id => inPicture(state.catalog, north, state.units.get(id)!))).toEqual(['n1', 'site'])
    expect(refusalOf(state, north, ids.hold, { unitId: 's1' })).toBe('not_in_picture: Not in your picture')
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
