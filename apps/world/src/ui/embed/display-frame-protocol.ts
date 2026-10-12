// Messages between World's process display window and the display frames it
// shows. Both ends are World pages on one origin, so this stays World-internal:
// the window tells a frame whether it is shown, at what zoom and what Back
// returns to; the frame says how much room its content needs, passes on zoom
// gestures made inside it, and asks for a display to be opened after it.
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
  /** For a display the window opened from another: the title of that one, which Back returns to. */
  readonly back?: string
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

/**
 * Frame -> window: show this display of the same Plant in the window, after
 * this one (equipment a safety function chip or a banner label names, opened
 * from an answer's display); Back returns here.
 */
export interface DisplayFrameOpen {
  readonly type: 'world:display-open'
  /** The display's state, as its view publication carries it. */
  readonly state: string
  readonly title: string
}

/** Frame -> window: Back, to the display this one was opened from. */
export interface DisplayFrameBack {
  readonly type: 'world:display-back'
}

/** One pending proposal on the frame's Plant as the window's toolbar lists it (operation-presenter ProposalListEntry). */
export interface DisplayFrameProposalEntry {
  readonly id: string
  readonly item: string
  /** The components the item's own detail draws around: what the window opens to review it. */
  readonly components: ReadonlyArray<string>
  readonly action: string
  readonly proposer: 'AI' | 'OP'
  readonly minutes: number | null
  readonly text: string
}

/**
 * Frame -> window: the pending proposals on the Plant an operated display
 * reads with its samples, most time-critical first; none clears the window's
 * chip. The window installs no poller of its own: what its toolbar lists
 * comes from the display it shows.
 */
export interface DisplayFrameProposals {
  readonly type: 'world:display-proposals'
  readonly entries: ReadonlyArray<DisplayFrameProposalEntry>
}

export type DisplayFrameMessage = DisplayFrameReady | DisplayFrameExtent | DisplayFrameZoomRequest | DisplayFrameOpen | DisplayFrameBack | DisplayFrameProposals

/** The longest state and title an open request carries (a detail's state is far shorter). */
const OPEN_STATE_MAX = 4_096
const OPEN_TITLE_MAX = 120
/** The most proposals, components and characters a proposals message carries. */
const PROPOSALS_MAX = 64
const PROPOSAL_COMPONENTS_MAX = 16
const PROPOSAL_TEXT_MAX = 600

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

const hasKeys = (record: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(record).sort().join() === [...keys].sort().join()

const text = (value: unknown, most: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= most

export const parseDisplayFramePresentation = (value: unknown): DisplayFramePresentation | null => {
  if (!isRecord(value) || value.type !== 'world:display-frame') return null
  if (!hasKeys(value, ['type', 'shown', 'zoom']) && !hasKeys(value, ['type', 'shown', 'zoom', 'back'])) return null
  if (typeof value.shown !== 'boolean' || !finitePositive(value.zoom)) return null
  if (value.zoom < DISPLAY_ZOOM_MIN || value.zoom > DISPLAY_ZOOM_MAX) return null
  if ('back' in value && !text(value.back, OPEN_TITLE_MAX)) return null
  return { type: 'world:display-frame', shown: value.shown, zoom: value.zoom, ...(typeof value.back === 'string' ? { back: value.back } : {}) }
}

const parseProposalEntry = (value: unknown): DisplayFrameProposalEntry | null => {
  if (!isRecord(value) || !hasKeys(value, ['id', 'item', 'components', 'action', 'proposer', 'minutes', 'text'])) return null
  if (!text(value.id, OPEN_TITLE_MAX) || !text(value.item, OPEN_TITLE_MAX) || !text(value.action, PROPOSAL_TEXT_MAX) || !text(value.text, PROPOSAL_TEXT_MAX)) return null
  if (value.proposer !== 'AI' && value.proposer !== 'OP') return null
  if (value.minutes !== null && !(typeof value.minutes === 'number' && Number.isFinite(value.minutes) && value.minutes >= 0)) return null
  if (!Array.isArray(value.components) || value.components.length === 0 || value.components.length > PROPOSAL_COMPONENTS_MAX || !value.components.every(component => text(component, OPEN_TITLE_MAX))) return null
  return { id: value.id, item: value.item, components: value.components as ReadonlyArray<string>, action: value.action, proposer: value.proposer, minutes: value.minutes as number | null, text: value.text }
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
  if (value.type === 'world:display-open') {
    if (!hasKeys(value, ['type', 'state', 'title']) || !text(value.state, OPEN_STATE_MAX) || !text(value.title, OPEN_TITLE_MAX)) return null
    return { type: 'world:display-open', state: value.state, title: value.title }
  }
  if (value.type === 'world:display-back') return hasKeys(value, ['type']) ? { type: 'world:display-back' } : null
  if (value.type === 'world:display-proposals') {
    if (!hasKeys(value, ['type', 'entries']) || !Array.isArray(value.entries) || value.entries.length > PROPOSALS_MAX) return null
    const entries = value.entries.map(parseProposalEntry)
    return entries.every((entry): entry is DisplayFrameProposalEntry => entry !== null) ? { type: 'world:display-proposals', entries } : null
  }
  return null
}
