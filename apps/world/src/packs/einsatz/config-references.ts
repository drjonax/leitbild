import { isMapSymbol } from '../../core/map-symbols/catalog.ts'
import { configIssue, listItem, repeatedValues, undeclaredValues, type ConfigCheck, type ConfigIssue, type ConfigPath } from './config-issues.ts'
import type { EinsatzConfig, TaskTemplate, UnitType } from './config-schema.ts'

/** Ids are unique in their list, and so are the members of every id list. */
export const uniqueIds: ConfigCheck = config => [
  ...repeatedValues(config.loadClasses.map(loadClass => loadClass.id), index => ['loadClasses', index, 'id'], 'Load class'),
  ...repeatedValues(config.loadClasses.map(loadClass => loadClass.code), index => ['loadClasses', index, 'code'], 'Load class code', 'duplicate_code'),
  ...repeatedValues(config.unitTypes.map(type => type.id), index => ['unitTypes', index, 'id'], 'Unit type'),
  ...config.unitTypes.flatMap((type, index) => uniqueWithinType(type, ['unitTypes', index])),
  ...repeatedValues(config.taskTemplates.map(template => template.id), index => ['taskTemplates', index, 'id'], 'Task template'),
  ...config.taskTemplates.flatMap((template, index) =>
    repeatedValues(template.requires.map(requirement => requirement.provides), entry => ['taskTemplates', index, 'requires', entry, 'provides'], 'Requirement')),
  ...repeatedValues(config.authority.map(entry => entry.roleId), index => ['authority', index, 'roleId'], 'Authority for role'),
  ...config.authority.flatMap((entry, index) => [
    ...('types' in entry.units ? repeatedValues(entry.units.types, listItem(['authority', index, 'units', 'types']), 'Unit type') : []),
    ...('tags' in entry.units ? repeatedValues(entry.units.tags, listItem(['authority', index, 'units', 'tags']), 'Tag') : []),
    ...repeatedValues(entry.taskTemplates, listItem(['authority', index, 'taskTemplates']), 'Task template'),
  ]),
  ...Object.entries(config.hostility).flatMap(([side, hostile]) => repeatedValues(hostile, listItem(['hostility', side]), 'Hostile side')),
  ...repeatedValues(config.groups.map(group => group.id), index => ['groups', index, 'id'], 'Group'),
]

const uniqueWithinType = (type: UnitType, at: ConfigPath): ConfigIssue[] => {
  const { service, carry, receiving, effector } = type.components
  return [
    ...repeatedValues(type.tags, listItem([...at, 'tags']), 'Tag'),
    ...repeatedValues(type.properties.map(property => property.id), index => [...at, 'properties', index, 'id'], 'Property'),
    ...type.properties.flatMap((property, index) => property.kind !== 'enum' ? []
      : repeatedValues(property.values.map(value => value.id), entry => [...at, 'properties', index, 'values', entry, 'id'], 'Value')),
    ...repeatedValues(service?.provides ?? [], listItem([...at, 'components', 'service', 'provides']), 'Service'),
    ...repeatedValues(carry?.classes ?? [], listItem([...at, 'components', 'carry', 'classes']), 'Load class'),
    ...repeatedValues(receiving?.accepts ?? [], listItem([...at, 'components', 'receiving', 'accepts']), 'Load class'),
    ...repeatedValues(effector?.targets ?? [], listItem([...at, 'components', 'effector', 'targets']), 'Target tag'),
  ]
}

const notDeclared = (what: string) => (value: string) => `${what} "${value}" is not declared`
const notTagged = (value: string) => `No unit type is tagged "${value}"`

