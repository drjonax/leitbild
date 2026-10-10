import { z } from 'zod'
import { idSchema, isoTimestampSchema } from '../../../core/model/index.ts'
import { MIMIC_REACH_LINKS } from './mimic/scope.ts'

// An AI-composed display states WHAT the operator should see and WHY. The
// Pack owns HOW: resolution, units, I&C thresholds, scales, layout and live
// data. There are deliberately no fields for numbers, limits, colours,
// positions or forecasts.
export const COMPOSED_DISPLAY_VIEW_TYPE = 'process-plant.display'

export const composedDisplayHorizonMs = {
  '2m': 120_000,
  '10m': 600_000,
  '30m': 1_800_000,
} as const
export const composedDisplayHorizonSchema = z.enum(['2m', '10m', '30m'])
export type ComposedDisplayHorizon = z.infer<typeof composedDisplayHorizonSchema>

/**
 * The time each lead value's sparkline spans on a display World generates.
 * Ten minutes holds the onset of a transient and the way a value settled
 * after it, and still draws a trip's step as a step; one window for every
 * row, so their slopes compare.
 */
export const LEAD_VALUE_SPARKLINE_MS = composedDisplayHorizonMs['10m']

export const composedDisplaySignalRoleSchema = z.enum(['primary', 'context', 'counter-evidence'])
export type ComposedDisplaySignalRole = z.infer<typeof composedDisplaySignalRoleSchema>

const text = (min: number, max: number) => z.string().trim().min(min).max(max)

export const composedDisplaySignalSchema = z.object({
  ref: text(1, 120),
  role: composedDisplaySignalRoleSchema,
}).strict()
export type ComposedDisplaySignal = z.infer<typeof composedDisplaySignalSchema>

// Size limits keep a chat display glanceable; larger questions belong to the
// Plant's own displays.
export const COMPOSED_TREND_MAX_SIGNALS = 6
// The schema bounds the payload; the authoring limit above is checked with the
// other issues, so one rejection names every fix.
const COMPOSED_TREND_SCHEMA_MAX_SIGNALS = 12
/** A trend stacks one strip per measurement on its time axis; a strip holds the loops of a 4-loop plant. */
export const COMPOSED_TREND_MAX_STRIPS = 4
export const COMPOSED_TREND_STRIP_MAX_PENS = 4
export const COMPOSED_COMPARISON_MAX_SIGNALS = 6
export const COMPOSED_READOUTS_MAX_SIGNALS = 6
// One trend plus up to two supporting panels (HMI review); with the 660 px cap
// nearly every three-panel combination fits by construction.
export const COMPOSED_DISPLAY_MAX_PANELS = 3
/** Live values one display samples each second, across its panels. */
export const COMPOSED_DISPLAY_MAX_SAMPLE_PATHS = 96
/** The most live values one sample reads: a unit overview's drawing, lead values and alarms. */
export const PROCESS_DISPLAY_SAMPLE_MAX_PATHS = 256
export const COMPOSED_DISPLAY_MAX_TRENDS = 1

/** History of numeric signals; the Pack groups them into one strip per measurement. */
export const composedDisplayTrendPanelSchema = z.object({
  kind: z.literal('trend'),
  horizon: composedDisplayHorizonSchema,
  signals: z.array(composedDisplaySignalSchema).min(1).max(COMPOSED_TREND_SCHEMA_MAX_SIGNALS),
}).strict()
export type ComposedDisplayTrendPanel = z.infer<typeof composedDisplayTrendPanelSchema>

/** Parallel signals of one unit side by side, e.g. the four loops. */
export const composedDisplayComparisonPanelSchema = z.object({
  kind: z.literal('comparison'),
  signals: z.array(composedDisplaySignalSchema).min(2).max(COMPOSED_COMPARISON_MAX_SIGNALS),
}).strict()

/** Current values, including on/off states, with margin to I&C thresholds. */
export const composedDisplayReadoutsPanelSchema = z.object({
  kind: z.literal('readouts'),
  signals: z.array(composedDisplaySignalSchema).min(1).max(COMPOSED_READOUTS_MAX_SIGNALS),
}).strict()

