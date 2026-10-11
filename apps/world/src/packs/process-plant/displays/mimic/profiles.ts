import type { DiagramProfile } from './layout/index.ts'
import { MIMIC_MIN_SCALE } from './mimic-model.ts'
import { openBridgeDevice } from './text-metrics.ts'

// How a kind of display draws its mimics: the HMI rules every drawing it
// shows keeps, apart from the room a particular display leaves. Profiles are
// data beside each other, so a new kind of display is a new profile, not a
// new drawing path.

export interface MimicProfile {
  /** Names the profile in refusals and in the drawing's identity. */
  readonly id: string
  /** The layout engine's rules: grid, pipes, alarm frames, density and the fit ladder. */
  readonly layout: Omit<DiagramProfile, 'maxWidth' | 'maxHeight'>
  /**
   * OpenBridge's readout stack size beside a device symbol: `small` rows set
   * text at 11.5 px, `regular` rows at 16 px. Vessel stacks, tags and stub
   * text are regular in both.
   */
  readonly readoutSize: 'small' | 'regular'
  /**
   * Valves on drawn lines: full symbols with their tag and readout stack, or
   * compact markers (the valve's OpenBridge icon on the pipe, no tag, and one
   * row that is empty unless the valve says something: its command disagrees,
   * its position is not known, or it stands between shut and open).
   */
  readonly valves: 'symbols' | 'markers'
  /**
   * Identical parallel equipment (same kind, same neighbours on both sides,
   * same ports): one symbol each, or one symbol for all of them that counts
   * how many are running ("RUN 1/2").
   */
  readonly parallel: 'each' | 'grouped'
  /**
   * Where the drawing stops, how a stub names its far ends: each by name
   * (grouped only when the list would be cut short), or alike ones once by
   * their shared label with a count ("from ACC ×4, CHG ×2, SI header").
   */
  readonly stubLabels: 'names' | 'groups'
  /**
   * A command an item does not follow: one row (CMD RUN), or CMD over the
   * command (narrower; each row then reserves only what the item's bindings
   * let it say).
   */
  readonly commands: 'inline' | 'stacked'
  /**
   * The smallest scale a viewer may show the drawing at. Below it the view
   * scrolls; the drawing itself only ever loses optional rows to fit.
   */
  readonly minScale: number
}

/** OpenBridge's drawing conventions: its 24 px grid, pipe outline and alarm frame. */
const openBridgeDrawing = {
  grid: 24,
  cell: 24,
  pipe: { outline: 6, cornerRadius: 8, crossingHalfGap: 5 },
  textClearance: 9,
  frameMargin: 1,
  flapHeight: openBridgeDevice.flapHeight,
  flapLabelPadding: openBridgeDevice.flapLabelInset,
} as const

/** Chat's ladder: stacks move below symbols before optional lines go. */
const chatFit = [
  { detail: 'full', text: 'right' },
  { detail: 'full', text: 'lanesBelow' },
  { detail: 'full', text: 'allBelow' },
  { detail: 'required', text: 'right' },
  { detail: 'required', text: 'lanesBelow' },
  { detail: 'required', text: 'allBelow' },
] as const

/**
 * The overview's ladder: stub labels move below their ends (nothing is lost),
 * then optional lines go, and only then do stacks leave their place right of
 * their symbols.
 */
const overviewFit = [
  { detail: 'full', text: 'right' },
  { detail: 'full', text: 'stubsBelow' },
  { detail: 'required', text: 'stubsBelow' },
  { detail: 'required', text: 'lanesBelow' },
  { detail: 'required', text: 'allBelow' },
] as const

/**
 * A mimic beside an answer in chat: about three symbols per loop and eight
 * shared, what an operator takes in at a glance, and enough for one service
 * to all four loops or a diesel to its pump. A narrow chat column may shrink
 * it until its smallest text (11.5 px rows) reads 11 px.
 */
export const chatMimicProfile: MimicProfile = {
  id: 'chat',
  layout: {
    ...openBridgeDrawing,
    limits: { symbols: 20, symbolsPerLane: 3, sharedSymbols: 8, lanes: 4, crossings: 6, crossingsOverBound: 6, bendsPerEdge: 3 },
    fit: chatFit,
  },
  readoutSize: 'small',
  valves: 'symbols',
  parallel: 'each',
  stubLabels: 'names',
  commands: 'inline',
  minScale: MIMIC_MIN_SCALE,
}

/**
 * A unit overview: the Plant's principal circuits on one screen at 1:1, read
 * at arm's length. Text is never below 12 px (tags) and 14 px (values), so
 * device rows are OpenBridge's regular size and the drawing is never scaled
 * down. Valves on the circuits are markers and parallel equipment is one
 * symbol, which keeps eight loops' worth of symbols legible. Some crossings
 * are forced by the Plant's structure (every loop meets the core and both
 * headers); a drawing may have at most two more than the structure forces.
 */
export const overviewMimicProfile: MimicProfile = {
  id: 'overview',
  layout: {
    ...openBridgeDrawing,
    limits: { symbols: 60, symbolsPerLane: 6, sharedSymbols: 24, lanes: 8, crossings: 40, crossingsOverBound: 2, bendsPerEdge: 3 },
    fit: overviewFit,
  },
  readoutSize: 'regular',
  valves: 'markers',
  parallel: 'grouped',
  stubLabels: 'groups',
  commands: 'stacked',
  minScale: 1,
}

/**
 * Equipment opened from a generated display: its surroundings at 1:1, read
 * at arm's length like the overview and held to the same crossings, but
 * read for which item does what. Every valve is a symbol with its tag and
 * every parallel item is drawn on its own; stubs name their far ends.
 */
export const detailMimicProfile: MimicProfile = {
  ...overviewMimicProfile,
  id: 'detail',
  valves: 'symbols',
  parallel: 'each',
  stubLabels: 'names',
}
