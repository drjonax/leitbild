// A minimal World Pack for core tests only. It gives the platform positioned
// objects, Scenario items, presentation and recording without borrowing any
// shipped Pack's domain. Its runtime lives in fixture-runtime.ts. In a Run
// that declares sides it keeps the role-aware obligations: each item writes
// the audience it declares, and the runtime answers within the stamped viewer.
// role-runs.ts opts it into role Runs.
import { z } from 'zod'
import {
  geoPointFromLonLat,
  idSchema,
  objectAudienceSchema,
  objectIdSchema,
  type AdapterId,
  type GeoJsonPoint,
  type IsoTimestamp,
  type ObjectId,
  type ObjectKind,
  type OperationalObject,
  type PackId,
  type RecordingProfileDescriptor,
} from '../../src/core/model/index.ts'
import { packField, packStatus } from '../../src/core/packs/presentation.ts'
import {
  createWorldPackDescriptor,
  type PackObjectPresentation,
  type PackScenarioAuthoringField,
  type PackScenarioConfigContext,
  type PackScenarioConfigIssue,
  type WorldPack,
} from '../../src/core/packs/protocol.ts'

export const fixturePackId = 'fixture'
export const fixtureRuntimeId = 'fixture.local'
export const fixtureAdapterId = 'adapter:fixture.local' as AdapterId
/** Units declare observations: speed and status, measured on an engine fed from a tank. */
export const fixtureObservationIds = {
  declarations: 'world.fixture.observation.declarations', read: 'world.fixture.observation.read', topology: 'world.fixture.observation.topology',
} as const

export const prioritySchema = z.enum(['low', 'normal', 'high'])

const lonLat = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)])
const common = {
  id: objectIdSchema,
  label: z.string().trim().min(1).max(120),
  position: lonLat.optional(),
  atObject: objectIdSchema.optional(),
  /** Whose picture the object belongs to in a Run that declares sides; written as given. */
  audience: objectAudienceSchema.optional(),
}
/** A crew is configuration vocabulary that authority names, never an instance id. */
const crewSchema = z.string().trim().min(1).max(40)
const unitItemSchema = z.object({ ...common, type: z.literal('unit'), speedMps: z.number().finite().positive().max(100), crew: crewSchema.optional() }).strict()
const siteItemSchema = z.object({ ...common, type: z.literal('site') }).strict()
const taskItemSchema = z.object({ ...common, type: z.literal('task'), priority: prioritySchema }).strict()

export const fixtureItemSchema = z.discriminatedUnion('type', [unitItemSchema, siteItemSchema, taskItemSchema])
  .superRefine((item, context) => {
    if ((item.position === undefined) === (item.atObject === undefined)) {
      context.addIssue({ code: 'custom', path: ['position'], message: 'Provide exactly one position or atObject' })
    }
  })
export type FixtureItem = z.infer<typeof fixtureItemSchema>

/** Pack-owned truth. A unit's motion is fully described by its canonical
 * position, its speed and the task it is heading to. */
export const fixtureDataSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('unit'), speedMps: z.number().finite().positive(), taskId: objectIdSchema.optional(), crew: crewSchema.optional() }).strict(),
  z.object({ type: z.literal('site') }).strict(),
  z.object({ type: z.literal('task'), priority: prioritySchema, unitId: objectIdSchema.optional() }).strict(),
])
export type FixtureData = z.infer<typeof fixtureDataSchema>
export const fixtureDataOf = (object: OperationalObject): FixtureData => fixtureDataSchema.parse(object.packData)

/** Declares query providers a Run must have, so core tests can exercise the
 * conditional dependency check (the runtime itself never invokes them), and
 * optionally which crews each operator role commands. Without authority every
 * operator role commands every unit it sees. */
export const fixtureConfigSchema = z.object({
  requiredQueries: z.array(z.string().min(1)).default([]),
  authority: z.array(z.object({ roleId: idSchema, crews: z.array(crewSchema).min(1) }).strict()).optional(),
}).strict()
export type FixtureConfig = z.infer<typeof fixtureConfigSchema>

