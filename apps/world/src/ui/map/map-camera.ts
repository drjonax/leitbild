import type { Map as MapLibreMap } from 'maplibre-gl'

interface CameraInteractionHandler {
  readonly enable: () => void
  readonly disable: () => void
  readonly isEnabled: () => boolean
}

const cameraInteractionHandlers = (current: MapLibreMap): ReadonlyArray<{
  readonly name: string
  readonly handler: CameraInteractionHandler
}> => [
  { name: 'dragPan', handler: current.dragPan },
  { name: 'scrollZoom', handler: current.scrollZoom },
  { name: 'boxZoom', handler: current.boxZoom },
  { name: 'doubleClickZoom', handler: current.doubleClickZoom },
  { name: 'touchZoomRotate', handler: current.touchZoomRotate },
  { name: 'keyboard', handler: current.keyboard },
]

export const cameraInteractionDebug = (current: MapLibreMap | null): string => {
  if (!current) return 'handlers=no-map'
  return cameraInteractionHandlers(current)
    .map(({ name, handler }) => `${name}:${handler.isEnabled() ? 'on' : 'off'}`)
    .join(' ')
}

/** Camera gestures a Pack may switch off; every other gesture is always on. */
export interface CameraInteraction {
  readonly doubleClickZoom: boolean
  readonly keyboard: boolean
  readonly boxZoom: boolean
}

const switchedOn = (name: string, interaction: CameraInteraction): boolean =>
  name === 'doubleClickZoom' || name === 'keyboard' || name === 'boxZoom' ? interaction[name] : true

export const assertCameraInteractionContract = (current: MapLibreMap, interaction: CameraInteraction): void => {
  if (current.cooperativeGestures.isEnabled()) current.cooperativeGestures.disable()
  for (const { name, handler } of cameraInteractionHandlers(current)) {
    if (switchedOn(name, interaction) && !handler.isEnabled()) handler.enable()
    if (!switchedOn(name, interaction) && handler.isEnabled()) handler.disable()
  }
  const wrong = cameraInteractionHandlers(current)
    .filter(({ name, handler }) => handler.isEnabled() !== switchedOn(name, interaction))
    .map(({ name, handler }) => `${name} ${handler.isEnabled() ? 'on' : 'off'}`)
  if (wrong.length > 0) {
    throw new Error(`Map camera interactions do not match the contract: ${wrong.join(', ')}`)
  }
}

/** Pixels on each side of the map a camera keeps clear, as MapLibre's `padding`. */
export interface CameraPadding {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

/**
 * The zoom that shows a Starting View's whole extent inside the part of the
 * map no panel covers: the authored zoom describes the full map, so it is
 * lowered by how much narrower (or shorter) the clear part is. A map with no
 * size yet, or no clear part, keeps the authored zoom.
 */
export const startingZoomFor = (zoom: number, size: { readonly width: number; readonly height: number }, padding: CameraPadding): number => {
  const clearWidth = size.width - padding.left - padding.right
  const clearHeight = size.height - padding.top - padding.bottom
  if (size.width <= 0 || size.height <= 0 || clearWidth <= 0 || clearHeight <= 0) return zoom
  return zoom - Math.log2(Math.max(size.width / clearWidth, size.height / clearHeight))
}
