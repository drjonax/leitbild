/**
 * Test-only renaming for the generality test: a copy of a Definition in which
 * every unit type, tag, task template, load class, property, enum value,
 * service, role and side id, every label and every lexicon word is replaced
 * by an opaque token. Icons, positions, instance ids and timings stay. The
 * renaming also maps what a Run of the original wrote into the copy's words,
 * so the two Runs can be compared record by record. Production code never
 * imports this file.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }
export type Namespace = 'type' | 'template' | 'class' | 'property' | 'value' | 'tag' | 'service' | 'role' | 'side'

export interface Renaming {
  readonly definition: unknown
  /** The token an original id of a namespace became. */
  readonly id: (namespace: Namespace, value: string) => string
  /** A text of the original Run in the copy's words: every original word in it replaced by its token. */
  readonly text: (value: string) => string
}

const isObject = (value: Json | undefined): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const objects = (value: Json | undefined): JsonObject[] => Array.isArray(value) ? value.filter(isObject) : []
const strings = (value: Json | undefined): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const inline = (word: string): string => word.charAt(0).toLowerCase() + word.slice(1)

export const renameDefinition = (original: unknown): Renaming => {
  const definition = structuredClone(original) as JsonObject
  const ids = new Map<string, string>()
  const words = new Map<string, string>()
  /** Lexicon words also appear with a lower-case first letter inside sentences. */
  const inlineWords = new Map<string, string>()
  const id = (namespace: Namespace, value: string): string => {
    const key = `${namespace}:${value}`
    if (!ids.has(key)) ids.set(key, `qi${String(ids.size + 1).padStart(3, '0')}`)
    return ids.get(key)!
  }
  const word = (value: string, lexicon = false): string => {
    if (!words.has(value)) words.set(value, `qw${String(words.size + 1).padStart(3, '0')}`)
    if (lexicon) inlineWords.set(inline(value), words.get(value)!)
    return words.get(value)!
  }
  const renameKeys = (record: Json | undefined, namespace: Namespace): Json | undefined =>
    isObject(record) ? Object.fromEntries(Object.entries(record).map(([key, value]) => [id(namespace, key), value])) : record
  const set = (target: JsonObject, key: string, rename: (value: string) => string): void => {
    const value = target[key]
    if (typeof value === 'string') target[key] = rename(value)
  }
  const setList = (target: JsonObject, key: string, rename: (value: string) => string): void => {
    if (Array.isArray(target[key])) target[key] = strings(target[key]).map(rename)
  }
  const renameLexicon = (lexicon: Json | undefined): void => {
    if (!isObject(lexicon)) return
    for (const key of Object.keys(lexicon)) set(lexicon, key, value => word(value, true))
  }
  const enumTypes = new Map<string, boolean>()

  // Roles and sides of the Definition itself.
  for (const role of objects(definition.roles)) {
    set(role, 'id', value => id('role', value))
    set(role, 'label', value => word(value))
    if (Array.isArray(role.sees)) setList(role, 'sees', value => id('side', value))
  }
  for (const side of objects(definition.sides)) {
    set(side, 'id', value => id('side', value))
    set(side, 'label', value => word(value))
  }
  for (const preset of objects(definition.rolePresets)) {
    set(preset, 'label', value => word(value))
    setList(preset, 'roles', value => id('role', value))
  }

  const pack = objects(definition.packs).find(entry => entry.id === 'einsatz')
  if (pack === undefined) throw new Error('The Definition holds no Einsatz Pack Selection')
  const config = pack.config as JsonObject
  renameLexicon(config.lexicon)
  if (isObject(config.hostility)) {
    config.hostility = Object.fromEntries(Object.entries(config.hostility).map(([side, hostile]) => [id('side', side), strings(hostile).map(value => id('side', value))]))
  }
  for (const loadClass of objects(config.loadClasses)) {
    set(loadClass, 'id', value => id('class', value))
    set(loadClass, 'label', value => word(value))
    set(loadClass, 'code', value => word(value))
    if (isObject(loadClass.noun)) for (const key of ['one', 'other']) set(loadClass.noun, key, value => word(value))
  }
  for (const type of objects(config.unitTypes)) {
    set(type, 'id', value => id('type', value))
    set(type, 'label', value => word(value))
    setList(type, 'tags', value => id('tag', value))
    renameLexicon(type.lexicon)
    const components = isObject(type.components) ? type.components : {}
    if (isObject(components.service)) setList(components.service, 'provides', value => id('service', value))
    if (isObject(components.carry)) setList(components.carry, 'classes', value => id('class', value))
    if (isObject(components.receiving)) setList(components.receiving, 'accepts', value => id('class', value))
    if (isObject(components.effector)) setList(components.effector, 'targets', value => id('tag', value))
    for (const property of objects(type.properties)) {
      enumTypes.set(String(property.id), property.kind === 'enum')
      set(property, 'id', value => id('property', value))
      set(property, 'label', value => word(value))
      set(property, 'unit', value => word(value))
      if (property.kind === 'enum') {
        for (const option of objects(property.values)) {
          set(option, 'id', value => id('value', value))
          set(option, 'label', value => word(value))
        }
        set(property, 'default', value => id('value', value))
      }
    }
    const orders = isObject(type.standingOrders) ? type.standingOrders : {}
    if (isObject(orders.onStepLost)) {
      set(orders.onStepLost, 'createTask', value => id('template', value))
      orders.onStepLost.perStep = renameKeys(orders.onStepLost.perStep, 'class') ?? null
    }
  }
  const renameProperties = (record: Json | undefined): Json | undefined => isObject(record)
    ? Object.fromEntries(Object.entries(record).map(([key, value]) => [id('property', key), enumTypes.get(key) === true && typeof value === 'string' ? id('value', value) : value]))
    : record
  for (const template of objects(config.taskTemplates)) {
    set(template, 'id', value => id('template', value))
    set(template, 'label', value => word(value))
    set(template, 'priorityClass', value => id('class', value))
    for (const requirement of objects(template.requires)) {
      set(requirement, 'provides', value => id('service', value))
      if (isObject(requirement.label)) for (const key of ['one', 'other']) set(requirement.label, key, value => word(value))
      for (const condition of objects(requirement.where)) {
        const property = String(condition.property)
        set(condition, 'property', value => id('property', value))
        if (enumTypes.get(property) === true) set(condition, 'equals', value => id('value', value))
      }
    }
  }
  for (const entry of objects(config.authority)) {
    set(entry, 'roleId', value => id('role', value))
    setList(entry, 'taskTemplates', value => id('template', value))
    if (isObject(entry.units)) {
      setList(entry.units, 'types', value => id('type', value))
      setList(entry.units, 'tags', value => id('tag', value))
    }
  }

  /** Items and cue inputs name types, templates, classes and properties, and carry labels. */
  const renameRecordInput = (input: JsonObject): void => {
    set(input, 'label', value => word(value))
    set(input, 'side', value => id('side', value))
    set(input, 'reason', value => word(value))
    if (input.type !== 'unit' && input.type !== 'task') set(input, 'type', value => id('type', value))
    set(input, 'unitType', value => id('type', value))
    set(input, 'template', value => id('template', value))
    if (input.loads !== undefined) input.loads = renameKeys(input.loads, 'class') ?? null
    if (input.properties !== undefined) input.properties = renameProperties(input.properties) ?? null
  }
  for (const item of objects(pack.items)) renameRecordInput(item)
  if (isObject(definition.timeline)) {
    for (const cue of objects(definition.timeline.cues)) {
      for (const action of objects(cue.actions)) if (isObject(action.input)) renameRecordInput(action.input)
    }
  }

  const replacements = [...[...words].map(([from, to]) => [from, to] as const), ...inlineWords]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([from, to]) => [new RegExp(`(?<![\\w-])${escape(from)}(?![\\w-])`, 'g'), to] as const)
  return {
    definition,
    id: (namespace, value) => {
      const token = ids.get(`${namespace}:${value}`)
      if (token === undefined) throw new Error(`${namespace} ${value} was not renamed`)
      return token
    },
    text: value => {
      const exact = words.get(value)
      if (exact !== undefined) return exact
      return replacements.reduce((text, [pattern, to]) => text.replace(pattern, to), value)
    },
  }
}
