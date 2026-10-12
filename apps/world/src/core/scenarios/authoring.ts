import { z } from 'zod'
import type { PackScenarioAuthoringField,WorldPack } from '../packs/protocol.ts'

const pathSegmentSchema = z.union([z.string().min(1), z.number().int().nonnegative()])
const pathSchema = z.array(pathSegmentSchema).min(1)

const controlSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), defaultValue: z.string().optional() }).strict(),
  z.object({
    kind: z.literal('number'),
    defaultValue: z.number().finite().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
  }).strict(),
  z.object({ kind: z.literal('boolean'), defaultValue: z.boolean().optional() }).strict(),
  z.object({
    kind: z.literal('select'),
    defaultValue: z.string().optional(),
    // Empty only when the options come from the Pack configuration (checked in validateAuthoring).
    options: z.array(z.object({ value: z.string(), label: z.string().min(1), compatibleWith: z.object({ path: pathSchema, values: z.array(z.string()) }).strict().optional() }).strict()),
    extendFromConfig: z.object({ path: pathSchema, valueKey: z.string(), labelKey: z.string() }).strict().optional(),
  }).strict(),
  z.object({ kind: z.literal('reference'), itemTypes: z.array(z.string()).optional(), defaultValue: z.string().optional() }).strict(),
  z.object({ kind: z.literal('string-list'), defaultValue: z.array(z.string()).optional() }).strict(),
])

const authoringFieldSchema = z.object({
  path: pathSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  control: controlSchema,
  optional: z.boolean().default(false),
}).strict()

const authoringItemTypeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  idPrefix: z.string().regex(/^[a-z][a-z0-9-]*$/),
  defaultItem: z.record(z.string(), z.unknown()),
  itemSchema: z.record(z.string(), z.unknown()),
  placement: z.object({
    kind: z.literal('point'),
    path: pathSchema,
    orReference: pathSchema.optional(),
  }).strict().optional(),
  fields: z.array(authoringFieldSchema),
  collections: z.array(z.object({
    path: pathSchema,
    label: z.string().min(1),
    defaultItem: z.record(z.string(), z.unknown()),
    fields: z.array(authoringFieldSchema),
    maxItems: z.number().int().min(1).max(256),
    keyframes: z.object({ timePath: pathSchema, increment: z.number().finite().positive() }).strict().optional(),
  }).strict()).default([]),
}).strict()

const scenarioAuthoringPackSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  categoryIds: z.array(z.string().min(1)),
  runtimes: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(['local', 'remote', 'replay']),
    clock: z.enum(['simulation', 'live', 'none']),
  }).strict()),
  defaultRuntimeId: z.string().min(1).optional(),
  recordingProfiles: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    defaultIntervalMs: z.number().int().positive(),
    minimumIntervalMs: z.number().int().positive(),
  }).strict()),
  configSchema: z.record(z.string(), z.unknown()),
  configDefaults: z.record(z.string(), z.unknown()),
  configFields: z.array(authoringFieldSchema),
  itemTypes: z.array(authoringItemTypeSchema),
}).strict()

export const scenarioAuthoringCatalogSchema = z.object({
  packs: z.array(scenarioAuthoringPackSchema),
  commands: z.array(z.object({
    id: z.string(), title: z.string(), description: z.string(), packId: z.string(), runtimeId: z.string(), inputSchema: z.record(z.string(), z.unknown()),
  }).strict()).default([]),
}).strict()

export type ScenarioAuthoringCatalog = z.infer<typeof scenarioAuthoringCatalogSchema>

export const scenarioAuthoringDetailSchema = z.enum(['catalog', 'authoring', 'editor'])
export type ScenarioAuthoringDetail = z.infer<typeof scenarioAuthoringDetailSchema>
export const scenarioAuthoringDescriptionSchema = z.object({
  detail: scenarioAuthoringDetailSchema,
  packs: z.array(z.record(z.string(), z.unknown())),
  commands: z.array(z.record(z.string(), z.unknown())),
}).strict()

