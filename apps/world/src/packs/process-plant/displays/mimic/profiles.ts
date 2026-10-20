import type { DiagramProfile } from '../../../../features/displays/diagram/index.ts'
import { MIMIC_MIN_SCALE } from './mimic-model.ts'
import { openBridgeDevice } from './text-metrics.ts'

// How a kind of display draws its mimics: the HMI rules every drawing it
// shows keeps, apart from the room a particular display leaves. Profiles are
// data beside each other, so a new kind of display is a new profile, not a
// new drawing path.

/** How much room a framed item's alarm badge reserves (MimicProfile.badges). */
export type BadgeReservation = 'reserved' | 'fitted'

export interface MimicProfile {
  /** Names the profile in refusals and in the drawing's identity. */
  readonly id: string
  /** The layout engine's rules: grid, pipes, alarm frames, density and the fit ladder. */
  readonly layout: DiagramProfile
  /**
   * OpenBridge's readout stack size beside a device symbol: `small` rows set
   * text at 11.5 px, `regular` rows at 16 px. Vessel stacks, tags and stub
   * text are regular in both.
   */
  readonly readoutSize: 'small' | 'regular'
  /**
   * Valves on drawn lines: full symbols with their tag and readout stack, or
   * compact markers (the valve's OpenBridge icon on the pipe, its tag, and
   * rows that are empty unless the valve says something: its command
   * disagrees, its position is not known, or it stands between shut and open).
   */
  readonly valves: 'symbols' | 'markers'
  /**
   * A value whose instrument reads at an end of its span: it reads that end
   * ("<0 %"), or, where the equipment declares an instrument that reads the
   * same quantity over a wider span, that one in whole units ("WR 24 %"),
   * which needs the room of a mark beside the value.
   */
  readonly offSpan: 'end' | 'wider'
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
  /**
   * What a framed item reserves for its alarm badge, tried in this order
   * until the drawing fits: `reserved`, room for its flap's whole text, a
   * further line with its action where the frame is too narrow for it, and
   * a line counting its other alarms ("+2 alarms"), so the badge reads alike
   * wherever it is drawn; `fitted`, only each flap's watched part, the
   * action and count shown where the frame has room for them (a chat
   * column's four loops have none to spare).
   */
  readonly badges: ReadonlyArray<BadgeReservation>
  /**
   * Whether its drawing is interactive (the display window's overview and
   * details): each item's tag line then reserves the detail dot that opens
   * its quick look (QUICK_LOOK_DOT). A chat answer's drawing is a picture.
   */
  readonly quickLooks: boolean
  /**
   * How a reactor vessel is drawn (vessel-symbol.ts): this many grid cells
   * wide, with its core region below its nozzles (`band`) or overlapping
   * the lowest of them (`overlap`) where a drawing has no height to spare,
   * and its head this far above its first nozzle (at least the head's own
   * height, text-metrics.ts; more makes it taller where a drawing has the
   * height above it).
   */
  readonly vessel: { readonly cells: number; readonly core: 'band' | 'overlap'; readonly head: number }
  /**
   * Whether vessels show what their reading did over the last minutes
   * (MimicItemTrend): a tank's fill as its trace, a heat exchanger's level
   * in a strip inside it, a reactor vessel's value rows each with a
   * sparkline. A chat answer's drawing has no room for them, and its
   * display has its own trend panel.
   */
  readonly trends: boolean
  /**
   * Where it shows trends, the size of a reactor vessel's value-row
   * sparklines, framed on a line under each row, large enough to read a rise
   * or a fall (HMI review of run 26c: at 40 x 14 it was decorative); none
   * where the drawing has no height for them over its other rows (a detail,
   * whose lead values and faceplate trend the same readings).
   */
  readonly sparklines: { readonly width: number; readonly height: number } | null
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
  { detail: 'full', text: 'partitionsBelow' },
  { detail: 'full', text: 'allBelow' },
  { detail: 'required', text: 'right' },
  { detail: 'required', text: 'partitionsBelow' },
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
  { detail: 'required', text: 'partitionsBelow' },
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
    limits: { symbols: 20, symbolsPerPartition: 3, sharedSymbols: 8, partitions: 4, crossings: 6, crossingsOverBound: 6, bendsPerEdge: 3 },
    fit: chatFit,
  },
  readoutSize: 'small',
  valves: 'symbols',
  // A chat column has no room for the mark; the display World composes adds the wider reading as evidence.
  offSpan: 'end',
  parallel: 'each',
  stubLabels: 'names',
  commands: 'inline',
  minScale: MIMIC_MIN_SCALE,
  badges: ['reserved', 'fitted'],
  quickLooks: false,
  vessel: { cells: 2, core: 'overlap', head: openBridgeDevice.reactorVessel.head },
  trends: false,
  sparklines: null,
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
    limits: { symbols: 60, symbolsPerPartition: 6, sharedSymbols: 24, partitions: 8, crossings: 40, crossingsOverBound: 2, bendsPerEdge: 3 },
    fit: overviewFit,
  },
  readoutSize: 'regular',
  valves: 'markers',
  offSpan: 'wider',
  parallel: 'grouped',
  stubLabels: 'groups',
  commands: 'stacked',
  minScale: 1,
  badges: ['reserved'],
  quickLooks: true,
  // The plant's most important component (owner, v0.4.0: "still a narrow box"): four cells wide, as wide as the
  // rows over it, so it takes no more width than they do (three cells would center 92 px of rows on 72 px and need
  // 1595 px of a 1585 px room), and four grid steps taller into the free height above its nozzles.
  vessel: { cells: 4, core: 'overlap', head: openBridgeDevice.reactorVessel.head + 4 * 24 },
  trends: true,
  sparklines: { width: 80, height: 24 },
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
  vessel: { cells: 4, core: 'overlap', head: openBridgeDevice.reactorVessel.head },
  sparklines: null,
}
