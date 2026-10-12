import type { GeoJsonPoint, OperationalObject } from '../model/index.ts'
import type {
  PackCommandRequest,
  PackCreationGeometry,
  PackCreationContribution,
  PackMapFeature,
  PackPresentationContribution,
  PackMapFeatureQuery,
  PackMapTarget,
  PackObjectPresentationContext,
  PackTargetContext,
  PackTargetingContribution,
  PackSurfacePanelContribution,
  WorldPackView,
} from './protocol.ts'
import type { PackReferenceDatasetStyle } from './reference-style.ts'

export interface ActivePackViews {
  readonly packs: ReadonlyArray<WorldPackView>
  readonly packIds: ReadonlyArray<string>
  readonly presentation: PackPresentationContribution
  readonly creation?: PackCreationContribution
  readonly targeting?: PackTargetingContribution
  readonly referenceDatasetIds: ReadonlyArray<string>
  readonly referenceStyles: ReadonlyArray<PackReferenceDatasetStyle>
  readonly mapFeatureSourcePackIds: ReadonlyArray<string>
  readonly surfacePanels: ReadonlyArray<PackSurfacePanelContribution>
  readonly packForObject: (object: OperationalObject) => WorldPackView
  readonly defaultRuntimeIdFor: (packId: string) => string | undefined
}

const assertUniqueIds = (values: ReadonlyArray<{ readonly id: string }>, kind: string): void => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.id)) throw new Error(`duplicate ${kind}: ${value.id}`)
    seen.add(value.id)
  }
}

/** The presentation context without the map's selection, for a hook that does not follow it. */
const withoutSelection = (context: PackObjectPresentationContext): PackObjectPresentationContext => {
  if (context.selectedObjectId === undefined) return context
  const { selectedObjectId: _selected, ...rest } = context
  return rest
}

/** Each reference dataset a Pack declares is drawn by exactly one style from the same Pack. */
const referenceStylesFor = (pack: WorldPackView): ReadonlyArray<PackReferenceDatasetStyle> => {
  const packId = pack.descriptor.id
  const datasetIds = (pack.referenceData?.datasetIds ?? []).map(String)
  const styles = pack.presentation.referenceStyles ?? []
  for (const style of styles) {
    if (!datasetIds.includes(style.datasetId)) throw new Error(`Pack ${packId} styles undeclared reference dataset ${style.datasetId}`)
  }
  for (const datasetId of datasetIds) {
    const count = styles.filter(style => style.datasetId === datasetId).length
    if (count !== 1) throw new Error(`Pack ${packId} declares reference dataset ${datasetId} with ${count} styles; exactly one is required`)
  }
  return styles
}