// Broad discovery should not carry every JSON Schema and form control. Callers
// opt into machine-authoring data for selected Packs, while the interactive
// editor asks for the complete form description.
export const describeScenarioAuthoring = (
  catalog: ScenarioAuthoringCatalog,
  detail: ScenarioAuthoringDetail,
): unknown => {
  if (detail === 'editor') return { detail, ...catalog }
  return {
    detail,
    packs: catalog.packs.map(pack => ({
      id: pack.id,
      title: pack.title,
      description: pack.description,
      categoryIds: pack.categoryIds,
      runtimes: pack.runtimes,
      ...(pack.defaultRuntimeId === undefined ? {} : { defaultRuntimeId: pack.defaultRuntimeId }),
      recordingProfiles: pack.recordingProfiles,
      ...(detail === 'authoring' ? {
        configSchema: pack.configSchema,
        configDefaults: pack.configDefaults,
      } : {}),
      itemTypes: pack.itemTypes.map(itemType => ({
        id: itemType.id,
        label: itemType.label,
        description: itemType.description,
        idPrefix: itemType.idPrefix,
        ...(itemType.placement === undefined ? {} : { placement: itemType.placement }),
        ...(detail === 'authoring' ? {
          defaultItem: itemType.defaultItem,
          itemSchema: itemType.itemSchema,
        } : {}),
      })),
    })),
    commands: catalog.commands.map(command => ({
      id: command.id,
      title: command.title,
      description: command.description,
      packId: command.packId,
      runtimeId: command.runtimeId,
      ...(detail === 'authoring' ? { inputSchema: command.inputSchema } : {}),
    })),
  }
}

const valueAt = (root: Readonly<Record<string, unknown>>, path: ReadonlyArray<string | number>): unknown => {
  let value: unknown = root
  for (const segment of path) {
    if (typeof value !== 'object' || value === null || !(segment in value)) return undefined
    value = (value as Record<string | number, unknown>)[segment]
  }
  return value
}

const setValueAt = (root: Record<string, unknown>, path: ReadonlyArray<string | number>, next: unknown): void => {
  let value: unknown = root
  path.forEach((segment, index) => {
    if (value === null || typeof value !== 'object') throw new Error(`invalid authoring path at ${String(segment)}`)
    if (index === path.length - 1) {
      ;(value as Record<string | number, unknown>)[segment] = next
      return
    }
    const candidate = (value as Record<string | number, unknown>)[segment]
    if (candidate === null || typeof candidate !== 'object') {
      const following = path[index + 1]
      ;(value as Record<string | number, unknown>)[segment] = typeof following === 'number' ? [] : {}
    }
    value = (value as Record<string | number, unknown>)[segment]
  })
}

const validateAuthoring = (pack: WorldPack): void => {
  const itemTypeIds = new Set<string>()
  for (const itemType of pack.authoring?.itemTypes ?? []) {
    if (itemTypeIds.has(itemType.id)) throw new Error(`duplicate authoring item type ${itemType.id} in Pack ${pack.descriptor.id}`)
    itemTypeIds.add(itemType.id)
    if (!pack.scenario?.itemSchemas[itemType.id]) {
      throw new Error(`authoring item type ${itemType.id} in Pack ${pack.descriptor.id} has no Scenario item schema`)
    }
    const candidate: Record<string, unknown> = {
      pack: pack.descriptor.id,
      type: itemType.id,
      id: `${itemType.idPrefix}-authoring-check`,
      label: itemType.label,
      ...structuredClone(itemType.defaultItem),
    }
    if (itemType.placement) {
      setValueAt(candidate, itemType.placement.path, [0, 0])
    }
    // Probe schema shape only, just as the point above does. Required references
    // cannot have genuine defaults before the user selects an existing item.
    // These values never enter published defaults, a Scenario, or a Run.
    // A required choice among the Scenario's own configuration records, such
    // as a configured type, has no genuine default either: the author picks one.
    const itemSchema = z.toJSONSchema(pack.scenario.itemSchemas[itemType.id]!, { io: 'input' }) as SchemaNode
    for (const field of itemType.fields) {
      if (field.control.kind === 'select' && field.control.options.length === 0 && field.control.extendFromConfig === undefined)
        throw new Error(`authoring field ${field.path.join('.')} of ${itemType.id} in Pack ${pack.descriptor.id} offers no options and takes none from the configuration`)
      if (schemaAt(itemSchema, field.path).optional || valueAt(candidate, field.path) !== undefined) continue
      if (field.control.kind === 'reference') setValueAt(candidate, field.path, 'reference:authoring-check')
      else if (field.control.kind === 'select' && field.control.options.length === 0) setValueAt(candidate, field.path, 'authoring-check')
    }
    pack.scenario.itemSchemas[itemType.id]!.parse(candidate)
    for (const collection of itemType.collections ?? []) {
      if (!Array.isArray(valueAt(itemType.defaultItem, collection.path))) throw new Error('Authoring collection must refer to an array')
      const withRow = structuredClone(candidate)
      setValueAt(withRow, collection.path, [structuredClone(collection.defaultItem)])
      pack.scenario.itemSchemas[itemType.id]!.parse(withRow)
    }
  }
}

