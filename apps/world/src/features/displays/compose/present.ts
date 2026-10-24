/** An object's presentation, read server-side for its words only (category, status, urgency, relations), never its summary or fields. */
import type { OperationalObject } from '../../../core/model/index.ts'
import type { PackCategoryMembers, PackObjectCategory, PackObjectPresentation } from '../../../core/packs/protocol.ts'
import type { SearchRun } from '../observation/search.ts'

const presented = new WeakMap<OperationalObject, PackObjectPresentation | null>()

/** Null for a Pack without categories, which keeps records rather than operational objects. */
export const presentedOf = (run: SearchRun, object: OperationalObject): PackObjectPresentation | null => {
  const known = presented.get(object)
  if (known !== undefined) return known
  const pack = run.packs.find(candidate => candidate.descriptor.id === object.packId)
  const made = pack === undefined || pack.presentation.categories.length === 0 ? null
    : pack.presentation.presentObject(object, { objects: run.objects, objectsForPack: id => run.objects.filter(candidate => candidate.packId === id), tier: 'summary' })
  presented.set(object, made)
  return made
}

/** A Pack's presentation category by id. */
export const categoryOf = (run: Pick<SearchRun, 'packs'>, packId: string, categoryId: string): PackObjectCategory | undefined =>
  run.packs.find(pack => pack.descriptor.id === packId)?.presentation.categories.find(category => category.id === categoryId)

/** How a category's members are grouped and listed, where its Pack declares it. */
export const membersDeclared = (run: Pick<SearchRun, 'packs'>, packId: string, categoryId: string): PackCategoryMembers | undefined =>
  categoryOf(run, packId, categoryId)?.members
