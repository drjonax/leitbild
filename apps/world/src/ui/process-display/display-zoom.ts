import { DISPLAY_ZOOM_MAX, DISPLAY_ZOOM_MIN } from '../embed/display-frame-protocol.ts'

// The zoom of one display in the process display window. The window paints a
// display's frame scaled; the frame lays out for its own (logical) size and
// says how much room its content needs. Zoom is per display: an overview and
// an answer's advice need different scales in the same window.

/** The steps − and + move between. */
export const DISPLAY_ZOOM_LADDER: ReadonlyArray<number> = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

/** The slider, in percent. */
export const DISPLAY_ZOOM_SLIDER = { min: 50, max: 200, step: 5 } as const

// Advice opens as large as fits, but never below 75 % (text gets too small)
// nor above 100 % (a default must not magnify). A generated display is drawn
// for its frame, so Fit never magnifies it either.
const ADVICE_DEFAULT_MIN = 0.75
const ADVICE_DEFAULT_MAX = 1
const GENERATED_FIT_MAX = 1
// Below this, two zooms are the same step (0.67 vs 2/3).
const SAME_ZOOM = 0.005

/** How a display uses its frame: advice is fixed in height and stretches in width; a generated display is drawn for the frame. */
export type DisplayKind = 'advice' | 'generated'

export interface DisplaySize {
  readonly width: number
  readonly height: number
}