type SchemaNode = { properties?: Record<string, SchemaNode>; items?: SchemaNode; required?: string[]; minimum?: number; maximum?: number; enum?: string[]; default?: unknown }
const schemaAt = (schema: SchemaNode, path: ReadonlyArray<string | number>): { node: SchemaNode; optional: boolean } => {
  let node = schema
  let optional = false
  for (const segment of path) {
    optional ||= typeof segment === 'string' && !(node.required ?? []).includes(segment)
    node = (typeof segment === 'number' ? node.items : node.properties?.[segment]) ?? {}
  }
  return { node, optional }
}
const describeFields = (fields: ReadonlyArray<PackScenarioAuthoringField>, seed: Readonly<Record<string, unknown>>, schema: SchemaNode) => fields.map(field => {
  const { node, optional } = schemaAt(schema, field.path)
  const defaultValue = valueAt(seed, field.path) ?? node.default
  const control = { ...field.control, ...(defaultValue === undefined ? {} : { defaultValue }) }
  if (control.kind === 'number') {
    if (node.minimum !== undefined) control.min = node.minimum
    if (node.maximum !== undefined) control.max = node.maximum
  }
  if (control.kind === 'select' && node.enum) control.options = node.enum.map(value => ({ value, label: control.options.find(option => option.value === value)?.label ?? value }))
  return { ...field, optional, control }
})

export const scenarioAuthoringCatalogFor = (packs: ReadonlyArray<WorldPack>): ScenarioAuthoringCatalog => {
  for (const pack of packs) validateAuthoring(pack)
  const authoringPacks = packs.map(pack => ({
    id: pack.descriptor.id,
    title: pack.descriptor.name,
    description: pack.descriptor.description,
    categoryIds: pack.presentation.categories.map(category => category.id),
    runtimes: (pack.runtime?.runtimes ?? []).map(runtime => ({
      id: runtime.id,
      label: runtime.label,
      kind: runtime.kind,
      clock: runtime.clock,
    })),
    ...(pack.runtime?.defaultRuntimeId === undefined ? {} : { defaultRuntimeId: pack.runtime.defaultRuntimeId }),
    recordingProfiles: pack.recording?.profiles ?? [],
    configSchema: z.toJSONSchema(pack.scenarioConfigSchema, { unrepresentable: 'any' }),
    configDefaults: pack.scenarioConfigSchema.parse({}),
    configFields: describeFields(pack.authoring?.configFields ?? [], pack.scenarioConfigSchema.parse({}) as Record<string, unknown>, z.toJSONSchema(pack.scenarioConfigSchema) as SchemaNode),
    itemTypes: (pack.authoring?.itemTypes ?? []).map(itemType => ({
      ...itemType,
      itemSchema: z.toJSONSchema(pack.scenario!.itemSchemas[itemType.id]!, { io: 'input' }),
      fields: describeFields(itemType.fields, itemType.defaultItem, z.toJSONSchema(pack.scenario!.itemSchemas[itemType.id]!, { io: 'input' }) as SchemaNode),
      collections: (itemType.collections ?? []).map(collection => ({
        ...collection,
        fields: describeFields(collection.fields, collection.defaultItem, schemaAt(z.toJSONSchema(pack.scenario!.itemSchemas[itemType.id]!, { io: 'input' }) as SchemaNode, [...collection.path, 0]).node),
      })),
    })),
  }))
  const ids = new Set<string>()
  for (const pack of authoringPacks) {
    if (ids.has(pack.id)) throw new Error(`duplicate Scenario authoring Pack: ${pack.id}`)
    ids.add(pack.id)
  }
  return scenarioAuthoringCatalogSchema.parse({
    packs: authoringPacks.sort((left, right) => left.title.localeCompare(right.title)),
  })
}