/** Active alarms and trips: those acting on the displayed signals, or the whole Plant. */
export const composedDisplayAlarmsPanelSchema = z.object({
  kind: z.literal('alarms'),
  scope: z.enum(['related', 'plant']),
}).strict()

const equipmentName = text(1, 120)

/**
 * A generated equipment drawing of the part of the Plant the question is
 * about, stated in plant terms: a route from equipment to equipment, what is
 * upstream of (`to` alone) or downstream of (`from` alone) one item, what
 * feeds an item and where its outflow goes (`around`), or whole services,
 * narrowed to loops. Each entry names one component by its id, a
 * tag measured on it, or its label or short label. World draws every symbol
 * and picks every state signal; there is no catalogue of views.
 */
export const composedDisplayMimicPanelSchema = z.object({
  kind: z.literal('mimic'),
  from: z.array(equipmentName).min(1).max(4).optional(),
  to: z.array(equipmentName).min(1).max(4).optional(),
  around: z.array(equipmentName).min(1).max(4).optional(),
  services: z.array(text(1, 64)).min(1).max(4).optional(),
  loops: z.array(text(1, 16)).min(1).max(6).optional(),
  exclude: z.array(equipmentName).min(1).max(6).optional(),
  /** How many links a one-ended or around drawing follows from its items; a smaller reach draws a closer neighbourhood. */
  reach: z.number().int().min(1).max(MIMIC_REACH_LINKS).optional(),
}).strict()

export const composedDisplayPanelSchema = z.discriminatedUnion('kind', [
  composedDisplayTrendPanelSchema,
  composedDisplayComparisonPanelSchema,
  composedDisplayReadoutsPanelSchema,
  composedDisplayAlarmsPanelSchema,
  composedDisplayMimicPanelSchema,
])
export type ComposedDisplayPanel = z.infer<typeof composedDisplayPanelSchema>

/** The most subjects a display names: what its question is about. */
export const COMPOSED_DISPLAY_MAX_SUBJECTS = 4

export const composedDisplayCompositionSchema = z.object({
  plantId: idSchema,
  title: text(3, 60),
  question: text(8, 160),
  need: text(8, 160),
  /**
   * What the question is about: equipment (id, a tag on it, its label) or
   * signals (tag or path). Composing refuses a display that shows any of them
   * nowhere. Advice composed before subjects existed re-opens without them.
   */
  subjects: z.array(text(1, 120)).min(1).max(COMPOSED_DISPLAY_MAX_SUBJECTS).optional(),
  panels: z.array(composedDisplayPanelSchema).min(1).max(COMPOSED_DISPLAY_MAX_PANELS),
}).strict()
export type ComposedDisplayComposition = z.infer<typeof composedDisplayCompositionSchema>

// Opaque to embedders. The issue time and model digest let a later view say
// when the advice was given and whether the Plant model has changed since.
export const composedDisplayStateSchema = z.object({
  composition: composedDisplayCompositionSchema,
  issuedAt: isoTimestampSchema,
  modelDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Each mimic panel's drawing as the advice saw it, so a later view can say the drawing changed. */
  drawings: z.array(z.string().min(1).max(160)).max(COMPOSED_DISPLAY_MAX_PANELS).optional(),
}).strict().superRefine((state, ctx) => {
  const mimics = state.composition.panels.filter(panel => panel.kind === 'mimic').length
  if ((state.drawings?.length ?? 0) !== mimics) ctx.addIssue({ code: 'custom', path: ['drawings'], message: `a display with ${mimics} mimic panels stores ${mimics} drawing hashes` })
})
export type ComposedDisplayState = z.infer<typeof composedDisplayStateSchema>

/** A unit overview World generates for a Plant; it holds no advice, so it never goes stale against one. */
export const overviewDisplayStateSchema = z.object({
  overview: z.object({ plantId: idSchema }).strict(),
}).strict()
export type OverviewDisplayState = z.infer<typeof overviewDisplayStateSchema>

/** The most components one detail opens: a drawn symbol stands for one, or for a group of parallel equipment. */
export const PROCESS_DISPLAY_DETAIL_MAX_COMPONENTS = 8

/**
 * Equipment opened from a generated display: World draws what feeds it and
 * where its outflow goes, its lead values and its alarms. Like the overview,
 * it holds no advice.
 */
