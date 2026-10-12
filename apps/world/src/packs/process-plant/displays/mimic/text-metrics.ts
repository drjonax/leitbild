import metrics from './openbridge-text-metrics.json'

// Widths of OpenBridge text as its components render it, so the server can
// reserve text boxes without a DOM. The table is generated from the installed
// OpenBridge package (generate-text-metrics.ts): each style's typography from
// its component styles, advances and kerning shaped with HarfBuzz from its
// Noto Sans, which the embed loads for mimics. It is part of the drawing's
// identity (MIMIC_LAYOUT_VERSION).

/** The text styles of an OpenBridge device's readout stack and alarm flap. */
export type OpenBridgeTextStyle = 'tag' | 'value' | 'unit' | 'stateRow' | 'alertLabel'

interface StyleTable {
  /** px per em: the font size after font-size-adjust. */
  readonly em: number
  readonly css: { readonly letterSpacing: number }
  /** In font units. */
  readonly advance: Readonly<Record<string, number>>
  /** In font units. */
  readonly kern: Readonly<Record<string, number>>
}

const unitsPerEm = metrics.font.unitsPerEm
const styles = metrics.styles as Readonly<Record<OpenBridgeTextStyle, StyleTable>>

/** Characters the table does not cover; text containing them cannot be measured and is rejected. */
export const unmeasurable = (style: OpenBridgeTextStyle, text: string): ReadonlyArray<string> =>
  [...new Set([...text].filter(character => styles[style].advance[character] === undefined))]

/** Rendered width in px, rounded up; throws for characters the table lacks (check `unmeasurable` first). */
export const textWidth = (style: OpenBridgeTextStyle, text: string): number => {
  const table = styles[style]
  let units = 0
  let characters = 0
  let previous = ''
  for (const character of text) {
    const advance = table.advance[character]
    if (advance === undefined) throw new Error(`no ${style} advance for "${character}"`)
    units += advance + (table.kern[previous + character] ?? 0)
    previous = character
    characters++
  }
  // Letter-spacing follows every character, the last included.
  return Math.ceil((units * table.em) / unitsPerEm + characters * table.css.letterSpacing)
}

/** OpenBridge device geometry at the regular size, in px. */
export const openBridgeDevice = {
  /** The symbol's touch target, centred on its anchor. */
  symbol: 48,
  /** The readout stack's tag line and each value or state row (regular stacks, and our vessel stacks). */
  tagLine: 16,
  row: 20,
  /** A device's stack uses OpenBridge's `small` readout size: 11.5 px rows, 16 px state rows and 18 px value rows. */
  smallStateRow: 16,
  smallValueRow: 18,
  smallTextScale: 11.5 / 16,
  /** A value row is the readout block plus its unit plus this padding. */
  valueRowPadding: 22,
  /** The gap between the parts of a value row (MimicPanel's value-row), before a mark such as WR. */
  valueRowGap: 4,
  /** A state row is its text plus this padding. */
  stateRowPadding: 16,
  /** The bottom alarm flap below the button, and where its label starts. */
  flapHeight: 21,
  flapLabelInset: 28,
  /** Tanks and heat exchangers: the box, and how far the visible body sits inside it. */
  vessel: { width: 48, height: 96, inset: 5 },
  /** Where OpenBridge's compact tank draws its fill in that box (measured): a fill trace lies on the same cell. */
  tankFill: { x: 10, y: 19, width: 28, height: 54 },
  /**
   * A reactor vessel (vessel-symbol.ts), down its box: its head (dome and
   * flange) and the clearance under it, above its first nozzle; below its
   * last nozzle the gap to its core region, the core region, and its bottom
   * dome. Where a drawing has no height for the core region below the
   * nozzles, it overlaps the lowest of them (`overlap`) and the box keeps
   * only its bottom dome there.
   */
  reactorVessel: { head: 46, dome: 30, flange: 6, coreGap: 12, coreBand: 72, bottomDome: 20 },
  /** A sparkline on a line under a value row (MimicRow `sparkline`): its width and height, on a line this high. */
  rowSparkline: { width: 40, height: 14, line: 16 },
} as const

/** What a reactor vessel's box keeps below its last nozzle: its core region there (`band`), or only its bottom dome (`overlap`). */
export const reactorVesselBottom = (core: 'band' | 'overlap'): number =>
  openBridgeDevice.reactorVessel.bottomDome + (core === 'band' ? openBridgeDevice.reactorVessel.coreGap + openBridgeDevice.reactorVessel.coreBand : 0)

/** Width of a readout block holding up to `digits` digits (and a fraction), as OpenBridge reserves it. */
export const readoutBlockWidth = (integerDigits: number, fractionDigits: number): number =>
  textWidth('value', `${'0'.repeat(integerDigits)}${fractionDigits === 0 ? '' : `.${'0'.repeat(fractionDigits)}`}`)

/** A state row of a small readout stack: the regular row's glyphs at 11.5 px (Noto Sans scales linearly). */
export const smallStateRowWidth = (text: string): number =>
  Math.ceil(textWidth('stateRow', text) * openBridgeDevice.smallTextScale) + openBridgeDevice.stateRowPadding

/** A value row of a small readout stack: up to three digits (or as many as it declares) at 11.5 px, then its unit. */
export const smallValueRowWidth = (unit: string, integerDigits = 3): number =>
  Math.ceil(textWidth('stateRow', '0'.repeat(integerDigits)) * openBridgeDevice.smallTextScale) + (unit === '' ? 0 : textWidth('unit', unit)) + openBridgeDevice.valueRowPadding

/**
 * The detail dot at the end of an item's tag line, which opens its quick
 * look where a drawing is interactive (MimicProfile.quickLooks): a button
 * this many px square, this far after the tag. The tag line reserves both,
 * so the dot never covers anything.
 */
export const QUICK_LOOK_DOT = { size: 18, gap: 2 } as const