/** The room a frame says its content needs, in the frame's own CSS pixels. */
export interface DisplayExtent {
  readonly kind: DisplayKind
  readonly minWidth: number
  readonly width: number
  readonly height: number
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const tidy = (zoom: number): number => Math.round(zoom * 1000) / 1000

// A fitted zoom rounds down, so the fitted display never overflows the body by a fraction of a pixel.
const tidyDown = (zoom: number): number => Math.floor(zoom * 1000 + 1e-6) / 1000

export const clampDisplayZoom = (zoom: number): number => tidy(clamp(zoom, DISPLAY_ZOOM_MIN, DISPLAY_ZOOM_MAX))

export const displayZoomPercent = (zoom: number): number => Math.round(zoom * 100)

export const isActualSize = (zoom: number): boolean => displayZoomPercent(zoom) === 100

/** The next ladder step above (in) or below (out) the current zoom; zooms between steps snap to the next one. */
export const steppedDisplayZoom = (zoom: number, direction: 'in' | 'out'): number => {
  if (direction === 'in') return DISPLAY_ZOOM_LADDER.find(step => step > zoom + SAME_ZOOM) ?? DISPLAY_ZOOM_MAX
  return [...DISPLAY_ZOOM_LADDER].reverse().find(step => step < zoom - SAME_ZOOM) ?? DISPLAY_ZOOM_MIN
}

export const displayZoomFromSlider = (percent: number): number => {
  const stepped = Math.round(percent / DISPLAY_ZOOM_SLIDER.step) * DISPLAY_ZOOM_SLIDER.step
  return clampDisplayZoom(stepped / 100)
}

export const sliderPercentForZoom = (zoom: number): number =>
  clamp(Math.round(zoom * 100 / DISPLAY_ZOOM_SLIDER.step) * DISPLAY_ZOOM_SLIDER.step, DISPLAY_ZOOM_SLIDER.min, DISPLAY_ZOOM_SLIDER.max)

/** What the window knows about a display when it sizes or fits it. */
export interface DisplayZoomContext {
  /** The display's own report wins over what its state says. */
  readonly kind: DisplayKind
  /** The window body; null until it is measured. */
  readonly body: DisplaySize | null
  /** The frame's latest report; null until it reports. */
  readonly extent: DisplayExtent | null
  /** The height the view was published with, used for advice until the frame reports its own. */
  readonly envelopeHeight: number
}

export interface DisplayFrameGeometry {
  /** The frame's own CSS size: what its page lays out for. */
  readonly frameWidth: number
  readonly frameHeight: number
  /** The room the scaled frame takes in the window body. */
  readonly boxWidth: number
  readonly boxHeight: number
  /** Advice scrolls in the window body; a generated display scrolls itself. */
  readonly bodyScrolls: boolean
}

const adviceHeight = (context: DisplayZoomContext): number => context.extent?.height ?? context.envelopeHeight

/**
 * Where a display's frame goes. A generated display gets the whole body at
 * its zoom (W/z x B/z, scaled by z), so it is drawn for exactly the room it
 * has. Advice keeps its height, stretches to the body width, and never gets
 * narrower than its content needs; the body scrolls what does not fit.
 */
export const displayFrameGeometry = (config: {
  readonly kind: DisplayKind
  readonly zoom: number
  readonly body: DisplaySize
  readonly extent: DisplayExtent | null
  readonly envelopeHeight: number
}): DisplayFrameGeometry => {
  const { zoom, body } = config
  if (config.kind === 'generated') {
    return { frameWidth: body.width / zoom, frameHeight: body.height / zoom, boxWidth: body.width, boxHeight: body.height, bodyScrolls: false }
  }
  const frameWidth = Math.max(body.width / zoom, config.extent?.minWidth ?? 0)
  const frameHeight = config.extent?.height ?? config.envelopeHeight
  return { frameWidth, frameHeight, boxWidth: frameWidth * zoom, boxHeight: frameHeight * zoom, bodyScrolls: true }
}

/**
 * The zoom at which a display fits the body. Advice: as large as shows its
 * whole height and its narrowest width (50-200 %). A generated display: the
 * zoom at which the room it reported needing fits, never above 100 %; its
 * layout changes with its size, so the caller allows one correction after the
 * next report and then stops, and tries 100 % first where the display is
 * already drawn whole.
 */
export const fitDisplayZoom = (context: DisplayZoomContext, zoom: number): number => {
  const body = context.body
  if (body === null) return clampDisplayZoom(zoom)
  if (context.kind === 'advice') {
    const byHeight = body.height / adviceHeight(context)
    const byWidth = context.extent === null ? Number.POSITIVE_INFINITY : body.width / context.extent.minWidth
    return clampDisplayZoom(tidyDown(Math.min(byHeight, byWidth)))
  }
  if (context.extent === null) return tidy(clamp(zoom, DISPLAY_ZOOM_MIN, GENERATED_FIT_MAX))
  // z * min((W/z)/w, (B/z)/h): the frame's needed room at its current zoom, fitted to the body.
  const scale = Math.min((body.width / zoom) / context.extent.width, (body.height / zoom) / context.extent.height)
  return tidy(clamp(tidyDown(zoom * scale), DISPLAY_ZOOM_MIN, GENERATED_FIT_MAX))
}

const adviceDefaultZoom = (context: DisplayZoomContext): number =>
  context.body === null ? ADVICE_DEFAULT_MAX : tidy(clamp(fitDisplayZoom(context, ADVICE_DEFAULT_MAX), ADVICE_DEFAULT_MIN, ADVICE_DEFAULT_MAX))

/** An operator's zoom of one display, as remembered. */
export interface StoredDisplayZoom {
  readonly zoom: number
  readonly fit: boolean
}

export interface DisplayZoomState {
  readonly zoom: number
  /** Fit is sticky: it refits when the body changes, until the operator zooms. */
  readonly fit: boolean
  /** Advice nobody zoomed yet follows its default: Fit held to 75-100 %. */
  readonly auto: boolean
  /** Refits still allowed on a generated display's extent reports since Fit last fitted it. */
  readonly corrections: number
}

export type DisplayZoomAction =
  | { readonly type: 'step'; readonly step: 'in' | 'out' | 'reset' }
  | { readonly type: 'set'; readonly zoom: number }
  | { readonly type: 'scale'; readonly factor: number }
  | { readonly type: 'toggle-fit' }
  /** The body was measured again; the context carries the new size. */
  | { readonly type: 'body' }
  /** The frame reported its extent; the context carries it. */
  | { readonly type: 'extent' }

const manual = (zoom: number): DisplayZoomState => ({ zoom: clampDisplayZoom(zoom), fit: false, auto: false, corrections: 0 })

// A generated display drawn whole reports exactly its frame, which says
// nothing about how much larger it could be drawn whole.
const drawnWholeAt = (context: DisplayZoomContext, zoom: number): boolean =>
  context.body !== null && context.extent !== null
  && context.extent.width <= context.body.width / zoom + 0.5
  && context.extent.height <= context.body.height / zoom + 0.5

const fitted = (context: DisplayZoomContext, zoom: number): DisplayZoomState => {
  // Drawn whole below 100 %, it may be drawn whole larger too: Fit tries 100 % and
  // takes the one correction its next report allows.
  if (context.kind === 'generated' && zoom < GENERATED_FIT_MAX - SAME_ZOOM && drawnWholeAt(context, zoom)) {
    return { zoom: GENERATED_FIT_MAX, fit: true, auto: false, corrections: 1 }
  }
  return {
    zoom: fitDisplayZoom(context, zoom),
    fit: true,
    auto: false,
    corrections: context.kind === 'generated' ? 1 : 0,
  }
}

/** A display's zoom when the window first shows it: what the operator left, else 100 % (generated) or the advice default. */
export const initialDisplayZoom = (context: DisplayZoomContext, stored: StoredDisplayZoom | null): DisplayZoomState => {
  if (stored !== null) return stored.fit ? fitted(context, stored.zoom) : manual(stored.zoom)
  if (context.kind === 'generated') return manual(1)
  return { zoom: adviceDefaultZoom(context), fit: false, auto: true, corrections: 0 }
}

export const reduceDisplayZoom = (
  state: DisplayZoomState,
  action: DisplayZoomAction,
  context: DisplayZoomContext,
): DisplayZoomState => {
  switch (action.type) {
    case 'step':
      return manual(action.step === 'reset' ? 1 : steppedDisplayZoom(state.zoom, action.step))
    case 'set':
      return manual(action.zoom)
    case 'scale':
      return Number.isFinite(action.factor) && action.factor > 0 ? manual(state.zoom * action.factor) : state
    case 'toggle-fit':
      return state.fit ? { ...state, fit: false, corrections: 0 } : fitted(context, state.zoom)
    case 'body':
      if (state.fit) return fitted(context, state.zoom)
      if (state.auto) return { ...state, zoom: adviceDefaultZoom(context) }
      return state
    case 'extent':
      if (state.fit && context.kind === 'advice') return { ...state, zoom: fitDisplayZoom(context, state.zoom) }
      if (state.fit && state.corrections > 0) return { ...state, zoom: fitDisplayZoom(context, state.zoom), corrections: state.corrections - 1 }
      if (state.auto) return { ...state, zoom: adviceDefaultZoom(context) }
      return state
  }
}

/** The zoom an operator chose is remembered; a default or a refit is not a choice. */
export const storedDisplayZoom = (state: DisplayZoomState): StoredDisplayZoom | null =>
  state.auto ? null : { zoom: state.zoom, fit: state.fit }

interface StorageLike {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

export interface DisplayZoomStore {
  readonly read: (key: string) => StoredDisplayZoom | null
  readonly write: (key: string, value: StoredDisplayZoom) => void
}

const parseStoredZoom = (value: unknown): StoredDisplayZoom => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('stored display zoom must be an object')
  const record = value as Record<string, unknown>
  if (typeof record.zoom !== 'number' || !Number.isFinite(record.zoom) || record.zoom < DISPLAY_ZOOM_MIN || record.zoom > DISPLAY_ZOOM_MAX) {
    throw new Error('stored display zoom is out of range')
  }
  if (typeof record.fit !== 'boolean') throw new Error('stored display zoom requires fit')
  return { zoom: record.zoom, fit: record.fit }
}

const parseZoomEntries = (raw: string, storageKey: string): ReadonlyArray<readonly [string, StoredDisplayZoom]> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`${storageKey} is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${storageKey} must be a list`)
  return parsed.map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') throw new Error(`${storageKey} has a malformed entry`)
    return [entry[0], parseStoredZoom(entry[1])] as const
  })
}

