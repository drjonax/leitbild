import { describe, expect, test } from 'bun:test'
import { einsatzConfigSchema } from './config-validation.ts'
import { commandedTypes, commandsUnit, groupUnitTypesOf, inPicture, queuesAnyTask, queuesTask, type GroupUnitTypes, type PictureTask, type PictureTypes, type PictureUnit, type PictureViewer } from './picture.ts'

/**
 * The picture rules for role sets (§3.1, owner amendment A8): the union of
 * the held roles' pictures, each role commanding and queueing only within its
 * own. The engine agreement for Runs without sides lives in the Board's
 * `rules.test.ts`.
 */

describe('Picture rules for role sets', () => {
  /** Two sides' roles held at once, and a public site whose type one role's selector names. */
  const config = einsatzConfigSchema.parse({
    loadClasses: [{ id: 'c1', label: 'One', code: 'C1', noun: { one: 'item', other: 'items' } }],
    unitTypes: [
      { id: 'mover', label: 'Mover', icon: 'car', components: { mobility: { mode: 'road' }, carry: { capacity: 1, classes: ['c1'] } } },
      { id: 'watcher', label: 'Watcher', icon: 'eye', components: { mobility: { mode: 'road' }, sensor: { detectM: 1_000, identifyM: 500 } } },
      { id: 'depot', label: 'Depot', icon: 'warehouse', public: true, components: { receiving: { accepts: ['c1'], slots: 1, handoverS: 60, accepting: true } } },
    ],
    taskTemplates: [{ id: 'job', label: 'Job', icon: 'package' }, { id: 'order', label: 'Order', icon: 'flag', priorityClass: 'c1' }],
    authority: [
      { roleId: 'north-desk', units: { types: ['mover', 'depot'] }, taskTemplates: ['job'] },
      { roleId: 'south-lead', units: { types: ['watcher'] }, taskTemplates: ['order'] },
    ],
  })
  const northDesk = { id: 'north-desk', class: 'operator', sees: ['north'] } as const
  const southLead = { id: 'south-lead', class: 'operator', sees: ['south'] } as const
  const types: PictureTypes = {
    authority: config.authority,
    unitType: id => config.unitTypes.find(type => type.id === id)!,
    taskTemplate: id => config.taskTemplates.find(template => template.id === id)!,
  }
  /** These role sets play no group. */
  const noGroups: GroupUnitTypes = () => []
  const unit = (unitType: string, side?: string): PictureUnit => ({ type: 'unit', unitType, side })
  const task = (template: string, side: string): PictureTask => ({ type: 'task', template, side, loads: {}, pickedUp: {} })

  test('a role commands and queues only within its own sides, and no side role commands a public unit', () => {
    const both: PictureViewer = { class: 'operator', sees: ['north', 'south'], roles: [northDesk, southLead] }
    const commands = (record: PictureUnit) => [inPicture(types, both, record), commandsUnit(types, both, record)]
    const queues = (record: PictureTask) => [inPicture(types, both, record), queuesTask(types, both, record, noGroups)]
    expect(commands(unit('mover', 'north'))).toEqual([true, true])
    // The north role's selector names the type, but the unit is on a side only the south role sees.
    expect(commands(unit('mover', 'south'))).toEqual([true, false])
    expect(commands(unit('watcher', 'south'))).toEqual([true, true])
    expect(commands(unit('watcher', 'north'))).toEqual([true, false])
    // Every side sees the public depot; no side role commands it.
    expect(commands(unit('depot'))).toEqual([true, false])
    expect(queues(task('job', 'north'))).toEqual([true, true])
    expect(queues(task('job', 'south'))).toEqual([true, false])
    expect(queues(task('order', 'south'))).toEqual([true, true])
    expect(queues(task('order', 'north'))).toEqual([true, false])
  })

  test('a role seeing the truth commands what its selector names on any side, public units included; a controller commands its whole picture', () => {
    const truth: PictureViewer = { class: 'operator', sees: 'all', roles: [{ id: 'north-desk', class: 'operator' }] }
    expect([unit('mover', 'south'), unit('depot'), unit('watcher', 'north')].map(record => commandsUnit(types, truth, record))).toEqual([true, true, false])
    const controller: PictureViewer = { class: 'controller', sees: ['north'], roles: [{ id: 'white', class: 'controller', sees: ['north'] }] }
    expect([unit('watcher', 'north'), unit('watcher', 'south'), unit('depot')].map(record => commandsUnit(types, controller, record))).toEqual([true, false, true])
  })

  test('an operator role set draws on the types its roles select, a controller on every type', () => {
    const both: PictureViewer = { class: 'operator', sees: ['north', 'south'], roles: [northDesk, southLead] }
    expect(commandedTypes(types, both, config.unitTypes, noGroups).map(type => type.id)).toEqual(['mover', 'watcher', 'depot'])
    expect(commandedTypes(types, { class: 'operator', sees: 'all', roles: [southLead] }, config.unitTypes, noGroups).map(type => type.id)).toEqual(['watcher'])
    expect(commandedTypes(types, { class: 'controller', sees: 'all', roles: [] }, config.unitTypes, noGroups)).toHaveLength(3)
  })
})

