import type { OperationalObject } from '../../core/model/index.ts'

/**
 * Objects stacked under one tap. Where several icons cover one spot (units
 * parked on a depot), the top one takes every tap and the others cannot be
 * reached. A surface that opts in (`chooseStacked`, for a panel taking map
 * targets) then shows a small chooser listing them, and the one chosen is
 * picked as if it had been tapped alone.
 */

/** The deck layers that draw an object's icon: what counts as lying under a tap. Labels do not. */
export const stackLayerIds = ['leitbild-object-symbols', 'leitbild-object-catalogue-symbols', 'leitbild-object-status-disks'] as const

/** How many objects a chooser lists at most. */
export const stackDepth = 8

/** The distinct objects of the deck's picks under a tap, top first; a pick of no object counts for nothing. */
export const stackedObjects = (picks: ReadonlyArray<{ readonly object?: unknown }>): ReadonlyArray<OperationalObject> => {
  const seen = new Set<string>()
  const objects: OperationalObject[] = []
  for (const pick of picks) {
    const feature = pick.object as { readonly object?: OperationalObject } | undefined
    const object = feature?.object
    if (object === undefined || seen.has(object.id)) continue
    seen.add(object.id)
    objects.push(object)
  }
  return objects
}