/** Authority names declared operator roles only: a controller-class role commands everything already. */
export const fixtureConfigIssues = (raw: unknown, context: PackScenarioConfigContext): ReadonlyArray<PackScenarioConfigIssue> => {
  const config = fixtureConfigSchema.parse(raw)
  if (config.authority === undefined) return []
  if (context.roles.length === 0) return [{ path: ['authority'], code: 'authority_without_roles', message: 'authority_without_roles: authority needs a Scenario that declares roles' }]
  return config.authority.flatMap((entry, index) => {
    const role = context.roles.find(candidate => candidate.id === entry.roleId)
    if (!role) return [{ path: ['authority', index, 'roleId'], code: 'unknown_authority_role', message: `unknown_authority_role: no declared role ${entry.roleId}` }]
    if (role.class === 'controller') return [{ path: ['authority', index, 'roleId'], code: 'controller_authority', message: `controller_authority: controller role ${entry.roleId} commands every unit; give authority to operator roles only` }]
    return []
  })
}

const kindByType: Readonly<Record<FixtureItem['type'], ObjectKind>> = { unit: 'mobile_entity', site: 'facility', task: 'incident' }
const initialStatusByType: Readonly<Record<FixtureItem['type'], string>> = { unit: 'available', site: 'open', task: 'open' }

const placeOf = (item: FixtureItem, objectById: (id: ObjectId) => OperationalObject | undefined): GeoJsonPoint => {
  if (item.position) return geoPointFromLonLat(...item.position)
  const point = item.atObject ? objectById(item.atObject)?.spatial.position?.point : undefined
  if (!point) throw new Error(`Location reference ${item.atObject ?? '(missing)'} has no position`)
  return structuredClone(point)
}

/** One constructor for Scenario items and the create-item command. */
export const createFixtureObject = (raw: FixtureItem, context: {
  readonly at: IsoTimestamp
  readonly objectById: (id: ObjectId) => OperationalObject | undefined
}): OperationalObject => {
  const item = fixtureItemSchema.parse(raw)
  if (context.objectById(item.id)) throw new Error(`Object already exists: ${item.id}`)
  const point = placeOf(item, context.objectById)
  const packData: FixtureData = item.type === 'unit' ? { type: 'unit', speedMps: item.speedMps, ...(item.crew === undefined ? {} : { crew: item.crew }) }
    : item.type === 'task' ? { type: 'task', priority: item.priority }
      : { type: 'site' }
  return {
    id: item.id,
    kind: kindByType[item.type],
    packId: fixturePackId as PackId,
    label: item.label,
    lifecycle: 'active',
    revision: 0,
    spatial: { frame: { kind: 'wgs84' }, position: { point, observedAt: context.at, ...(item.type === 'unit' ? { speedMps: 0 } : {}) } },
    operational: { status: initialStatusByType[item.type], mode: 'simulated' },
    alerts: [],
    provenance: { source: 'simulator', adapterId: fixtureAdapterId, externalId: item.id },
    timestamps: { createdAt: context.at, updatedAt: context.at },
    packData,
    ...(item.audience === undefined ? {} : { audience: item.audience }),
  }
}

export const fixtureRecordingProfiles: ReadonlyArray<RecordingProfileDescriptor> = [{
  id: 'operations',
  title: 'Operations',
  description: 'Status of every fixture object and the speed of each unit.',
  defaultIntervalMs: 1_000,
  minimumIntervalMs: 1_000,
}]

const typeOf = (object: OperationalObject): FixtureData['type'] | null =>
  object.packId === fixturePackId ? fixtureDataOf(object).type : null

