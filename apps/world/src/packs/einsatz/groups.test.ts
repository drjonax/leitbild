import { describe, expect, test } from 'bun:test'
import { ZodError } from 'zod'
import { compileScenarioDefinition } from '../../core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import { einsatzCommandIds as ids, einsatzQueryIds } from './capabilities.ts'
import { einsatzConfigSchema } from './config-validation.ts'
import { types } from './fixtures/engine-harness.ts'
import fixture from './fixtures/engine.config.json'
import { groupConfig as config, groupDeclaration as declared, groupDeclaredRoles as roles, groupItems as items, groups, placed } from './fixtures/groups-run.ts'
import border from '../../scenarios/halden-border.scenario.json'
import civilRoles from './fixtures/halden-civil-roles.scenario.json'
import { renameDefinition } from './fixtures/renaming.ts'
import { definitionOf, lonLat, openRun, screenOf, unitItem, type OpenRun, type RoleRunDeclaration, type TaskItem, type UnitItem } from './fixtures/run-harness.ts'
import { groupOfRoleId, groupRoleId } from './ids.ts'
import { einsatzPack } from './pack.ts'
import type { Recommendation } from './recommendation-schema.ts'
import { refusalCode } from './refusal.ts'

/**
 * Groups (owner amendment A9, item 4): every unit of a configuration that
 * declares groups belongs to exactly one, each group becomes an operator role
 * commanding exactly its units and queueing what they can serve, and a
 * configuration without groups runs exactly as before.
 */

const screens = {
  haulA: screenOf(declared, groupRoleId('haul-a')),
  haulB: screenOf(declared, groupRoleId('haul-b')),
  guards: screenOf(declared, groupRoleId('guards')),
  bothHaulers: screenOf(declared, groupRoleId('haul-a'), groupRoleId('haul-b')),
  desk: screenOf(declared, 'north-desk'),
  control: screenOf(declared, 'control'),
}

const withRun = async (body: (run: OpenRun) => Promise<void>, options: { readonly items?: ReadonlyArray<UnitItem | TaskItem>; readonly declared?: RoleRunDeclaration } = {}): Promise<void> => {
  const run = await openRun({ items: options.items ?? items, declared: options.declared ?? declared, paused: true })
  try { await body(run) } finally { await run.close() }
}

const compile = async (definition: unknown) => await compileScenarioDefinition(definition, [einsatzPack], { routing: createDirectRoutingAdapter() })
const compileIssues = async (definition: unknown): Promise<ReadonlyArray<{ readonly path: string; readonly message: string }>> => {
  const error = await compile(definition).then(() => null, (caught: unknown) => caught)
  if (!(error instanceof ZodError)) throw new Error(`Expected the Definition to be refused, got ${String(error)}`)
  return error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
}
const recommendation = async (run: OpenRun, taskId: string, actor: Parameters<OpenRun['query']>[2]): Promise<Recommendation> =>
  await run.query<Recommendation>(einsatzQueryIds.recommend, { taskId }, actor)
const recommendRefusal = async (run: OpenRun, taskId: string, actor: Parameters<OpenRun['query']>[2]): Promise<string> =>
  await run.query(einsatzQueryIds.recommend, { taskId }, actor).then(() => 'answered', (error: Error) => error.message)

