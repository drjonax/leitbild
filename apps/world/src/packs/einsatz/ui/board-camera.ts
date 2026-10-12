import type { MapCover } from '../../../ui/surface-panel-contract.ts'
import { boardBottomClearancePx, boardTopClearancePx } from './board-layout.ts'

/**
 * Where the map shows an object beside the Board. The Board lies over the
 * map's right edge, and the role bar and the World status line over its top
 * and bottom, so an object can be on the map yet out of sight. The camera
 * centres in the part the Board leaves clear (its padding is the Board's
 * cover), so a point's place on screen follows from the camera's centre,
 * zoom and bearing in Web Mercator, at MapLibre's 512 px world tile.
 */

/** How far from the clear part's edges an object must lie to be seen whole: its icon and label. */
export const revealMarginPx = 32

export interface ScreenSize {
  readonly width: number
  readonly height: number
}

/** The camera a point is placed by: its centre, zoom and bearing, as the map reports them. */
export interface CameraView {
  readonly center: readonly [number, number]
  readonly zoom: number
  readonly bearing: number
}

const worldPx = (zoom: number): number => 512 * 2 ** zoom
/** A point in world px at a zoom: x eastwards from 180° W, y southwards from the Mercator top. */
const worldPoint = (point: readonly [number, number], zoom: number): { readonly x: number; readonly y: number } => {
  const size = worldPx(zoom)
  const latitude = Math.max(-85.0511, Math.min(85.0511, point[1]))
  const mercator = Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360))
  return { x: (point[0] + 180) / 360 * size, y: (1 - mercator / Math.PI) / 2 * size }
}

/** A point's place on a map of this size, whose camera is padded by `padding`, in px from its top left. */
export const screenPointOf = (camera: CameraView, size: ScreenSize, padding: MapCover, point: readonly [number, number]): { readonly x: number; readonly y: number } => {
  const world = worldPx(camera.zoom)
  const centre = worldPoint(camera.center, camera.zoom)
  const at = worldPoint(point, camera.zoom)
  // The nearer copy of the point across the antimeridian.
  const dx = ((at.x - centre.x) % world + world * 1.5) % world - world / 2
  const dy = at.y - centre.y
  const angle = -camera.bearing * Math.PI / 180
  return {
    x: padding.left + (size.width - padding.left - padding.right) / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: padding.top + (size.height - padding.top - padding.bottom) / 2 + dx * Math.sin(angle) + dy * Math.cos(angle),
  }
}

/** The part of a map of this size no panel, role bar or status line covers, less the margin an object needs, in px. */
export const clearPart = (size: ScreenSize, cover: MapCover): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } => ({
  left: cover.left + revealMarginPx,
  right: size.width - cover.right - revealMarginPx,
  top: Math.max(cover.top, boardTopClearancePx) + revealMarginPx,
  bottom: size.height - Math.max(cover.bottom, boardBottomClearancePx) - revealMarginPx,
})

/**
 * Whether the map shows a point beside the Board, whole: false under the
 * Board, under the bars, or off the map. A selection from the Board's lists
 * that is not shown so pans the map to it.
 */
export const shownBesideBoard = (camera: CameraView, size: ScreenSize, cover: MapCover, point: readonly [number, number]): boolean => {
  if (size.width <= 0 || size.height <= 0) throw new Error(`The map has no size: ${size.width} × ${size.height}`)
  const at = screenPointOf(camera, size, cover, point)
  const clear = clearPart(size, cover)
  return at.x >= clear.left && at.x <= clear.right && at.y >= clear.top && at.y <= clear.bottom
}