export const detailDisplayStateSchema = z.object({
  detail: z.object({
    plantId: idSchema,
    components: z.array(idSchema).min(1).max(PROCESS_DISPLAY_DETAIL_MAX_COMPONENTS),
  }).strict(),
}).strict()
export type DetailDisplayState = z.infer<typeof detailDisplayStateSchema>

/** What an embedded Process Plant display re-opens: an agent's advice, a Plant's unit overview, or equipment opened from it. */
export const processDisplayStateSchema = z.union([composedDisplayStateSchema, overviewDisplayStateSchema, detailDisplayStateSchema])
export type ProcessDisplayState = z.infer<typeof processDisplayStateSchema>

/** The Plant a display state is about. */
export const processDisplayStatePlantId = (state: ProcessDisplayState): string =>
  'overview' in state ? state.overview.plantId : 'detail' in state ? state.detail.plantId : state.composition.plantId

// One layout used by the compiler (to size the embedded card) and by the view
// (to size each panel), so the reserved frame always fits what is drawn.
export const composedDisplayLayout = {
  /** Header, unit and Run line, two-line caption, one reserved notice line, footer, gaps and padding. */
  frame: 140,
  /** Above each trend strip: unit and advice labels. */
  trendStripTop: 18,
  /**
   * Plot height of a trend with one strip, and of each strip when several
   * stack; shrunk toward the minimum when the other panels need the room.
   */
  trendPlot: 116,
  trendStackedPlot: 72,
  trendMinPlot: 64,
  trendMinStackedPlot: 48,
  /** Time labels, once under the bottom strip. */
  trendTimeAxis: 22,
  /** Legend under each strip: one row per pen with value, alarm state or margin, and rate. */
  trendLegendRow: 16,
  trendLegendPad: 4,
  comparisonHeader: 22,
  comparisonRow: 24,
  comparisonCaption: 14,
  readoutsPerRow: 3,
  readoutsRow: 74,
  /** Title row plus four alarm rows; more are summarised as a count. */
  alarms: 110,
  alarmRows: 4,
  panelGap: 6,
  /** The mimic's legend line under its drawing. */
  mimicLegend: 16,
  /**
   * A unit overview's window: its side padding, and its frame (top and
   * bottom padding and one header row with title, Run, notice line, state and
   * clock, with the gap under it).
   */
  overviewPadding: 10,
  overviewFrame: 40,
  /** The footer line and its gap, under an overview whose panels stack. */
  overviewFooter: 18,
  /** On a window wide enough, the column of lead values and alarms beside the drawing, and the gap before it. */
  overviewColumn: 280,
  overviewColumnGap: 12,
  /**
   * A lead value in that column, one per row: its name line, its readout with
   * its sparkline beside it, and its margin line (78 px), and the gap under it.
   */
  overviewReadoutRow: 82,
  /** Over the column's lead values: the title line that labels their sparklines' window once, and the gap under it. */
  overviewReadoutsTitle: 16,
  /**
   * Annunciator tiles over a generated display's alarm list: each tile's
   * least width, widest first (a column too short for two tiles to a row
   * takes three compact ones), its height (the system's name, then its counts
   * and tags), and the severity bar and padding its name leaves room for; and
   * the gap between tiles.
   */
  annunciatorTile: { widths: [134, 88], height: 40, inset: 16 },
  annunciatorGap: 4,
} as const

// A chat display taller than about 600 px pushes its own lower panels below
// the fold (HMI review). A display led by an equipment mimic, drawn with
// OpenBridge's full-size symbols, may take up to 900 px (owner decision).
export const COMPOSED_DISPLAY_MAX_HEIGHT_PX = 660
export const COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX = 900

/** The height a display may take: taller when an equipment mimic leads it. */
export const composedDisplayMaxHeight = (panels: ReadonlyArray<{ readonly kind: string }>): number =>
  panels.some(panel => panel.kind === 'mimic') ? COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX : COMPOSED_DISPLAY_MAX_HEIGHT_PX

