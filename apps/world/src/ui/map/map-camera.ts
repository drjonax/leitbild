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