describe('Einsatz group declarations', () => {
  test('group ids are unique and a group declares exactly an id, a label, a category and an optional side', () => {
    const refused = einsatzConfigSchema.safeParse({ groups: [groups[0], { ...groups[1], id: 'haul-a' }] })
    expect(refused.error?.issues.map(issue => [issue.path.join('.'), refusalCode(issue.message)])).toEqual([['groups.1.id', 'duplicate_id']])
    expect(einsatzConfigSchema.safeParse({ groups: [{ ...groups[0], colour: '#fff' }] }).error?.issues[0]?.code).toBe('unrecognized_keys')
    expect(einsatzConfigSchema.safeParse({ groups: [{ id: 'x', label: 'X' }] }).success).toBe(false)
    expect(groupRoleId('haul-a')).toBe('group:haul-a')
    expect([groupOfRoleId('group:haul-a'), groupOfRoleId('control')]).toEqual(['haul-a', undefined])
  })

  test('each group becomes an operator role after the declared ones: its label, its category, and its side\'s picture', async () => {
    const compiled = await compile(definitionOf(items, undefined, declared))
    expect(compiled.roles).toEqual([
      ...roles,
      { id: 'group:haul-a', label: 'Haulers A', class: 'operator', category: 'Haulers', sees: ['north'] },
      { id: 'group:haul-b', label: 'Haulers B', class: 'operator', category: 'Haulers', sees: ['north'] },
      { id: 'group:guards', label: 'Guards', class: 'operator', category: 'Guards', sees: ['north'] },
      { id: 'group:raid', label: 'Raiders', class: 'operator', category: 'Haulers', sees: ['south'] },
    ])
    // Without sides a group's role sees everything, and so declares no sees.
    const unsided: RoleRunDeclaration = { roles: roles.map(({ sees: _sees, ...role }) => role), config: { ...fixture, groups: [{ id: 'all', label: 'Everyone', category: 'Crews' }] } }
    const plain = await compile(definitionOf([placed(unitItem('a1', types.roadCarrier, lonLat(0)), { group: 'all' })], undefined, unsided))
    expect(plain.roles?.at(-1)).toEqual({ id: 'group:all', label: 'Everyone', class: 'operator', category: 'Crews' })
  })

  test('groups need declared roles, and name a declared side exactly when the Scenario declares sides', async () => {
    expect(await compileIssues({ ...definitionOf([], undefined, declared), roles: undefined, sides: undefined, packs: [{ id: 'einsatz', config: { ...fixture, groups: [{ id: 'g', label: 'G', category: 'C' }] }, items: [] }] }))
      .toEqual([{ path: 'packs.0.config.groups', message: 'groups_without_roles: Groups become roles, but the Scenario declares none: declare roles, at least a controller, to play groups' }])
    const withGroups = (entries: ReadonlyArray<Record<string, unknown>>, sided = true) =>
      definitionOf([], undefined, sided ? { ...declared, config: { ...config, groups: entries } } : { roles: roles.map(({ sees: _sees, ...role }) => role), config: { ...fixture, groups: entries } })
    expect(await compileIssues(withGroups([{ id: 'g', label: 'G', category: 'C' }]))).toEqual([{ path: 'packs.0.config.groups.0.side', message: 'group_side_required: Group "g" needs a side: north, south' }])
    expect(await compileIssues(withGroups([{ id: 'g', label: 'G', category: 'C', side: 'east' }]))).toEqual([{ path: 'packs.0.config.groups.0.side', message: 'unknown_side: Side "east" is not declared; the Scenario declares north, south' }])
    expect(await compileIssues(withGroups([{ id: 'g', label: 'G', category: 'C', side: 'north' }], false))).toEqual([{ path: 'packs.0.config.groups.0.side', message: 'group_side_not_declared: Group "g" names side "north", but the Scenario declares no sides' }])
  })

  test('only a declared group\'s own role takes the form group:<id>', async () => {
    const imitating = definitionOf(items, undefined, { ...declared, roles: [...roles, { id: 'group:ghost', label: 'Ghost', class: 'operator', sees: ['north'] }] })
    expect(await compileIssues(imitating)).toEqual([{ path: 'packs.0.config', message: 'reserved_role_id: Role "group:ghost" takes the form of a group\'s role, but no group "ghost" is declared: rename the role' }])
    const taken = definitionOf(items, undefined, { ...declared, roles: [...roles, { id: 'group:guards', label: 'Guards', class: 'operator', sees: ['north'] }] })
    expect((await compileIssues(taken))[0]?.message).toStartWith('duplicate_role: Pack einsatz derives the role group:guards')
  })

  test('a declared preset may bundle group roles, which compile checks against the groups declared', async () => {
    const preset = (members: ReadonlyArray<string>) => ({ ...definitionOf(items, undefined, declared), rolePresets: [{ id: 'north-haul', label: 'North hauling', roles: members }] })
    const compiled = await compile(preset(['north-desk', groupRoleId('haul-a'), groupRoleId('haul-b')]))
    expect(compiled.rolePresets).toEqual([{ id: 'north-haul', label: 'North hauling', roles: ['north-desk', 'group:haul-a', 'group:haul-b'] }])
    expect(await compileIssues(preset([groupRoleId('haul-a'), groupRoleId('ghost')]))).toEqual([{ path: 'rolePresets.0.roles.1', message: 'role preset names an undeclared role: group:ghost' }])
  })

  test('a group labelled as a standing order is refused at its label', async () => {
    const relabelled = { ...declared, config: { ...config, groups: groups.map((group, index) => index === 1 ? { ...group, label: 'standing-order:hold' } : group) } }
    expect(await compileIssues(definitionOf(items, undefined, relabelled))).toEqual([{
      path: 'packs.0.config.groups.1.label',
      message: 'role_label_reserved: Group "haul-b" is labelled "standing-order:hold"; Einsatz names its standing orders "standing-order:…" where it names the roles that gave an order, so the label would make a person\'s order read as a standing order: relabel the group',
    }])
  })

  test('once groups are declared, every unit but a public one names exactly one group, of its own side', async () => {
    const refusedItem = async (extra: UnitItem): Promise<string> =>
      await compile(definitionOf([...items, extra], undefined, declared)).then(() => 'compiled', (error: Error) => error.message)
    expect(await refusedItem(placed(unitItem('x', types.roadCarrier, lonLat(0)), { side: 'north' }))).toBe('Einsatz item x: group_required: Name a group: haul-a, haul-b, guards, raid')
    expect(await refusedItem(placed(unitItem('x', types.roadCarrier, lonLat(0)), { side: 'north', group: 'ghost' }))).toBe('Einsatz item x: unknown_group: Group "ghost" is not declared')
    expect(await refusedItem(placed(unitItem('x', types.roadCarrier, lonLat(0)), { side: 'south', group: 'guards' }))).toBe('Einsatz item x: group_side_mismatch: Group "guards" is on side "north", not "south"')
    expect(await refusedItem(placed(unitItem('x', types.publicSite, lonLat(0)), { group: 'guards' }))).toBe('Einsatz item x: public_takes_no_group: Clinic is public and belongs to no group')
    const ungrouped = await compile(definitionOf([placed(unitItem('x', types.roadCarrier, lonLat(0)), { group: 'guards' })]))
      .then(() => 'compiled', (error: Error) => error.message)
    expect(ungrouped).toBe('Einsatz item x: group_not_declared: This configuration declares no groups, so "guards" is not one')
  })
})

