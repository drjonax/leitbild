import { describe, expect, test } from 'bun:test'
import { ZodError } from 'zod'
import type { CommandId, ObjectAudience, ScenarioRole, ScenarioSide } from '../../../core/model/index.ts'
import { compileScenarioDefinition } from '../../../core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import { einsatzCommandIds as ids, einsatzQueryIds, type Recommendation } from '../capabilities.ts'
import { low, start, templates, types } from '../fixtures/engine-harness.ts'
import fixture from '../fixtures/engine.config.json'
import { definitionOf, isoAt, lonLat, openRun, screenOf, taskItem, unitItem, type OpenRun, type RoleRunDeclaration, type TaskItem, type UnitItem } from '../fixtures/run-harness.ts'
import { einsatzAdapterId, einsatzPackId } from '../ids.ts'
import { einsatzPack } from '../pack.ts'
import { refusalCode } from '../refusal.ts'
import { causedBy, type Commander } from './adapter.ts'

/**
 * Einsatz in role Runs, on a real Run: sides on items, creates and objects,
 * the commandable set and queues of each held role, refusals worded within
 * the caller's picture, the same-side invariant for every caller, command
 * ids kept to the caller's view, and the configuration's checks against the
 * Scenario's roles and sides.
 */

const sides: ReadonlyArray<ScenarioSide> = [
  { id: 'north', label: 'North', colour: '#1565c0' },
  { id: 'south', label: 'South', colour: '#c62828' },
]
const roles: ReadonlyArray<ScenarioRole> = [
  { id: 'north-ground', label: 'North ground', class: 'operator', sees: ['north'] },
  { id: 'north-air', label: 'North air', class: 'operator', sees: ['north'] },
  { id: 'south-ground', label: 'South ground', class: 'operator', sees: ['south'] },
  { id: 'umpire', label: 'Umpire', class: 'operator', sees: 'all' },
  { id: 'control', label: 'Control', class: 'controller', sees: 'all' },
]
const authority = [
  { roleId: 'north-ground', units: { types: [types.roadCarrier, types.publicSite] }, taskTemplates: [templates.load, templates.report] },
  { roleId: 'north-air', units: { types: [types.directCarrier] }, taskTemplates: [templates.report] },
  { roleId: 'south-ground', units: { types: [types.roadCarrier] }, taskTemplates: [templates.load] },
]
const declared: RoleRunDeclaration = { roles, sides, config: { ...fixture, hostility: { north: ['south'], south: ['north'] }, authority } }

const sided = <T extends UnitItem | TaskItem>(item: T, side: string): T => ({ ...item, side })
/**
 * A North and a South carrier of the same type, the South one nearer the
 * North task; a North flyer; a public and a North site; tasks of both sides.
 * North ground's selector names the public site's type, which a side role
 * still never commands.
 */
const items = [
  sided(unitItem('n1', types.roadCarrier, lonLat(0)), 'north'),
  sided(unitItem('n2', types.directCarrier, lonLat(0)), 'north'),
  sided(unitItem('s1', types.roadCarrier, lonLat(0.009)), 'south'),
  unitItem('clinic', types.publicSite, lonLat(0.02)),
  sided(unitItem('ncamp', types.sidedSite, lonLat(0.02, 0.001)), 'north'),
  sided(taskItem('tn', templates.load, lonLat(0.01), { [low]: 1 }), 'north'),
  sided(taskItem('ts', templates.load, lonLat(0.011), { [low]: 1 }), 'south'),
  sided(taskItem('rn', templates.report, lonLat(0.005)), 'north'),
]

const screens = {
  northGround: screenOf(declared, 'north-ground'),
  northAir: screenOf(declared, 'north-air'),
  crossed: screenOf(declared, 'north-air', 'south-ground'),
  umpire: screenOf(declared, 'umpire'),
  control: screenOf(declared, 'control'),
}

