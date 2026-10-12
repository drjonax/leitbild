import { z } from 'zod'
import type { RoutingAdapter } from '../../routing/protocol.ts'
import {
  compiledScenarioSchema,
  electricalPortFromObject,
  geoPointFromLonLat,
  type CompiledScenario,
  type ElectricalConnectionDefinition,
  type GeoJsonPoint,
  type IsoTimestamp,
  type ObjectId,
  type OperationalObject,
  type StartingView,
} from '../model/index.ts'
import type { PackScenarioItemContribution, PackScenarioItemSpec, WorldPack } from '../packs/protocol.ts'

import { scenarioDefinitionSchema, type ScenarioDefinition } from './definition.ts'
import { createScenarioRuntimeResolver } from './runtime-resolver.ts'
const pointFromLonLat = (value: readonly [number, number]): GeoJsonPoint =>
  geoPointFromLonLat(value[0], value[1])

const compileElectricalConnections = (
  specs: ScenarioDefinition['connections'],
  objects: ReadonlyMap<ObjectId, OperationalObject>,
): ReadonlyArray<ElectricalConnectionDefinition> => specs.map(spec => {
  const systemObject = objects.get(spec.system.objectId)
  if (!systemObject) throw new Error(`electrical connection ${spec.id} references unknown system object: ${spec.system.objectId}`)
  const networkObject = objects.get(spec.network.objectId)
  if (!networkObject) throw new Error(`electrical connection ${spec.id} references unknown network object: ${spec.network.objectId}`)
  const systemPort = electricalPortFromObject(systemObject, spec.system.portId)
  if (!systemPort) throw new Error(`electrical connection ${spec.id} references unknown system port: ${spec.system.objectId}:${spec.system.portId}`)
  if (systemPort.role !== 'system') throw new Error(`electrical connection ${spec.id} system endpoint is not a system port: ${spec.system.objectId}:${spec.system.portId}`)
  const networkPort = electricalPortFromObject(networkObject, spec.network.portId)
  if (!networkPort) throw new Error(`electrical connection ${spec.id} references unknown network port: ${spec.network.objectId}:${spec.network.portId}`)
  if (networkPort.role !== 'network') throw new Error(`electrical connection ${spec.id} network endpoint is not a network port: ${spec.network.objectId}:${spec.network.portId}`)
  if (Math.abs(systemPort.nominalKv - networkPort.nominalKv) > 0.001) {
    throw new Error(`electrical connection ${spec.id} voltage mismatch: ${systemPort.nominalKv} kV and ${networkPort.nominalKv} kV`)
  }
  return {
    ...spec,
    nominalKv: systemPort.nominalKv,
    maximumSystemExportMw: Math.min(systemPort.maximumExportMw, networkPort.maximumImportMw),
    maximumSystemImportMw: Math.min(systemPort.maximumImportMw, networkPort.maximumExportMw),
    ...(systemPort.inertiaSeconds === undefined ? {} : { systemInertiaSeconds: systemPort.inertiaSeconds }),
  }
})

const packFor = (packs: ReadonlyMap<string, WorldPack>, packId: string): WorldPack => {
  const pack = packs.get(packId)
  if (!pack) throw new Error(`scenario references unknown pack: ${packId}`)
  if (!pack.scenario) throw new Error(`pack ${packId} does not support scenario config expansion`)
  return pack
}

const registeredPackFor = (packs: ReadonlyMap<string, WorldPack>, packId: string): WorldPack => {
  const pack = packs.get(packId)
  if (!pack) throw new Error(`scenario references unknown pack: ${packId}`)
  return pack
}

const expandItem = async (
  spec: PackScenarioItemSpec,
  context: {
    readonly at: IsoTimestamp
    readonly packs: ReadonlyMap<string, WorldPack>
    readonly objectMap: Map<ObjectId, OperationalObject>
    readonly routing: RoutingAdapter
    readonly packConfigs: Record<string, unknown>
  },
): Promise<PackScenarioItemContribution> => {
  const pack = packFor(context.packs, spec.pack)
  const itemSchema = pack.scenario?.itemSchemas[spec.type]
  if (!itemSchema) throw new Error(`Pack ${pack.descriptor.id} does not declare Scenario item type: ${spec.type}`)
  const { context: _context, ...packSpec } = spec
  const parsedSpec = itemSchema.parse(packSpec) as PackScenarioItemSpec
  const expansionContext = {
    at: context.at,
    objects: [...context.objectMap.values()],
    objectById: (id: ObjectId) => context.objectMap.get(id),
    routing: context.routing,
    packConfigs: context.packConfigs,
  }
  return await pack.scenario!.expandItem(parsedSpec, expansionContext)
}


/** A role Run admits only Packs that accept the role obligations (WorldPack.roleAware). */
const assertRolePacks = (source: ScenarioDefinition, packs: ReadonlyArray<WorldPack>): void => {
  if (source.roles === undefined) return
  const issues = source.packs.flatMap((selection, index) => packs[index]?.roleAware === true ? [] : [{
    code: 'custom' as const,
    path: ['packs', index, 'id'],
    message: `role_run_pack_not_role_aware: Pack ${selection.id} is not role-aware, so it cannot run in a Scenario that declares roles`,
    params: { code: 'role_run_pack_not_role_aware' },
  }])
  if (issues.length > 0) throw new z.ZodError(issues)
}

