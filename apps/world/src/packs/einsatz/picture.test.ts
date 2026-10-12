import { describe, expect, test } from 'bun:test'
import { einsatzConfigSchema } from './config-validation.ts'
import { commandedTypes, commandsUnit, inPicture, queuesTask, type PictureTask, type PictureTypes, type PictureUnit, type PictureViewer } from './picture.ts'

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
  const types: PictureTypes = { authority: config.authority, unitType: id => config.unitTypes.find(type => type.id === id)! }
  const unit = (unitType: string, side?: string): PictureUnit => ({ type: 'unit', unitType, side })
  const task = (template: string, side: string): PictureTask => ({ type: 'task', template, side })

  test('a role commands and queues only within its own sides, and no side role commands a public unit', () => {
    const both: PictureViewer = { class: 'operator', sees: ['north', 'south'], roles: [northDesk, southLead] }
    const commands = (record: PictureUnit) => [inPicture(types, both, record), commandsUnit(types, both, record)]
    const queues = (record: PictureTask) => [inPicture(types, both, record), queuesTask(types, both, record)]
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
    expect(commandedTypes(types, both, config.unitTypes).map(type => type.id)).toEqual(['mover', 'watcher', 'depot'])
    expect(commandedTypes(types, { class: 'operator', sees: 'all', roles: [southLead] }, config.unitTypes).map(type => type.id)).toEqual(['watcher'])
    expect(commandedTypes(types, { class: 'controller', sees: 'all', roles: [] }, config.unitTypes)).toHaveLength(3)
  })
})