/** Every load class, unit type, task template and tag a declaration names exists. */
export const knownReferences: ConfigCheck = config => {
  const loadClasses = new Set(config.loadClasses.map(loadClass => loadClass.id))
  const types = new Set(config.unitTypes.map(type => type.id))
  const templates = new Map(config.taskTemplates.map(template => [template.id, template]))
  const tags = new Set(config.unitTypes.flatMap(type => type.tags))
  return [
    ...config.unitTypes.flatMap((type, index) => {
      const at = ['unitTypes', index, 'components']
      const { carry, receiving, effector } = type.components
      return [
        ...undeclaredValues(carry?.classes ?? [], loadClasses, [...at, 'carry', 'classes'], 'unknown_load_class', notDeclared('Load class')),
        ...undeclaredValues(receiving?.accepts ?? [], loadClasses, [...at, 'receiving', 'accepts'], 'unknown_load_class', notDeclared('Load class')),
        ...undeclaredValues(effector?.targets ?? [], tags, [...at, 'effector', 'targets'], 'unknown_tag', notTagged),
        ...stepLossReferences(type, ['unitTypes', index, 'standingOrders', 'onStepLost'], loadClasses, templates),
      ]
    }),
    ...config.taskTemplates.flatMap((template, index) => template.priorityClass === undefined || loadClasses.has(template.priorityClass) ? []
      : [configIssue(['taskTemplates', index, 'priorityClass'], 'unknown_load_class', notDeclared('Load class')(template.priorityClass))]),
    ...config.authority.flatMap((entry, index) => [
      ...('types' in entry.units ? undeclaredValues(entry.units.types, types, ['authority', index, 'units', 'types'], 'unknown_unit_type', notDeclared('Unit type')) : []),
      ...('tags' in entry.units ? undeclaredValues(entry.units.tags, tags, ['authority', index, 'units', 'tags'], 'unknown_tag', notTagged) : []),
      ...undeclaredValues(entry.taskTemplates, new Set(templates.keys()), ['authority', index, 'taskTemplates'], 'unknown_task_template', notDeclared('Task template')),
    ]),
  ]
}

/** A step loss creates a task from a declared template; a template without a priority floor needs load to rank it. */
const stepLossReferences = (type: UnitType, at: ConfigPath, loadClasses: ReadonlySet<string>, templates: ReadonlyMap<string, TaskTemplate>): ConfigIssue[] => {
  const order = type.standingOrders?.onStepLost
  if (order === undefined) return []
  const template = templates.get(order.createTask)
  const loads = Object.keys(order.perStep)
  return [
    ...(template === undefined ? [configIssue([...at, 'createTask'], 'unknown_task_template', notDeclared('Task template')(order.createTask))] : []),
    ...loads.filter(id => !loadClasses.has(id)).map(id => configIssue([...at, 'perStep', id], 'unknown_load_class', notDeclared('Load class')(id))),
    ...(template !== undefined && template.priorityClass === undefined && loads.length === 0
      ? [configIssue([...at, 'perStep'], 'priority_class_required', `"${template.label}" has no priority floor, so each step lost must create load`)]
      : []),
  ]
}

const unknownIcon = (path: ConfigPath, icon: string): ConfigIssue[] =>
  isMapSymbol(icon) ? [] : [configIssue(path, 'unknown_icon', `Unknown icon "${icon}"; discover names with world.map.symbols`)]

/** Every icon is a map symbol catalogue id. */
export const catalogueIcons: ConfigCheck = (config: EinsatzConfig) => [
  ...config.unitTypes.flatMap((type, index) => unknownIcon(['unitTypes', index, 'icon'], type.icon)),
  ...config.taskTemplates.flatMap((template, index) => unknownIcon(['taskTemplates', index, 'icon'], template.icon)),
]

/** Hostility is between sides; whether the sides exist is checked against the Scenario. */
export const hostilityPairs: ConfigCheck = config => Object.entries(config.hostility).flatMap(([side, hostile]) =>
  hostile.flatMap((other, index) => other === side ? [configIssue(['hostility', side, index], 'self_hostility', `Side "${side}" cannot be hostile to itself`)] : []))
