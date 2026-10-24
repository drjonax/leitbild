import { capabilityIds,capabilityJsonSchema } from '../../simulation/capabilities.ts'
import type { PackRuntimeAdapter } from '../../simulation/protocol.ts'
import { observationShapes, type ObservationCapabilityKind } from '../observation/capabilities.ts'
import { quantityUnits } from '../observation/model.ts'
import type { WorldPack } from './protocol.ts'

export interface ValidatedWorldAssembly {
  readonly packs: ReadonlyArray<WorldPack>
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
}

const assertUnique = (ids: ReadonlyArray<string>, kind: string): void => {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate ${kind}: ${id}`)
    seen.add(id)
  }
}

const declaredContributionIds = (pack: WorldPack): ReadonlyArray<string> => [
  ...(pack.runtime ? ['runtime'] : []),
  ...(pack.recording ? ['recording'] : []),
  ...(pack.knowledge ? ['knowledge'] : []),
  ...(pack.referenceData ? ['reference-data'] : []),
  ...(pack.scenario || pack.authoring ? ['scenario'] : []),
  'presentation',
  ...(pack.creation ? ['creation'] : []),
  ...(pack.targeting ? ['targeting'] : []),
  ...(pack.mapAssignment ? ['map-assignment'] : []),
  ...(pack.interactions ? ['interactions'] : []),
  ...(pack.observation ? ['observation'] : []),
]

/** Refuses a Pack whose descriptor declares other contributions than it makes. */
export const assertContributionDescriptor = (pack: WorldPack): void => {
  const declared = pack.descriptor.contributions.map(contribution => contribution.kind).sort()
  const actual = [...declaredContributionIds(pack)].sort()
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new Error(`Pack ${pack.descriptor.id} contribution descriptor mismatch: declared ${declared.join(', ')}, actual ${actual.join(', ')}`)
  }
}

const capabilityContract = (capability: PackRuntimeAdapter['capabilities'][number]): string => JSON.stringify({
  id: capability.id,
  kind: capability.kind,
  title: capability.title,
  description: capability.description,
  risk: capability.risk,
  idempotent: capability.idempotent,
  schedulable: capability.schedulable ?? false,
  audience: capability.audience ?? null,
  inputSchema: capabilityJsonSchema(capability.input),
  outputSchema: capabilityJsonSchema(capability.output),
})

/** Refuses an observation contribution whose categories or Capabilities are not the core's (T25). */
const assertObservationContribution = (pack: WorldPack, adapters: ReadonlyArray<PackRuntimeAdapter>): void => {
  const observation = pack.observation
  const id = pack.descriptor.id
  const guidance = pack.knowledge?.guidance
  if (guidance !== undefined && (guidance.trim() === '' || guidance.length > 200 || guidance.includes('\n'))) {
    throw new Error(`Pack ${id} guidance must be one line of at most 200 characters`)
  }
  if (!observation) return
  const categories = new Set(pack.presentation.categories.map(category => category.id))
  for (const category of observation.categories) {
    if (!categories.has(category)) throw new Error(`Pack ${id} declares observations for unknown category ${category}`)
  }
  if (adapters.length === 0) throw new Error(`Pack ${id} declares observations without a Pack Runtime`)
  const named: ReadonlyArray<readonly [ObservationCapabilityKind, string]> = [
    ['declarations', observation.declarations], ['read', observation.read],
    ...(observation.topology ? [['topology', observation.topology.capability] as const] : []),
  ]
  for (const adapter of adapters) {
    for (const [kind, capabilityId] of named) {
      const capability = adapter.capabilities.find(candidate => candidate.id === capabilityId)
      const shape = observationShapes[kind]
      if (!capability) throw new Error(`Pack Runtime ${adapter.id} lacks observation ${kind} Capability ${capabilityId}`)
      if (capability.kind !== 'query' || capability.risk !== 'read' || capability.audience !== 'system') {
        throw new Error(`Observation Capability ${capabilityId} must be a system-audience read query`)
      }
      // The core's own schema and inspect rule instances, so the Run's parse is the core validation (defineObservationCapability).
      if (capability.input !== shape.input || capability.output !== shape.output || capability.inspectObjectIds !== shape.inspectObjectIds) {
        throw new Error(`Observation Capability ${capabilityId} differs from the core ${kind} shape`)
      }
    }
  }
}

const KEY = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/
const unitCodes = new Set<string>(Object.values(quantityUnits).flat())
/** The most columns a fleet row holds beside its label. */
export const MAX_MEMBER_COLUMNS = 8

/** Refuses member columns, groups and comparable roles that a fleet or compare view could not draw from. */
const assertMemberDeclarations = (pack: WorldPack): void => {
  const id = pack.descriptor.id
  for (const category of pack.presentation.categories) {
    const members = category.members
    if (members === undefined) continue
    const where = `Pack ${id} category ${category.id}`
    if (members.group !== undefined && members.group.label.trim() === '') throw new Error(`${where} declares a group without a label`)
    if (members.columns.length === 0 || members.columns.length > MAX_MEMBER_COLUMNS) throw new Error(`${where} declares ${members.columns.length} member columns; 1 to ${MAX_MEMBER_COLUMNS}`)
    assertUnique(members.columns.map(column => column.key), `member column in ${where}`)
    for (const column of members.columns) {
      if (!KEY.test(column.key)) throw new Error(`${where} member column key ${column.key} is not a lower-case key`)
      if (column.label.trim() === '' || column.label.length > 40) throw new Error(`${where} member column ${column.key} needs a label of at most 40 characters`)
      if (column.unit !== '' && !unitCodes.has(column.unit)) throw new Error(`${where} member column ${column.key} has unit ${column.unit}, not a core unit code`)
      if (column.tally !== undefined && column.unit !== '') throw new Error(`${where} member column ${column.key} tallies numbers; only word columns are tallied`)
    }
  }
  const comparable = pack.observation?.comparable ?? []
  const observed = new Set(pack.observation?.categories ?? [])
  assertUnique(comparable.map(role => role.id), `comparable role in Pack ${id}`)
  assertUnique(comparable.map(role => `${role.category} ${role.label.toLowerCase()}`), `comparable role label in Pack ${id}`)
  for (const role of comparable) {
    if (!KEY.test(role.id)) throw new Error(`Pack ${id} comparable role ${role.id} is not a lower-case key`)
    if (!observed.has(role.category)) throw new Error(`Pack ${id} comparable role ${role.id} is for ${role.category}, which declares no observations`)
    if (role.label.trim() === '' || role.label.length > 60) throw new Error(`Pack ${id} comparable role ${role.id} needs a label of at most 60 characters`)
    if (role.ref.trim() === '' || role.ref.includes('#')) throw new Error(`Pack ${id} comparable role ${role.id} needs a local ref, without its object id`)
  }
}

export const validateWorldAssembly = (config: {
  readonly packs: ReadonlyArray<WorldPack>
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
}): ValidatedWorldAssembly => {
  assertUnique(config.packs.map(pack => pack.descriptor.id), 'Pack id')
  assertUnique(config.runtimeAdapters.map(adapter => adapter.id), 'Pack Runtime id')

  const adaptersById = new Map(config.runtimeAdapters.map(adapter => [adapter.id, adapter]))
  const packsById = new Map(config.packs.map(pack => [pack.descriptor.id, pack]))
  for (const adapter of config.runtimeAdapters) {
    const pack = packsById.get(adapter.packId)
    if (!pack) throw new Error(`Pack Runtime ${adapter.id} references unknown Pack ${adapter.packId}`)
    if (!pack.runtime?.runtimes.some(runtime => runtime.id === adapter.id)) {
      throw new Error(`Pack Runtime ${adapter.id} is not declared by Pack ${adapter.packId}`)
    }
    assertUnique(adapter.capabilities.map(capability => capability.id), `capability in Pack Runtime ${adapter.id}`)
    assertUnique([...adapter.capabilities, ...adapter.workspaceCapabilities ?? []].map(capability => capability.id), `Capability across scopes in ${adapter.id}`)
    for (const capability of adapter.workspaceCapabilities ?? []) {
      if (!capability.title.trim() || !capability.description.trim()) throw new Error('Workspace Capability has incomplete metadata: ' + capability.id)
      capabilityJsonSchema(capability.input); capabilityJsonSchema(capability.output)
      if (!capability.id.startsWith(`world.${adapter.packId}.`)) throw new Error('Workspace Capability is not owned by its Pack: ' + capability.id)
    }
    for (const capability of adapter.capabilities) {
      if (capability.id.trim() === '' || capability.title.trim() === '' || capability.description.trim() === '') {
        throw new Error(`Pack Runtime ${adapter.id} has incomplete ${capability.kind} capability metadata`)
      }
      if (!capability.id.startsWith(`world.${adapter.packId}.`)) {
        throw new Error(`Pack Runtime ${adapter.id} exposes foreign Capability ${capability.id}; expected world.${adapter.packId}.*`)
      }
    }
    assertUnique(adapter.realtimeInputTypes ?? [], `realtime input in Pack Runtime ${adapter.id}`)
    const commandIds = new Set(capabilityIds(adapter.capabilities, 'command'))
    for (const commandId of Object.keys(adapter.commandEventHistory ?? {})) {
      if (!commandIds.has(commandId)) {
        throw new Error(`Pack Runtime ${adapter.id} configures history for undeclared command ${commandId}`)
      }
    }
  }

  const packs = config.packs.map(pack => {
    if (!pack.descriptor.description?.trim()) throw new Error(`Pack ${pack.descriptor.id} has no discovery description`)
    pack.scenarioConfigSchema.parse({})
    if (pack.runtime && !pack.runtime.runtimes.some(runtime => runtime.id === pack.runtime!.defaultRuntimeId)) {
      throw new Error(`Pack ${pack.descriptor.id} default runtime is not declared: ${pack.runtime.defaultRuntimeId}`)
    }
    const availableRuntimes = (pack.runtime?.runtimes ?? []).filter(runtime => adaptersById.has(runtime.id))
    for (const runtime of availableRuntimes) {
      const adapter = adaptersById.get(runtime.id)!
      if (adapter.packId !== pack.descriptor.id) {
        throw new Error(`Pack Runtime ${runtime.id} belongs to ${adapter.packId}, not ${pack.descriptor.id}`)
      }
      if (adapter.version !== runtime.version) {
        throw new Error(`Pack Runtime ${runtime.id} version mismatch: catalog ${runtime.version}, adapter ${adapter.version}`)
      }
      if (adapter.clock !== runtime.clock) {
        throw new Error(`Pack Runtime ${runtime.id} clock mismatch: catalog ${runtime.clock}, adapter ${adapter.clock}`)
      }
    }
    if (!pack.runtime || availableRuntimes.length === pack.runtime.runtimes.length) return pack
    const { runtime: _runtime, ...withoutRuntime } = pack
    if (availableRuntimes.length === 0) return withoutRuntime as WorldPack
    if (!availableRuntimes.some(runtime => runtime.id === pack.runtime!.defaultRuntimeId)) {
      throw new Error(`Pack ${pack.descriptor.id} default runtime is unavailable: ${pack.runtime.defaultRuntimeId}`)
    }
    return {
      ...withoutRuntime,
      runtime: { runtimes: availableRuntimes, defaultRuntimeId: pack.runtime.defaultRuntimeId },
    } as WorldPack
  })

  for (const pack of packs) assertContributionDescriptor(pack)
  for (const pack of packs) assertObservationContribution(pack, config.runtimeAdapters.filter(adapter => adapter.packId === pack.descriptor.id))
  for (const pack of packs) assertMemberDeclarations(pack)
  for (const pack of packs) {
    const scenarioItemTypeIds = Object.keys(pack.scenario?.itemSchemas ?? {}).sort()
    const authoringItemTypeIds = (pack.authoring?.itemTypes ?? []).map(item => item.id).sort()
    if (JSON.stringify(scenarioItemTypeIds) !== JSON.stringify(authoringItemTypeIds)) {
      throw new Error(`Pack ${pack.descriptor.id} Scenario item types and authoring item types differ: Scenario ${scenarioItemTypeIds.join(', ')}, authoring ${authoringItemTypeIds.join(', ')}`)
    }
  }
  assertUnique(packs.flatMap(pack => pack.presentation.categories.map(category => category.id)), 'object category id')
  assertUnique(packs.flatMap(pack => pack.creation?.createObjectTypes.map(type => type.id) ?? []), 'create object type id')
  assertUnique(packs.flatMap(pack => pack.interactions?.handlers.map(handler => handler.id) ?? []), 'interaction handler id')
  for (const pack of packs) {
    assertUnique(pack.recording?.profiles.map(profile => profile.id) ?? [], `recording profile id in Pack ${pack.descriptor.id}`)
    if (pack.recording && !pack.runtime) throw new Error(`Pack ${pack.descriptor.id} contributes recording profiles without a Pack Runtime`)
  }
  const categoryIds = new Set(packs.flatMap(pack => pack.presentation.categories.map(category => category.id)))
  for (const type of packs.flatMap(pack => pack.creation?.createObjectTypes ?? [])) {
    if (!categoryIds.has(type.categoryId)) {
      throw new Error(`create object type ${type.id} references unknown category ${type.categoryId}`)
    }
  }

  for (const [routeType, routesFor] of [
    ['capability', (adapter: PackRuntimeAdapter) => adapter.capabilities.map(capability => capability.id)],
    ['realtime input', (adapter: PackRuntimeAdapter) => adapter.realtimeInputTypes ?? []],
  ] as const) {
    const owners = new Map<string, string>()
    for (const adapter of config.runtimeAdapters) {
      for (const route of routesFor(adapter)) {
        const ownerPackId = owners.get(route)
        if (ownerPackId && ownerPackId !== adapter.packId) {
          throw new Error(`${routeType} route ${route} is claimed by Packs ${ownerPackId} and ${adapter.packId}`)
        }
        owners.set(route, adapter.packId)
      }
    }
  }

  const capabilityContracts = new Map<string, { readonly runtimeId: string; readonly contract: string }>()
  for (const adapter of config.runtimeAdapters) {
    for (const capability of adapter.capabilities) {
      const contract = capabilityContract(capability)
      const existing = capabilityContracts.get(capability.id)
      if (existing && existing.contract !== contract) {
        throw new Error(`Pack Runtimes ${existing.runtimeId} and ${adapter.id} disagree on Capability ${capability.id}`)
      }
      capabilityContracts.set(capability.id, { runtimeId: adapter.id, contract })
    }
  }

  return { packs, runtimeAdapters: config.runtimeAdapters }
}