describe('Picture rules for group roles', () => {
  /** A carrier, a server of one requirement and a sensor, none of them named by any authority entry. */
  const config = einsatzConfigSchema.parse({
    loadClasses: [{ id: 'c1', label: 'One', code: 'C1', noun: { one: 'item', other: 'items' } }, { id: 'c2', label: 'Two', code: 'C2', noun: { one: 'item', other: 'items' } }],
    unitTypes: [
      { id: 'mover', label: 'Mover', icon: 'car', components: { mobility: { mode: 'road' }, carry: { capacity: 1, classes: ['c1'] } } },
      { id: 'fixer', label: 'Fixer', icon: 'wrench', components: { mobility: { mode: 'road' }, service: { provides: ['fix'], onSceneS: 60 } } },
      { id: 'watcher', label: 'Watcher', icon: 'eye', components: { mobility: { mode: 'road' }, sensor: { detectM: 1_000, identifyM: 500 } } },
    ],
    taskTemplates: [
      { id: 'job', label: 'Job', icon: 'package' },
      { id: 'repair', label: 'Repair', icon: 'flag', priorityClass: 'c2', requires: [{ provides: 'fix', count: 1, label: { one: 'fixer', other: 'fixers' } }] },
      { id: 'note', label: 'Note', icon: 'flag', priorityClass: 'c2' },
    ],
  })
  const types: PictureTypes = {
    authority: config.authority,
    unitType: id => config.unitTypes.find(type => type.id === id)!,
    taskTemplate: id => config.taskTemplates.find(template => template.id === id)!,
  }
  const units: ReadonlyArray<PictureUnit> = [
    { type: 'unit', unitType: 'mover', side: 'north', group: 'haulers' },
    { type: 'unit', unitType: 'mover', side: 'north', group: 'haulers' },
    { type: 'unit', unitType: 'fixer', side: 'north', group: 'crew' },
    { type: 'unit', unitType: 'watcher', side: 'north', group: 'eyes' },
    { type: 'unit', unitType: 'mover', side: 'south', group: 'raiders' },
  ]
  const groups = groupUnitTypesOf(units)
  const role = (group: string, sees: ReadonlyArray<string>) => ({ id: `group:${group}`, class: 'operator', sees }) as const
  const viewerOf = (...roles: ReadonlyArray<ReturnType<typeof role>>): PictureViewer =>
    ({ class: 'operator', sees: [...new Set(roles.flatMap(entry => entry.sees))], roles })
  const task = (template: string, side: string, loads: Readonly<Record<string, number>> = {}, pickedUp: Readonly<Record<string, number>> = {}): PictureTask =>
    ({ type: 'task', template, side, loads, pickedUp })

  test('reads each group\'s unit types from its units, once each', () => {
    expect(['haulers', 'crew', 'eyes', 'raiders', 'nobody'].map(groups)).toEqual([['mover'], ['fixer'], ['watcher'], ['mover'], []])
  })

  test('a group\'s role commands exactly its group\'s units, within the side it sees', () => {
    const haulers = viewerOf(role('haulers', ['north']))
    expect(units.map(entry => commandsUnit(types, haulers, entry))).toEqual([true, true, false, false, false])
    // A group's role seeing both sides still commands its own group only.
    const wide = viewerOf(role('haulers', ['north', 'south']))
    expect(units.map(entry => commandsUnit(types, wide, entry))).toEqual([true, true, false, false, false])
    expect(units.map(entry => commandsUnit(types, viewerOf(role('crew', ['north']), role('raiders', ['south'])), entry))).toEqual([false, false, true, false, true])
  })

  test('a group\'s role queues the tasks of its picture its units can serve: a requirement they provide or load they carry', () => {
    const queues = (viewer: PictureViewer, record: PictureTask) => queuesTask(types, viewer, record, groups)
    const haulers = viewerOf(role('haulers', ['north']))
    const crew = viewerOf(role('crew', ['north']))
    const eyes = viewerOf(role('eyes', ['north']))
    // Load of a class the movers carry, still waiting or already picked up; none of a class they do not carry.
    expect([task('job', 'north', { c1: 1 }), task('job', 'north', {}, { c1: 1 }), task('job', 'north', { c2: 1 }), task('job', 'south', { c1: 1 })].map(record => queues(haulers, record))).toEqual([true, true, false, false])
    expect([task('repair', 'north'), task('repair', 'north', { c1: 1 }), task('note', 'north')].map(record => queues(crew, record))).toEqual([true, true, false])
    // Movers carry the load of a repair, though they cannot fix it.
    expect(queues(haulers, task('repair', 'north', { c1: 1 }))).toBe(true)
    // A sensor serves nothing, and a report with nothing to serve is in no group's queue.
    expect([task('job', 'north', { c1: 1 }), task('repair', 'north'), task('note', 'north')].map(record => queues(eyes, record))).toEqual([false, false, false])
  })

  test('a group\'s role draws on its units\' types, and its queue can hold tasks only when they serve or carry', () => {
    const typeIds = (viewer: PictureViewer) => commandedTypes(types, viewer, config.unitTypes, groups).map(type => type.id)
    expect(typeIds(viewerOf(role('haulers', ['north'])))).toEqual(['mover'])
    expect(typeIds(viewerOf(role('crew', ['north']), role('eyes', ['north'])))).toEqual(['fixer', 'watcher'])
    expect(typeIds(viewerOf(role('nobody', ['north'])))).toEqual([])
    const any = (viewer: PictureViewer) => queuesAnyTask(types, viewer, config.taskTemplates, groups)
    expect([any(viewerOf(role('haulers', ['north']))), any(viewerOf(role('crew', ['north']))), any(viewerOf(role('eyes', ['north']))), any(viewerOf(role('nobody', ['north'])))]).toEqual([true, true, false, false])
  })
})
