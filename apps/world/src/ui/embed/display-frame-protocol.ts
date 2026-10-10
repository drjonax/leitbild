// Messages between World's process display window and the display frames it
// shows. Both ends are World pages on one origin, so this stays World-internal:
// the window tells a frame whether it is shown and at what zoom; the frame says
// how much room its content needs and passes on zoom gestures made inside it.
// Each end accepts a message only from the window it expects (the frame's
// parent, or the frame's own contentWindow) on the same origin.

export const DISPLAY_ZOOM_MIN = 0.5
export const DISPLAY_ZOOM_MAX = 2

/** Window -> frame: the frame's current presentation; sent on its ready message and on every change. */
export interface DisplayFramePresentation {
  readonly type: 'world:display-frame'
  /** A hidden frame stops sampling; shown again it catches up before drawing on. */
  readonly shown: boolean
  /** The scale the window paints the frame at, so canvases can be drawn sharp for it. */
  readonly zoom: number
}

/** Frame -> window: listening; the window answers with the presentation. */
export interface DisplayFrameReady {
  readonly type: 'world:display-frame-ready'
}

/**
 * Frame -> window: the room the content needs, in the frame's own CSS pixels.
 * An advice display is fixed in height and stretches in width down to
 * `minWidth`; a generated display (overview, detail) is drawn for the frame and
 * needs `width` x `height` to show without scrolling.
 */
export interface DisplayFrameExtent {
  readonly type: 'world:display-extent'
  readonly kind: 'advice' | 'generated'
  readonly minWidth: number
  readonly width: number
  readonly height: number
}

/** Frame -> window: a zoom gesture made inside the frame (keys or Ctrl/pinch wheel). */
export type DisplayFrameZoomRequest =
  | { readonly type: 'world:display-zoom'; readonly step: 'in' | 'out' | 'reset' }
  | { readonly type: 'world:display-zoom'; readonly factor: number }

export type DisplayFrameMessage = DisplayFrameReady | DisplayFrameExtent | DisplayFrameZoomRequest

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

const hasKeys = (record: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(record).sort().join() === [...keys].sort().join()

export const parseDisplayFramePresentation = (value: unknown): DisplayFramePresentation | null => {
  if (!isRecord(value) || value.type !== 'world:display-frame' || !hasKeys(value, ['type', 'shown', 'zoom'])) return null
  if (typeof value.shown !== 'boolean' || !finitePositive(value.zoom)) return null
  if (value.zoom < DISPLAY_ZOOM_MIN || value.zoom > DISPLAY_ZOOM_MAX) return null
  return { type: 'world:display-frame', shown: value.shown, zoom: value.zoom }
}

export const parseDisplayFrameMessage = (value: unknown): DisplayFrameMessage | null => {
  if (!isRecord(value)) return null
  if (value.type === 'world:display-frame-ready') return hasKeys(value, ['type']) ? { type: 'world:display-frame-ready' } : null
  if (value.type === 'world:display-extent') {
    if (!hasKeys(value, ['type', 'kind', 'minWidth', 'width', 'height'])) return null
    if (value.kind !== 'advice' && value.kind !== 'generated') return null
    if (!finitePositive(value.minWidth) || !finitePositive(value.width) || !finitePositive(value.height)) return null
    return { type: 'world:display-extent', kind: value.kind, minWidth: value.minWidth, width: value.width, height: value.height }
  }
  if (value.type === 'world:display-zoom') {
    if (hasKeys(value, ['type', 'step']) && (value.step === 'in' || value.step === 'out' || value.step === 'reset')) {
      return { type: 'world:display-zoom', step: value.step }
    }
    if (hasKeys(value, ['type', 'factor']) && finitePositive(value.factor)) return { type: 'world:display-zoom', factor: value.factor }
    return null
  }
  return null
}
