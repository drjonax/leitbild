import { describe, expect, test } from 'bun:test'
import { validateWorldAssembly } from '../../core/packs/assembly.ts'
import { scenarioAuthoringCatalogFor } from '../../core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../../core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import { einsatzAuthoring } from './authoring.ts'
import { low, templates, types } from './fixtures/engine-harness.ts'
import { groupDeclaration, groupItems, placed } from './fixtures/groups-run.ts'
import { definitionOf, lonLat, taskItem, unitItem, type TaskItem, type UnitItem } from './fixtures/run-harness.ts'
import { einsatzPack } from './pack.ts'
import { createEinsatzPackRuntimeAdapter } from './runtime/adapter.ts'

/**
 * The Einsatz Pack as the World application assembly takes it: its scenario
 * item types are the Builder's, and the Builder offers a type, template or
 * group only from the Selection's configuration, never a built-in one.
 */

const fieldsOf = (itemTypeId: string) => {
  const itemType = scenarioAuthoringCatalogFor([einsatzPack]).packs[0]!.itemTypes.find(candidate => candidate.id === itemTypeId)!
  return new Map(itemType.fields.map(field => [field.path.join('.'), field]))
}
const fromConfig = (records: string) => ({ kind: 'select', options: [], extendFromConfig: { path: [records], valueKey: 'id', labelKey: 'label' } })

describe('Einsatz Pack', () => {
  test('the World assembly accepts it with its runtime adapter', () => {
    const assembly = validateWorldAssembly({ packs: [einsatzPack], runtimeAdapters: [createEinsatzPackRuntimeAdapter({ routing: createDirectRoutingAdapter() })] })
    expect(assembly.packs.map(pack => pack.descriptor.id)).toEqual([einsatzPack.descriptor.id])
  })

  test('the Builder places a unit and a task, choosing type, template and group from the configuration alone', () => {
    const catalog = scenarioAuthoringCatalogFor([einsatzPack])
    const itemTypes = catalog.packs[0]!.itemTypes
    expect(itemTypes.map(itemType => itemType.id).sort()).toEqual(Object.keys(einsatzPack.scenario!.itemSchemas).sort())
    for (const itemType of itemTypes) {
      expect(itemType.defaultItem).toEqual({})
      expect(itemType.placement).toEqual({ kind: 'point', path: ['position'] })
    }
    const unit = fieldsOf('unit')
    expect([...unit.keys()]).toEqual(['unitType', 'group', 'side'])
    expect(unit.get('unitType')).toMatchObject({ optional: false, control: fromConfig('unitTypes') })
    // A configuration without groups places units without one; compile requires one once it declares any.
    expect(unit.get('group')).toMatchObject({ optional: true, control: fromConfig('groups') })
    expect(unit.get('side')).toMatchObject({ optional: true, control: { kind: 'text' } })
    const task = fieldsOf('task')
    expect([...task.keys()]).toEqual(['template', 'side'])
    expect(task.get('template')).toMatchObject({ optional: false, control: fromConfig('taskTemplates') })
    expect(task.get('side')).toMatchObject({ optional: true, control: { kind: 'text' } })
  })

  test('a choice that offers no options and takes none from the configuration is refused', () => {
    const [unit, ...rest] = einsatzAuthoring.itemTypes
    const bare = { ...unit!, fields: unit!.fields.map(field => field.control.kind === 'select' ? { ...field, control: { kind: 'select' as const, options: [] } } : field) }
    expect(() => scenarioAuthoringCatalogFor([{ ...einsatzPack, authoring: { itemTypes: [bare, ...rest] } }]))
      .toThrow('offers no options and takes none from the configuration')
  })

  /** Compiles the sided group Definition with one more item the Builder placed, saying whether it compiled or how it was refused. */
  const placedOutcome = async (item: UnitItem | TaskItem): Promise<string> =>
    await compileScenarioDefinition(definitionOf([...groupItems, item], undefined, groupDeclaration), [einsatzPack], { routing: createDirectRoutingAdapter() })
      .then(compiled => compiled.initialObjects.some(object => object.id === item.id) ? 'compiled' : 'missing', (error: Error) => error.message)

  test('a unit the Builder places in a sided configuration with groups compiles with a declared group of its side, and is refused in the Pack\'s words otherwise', async () => {
    const outcome = (fields: Record<string, unknown>) => placedOutcome(placed(unitItem('x', types.roadCarrier, lonLat(0.005)), fields))
    expect(await outcome({ side: 'north', group: 'haul-b' })).toBe('compiled')
    expect(await outcome({ side: 'north' })).toBe('Einsatz item x: group_required: Name a group: haul-a, haul-b, guards, raid')
    expect(await outcome({ side: 'south', group: 'haul-b' })).toBe('Einsatz item x: group_side_mismatch: Group "haul-b" is on side "north", not "south"')
    expect(await outcome({ group: 'haul-b' })).toStartWith('Einsatz item x: side_required: ')
  })

  test('a task the Builder places in a sided Definition compiles with a declared side, and is refused in the Pack\'s words without one', async () => {
    const outcome = (fields: Record<string, unknown>) => placedOutcome(placed(taskItem('y', templates.load, lonLat(0.012), { [low]: 1 }), fields))
    expect(await outcome({ side: 'north' })).toBe('compiled')
    expect(await outcome({})).toBe('Einsatz item y: side_required: Name a side: north, south')
  })

  test('a placed unit type or task template the configuration no longer declares, as the Builder shows "Unavailable", is refused at compile in the Pack\'s words', async () => {
    expect(await placedOutcome(placed(unitItem('x', 'withdrawn-type', lonLat(0.005)), { side: 'north', group: 'haul-b' })))
      .toBe('Einsatz item x: unknown_unit_type: Unit type "withdrawn-type" is not declared')
    expect(await placedOutcome(placed(taskItem('y', 'withdrawn-template', lonLat(0.012)), { side: 'north' })))
      .toBe('Einsatz item y: unknown_task_template: Task template "withdrawn-template" is not declared')
  })
})
