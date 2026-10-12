import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { runRolesOf, viewerForRoleSet, type ScenarioRole } from '../src/core/model/index.ts'
import type { PackScenarioConfigContext, WorldPack } from '../src/core/packs/protocol.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { fixtureConfigSchema } from './fixtures/fixture-pack.ts'
import { compileWithRolePacks, declaredPresets, declaredRoles, openRunDefinition, roleAwareFixturePack, roleRunDefinition, sidedRunDefinition } from './fixtures/role-runs.ts'

/**
 * A role-aware fixture Pack deriving one operator role per crew its authority
 * names, listed under one category; a test may make it derive more.
 */
const derivingPack = (extra: ReadonlyArray<ScenarioRole> = [], seen: Array<PackScenarioConfigContext> = []): WorldPack => ({
  ...roleAwareFixturePack,
  scenarioRoles: (config, context) => {
    const crews = [...new Set((fixtureConfigSchema.parse(config).authority ?? []).flatMap(entry => entry.crews))]
    return [
      ...crews.map(crew => ({
        id: `crew:${crew}`,
        label: `Crew ${crew}`,
        class: 'operator' as const,
        category: 'Crews',
        ...(context.sides.length === 0 ? {} : { sees: [context.sides[0]!.id] }),
      })),
      ...extra,
    ]
  },
  validateScenarioConfig: (config, context) => {
    seen.push(context)
    return roleAwareFixturePack.validateScenarioConfig!(config, context)
  },
})

const withCrews = (definition: Record<string, unknown>, authority: ReadonlyArray<{ readonly roleId: string; readonly crews: ReadonlyArray<string> }>) => ({
  ...definition,
  packs: (definition.packs as ReadonlyArray<Record<string, unknown>>).map(selection => ({ ...selection, config: { authority } })),
})

const issueOf = async (compiling: Promise<unknown>): Promise<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }> => {
  const error = await compiling.then(() => null, (caught: unknown) => caught)
  if (!(error instanceof z.ZodError)) throw new Error(`expected a refused Scenario, got ${String(error)}`)
  return error.issues[0]!
}