const startingView = (view: ScenarioDefinition['view'], packs: ReadonlyArray<WorldPack>): StartingView => {
  const layers = [...new Set(['objects', 'routes', 'highlights', ...packs.flatMap(pack => pack.presentation.mapFeatureLayers ?? [])])]
  const overrides = new Map((view.rail?.sections ?? []).map(section => [section.categoryId, section]))
  const categories = packs.flatMap(pack => pack.presentation.categories)
  for (const id of overrides.keys()) {
    if (!categories.some(category => category.id === id)) throw new Error(`Starting View references inactive category: ${id}`)
  }
  return {
    map: { center: pointFromLonLat(view.map.center), zoom: view.map.zoom, layers: layers.filter(layer => !view.map.hiddenLayers.includes(layer)) },
    rail: { sections: categories.map(category => overrides.get(category.id) ?? { categoryId: category.id, visible: true, collapsed: false, visibleFields: [] }) },
  }
}

export const compileScenarioDefinition = async (
  rawSource: unknown,
  packs: ReadonlyArray<WorldPack>,
  options: { readonly routing: RoutingAdapter },
): Promise<CompiledScenario> => {
  const source = scenarioDefinitionSchema.parse(rawSource)
  const packsById = new Map(packs.map(pack => [pack.descriptor.id, pack]))
  const startsAt = source.world.startsAt as IsoTimestamp
  const activePacks = source.packs.map(selection => registeredPackFor(packsById, selection.id))
  assertRolePacks(source, activePacks)
  const packConfigs = Object.fromEntries(source.packs.map(selection => {
    const pack = registeredPackFor(packsById, selection.id)
    return [selection.id, pack.scenarioConfigSchema.parse(selection.config)]
  }))
  const objectMap = new Map<ObjectId, OperationalObject>()
  const initialObjects: OperationalObject[] = []
  const pending = source.packs.flatMap(selection => selection.items.map(item => ({ selection, item })))
  while (pending.length > 0) {
    const readyIndex = pending.findIndex(({ selection, item }) => (packsById.get(selection.id)?.scenario?.referencedObjects?.({ ...item, pack: selection.id }) ?? []).every(id => objectMap.has(id as ObjectId)))
    if (readyIndex < 0) throw new z.ZodError(pending.map(({ selection, item }) => ({ code: 'custom', path: ['packs', selection.id, 'items', item.id], message: `Unresolved or cyclic object references: ${(packsById.get(selection.id)?.scenario?.referencedObjects?.({ ...item, pack: selection.id }) ?? []).filter(id => !objectMap.has(id as ObjectId)).join(', ')}` })))
    const { selection, item } = pending.splice(readyIndex, 1)[0]!
      const contribution = await expandItem({ ...item, pack: selection.id } as PackScenarioItemSpec, {
        at: startsAt,
        packs: packsById,
        objectMap,
        routing: options.routing,
        packConfigs,
      })
      for (const expandedObject of contribution.objects) {
        if (objectMap.has(expandedObject.id)) throw new Error(`scenario ${source.id} has duplicate object id: ${expandedObject.id}`)
        const object = (item.context === undefined ? expandedObject : { ...expandedObject, context: item.context }) as OperationalObject
        objectMap.set(object.id, object)
        initialObjects.push(object)
      }
  }
  for (const pack of activePacks)
    pack.scenario?.validateInitialObjects?.(initialObjects, packConfigs[pack.descriptor.id], startsAt)
  // Connections describe the initial physical topology. Timeline expansion may
  // create or delete later objects, but it must not rewrite that topology.
  const connections = compileElectricalConnections(source.connections, objectMap)
  const timeline = source.timeline
  const compiled = compiledScenarioSchema.parse({
    id: source.id,
    schemaVersion: 1,
    title: source.title,
    ...(source.description === undefined ? {} : { description: source.description }),
    objectives: source.objectives,
    agentRestrictions: source.agentRestrictions,
    ...(source.roles === undefined ? {} : { roles: source.roles }),
    ...(source.rolePresets === undefined ? {} : { rolePresets: source.rolePresets }),
    packs: source.packs.map(selection => selection.id),
    packRuntimes: Object.fromEntries(source.packs.flatMap(selection =>
      selection.runtime === undefined ? [] : [[selection.id, selection.runtime]])),
    packConfigs,
    connections,
    world: {
      startsAt,
      environment: source.world.environment,
    },
    initialObjects,
    view: startingView(source.view, activePacks),
    recording: source.packs.flatMap(selection => selection.recording ? [{ packId: selection.id, ...selection.recording }] : []),
    ...(timeline === undefined ? {} : { timeline }),
  }) as CompiledScenario
  createScenarioRuntimeResolver({ packs }).resolve(compiled)
  return compiled
}
