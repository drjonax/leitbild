import { statusDiskRadiusPx } from '../map-runtime/symbol-kit.ts'
import type { OperationalPointFeature, Position3 } from '../map-runtime/types.ts'

/**
 * Where a card attached to an object stands on the map. The card sits beside
 * the object's icon as drawn, fanned out where icons would overlap
 * (`point-declutter.ts`), not at its true coordinate, and it tries not to
 * cover the icons around it: four Halden units are drawn a few pixels apart,
 * and a card over a sibling hides the unit a reader compares it with. All
 * positions are in px from the map's top-left corner.
 */

export interface ScreenDisk {
  readonly x: number
  readonly y: number
  readonly radius: number
}

export interface ScreenRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface MapObjectAnchor {
  /** The object's icon disk as drawn. */
  readonly disk: ScreenDisk
  /** The other drawn icon disks in the clear part of the map, which the card should leave visible. */
  readonly others: ReadonlyArray<ScreenDisk>
  /** The part of the map no open panel covers (`cameraPadding`). */
  readonly clear: ScreenRect
}

/** What the map reports for an open card: where the map lies on the page, its clear part, and the card's icon when drawn there. */
export interface MapCardFrame {
  /** The map's top-left corner in the page (client px). */
  readonly origin: { readonly x: number; readonly y: number }
  /** The part of the map no open panel covers (`cameraPadding`). */
  readonly clear: ScreenRect
  /** Null when the icon is not drawn in the clear part of the map. */
  readonly anchor: MapObjectAnchor | null
}

export type ObjectCardSide = 'right' | 'left' | 'below' | 'above' | 'docked'

export interface ObjectCardPlacement {
  readonly left: number
  readonly top: number
  readonly side: ObjectCardSide
}

/** The gap between an icon's disk and its card, and between the card and the clear area's edge. */
export const objectCardGapPx = 12
const edgeMarginPx = 8

/**
 * The anchor of the object's card, or null when its icon is not drawn in the
 * clear part of the map: its category is hidden, or the camera left it
 * outside the view or under a panel.
 */
export const objectCardAnchor = (config: {
  readonly points: ReadonlyArray<OperationalPointFeature>
  readonly objectId: string
  readonly screenOf: (position: Position3) => { readonly x: number; readonly y: number }
  readonly clear: ScreenRect
}): MapObjectAnchor | null => {
  const { clear } = config
  const own = config.points.find(point => point.object.id === config.objectId)
  if (own === undefined) return null
  const diskOf = (point: OperationalPointFeature): ScreenDisk => {
    const screen = config.screenOf(point.position)
    return { x: screen.x, y: screen.y, radius: statusDiskRadiusPx(point.sizePx) }
  }
  const disk = diskOf(own)
  if (disk.x < clear.left || disk.x > clear.right || disk.y < clear.top || disk.y > clear.bottom) return null
  const others = config.points.flatMap(point => {
    if (point.object.id === config.objectId) return []
    const other = diskOf(point)
    const inside = other.x + other.radius >= clear.left && other.x - other.radius <= clear.right
      && other.y + other.radius >= clear.top && other.y - other.radius <= clear.bottom
    return inside ? [other] : []
  })
  return { disk, others, clear }
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))

const covers = (rect: ScreenRect, disk: ScreenDisk): boolean => {
  const dx = disk.x - clamp(disk.x, rect.left, rect.right)
  const dy = disk.y - clamp(disk.y, rect.top, rect.bottom)
  return dx * dx + dy * dy < disk.radius * disk.radius
}

/**
 * The card beside its icon: to the right, else the left, below or above,
 * the first side where it fits the clear area without covering another icon;
 * else the first side where it fits, covering the fewest; else pressed into
 * the clear area to the right, so it is never off screen.
 */
export const placeObjectCard = (
  anchor: MapObjectAnchor,
  size: { readonly width: number; readonly height: number },
): ObjectCardPlacement => {
  const { disk, clear } = anchor
  const { width, height } = size
  const reach = disk.radius + objectCardGapPx
  const lowLeft = clear.left + edgeMarginPx
  const highLeft = clear.right - edgeMarginPx - width
  const lowTop = clear.top + edgeMarginPx
  const highTop = clear.bottom - edgeMarginPx - height
  const alongY = clamp(disk.y - height / 2, lowTop, Math.max(lowTop, highTop))
  const alongX = clamp(disk.x - width / 2, lowLeft, Math.max(lowLeft, highLeft))
  const candidates: ReadonlyArray<ObjectCardPlacement> = [
    { side: 'right', left: disk.x + reach, top: alongY },
    { side: 'left', left: disk.x - reach - width, top: alongY },
    { side: 'below', left: alongX, top: disk.y + reach },
    { side: 'above', left: alongX, top: disk.y - reach - height },
  ]
  const judged = candidates.map(candidate => {
    const rect = { left: candidate.left, top: candidate.top, right: candidate.left + width, bottom: candidate.top + height }
    const fits = rect.left >= lowLeft && rect.right <= clear.right - edgeMarginPx && rect.top >= lowTop && rect.bottom <= clear.bottom - edgeMarginPx
    return { candidate, fits, covered: anchor.others.filter(other => covers(rect, other)).length }
  })
  const fitting = judged.filter(entry => entry.fits)
  const best = fitting.find(entry => entry.covered === 0)
    ?? fitting.reduce<(typeof fitting)[number] | null>((least, entry) => least === null || entry.covered < least.covered ? entry : least, null)
  if (best !== null) return best.candidate
  return {
    side: 'right',
    left: clamp(disk.x + reach, lowLeft, Math.max(lowLeft, highLeft)),
    top: alongY,
  }
}

/**
 * The card of an object whose icon is not in view, opened from the rail:
 * docked in the clear part of the map's top-left corner, below anything
 * already there (`occupied`, such as the scenario guidance).
 */
export const dockObjectCard = (
  clear: ScreenRect,
  occupied: ReadonlyArray<ScreenRect>,
  size: { readonly width: number; readonly height: number },
): ObjectCardPlacement => {
  const left = clear.left + objectCardGapPx
  const corner = clear.top + objectCardGapPx
  const below = occupied.filter(rect => rect.left < left + size.width && rect.right > left && rect.top < corner + size.height)
  const top = Math.max(corner, ...below.map(rect => rect.bottom + objectCardGapPx))
  return { side: 'docked', left, top }
}