const presentFixtureObject = (object: OperationalObject): PackObjectPresentation => {
  const data = fixtureDataOf(object)
  const status = object.operational.status
  if (data.type === 'unit') return {
    categoryId: 'units', icon: 'square', color: '#2f6f9f', summary: status,
    status: packStatus(data.taskId ? 'working' : 'ready', status),
    fields: [packField('speed', 'Speed', `${data.speedMps} m/s`), packField('task', 'Task', data.taskId ?? 'None')],
  }
  if (data.type === 'task') return {
    categoryId: 'tasks', icon: 'triangle-alert', color: '#b45309', summary: data.priority,
    status: packStatus(data.unitId ? 'working' : 'idle', status),
    fields: [packField('priority', 'Priority', data.priority), packField('unit', 'Unit', data.unitId ?? 'None')],
  }
  return { categoryId: 'sites', icon: 'map-pin', color: '#475569', summary: object.label, status: packStatus('ready', status), fields: [] }
}

const placement = { kind: 'point' as const, path: ['position'], orReference: ['atObject'] }
const atObjectField: PackScenarioAuthoringField = { path: ['atObject'], label: 'At existing object (instead of coordinates)', control: { kind: 'reference' } }
const ownedByFixture = { pack: z.literal(fixturePackId) }

export const fixturePack: WorldPack = {
  descriptor: createWorldPackDescriptor({
    id: fixturePackId,
    version: '1.0.0',
    name: 'Fixture',
    description: 'Test-only units, sites and tasks: a unit assigned to a task moves to it in a straight line.',
    contributions: ['runtime', 'recording', 'scenario', 'presentation', 'observation'],
  }),
  runtime: {
    runtimes: [{ id: fixtureRuntimeId, version: '1.0.0', label: 'Local fixture runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: fixtureRuntimeId,
  },
  presentation: {
    categories: [
      { id: 'units', label: 'Units', emptyLabel: 'No units', matches: object => typeOf(object) === 'unit' },
      { id: 'tasks', label: 'Tasks', emptyLabel: 'No tasks', matches: object => typeOf(object) === 'task' },
      { id: 'sites', label: 'Sites', emptyLabel: 'No sites', matches: object => typeOf(object) === 'site' },
    ],
    presentObject: object => presentFixtureObject(object),
  },
  observation: {
    categories: ['units'], declarations: fixtureObservationIds.declarations, read: fixtureObservationIds.read,
    topology: { family: 'flow', capability: fixtureObservationIds.topology },
  },
  scenarioConfigSchema: fixtureConfigSchema,
  validateScenarioConfig: fixtureConfigIssues,
  recording: { profiles: fixtureRecordingProfiles },
  scenario: {
    referencedObjects: item => typeof item.atObject === 'string' ? [item.atObject] : [],
    itemSchemas: { unit: unitItemSchema.extend(ownedByFixture), site: siteItemSchema.extend(ownedByFixture), task: taskItemSchema.extend(ownedByFixture) },
    expandItem: (spec, context) => {
      const { pack: _pack, ...item } = spec
      return { objects: [createFixtureObject(fixtureItemSchema.parse(item), { at: context.at, objectById: context.objectById })] }
    },
  },
  authoring: {
    itemTypes: [{
      id: 'unit', label: 'Unit', idPrefix: 'unit', placement,
      description: 'A mobile object. Assigned to a task, it moves there in a straight line at its speed.',
      defaultItem: { speedMps: 15 },
      fields: [atObjectField, { path: ['speedMps'], label: 'Speed (m/s)', control: { kind: 'number', step: 0.5 } }],
    }, {
      id: 'site', label: 'Site', idPrefix: 'site', placement,
      description: 'A fixed place.',
      defaultItem: {},
      fields: [atObjectField],
    }, {
      id: 'task', label: 'Task', idPrefix: 'task', placement,
      description: 'A place a unit can be assigned to, with a priority.',
      defaultItem: { priority: 'normal' },
      fields: [atObjectField, { path: ['priority'], label: 'Priority', control: { kind: 'select', options: prioritySchema.options.map(value => ({ value, label: value })) } }],
    }],
  },
}