/** What a panel's height depends on, known once its signals are resolved. */
export type ComposedPanelShape =
  /** Pens per strip, top to bottom, and live-only rows under the strips. */
  | { readonly kind: 'trend'; readonly strips: ReadonlyArray<number>; readonly live: number }
  | { readonly kind: 'comparison'; readonly rows: number }
  | { readonly kind: 'readouts'; readonly values: number }
  | { readonly kind: 'alarms' }
  /** A mimic has the height its generated drawing takes. */
  | { readonly kind: 'mimic'; readonly height: number }

/** A panel shape with its trend plot height decided. */
export type ComposedPanelSize =
  | Exclude<ComposedPanelShape, { readonly kind: 'trend' }>
  | { readonly kind: 'trend'; readonly strips: ReadonlyArray<number>; readonly live: number; readonly plot: number }

const trendPlotRange = (strips: number): { readonly preferred: number; readonly minimum: number } => strips === 1
  ? { preferred: composedDisplayLayout.trendPlot, minimum: composedDisplayLayout.trendMinPlot }
  : { preferred: composedDisplayLayout.trendStackedPlot, minimum: composedDisplayLayout.trendMinStackedPlot }

/** Chart height of each strip of a trend, top to bottom; the last carries the time axis. */
export const composedTrendStripHeights = (strips: number, plot: number): ReadonlyArray<number> => {
  const layout = composedDisplayLayout
  return Array.from({ length: strips }, (_, index) => layout.trendStripTop + plot + (index === strips - 1 ? layout.trendTimeAxis : 0))
}

export const composedTrendLegendHeight = (pens: number): number =>
  composedDisplayLayout.trendLegendPad + composedDisplayLayout.trendLegendRow * pens

export const composedPanelHeight = (panel: ComposedPanelSize): number => {
  const layout = composedDisplayLayout
  if (panel.kind === 'trend') {
    const charts = composedTrendStripHeights(panel.strips.length, panel.plot)
    const live = panel.live === 0 ? 0 : composedTrendLegendHeight(panel.live)
    return panel.strips.reduce((sum, pens, index) => sum + charts[index]! + composedTrendLegendHeight(pens), 0) + live
  }
  if (panel.kind === 'comparison') return layout.comparisonHeader + layout.comparisonRow * panel.rows + layout.comparisonCaption
  if (panel.kind === 'readouts') return layout.readoutsRow * Math.ceil(panel.values / layout.readoutsPerRow)
  if (panel.kind === 'mimic') return panel.height + layout.mimicLegend
  return layout.alarms
}

/** The least height a panel can take: trends at their smallest plots. */
export const composedPanelMinimumHeight = (panel: ComposedPanelShape): number =>
  composedPanelHeight(panel.kind === 'trend' ? { ...panel, plot: trendPlotRange(panel.strips.length).minimum } : panel)

export const composedDisplayHeight = (panels: ReadonlyArray<ComposedPanelSize>): number =>
  composedDisplayLayout.frame
  + panels.reduce((sum, panel) => sum + composedPanelHeight(panel), 0)
  + composedDisplayLayout.panelGap * (panels.length - 1)

/**
 * Sizes a display. Trends are the panels that can give: their plots take the
 * preferred height and shrink evenly toward their minimum when the other
 * panels need the room, so a display is too tall only when even its smallest
 * trend does not fit.
 */
export const fitComposedDisplay = (panels: ReadonlyArray<ComposedPanelShape>): {
  readonly height: number
  readonly panels: ReadonlyArray<ComposedPanelSize>
} => {
  const sized = (scale: number): ReadonlyArray<ComposedPanelSize> => panels.map(panel => {
    if (panel.kind !== 'trend') return panel
    const range = trendPlotRange(panel.strips.length)
    return { ...panel, plot: Math.max(range.minimum, Math.floor(range.preferred * scale)) }
  })
  const preferred = sized(1)
  const natural = composedDisplayHeight(preferred)
  const maxHeight = composedDisplayMaxHeight(panels)
  const plotTotal = panels.reduce((sum, panel) => panel.kind === 'trend' ? sum + trendPlotRange(panel.strips.length).preferred * panel.strips.length : sum, 0)
  if (natural <= maxHeight || plotTotal === 0) return { height: natural, panels: preferred }
  const fitted = sized(Math.max(0, (plotTotal - (natural - maxHeight)) / plotTotal))
  return { height: composedDisplayHeight(fitted), panels: fitted }
}
