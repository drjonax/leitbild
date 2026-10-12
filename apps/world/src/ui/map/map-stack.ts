import type { OperationalObject } from '../../core/model/index.ts'
import { statusDiskRadiusPx } from '../map-runtime/symbol-kit.ts'
import type { OperationalPointFeature, Position3 } from '../map-runtime/types.ts'

/**
 * Objects stacked under one tap. Where several icons cover one spot (units
 * parked on a depot), the top one takes every tap and the others cannot be
 * reached. A surface that picks map targets (`targetPicking`, while a panel
 * takes them) then shows a small chooser listing them, and the one chosen is
 * picked as if it had been tapped alone.
 */

export interface ScreenPoint { readonly x: number; readonly y: number }

/**
 * The object a tap on a stack picks without asking: while no controller is
 * highlighted, the one controller the stack holds, when it holds exactly
 * one, as a unit standing on its own task's marker. The tap then highlights
 * it as a tap on it alone would. With a controller highlighted, the tap
 * names a target, and the chooser asks which.
 */
export const stackPick = (
  stack: ReadonlyArray<OperationalObject>,
  controllerHighlighted: boolean,
  isController: (object: OperationalObject) => boolean,
): OperationalObject | null => {
  if (controllerHighlighted) return null
  const controllers = stack.filter(isController)
  return controllers.length === 1 ? controllers[0]! : null
}

/**
 * The objects whose icons lie under a point on the map's canvas itself, top
 * first (the last drawn): those whose coloured disk, which covers its glyph,
 * holds the point. No picking radius widens it, so icons that only stand
 * near each other never count as a stack; only icons overlapping where the
 * finger lands do. Labels do not count.
 */
export const objectsUnder = (
  points: ReadonlyArray<OperationalPointFeature>,
  screenOf: (position: Position3) => ScreenPoint,
  at: ScreenPoint,
): ReadonlyArray<OperationalObject> => {
  const seen = new Set<string>()
  const objects: OperationalObject[] = []
  for (const point of [...points].reverse()) {
    if (seen.has(point.object.id)) continue
    const screen = screenOf(point.position)
    if (Math.hypot(screen.x - at.x, screen.y - at.y) > statusDiskRadiusPx(point.sizePx)) continue
    seen.add(point.object.id)
    objects.push(point.object)
  }
  return objects
}