describe('Einsatz group roles in a role Run', () => {
  test('a group\'s role commands exactly its group\'s units, and a refusal names the group that does', async () => {
    await withRun(async run => {
      expect(run.unit('a1').group).toBe('haul-a')
      expect((await run.refusal(ids.hold, { unitId: 'a2' }, screens.haulB)).reason).toBe('unit_not_authorized: Haulers B does not command A2. It belongs to Haulers A: add that role to command it')
      // North desk commands every North road carrier by its authority, beside the carrier's group.
      expect((await run.refusal(ids.hold, { unitId: 'b1' }, screens.haulA)).reason).toBe('unit_not_authorized: Haulers A does not command B1. It belongs to North desk and Haulers B: add one of those roles to command it')
      expect((await run.refusal(ids.hold, { unitId: 'a2' }, screens.desk)).reason).toBe('unit_not_authorized: North desk does not command A2. It belongs to Haulers A: add that role to command it')
      expect((await run.refusal(ids.hold, { unitId: 'r1' }, screens.haulA)).reason).toBe('not_in_picture: Not in your picture')
      expect(await run.invoke(ids.send, { units: ['a1'], to: { taskId: 'load' } }, screens.haulA)).toMatchObject({ ok: true })
      expect(run.unit('a1').lastAction).toMatchObject({ verb: 'send', target: 'load', by: 'Haulers A' })
      // A role set commands the union of its groups.
      expect(await run.invoke(ids.hold, { unitId: 'b1' }, screens.bothHaulers)).toMatchObject({ ok: true })
      expect(run.unit('b1').lastAction).toMatchObject({ verb: 'hold', by: 'Haulers A and Haulers B' })
    })
  })

  test('a group\'s role gives its own unit every job-chain order, and is refused each of them on another group\'s unit, naming that group', async () => {
    await withRun(async run => {
      const point = (east: number) => ({ type: 'Point', coordinates: lonLat(east) })
      expect(await run.invoke(ids.send, { units: ['a1'], to: { point: point(0.006) } }, screens.haulA)).toMatchObject({ ok: true })
      expect(await run.invoke(ids.send, { units: ['b1'], to: { point: point(0.007) } }, screens.haulB)).toMatchObject({ ok: true })
      const own: ReadonlyArray<readonly [string, unknown]> = [
        [ids.queue, { unitId: 'a1', to: { point: point(0.008) } }],
        [ids.stepRemove, { unitId: 'a1', stepId: 'step-2' }],
        [ids.hold, { unitId: 'a1' }],
        [ids.resume, { unitId: 'a1' }],
        [ids.clear, { unitId: 'a1' }],
      ]
      for (const [capabilityId, input] of own) expect([capabilityId, (await run.invoke(capabilityId, input, screens.haulA)).ok]).toEqual([capabilityId, true])
      expect(run.unit('a1')).toMatchObject({ orders: [], lastAction: { verb: 'clear', by: 'Haulers A' } })
      const others: ReadonlyArray<readonly [string, unknown]> = [
        [ids.queue, { unitId: 'b1', to: { point: point(0.008) } }],
        [ids.stepRemove, { unitId: 'b1', stepId: 'step-1' }],
        [ids.hold, { unitId: 'b1' }],
        [ids.resume, { unitId: 'b1' }],
        [ids.clear, { unitId: 'b1' }],
      ]
      for (const [capabilityId, input] of others) {
        const refusal = await run.refusal(capabilityId, input, screens.haulA)
        expect([capabilityId, refusal.code, refusal.reason]).toEqual([capabilityId, 'unit_not_authorized', expect.stringContaining('Haulers B')])
      }
      expect(run.unit('b1').orders.map(step => [step.id, step.state])).toEqual([['step-1', 'active']])
    })
  })

  test('a group\'s queue holds the tasks its units can serve, and recommendations take only its own units', async () => {
    await withRun(async run => {
      const listedFor = async (taskId: string, actor: Parameters<OpenRun['query']>[2]) => {
        const answer = await recommendation(run, taskId, actor)
        return [...answer.proposal.units, ...answer.alternatives, ...answer.ineligible, ...answer.committed].map(entry => entry.unitId).sort()
      }
      expect(await listedFor('load', screens.haulA)).toEqual(['a1', 'a2'])
      expect(await listedFor('load', screens.haulB)).toEqual(['b1'])
      expect((await recommendation(run, 'pair', screens.guards)).proposal.units.map(entry => entry.unitId)).toEqual(['g1'])
      // Carriers carry nothing a load-less pair task holds; a guard carries no load; nobody's group serves a report.
      expect(await recommendRefusal(run, 'pair', screens.haulA)).toBe('task_not_in_role_queue: PAIR is not in the queue of Haulers A')
      expect(refusalCode(await recommendRefusal(run, 'load', screens.guards))).toBe('task_not_in_role_queue')
      expect((await run.refusal(ids.taskClose, { taskId: 'note' }, screens.haulA)).code).toBe('task_not_in_role_queue')
      // The declared role keeps its own queue beside the groups.
      expect(await run.invoke(ids.taskClose, { taskId: 'note' }, screens.desk)).toMatchObject({ ok: true })
    })
  })

  test('a unit created mid-run joins its group, which then commands it and queues what it serves', async () => {
    await withRun(async run => {
      const at = { type: 'Point', coordinates: lonLat(0.005) }
      expect((await run.refusal(ids.unitCreate, { type: types.roadCarrier, side: 'north', at }, screens.control)).reason).toBe('group_required: Name a group: haul-a, haul-b, guards, raid')
      expect((await run.refusal(ids.unitCreate, { type: types.roadCarrier, side: 'north', group: 'raid', at }, screens.control)).code).toBe('group_side_mismatch')
      expect(await run.invoke(ids.unitCreate, { type: types.roadCarrier, side: 'north', group: 'guards', at, label: 'Spare' }, screens.control)).toMatchObject({ ok: true })
      expect(run.object('unit:1')).toMatchObject({ label: 'Spare', packData: { group: 'guards', side: 'north' } })
      // Guards now hold a carrier too, so the carriage task is in their queue.
      expect((await recommendation(run, 'load', screens.guards)).proposal.units.map(entry => entry.unitId)).toEqual(['unit:1'])
      expect(await run.invoke(ids.hold, { unitId: 'unit:1' }, screens.guards)).toMatchObject({ ok: true })
    })
  })

  test('the generality test\'s renamed copy renames groups too: ids, labels, categories, sides and every unit\'s group', async () => {
    const renamed = renameDefinition(definitionOf(items, undefined, declared))
    const compiled = await compile(renamed.definition)
    const derived = compiled.roles?.filter(role => groupOfRoleId(role.id) !== undefined) ?? []
    expect(derived.map(role => role.id)).toEqual(groups.map(group => groupRoleId(renamed.id('group', group.id))))
    expect(derived.map(role => [role.label, role.category, role.sees])).toEqual(groups.map(group => [renamed.text(group.label), renamed.text(group.category), [renamed.id('side', group.side)]]))
    expect(JSON.stringify(derived)).not.toMatch(/haul|guard|raid|Haulers|Guards|Raiders/)
    expect(compiled.initialObjects.find(object => object.id === 'a1')?.packData).toMatchObject({ group: renamed.id('group', 'haul-a') })
  })

  test('without groups nothing changes: the shipped role Definitions compile to exactly their declared roles and units name no group', async () => {
    for (const definition of [border, civilRoles]) {
      const compiled = await compile(definition)
      expect<unknown>(compiled.roles).toEqual(definition.roles)
      expect(compiled.initialObjects.filter(object => object.packId === 'einsatz').some(object => 'group' in (object.packData as object))).toBe(false)
    }
  })
})