describe('Roles a Pack derives at compile', () => {
  test('join the declared roles after them, carry their category, and are what the Pack\'s own config check reads', async () => {
    const contexts: PackScenarioConfigContext[] = []
    const source = withCrews(roleRunDefinition, [{ roleId: 'dispatch', crews: ['alpha', 'bravo'] }, { roleId: 'crew:alpha', crews: ['alpha'] }])
    const compiled = await compileWithRolePacks(source, [derivingPack([], contexts)])
    const derived: ReadonlyArray<ScenarioRole> = [
      { id: 'crew:alpha', label: 'Crew alpha', class: 'operator', category: 'Crews' },
      { id: 'crew:bravo', label: 'Crew bravo', class: 'operator', category: 'Crews' },
    ]
    expect(compiled.roles).toEqual([...declaredRoles, ...derived])
    // Presets stay declared, and the Run's declaration holds the derived roles like any other.
    expect(runRolesOf(compiled)).toEqual({ roles: [...declaredRoles, ...derived], presets: [...declaredPresets] })
    // Authority naming a derived role passes the Pack's check, which receives every role.
    expect(contexts.map(context => context.roles.map(role => role.id))).toEqual([['dispatch', 'field', 'control', 'crew:alpha', 'crew:bravo']])
    expect(viewerForRoleSet(runRolesOf(compiled)!, ['crew:bravo', 'dispatch'])).toEqual({ roleIds: ['dispatch', 'crew:bravo'], class: 'operator', sees: 'all' })
  })

  test('see what the Pack gives them in a sided Scenario, checked like declared roles', async () => {
    // Its authority names the crews alpha (Red) and bravo (Blue); this Pack lets each crew role see the first side.
    const sided = sidedRunDefinition('n1')
    const compiled = await compileWithRolePacks(sided, [derivingPack()])
    expect(compiled.roles?.slice(-2)).toEqual([
      { id: 'crew:alpha', label: 'Crew alpha', class: 'operator', category: 'Crews', sees: ['red'] },
      { id: 'crew:bravo', label: 'Crew bravo', class: 'operator', category: 'Crews', sees: ['red'] },
    ])
    // A derived role that breaks the rules of what a role sees is refused at its Pack's configuration, naming it.
    const unseen = await issueOf(compileWithRolePacks(sided, [derivingPack([{ id: 'crew:ghost', label: 'Ghost', class: 'operator' }])]))
    expect(unseen.path).toEqual(['packs', 0, 'config'])
    expect(unseen.message).toBe('derived_role_invalid: Pack fixture derives the role crew:ghost, which breaks a role rule: role_sees_required: role crew:ghost must declare what it sees in a Scenario with sides: \'all\' or the sides whose picture it plays')
    const elsewhere = await issueOf(compileWithRolePacks(sided, [derivingPack([{ id: 'crew:far', label: 'Far', class: 'operator', sees: ['green'] }])]))
    expect([elsewhere.path, elsewhere.message]).toEqual([['packs', 0, 'config'], 'derived_role_invalid: Pack fixture derives the role crew:far, which breaks a role rule: role crew:far sees an undeclared side: green'])
    const unsided = await issueOf(compileWithRolePacks(withCrews(roleRunDefinition, [{ roleId: 'dispatch', crews: ['alpha'] }]), [derivingPack([{ id: 'crew:red', label: 'Red', class: 'operator', sees: ['red'] }])]))
    expect([unsided.path, unsided.message]).toEqual([['packs', 0, 'config'], 'derived_role_invalid: Pack fixture derives the role crew:red, which breaks a role rule: role crew:red declares sees, but the Scenario declares no sides: without sides every role sees everything'])
  })

  test('refuse a role that is no valid role at all, at the Pack\'s configuration and naming it', async () => {
    const source = withCrews(roleRunDefinition, [{ roleId: 'dispatch', crews: ['alpha'] }])
    const blank = await issueOf(compileWithRolePacks(source, [derivingPack([{ id: 'crew:blank', label: ' ', class: 'operator' }])]))
    expect(blank.path).toEqual(['packs', 0, 'config'])
    expect(blank.message).toStartWith('derived_role_invalid: Pack fixture derives the role crew:blank, which is not a valid role: label ')
  })

  test('may be bundled by a declared preset, whose members compile checks against the declared and derived roles', async () => {
    const withPresets = (presets: ReadonlyArray<{ readonly id: string; readonly label: string; readonly roles: ReadonlyArray<string> }>) =>
      ({ ...withCrews(roleRunDefinition, [{ roleId: 'dispatch', crews: ['alpha', 'bravo'] }]), rolePresets: presets })
    const compiled = await compileWithRolePacks(withPresets([{ id: 'crews', label: 'All crews', roles: ['dispatch', 'crew:alpha', 'crew:bravo'] }]), [derivingPack()])
    expect(runRolesOf(compiled)?.presets).toEqual([{ id: 'crews', label: 'All crews', roles: ['dispatch', 'crew:alpha', 'crew:bravo'] }])
    // The Definition alone cannot know the derived roles, so it accepts a member it does not declare; compile refuses one nobody derives.
    const ghost = withPresets([{ id: 'crews', label: 'All crews', roles: ['crew:alpha', 'crew:ghost'] }])
    expect(scenarioDefinitionSchema.safeParse(ghost).success).toBe(true)
    const refused = await issueOf(compileWithRolePacks(ghost, [derivingPack()]))
    expect([refused.path, refused.message]).toEqual([['rolePresets', 0, 'roles', 1], 'role preset names an undeclared role: crew:ghost'])
    // A preset's id may not repeat a derived role's id either.
    const clash = await issueOf(compileWithRolePacks(withPresets([{ id: 'crew:alpha', label: 'Alpha', roles: ['dispatch'] }]), [derivingPack()]))
    expect([clash.path, clash.message]).toEqual([['rolePresets', 0, 'id'], 'role preset id is already a role id: crew:alpha'])
  })

  test('refuse a controller and an id already taken, at the Pack\'s configuration', async () => {
    const source = withCrews(roleRunDefinition, [{ roleId: 'dispatch', crews: ['alpha'] }])
    const controller = await issueOf(compileWithRolePacks(source, [derivingPack([{ id: 'crew:boss', label: 'Boss', class: 'controller' }])]))
    expect(controller.path).toEqual(['packs', 0, 'config'])
    expect(controller.message).toStartWith('derived_role_not_operator: Pack fixture derives the controller role crew:boss')
    const repeated = await issueOf(compileWithRolePacks(source, [derivingPack([{ id: 'field', label: 'Field again', class: 'operator' }])]))
    expect(repeated.path).toEqual(['packs', 0, 'config'])
    expect(repeated.message).toStartWith('duplicate_role: Pack fixture derives the role field')
    const twice = await issueOf(compileWithRolePacks(source, [derivingPack([{ id: 'crew:alpha', label: 'Crew alpha', class: 'operator' }])]))
    expect(twice.message).toStartWith('duplicate_role: Pack fixture derives the role crew:alpha')
  })

  test('are never asked for in open mode, which stays without roles', async () => {
    let asked = 0
    const pack: WorldPack = { ...roleAwareFixturePack, scenarioRoles: () => { asked += 1; return [{ id: 'crew:alpha', label: 'Crew alpha', class: 'operator' }] } }
    const compiled = await compileWithRolePacks(openRunDefinition, [pack])
    expect([asked, runRolesOf(compiled)]).toEqual([0, null])
  })

  test('a declared role may carry a category too, kept strictly', () => {
    const categorised = { ...roleRunDefinition, roles: [{ ...declaredRoles[0]!, category: 'Dispatch' }, ...declaredRoles.slice(1)] }
    expect(scenarioDefinitionSchema.parse(categorised).roles?.[0]).toEqual({ id: 'dispatch', label: 'Dispatcher', class: 'operator', category: 'Dispatch' })
    expect(scenarioDefinitionSchema.safeParse({ ...roleRunDefinition, roles: [{ ...declaredRoles[0]!, category: ' ' }] }).success).toBe(false)
  })
})
