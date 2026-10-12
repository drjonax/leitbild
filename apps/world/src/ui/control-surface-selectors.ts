import type { OperationalObject } from '../core/model/index.ts'
import type { PackCreateObjectType, PackTargetContext } from '../core/packs/protocol.ts'
import type { ActivePackViews } from '../core/packs/active-views.ts'
import type { IconName } from './icons.ts'
import { isIconName } from './icons.ts'
import type { CategoryRow } from './types.ts'

export interface PlacementCursor {
  readonly icon: IconName
  readonly color: string
}

export const selectedControllerObjectFor = (
  objects: ReadonlyArray<OperationalObject>,
  selectedControllerId: string | null,
  pack: ActivePackViews,
  context: PackTargetContext,
): OperationalObject | null =>
  objects.find(object => object.id === selectedControllerId && pack.targeting?.isController(object, context) === true) ?? null

const compareOperationalObjectsForRail = (left: OperationalObject, right: OperationalObject): number => {
  const labelComparison = left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
  if (labelComparison !== 0) return labelComparison
  return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: 'base' })
}

export const categoryRowsFor = (
  objects: ReadonlyArray<OperationalObject>,
  pack: ActivePackViews,
): ReadonlyArray<CategoryRow> => {
  const objectsByPackId = new Map<string, OperationalObject[]>()
  const objectsByCategoryId = new Map<string, OperationalObject[]>()
  for (const object of objects) {
    const packObjects = objectsByPackId.get(object.packId) ?? []
    packObjects.push(object)
    objectsByPackId.set(object.packId, packObjects)
  }
  const objectsForPack = (packId: string): ReadonlyArray<OperationalObject> => objectsByPackId.get(packId) ?? []
  for (const object of objects) {
    const categoryId = pack.packForObject(object).presentation.presentObject(object, {
      objects,
      objectsForPack,
      tier: 'summary',
    }).categoryId
    const categoryObjects = objectsByCategoryId.get(categoryId) ?? []
    categoryObjects.push(object)
    objectsByCategoryId.set(categoryId, categoryObjects)
  }
  return pack.presentation.categories.map(category => {
    const createType = pack.creation?.createObjectTypes.find(type => type.categoryId === category.id)
    return {
      category,
      objects: [...(objectsByCategoryId.get(category.id) ?? [])].sort(compareOperationalObjectsForRail),
      ...(createType === undefined ? {} : { createType }),
    }
  })
}

export const placementCursorFor = (
  placementMode: PackCreateObjectType | null,
  pack: ActivePackViews,
): PlacementCursor | null => {
  if (!placementMode) return null
  if (!isIconName(placementMode.icon)) {
    throw new Error(`active Packs requested unknown create cursor icon: ${placementMode.icon}`)
  }
  return { icon: placementMode.icon, color: placementMode.color }
}