export const createActivePackViews = (packs: ReadonlyArray<WorldPackView>): ActivePackViews => {
  if (packs.length === 0) throw new Error('active Pack views require at least one Pack')
  const packsById = new Map(packs.map(pack => [pack.descriptor.id, pack]))
  if (packsById.size !== packs.length) throw new Error('active Pack views contain duplicate Pack ids')

  const categories = packs.flatMap(pack => pack.presentation.categories)
  const createObjectTypes = packs.flatMap(pack => pack.creation?.createObjectTypes ?? [])
  assertUniqueIds(categories, 'object category')
  assertUniqueIds(createObjectTypes, 'create object type')

  const creationOwners = new Map<string, PackCreationContribution>()
  for (const pack of packs) {
    if (!pack.creation) continue
    for (const type of pack.creation.createObjectTypes) creationOwners.set(type.id, pack.creation)
  }

  const ownerForObject = (object: OperationalObject): WorldPackView => {
    const owner = packsById.get(object.packId)
    if (!owner) throw new Error(`object ${object.id} belongs to inactive Pack ${object.packId}`)
    return owner
  }

  const targetingFor = (object: OperationalObject, context: PackTargetContext): PackTargetingContribution | null => {
    const targeting = ownerForObject(object).targeting
    return targeting?.isController(object, context) === true ? targeting : null
  }

  const mapFeatureLayers = [...new Set(packs.flatMap(pack => pack.presentation.mapFeatureLayers ?? []))]
  const mapFeatureSourcePackIds = [...new Set(packs.flatMap(pack => {
    if (!pack.presentation.mapFeatures && !pack.presentation.mapFeatureQueries) return []
    return pack.presentation.mapFeatureSourcePackIds ?? [pack.descriptor.id]
  }))]
  const mapLayerGroups = packs.flatMap(pack => pack.presentation.mapLayerGroups ?? [])
  assertUniqueIds(mapLayerGroups, 'map layer group')
  const surfacePanels = packs.flatMap(pack => pack.ui?.surfacePanels ?? [])
  assertUniqueIds(surfacePanels, 'surface panel')
  // One panel takes the map's target clicks and one the routed keys, so neither is ever ambiguous.
  for (const hook of ['mapTargets', 'keymap'] as const) {
    const declaring = surfacePanels.filter(panel => panel[hook] === true)
    if (declaring.length > 1) throw new Error(`active Packs declare ${hook} on more than one surface panel: ${declaring.map(panel => panel.id).join(', ')}`)
  }

  const referenceStyles = packs.flatMap(referenceStylesFor)
  if (new Set(referenceStyles.map(style => style.datasetId)).size !== referenceStyles.length) {
    throw new Error('active Packs declare the same reference dataset more than once')
  }
  const referenceDatasetIds = referenceStyles.map(style => style.datasetId)
  const mapLegends = packs.flatMap(pack => pack.presentation.mapLegends ?? [])
  assertUniqueIds(mapLegends, 'map legend')
  const hasTargeting = packs.some(pack => pack.targeting !== undefined)
  const describesTargets = packs.some(pack => pack.targeting?.describeTarget !== undefined)
  const targetsPoints = packs.some(pack => pack.targeting?.pointTargets !== undefined)
  const mutesObjects = packs.some(pack => pack.targeting?.mutedOnMap !== undefined)

  return {
    packs,
    packIds: packs.map(pack => pack.descriptor.id),
    presentation: {
      categories,
      contextualFieldQueries: (object) =>
        packs.flatMap((pack) => pack.presentation.contextualFieldQueries?.(object) ?? []),
      presentObject: (object, context) => {
        const owner = ownerForObject(object)
        const presentation = owner.presentation.presentObject(object, context)
        if (!categories.some(category => category.id === presentation.categoryId)) {
          throw new Error(`Pack ${owner.descriptor.id} presented object ${object.id} in unknown category ${presentation.categoryId}`)
        }
        if (context.tier !== 'detail') return presentation
        const contextualFields = []
        const existingKeys = new Set(presentation.fields.map(field => field.key))
        for (const pack of packs) {
          for (const field of pack.presentation.contextualFields?.(object, context) ?? []) {
            if (existingKeys.has(field.key)) continue
            existingKeys.add(field.key)
            contextualFields.push(field)
          }
        }
        if (contextualFields.length === 0) return presentation
        return {
          ...presentation,
          fields: [...presentation.fields, ...contextualFields],
        }
      },
      // The selection reaches only the map features of a Pack that follows it, and never a query.
      mapFeatures: (context): ReadonlyArray<PackMapFeature> =>
        packs.flatMap(pack => pack.presentation.mapFeatures?.(pack.presentation.mapFeaturesFollowSelection === true ? context : withoutSelection(context)) ?? []),
      ...(packs.some(pack => pack.presentation.mapFeaturesFollowSelection === true) ? { mapFeaturesFollowSelection: true as const } : {}),
      mapFeatureLayers,
      mapFeatureSourcePackIds,
      mapFeatureQueries: (context): ReadonlyArray<PackMapFeatureQuery> =>
        packs.flatMap(pack => (pack.presentation.mapFeatureQueries?.(withoutSelection(context)) ?? []).map(request => {
          if (!request.capabilityId.startsWith(`world.${pack.descriptor.id}.`)) {
            throw new Error(`Pack ${pack.descriptor.id} map feature query uses foreign Capability ${request.capabilityId}`)
          }
          return request
        })),
      mapLayerGroups,
      mapLegends,
    },
    ...(createObjectTypes.length === 0
      ? {}
      : {
          creation: {
            createObjectTypes,
            defaultObjectLabel: (typeId, context): string => {
              const owner = creationOwners.get(typeId)
              if (!owner) throw new Error(`unknown create object type: ${typeId}`)
              return owner.defaultObjectLabel(typeId, context)
            },
            buildCreateObjectCommand: (
              typeId: string,
              label: string,
              geometry: PackCreationGeometry,
              parameters?: unknown,
            ): PackCommandRequest => {
              const owner = creationOwners.get(typeId)
              if (!owner) throw new Error(`unknown create object type: ${typeId}`)
              return owner.buildCreateObjectCommand(typeId, label, geometry, parameters)
            },
          },
        }),
    ...(hasTargeting
      ? {
          targeting: {
            isController: (object: OperationalObject, context: PackTargetContext) => targetingFor(object, context) !== null,
            ...(describesTargets
              ? {
                  describeTarget: (controller: OperationalObject, target: PackMapTarget, context: PackTargetContext) =>
                    targetingFor(controller, context)?.describeTarget?.(controller, target, context) ?? null,
                }
              : {}),
            ...(targetsPoints
              ? {
                  pointTargets: {
                    isTarget: (controller: OperationalObject, point: GeoJsonPoint, context: PackTargetContext) =>
                      targetingFor(controller, context)?.pointTargets?.isTarget(controller, point, context) ?? false,
                    buildSetTargetCommand: (controller: OperationalObject, point: GeoJsonPoint, context: PackTargetContext) => {
                      const pointTargets = targetingFor(controller, context)?.pointTargets
                      if (!pointTargets || !pointTargets.isTarget(controller, point, context)) {
                        throw new Error(`no active Pack can target a map point from ${controller.id}`)
                      }
                      return pointTargets.buildSetTargetCommand(controller, point, context)
                    },
                  },
                }
              : {}),
            ...(mutesObjects
              ? {
                  mutedOnMap: (object: OperationalObject, context: PackTargetContext) =>
                    ownerForObject(object).targeting?.mutedOnMap?.(object, context) ?? false,
                }
              : {}),
            isTarget: (controller: OperationalObject, candidate: OperationalObject, context: PackTargetContext) =>
              targetingFor(controller, context)?.isTarget(controller, candidate, context) ?? false,
            buildSetTargetCommand: (controller: OperationalObject, target: OperationalObject, context: PackTargetContext) => {
              const targeting = targetingFor(controller, context)
              if (!targeting || !targeting.isTarget(controller, target, context)) {
                throw new Error(`no active Pack can target ${target.id} from ${controller.id}`)
              }
              return targeting.buildSetTargetCommand(controller, target, context)
            },
            buildCancelTargetCommand: (controller: OperationalObject, context: PackTargetContext) => {
              const targeting = targetingFor(controller, context)
              if (!targeting) throw new Error(`no active Pack can cancel targeting for ${controller.id}`)
              return targeting.buildCancelTargetCommand(controller, context)
            },
          },
        }
      : {}),
    referenceDatasetIds,
    referenceStyles,
    mapFeatureSourcePackIds,
    surfacePanels,
    packForObject: ownerForObject,
    defaultRuntimeIdFor: packId => packsById.get(packId)?.runtime?.defaultRuntimeId,
  }
}