/**
 * Remembered zooms under one storage key, oldest first and bounded: writing
 * moves a display to the newest end and drops the oldest beyond the limit.
 * Unreadable storage fails visibly instead of being overwritten.
 */
export const createDisplayZoomStore = (config: {
  readonly storageKey: string
  readonly limit: number
  readonly storage: StorageLike | null
}): DisplayZoomStore => {
  const entries = (): ReadonlyArray<readonly [string, StoredDisplayZoom]> => {
    const raw = config.storage?.getItem(config.storageKey) ?? null
    return raw === null ? [] : parseZoomEntries(raw, config.storageKey)
  }
  return {
    read: key => entries().find(([candidate]) => candidate === key)?.[1] ?? null,
    write: (key, value) => {
      if (!config.storage) return
      const next = [...entries().filter(([candidate]) => candidate !== key), [key, { zoom: value.zoom, fit: value.fit }] as const]
      config.storage.setItem(config.storageKey, JSON.stringify(next.slice(Math.max(0, next.length - config.limit))))
    },
  }
}

const OVERVIEW_ZOOM_STORAGE_KEY = 'leitbild.processDisplayZoom.v1'
const OVERVIEW_ZOOM_LIMIT = 200
const ANSWER_ZOOM_STORAGE_KEY = 'leitbild.processDisplayAnswerZoom.v1'
const ANSWER_ZOOM_LIMIT = 100

/** Unit overview zoom outlives the session, per Run and Plant. */
export const overviewZoomStore = (
  storage: StorageLike | null = typeof localStorage === 'undefined' ? null : localStorage,
): DisplayZoomStore => createDisplayZoomStore({ storageKey: OVERVIEW_ZOOM_STORAGE_KEY, limit: OVERVIEW_ZOOM_LIMIT, storage })

/** An answer's display keeps its zoom for the browser session only, so chat keys do not pile up. */
export const answerZoomStore = (
  storage: StorageLike | null = typeof sessionStorage === 'undefined' ? null : sessionStorage,
): DisplayZoomStore => createDisplayZoomStore({ storageKey: ANSWER_ZOOM_STORAGE_KEY, limit: ANSWER_ZOOM_LIMIT, storage })

export const overviewZoomKey = (simulationRunId: string, plantId: string): string => `${simulationRunId}:${plantId}`
