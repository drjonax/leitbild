import type { PackScenarioAuthoringContribution, PackScenarioAuthoringField } from '../../core/packs/protocol.ts'

/**
 * What the Scenario Builder offers for an Einsatz Pack Selection: a unit and
 * a task placed on the map. Their type, template and group come only from
 * the Selection's own configuration, so no type is built in and a new item
 * has none until the author picks one. A unit's group applies once the
 * configuration declares groups, and a side once the Scenario declares sides
 * (a grouped unit takes its group's side); compile refuses an item that
 * leaves either out, or mixes them, in the Pack's own words (`group_required`,
 * `group_side_mismatch`, `side_required`). Base, property values and counted
 * load are edited in the item's JSON.
 */

const fromConfig = (path: string, label: string, records: 'unitTypes' | 'taskTemplates' | 'groups', description: string): PackScenarioAuthoringField => ({
  path: [path],
  label,
  description,
  control: { kind: 'select', options: [], extendFromConfig: { path: [records], valueKey: 'id', labelKey: 'label' } },
})

const side = (description: string): PackScenarioAuthoringField => ({
  path: ['side'],
  label: 'Side',
  description,
  control: { kind: 'text' },
})

export const einsatzAuthoring: PackScenarioAuthoringContribution = {
  itemTypes: [
    {
      id: 'unit',
      label: 'Unit',
      description: 'A unit of a type the configuration declares, in one of its declared groups once it declares any. A type that receives load and does not move makes it a site.',
      idPrefix: 'unit',
      defaultItem: {},
      placement: { kind: 'point', path: ['position'] },
      fields: [
        fromConfig('unitType', 'Unit type', 'unitTypes', 'One of the unit types this Selection\'s configuration declares.'),
        fromConfig('group', 'Group', 'groups', 'One of the groups this Selection\'s configuration declares; required once it declares any, unless the type is public.'),
        side('The id of the declared side this unit belongs to: its group\'s side. Required exactly when the Scenario declares sides, unless the type is public.'),
      ],
    },
    {
      id: 'task',
      label: 'Task',
      description: 'Located demand from a task template the configuration declares, with counted load per load class.',
      idPrefix: 'task',
      defaultItem: {},
      placement: { kind: 'point', path: ['position'] },
      fields: [
        fromConfig('template', 'Task template', 'taskTemplates', 'One of the task templates this Selection\'s configuration declares.'),
        side('The id of the declared side this task belongs to; required exactly when the Scenario declares sides.'),
      ],
    },
  ],
}