const withRun = async (options: Parameters<typeof openRun>[0], body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun(options)
  try { await body(run) } finally { await run.close() }
}
const withSidedRun = (body: (run: OpenRun) => Promise<void>) => withRun({ items, declared, paused: true }, body)

const send = (units: ReadonlyArray<string>, to: unknown) => ({ units, to })
const recommendFor = (run: OpenRun, taskId: string, actor = screens.control) => run.query<Recommendation>(einsatzQueryIds.recommend, { taskId }, actor)
const queryRefusal = async (run: OpenRun, taskId: string, actor: Parameters<OpenRun['query']>[2]): Promise<string> => {
  try {
    await run.query<Recommendation>(einsatzQueryIds.recommend, { taskId }, actor)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error(`Expected recommend for ${taskId} to be refused`)
}
const listed = (recommendation: Recommendation): string[] => [
  ...recommendation.proposal.units.map(entry => entry.unitId),
  ...recommendation.alternatives.map(entry => entry.unitId),
  ...recommendation.ineligible.map(entry => entry.unitId),
  ...recommendation.committed.map(entry => entry.unitId),
].sort()

const compileIssues = async (definition: unknown): Promise<Array<{ readonly path: string; readonly code: unknown }>> => {
  try {
    await compileScenarioDefinition(definition, [einsatzPack], { routing: createDirectRoutingAdapter() })
  } catch (error) {
    if (!(error instanceof ZodError)) throw error
    return error.issues.map(issue => ({ path: issue.path.join('.'), code: (issue as { readonly params?: { readonly code?: unknown } }).params?.code }))
  }
  throw new Error('Expected the Definition to be refused')
}

describe('Einsatz sides', () => {
  test('an item names its side exactly when the Scenario declares sides, and a public type names none', async () => {
    const compile = (extra: ReadonlyArray<UnitItem | TaskItem>) =>
      compileScenarioDefinition(definitionOf([...items, ...extra], undefined, declared), [einsatzPack], { routing: createDirectRoutingAdapter() })
    await expect(compile([unitItem('x', types.roadCarrier, lonLat(0))])).rejects.toThrow('side_required: Name a side: north, south')
    await expect(compile([sided(unitItem('x', types.roadCarrier, lonLat(0)), 'east')])).rejects.toThrow('side_not_declared: Side "east" is not declared')
    await expect(compile([sided(taskItem('x', templates.load, lonLat(0), { [low]: 1 }), 'east')])).rejects.toThrow('side_not_declared')
    await expect(compile([sided(unitItem('x', types.publicSite, lonLat(0)), 'north')])).rejects.toThrow('public_takes_no_side')
  })

  test('every object carries its side as its audience, a public type\'s every side\'s, and a create names its side exactly when the Run declares sides', async () => {
    await withSidedRun(async run => {
      const audience = (id: string) => run.object(id)?.audience
      expect(['n1', 's1', 'clinic', 'ncamp', 'tn', 'ts'].map(audience)).toEqual([['north'], ['south'], 'public', ['north'], ['north'], ['south']])
      const create = { type: types.roadCarrier, at: { type: 'Point', coordinates: lonLat(0.001) }, label: 'Reserve' }
      expect((await run.refusal(ids.unitCreate, create, screens.control)).reason).toBe('side_required: Name a side: north, south')
      expect((await run.refusal(ids.unitCreate, { ...create, side: 'east' }, screens.control)).reason).toBe('side_not_declared: Side "east" is not declared')
      expect((await run.refusal(ids.taskCreate, { template: templates.load, at: create.at, loads: { [low]: 1 }, label: 'Late' }, screens.control)).code).toBe('side_required')
      expect(await run.invoke(ids.unitCreate, { ...create, side: 'south' }, screens.control)).toMatchObject({ ok: true })
      expect(run.object('unit:1')).toMatchObject({ label: 'Reserve', audience: ['south'], packData: { side: 'south', lastAction: { verb: 'create', by: 'Control' } } })
    })
  })

  test('a Run without sides writes no audience, and its roles all see everything', async () => {
    const unsided: RoleRunDeclaration = { roles: roles.map(({ sees: _sees, ...role }) => role), config: { ...fixture, authority } }
    await withRun({ items: [unitItem('n1', types.roadCarrier, lonLat(0)), unitItem('n2', types.directCarrier, lonLat(0)), taskItem('tn', templates.load, lonLat(0.01), { [low]: 1 })], declared: unsided, paused: true }, async run => {
      expect(run.object('n1')?.audience).toBeUndefined()
      const ground = screenOf(unsided, 'south-ground')
      expect((await run.refusal(ids.send, send(['n2'], { taskId: 'tn' }), ground)).reason).toBe('unit_not_authorized: South ground does not command N2. It belongs to North air: add that role to command it')
      expect(await run.invoke(ids.send, send(['n1'], { taskId: 'tn' }), ground)).toMatchObject({ ok: true })
      expect(run.unit('n1').lastAction).toMatchObject({ verb: 'send', by: 'South ground' })
    })
  })
})

describe('Einsatz authority in a role Run', () => {
  test('a side screen commands and asks only within its picture, and no refusal echoes what it cannot see', async () => {
    await withSidedRun(async run => {
      for (const input of [send(['s1'], { taskId: 'tn' }), send(['n1'], { taskId: 'ts' }), send(['n1'], { siteId: 's1' })]) {
        expect((await run.refusal(ids.send, input, screens.northGround)).reason).toBe('not_in_picture: Not in your picture')
      }
      expect((await run.refusal(ids.taskClose, { taskId: 'ts' }, screens.northGround)).reason).toBe('not_in_picture: Not in your picture')
      expect(await queryRefusal(run, 'ts', screens.northGround)).toBe('not_in_picture: Not in your picture')
      expect((await run.refusal(ids.send, send(['n2'], { taskId: 'tn' }), screens.northGround)).reason)
        .toBe('unit_not_authorized: North ground does not command N2. It belongs to North air: add that role to command it')
      expect((await run.refusal(ids.send, send(['n1'], { taskId: 'tn' }), screens.crossed)).reason)
        .toBe('unit_not_authorized: North air and South ground do not command N1. It belongs to North ground: add that role to command it')
      expect(await queryRefusal(run, 'tn', screens.northAir)).toBe('task_not_in_role_queue: TN is not in the queue of North air')
      expect(refusalCode(await queryRefusal(run, 'tn', screens.umpire))).toBe('task_not_in_role_queue')
      expect((await run.refusal(ids.unitCreate, { type: types.roadCarrier, side: 'north', at: { type: 'Point', coordinates: lonLat(0) } }, screens.northGround)).reason)
        .toBe('role_controller_only: Creating a unit needs a controller role')
      expect(await run.invoke(ids.send, send(['n1'], { taskId: 'tn' }), screens.northGround)).toMatchObject({ ok: true })
      expect(run.unit('n1').lastAction).toMatchObject({ verb: 'send', target: 'tn', by: 'North ground' })
    })
  })

  test('recommendations take candidates only from the task\'s side and the caller\'s commandable set', async () => {
    await withSidedRun(async run => {
      const asNorth = await recommendFor(run, 'tn', screens.northGround)
      expect(asNorth.proposal.units.map(entry => entry.unitId)).toEqual(['n1'])
      expect(listed(asNorth)).toEqual(['n1'])
      const asControl = await recommendFor(run, 'tn')
      expect(listed(asControl)).toEqual(['n1', 'n2'])
      expect(listed(await recommendFor(run, 'ts'))).toEqual(['s1'])
      expect(JSON.stringify(asNorth)).not.toContain('S1')
    })
  })

  test('the same-side invariant holds for the Controller and the timeline: a cross-side send is refused', async () => {
    const cue = { id: 'cross', at: { kind: 'after_scenario_start' as const, seconds: 5 }, actions: [{ type: 'invoke_capability' as const, capabilityId: ids.send, input: send(['s1'], { taskId: 'tn' }) }] }
    await withRun({ items, declared, paused: true, timeline: { cues: [cue] } }, async run => {
      expect((await run.refusal(ids.send, send(['s1'], { taskId: 'tn' }), screens.control)).reason).toBe('cross_side_reference: S1 cannot serve another side\'s TN')
      expect((await run.refusal(ids.send, send(['s1'], { siteId: 'ncamp' }), screens.control)).reason).toBe('cross_side_reference: S1 cannot use another side\'s NCAMP')
      await run.run.runMaximumPace(isoAt(start + 10_000), { shouldStop: () => false })
      const results = run.journal.flatMap(event => event.type === 'command.result' && !event.result.ok ? [event.result.reason] : [])
      expect(results.map(refusalCode)).toContain('cross_side_reference')
      expect(run.unit('s1')).toMatchObject({ phase: 'available' })
      expect(run.task('tn').coverage.loads).toEqual([{ classId: low, waiting: 1, covered: 0 }])
    })
  })

  test('only a role whose queue holds a task closes it, since closing releases every unit on it; the side\'s other roles see it read-only', async () => {
    await withSidedRun(async run => {
      expect(await run.invoke(ids.send, send(['n1'], { taskId: 'tn' }), screens.northGround)).toMatchObject({ ok: true })
      expect((await run.refusal(ids.taskClose, { taskId: 'tn' }, screens.northAir)).reason).toBe('task_not_in_role_queue: TN is not in the queue of North air')
      expect(run.unit('n1')).toMatchObject({ taskId: 'tn', lastAction: { verb: 'send', target: 'tn', by: 'North ground' } })
      expect(run.task('tn').closedAtMs).toBeUndefined()
      expect(await run.invoke(ids.taskClose, { taskId: 'rn' }, screens.northAir)).toMatchObject({ ok: true })
      expect(await run.invoke(ids.taskClose, { taskId: 'tn' }, screens.northGround)).toMatchObject({ ok: true })
      expect(run.unit('n1')).toMatchObject({ phase: 'available', lastAction: { verb: 'release', target: 'tn', by: 'North ground' } })
    })
  })

  test('a side role commands no public unit, so its command never changes a public object or another side\'s, and a command id stays on objects its caller sees', async () => {
    await withSidedRun(async run => {
      expect((await run.refusal(ids.siteSet, { siteId: 'clinic', accepting: false }, screens.northGround)).reason)
        .toBe('unit_not_authorized: North ground does not command CLINIC, and no operator role does')
      expect(run.unit('clinic')).toMatchObject({ accepting: true })
      expect(run.object('clinic')?.provenance).toEqual({ source: 'simulator', adapterId: einsatzAdapterId, externalId: 'clinic' })
      const sent = await run.invoke(ids.send, send(['n1'], { taskId: 'tn' }), screens.northGround)
      expect(run.object('n1')?.provenance.causedByCommandId).toBe(sent.commandId)
      expect(run.object('tn')?.provenance.causedByCommandId).toBe(sent.commandId)
      const closed = await run.invoke(ids.siteSet, { siteId: 'clinic', accepting: false }, screens.control)
      expect(closed).toMatchObject({ ok: true })
      expect(run.unit('clinic')).toMatchObject({ accepting: false, lastAction: { verb: 'set', by: 'Control' } })
      expect(run.object('clinic')?.provenance.causedByCommandId).toBe(closed.commandId)
    })
  })

  test('a role set spanning both sides stamps one command\'s id on the objects of each side it sees', async () => {
    await withSidedRun(async run => {
      const moved = await run.invoke(ids.send, send(['n2', 's1'], { point: { type: 'Point', coordinates: lonLat(0.012) } }), screens.crossed)
      expect(moved).toMatchObject({ ok: true })
      expect(['n2', 's1'].map(id => run.object(id)?.audience)).toEqual([['north'], ['south']])
      for (const id of ['n2', 's1']) {
        expect(run.object(id)?.provenance.causedByCommandId).toBe(moved.commandId)
        expect(run.unit(id).lastAction).toMatchObject({ verb: 'move', by: 'North air and South ground' })
      }
    })
  })

  test('an object names a command only when every reader of the object also sees the command', () => {
    const commandId = (value: string): CommandId => value as CommandId
    const [n, ns, t] = [commandId('n'), commandId('ns'), commandId('t')]
    const audiences: ReadonlyArray<ObjectAudience> = [['north'], ['south'], ['north', 'south'], [], 'public']
    const north: Commander = { id: n, sees: ['north'] }
    const both: Commander = { id: ns, sees: ['north', 'south'] }
    const truth: Commander = { id: t, sees: 'all' }
    expect(audiences.map(audience => causedBy(north, audience))).toEqual([n, undefined, undefined, undefined, undefined])
    expect(audiences.map(audience => causedBy(both, audience))).toEqual([ns, ns, ns, undefined, undefined])
    expect(audiences.map(audience => causedBy(truth, audience))).toEqual([t, t, t, t, t])
    expect(causedBy(truth, undefined)).toBe(t)
    expect(causedBy(undefined, ['north'])).toBeUndefined()
  })
})

describe('Einsatz configuration against the Scenario', () => {
  const withConfig = (config: Record<string, unknown>, scenario: { readonly roles?: ReadonlyArray<ScenarioRole>; readonly sides?: ReadonlyArray<ScenarioSide> } = { roles, sides }) => ({
    ...definitionOf(scenario.sides === undefined ? [] : items, undefined, scenario.roles === undefined ? undefined : { roles: scenario.roles, ...(scenario.sides === undefined ? {} : { sides: scenario.sides }), config: {} }),
    packs: [{ id: einsatzPackId, config: { ...fixture, ...config }, items: scenario.sides === undefined ? [] : items }],
  })
  const config = 'packs.0.config'

  test('authority names declared operator roles only, and needs declared roles', async () => {
    expect(await compileIssues(withConfig({ authority: [...authority, { roleId: 'ghost', units: { all: true }, taskTemplates: [] }, { roleId: 'control', units: { all: true }, taskTemplates: [] }] }))).toEqual([
      { path: `${config}.authority.3.roleId`, code: 'authority_unknown_role' },
      { path: `${config}.authority.4.roleId`, code: 'controller_authority' },
    ])
    expect(await compileIssues(withConfig({ authority }, {}))).toEqual([{ path: `${config}.authority`, code: 'authority_without_roles' }])
  })

  test('the labels of every declared role, held at once, fit lastAction.by, so a Run never writes an order it cannot read back', async () => {
    const labelled = (count: number): ReadonlyArray<ScenarioRole> => Array.from({ length: count }, (_, index) =>
      ({ id: `role-${index}`, label: `${String(index).padStart(2, '0')} ${'w'.repeat(77)}`, class: 'operator', sees: ['north'] }))
    await expect(compileScenarioDefinition(withConfig({}, { roles: labelled(12), sides }), [einsatzPack], { routing: createDirectRoutingAdapter() })).resolves.toBeDefined()
    expect(await compileIssues(withConfig({}, { roles: labelled(13), sides }))).toEqual([{ path: config, code: 'role_labels_too_long' }])
  })

  test('hostility is between declared sides', async () => {
    expect(await compileIssues(withConfig({ hostility: { north: ['south', 'east'], west: ['north'] } }))).toEqual([
      { path: `${config}.hostility.north.1`, code: 'unknown_side' },
      { path: `${config}.hostility.west`, code: 'unknown_side' },
    ])
    expect(await compileIssues(withConfig({ hostility: { north: ['south'] } }, { roles: roles.map(({ sees: _sees, ...role }) => role) }))).toEqual([
      { path: `${config}.hostility.north`, code: 'unknown_side' },
      { path: `${config}.hostility.north.0`, code: 'unknown_side' },
    ])
  })
})
