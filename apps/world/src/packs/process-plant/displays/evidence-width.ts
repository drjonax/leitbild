import type { ComposedDisplayPen, ComposedEvidenceItem } from './compose.ts'
import { composedDisplayLayout, evidenceKindWords, type DisplayEvidenceKind } from './composition.ts'
import { chipName, POSITION_OPEN_ABOVE, readingValueText, unitLabel } from './display-text.ts'
import { textWidth, unmeasurable } from './mimic/text-metrics.ts'

// How wide a row of values World adds draws, at its widest, so a row that
// would be cut at chat width goes on to the next line, whole values each
// (HMI review of run 26: the trip check lost the generator's output, its
// breaker and the stop valves on seven displays). Widths are of Noto Sans as
// the panel sets it (EvidencePanel.svelte): labels, units and names at
// 11.5 px, values at 13 px bold, the word for why and the demand mark at
// 9.5 px upper case, an alarm chip at 10.5 px bold. A value is reserved at
// the widest text it can read: either state's words, OPEN or SHUT for a
// valve, its span's ends as "<0" and ">100", or the most digits it reads to
// within its span.

/** The metrics table's regular style (Noto Sans 400 at 16 px), scaled to each size. */
const TABLE_PX = 16
/** Bold Noto Sans sets about this much wider than regular. */
const BOLD = 1.08
/** A character the table lacks is reserved at this share of the size. */
const UNKNOWN_EM = 0.65

const textPx = (text: string, px: number, options: { readonly bold?: boolean; readonly upper?: boolean; readonly spacingEm?: number } = {}): number => {
  const shown = options.upper === true ? text.toUpperCase() : text
  const characters = [...shown]
  const known = characters.filter(character => unmeasurable('stateRow', character).length === 0).join('')
  const unknown = characters.length - [...known].length
  const regular = (textWidth('stateRow', known) / TABLE_PX) * px + unknown * UNKNOWN_EM * px
  return Math.ceil(regular * (options.bold === true ? BOLD : 1) + characters.length * (options.spacingEm ?? 0) * px)
}

/** The gap between a row's parts, and between a value's label, number, unit and marks. */
const ROW_GAP = 8
const ITEM_GAP = 4
/** A dashed mark's side padding and border: the word for why, "demand", "sim". */
const MARK_PAD = 10
/** An alarm chip's side padding. */
const CHIP_PAD = 10

const mark = (text: string): number => textPx(text, 9.5, { upper: true, spacingEm: 0.04 }) + MARK_PAD

/** The word for why, on a row's first line. */
export const evidenceWhyWidth = (kind: DisplayEvidenceKind): number => mark(evidenceKindWords[kind])

/** A value's text at its widest: either state's words; OPEN or SHUT for a valve; its span's ends and the most digits within it. */
const widestValue = (pen: ComposedDisplayPen): { readonly value: number; readonly unit: number } => {
  if (pen.valueKind === 'boolean') {
    const words = pen.states === undefined ? ['ON', 'OFF'] : [pen.states.on, pen.states.off]
    return { value: Math.max(...words.map(word => textPx(word, 13, { bold: true }))), unit: 0 }
  }
  const span = pen.limits?.instrumentSpan
  const unit = unitLabel(pen.unit)
  const step = pen.resolution ?? 0
  const values = span === undefined
    ? [-99_999.9, 99_999.9]
    : [span.min, span.max, span.max - Math.max(step, (span.max - span.min) * 1e-3), span.min + Math.max(step, (span.max - span.min) * 1e-3)]
  const texts = [...values.map(value => readingValueText(value, pen.unit, pen.resolution, span)), ...(pen.position === true ? ['OPEN', 'SHUT', readingValueText(POSITION_OPEN_ABOVE, pen.unit, pen.resolution, span)] : [])]
  return { value: Math.max(...texts.map(text => textPx(text, 13, { bold: true }))), unit: unit === '' ? 0 : ITEM_GAP + textPx(unit, 11.5) }
}

/** The widest compact alarm chip a value of a row of several can show beside it. */
const widestChip = (pen: ComposedDisplayPen): number => {
  const chips = pen.thresholds.filter(threshold => threshold.kind !== 'control').map(threshold => textPx(chipName(threshold, true), 10.5, { bold: true, spacingEm: 0.03 }) + CHIP_PAD)
  return chips.length === 0 ? 0 : ITEM_GAP + Math.max(...chips)
}

/** One value as its row draws it at its widest: its label, value and unit, its marks, and in a row of several its chip. */
export const evidenceItemWidth = (item: ComposedEvidenceItem, several: boolean): number => {
  const { pen } = item
  const widest = widestValue(pen)
  return (item.label === '' ? 0 : textPx(item.label, 11.5) + ITEM_GAP) + widest.value + widest.unit
    + (pen.command ? ITEM_GAP + mark('demand') : 0)
    + (pen.simulatorOnly === true ? ITEM_GAP + mark('sim') : 0)
    + (several ? widestChip(pen) : 0)
}

/** What a row says beside its values, at 11 px. */
export const evidenceNoteWidth = (note: string): number => textPx(note, 11)

/** What the values of a row are, at 11.5 px. */
export const evidenceNameWidth = (name: string): number => textPx(name, 11.5)

/** One line of a row: its values, and whether the row's note ends it. */
export interface EvidenceLine<Item> {
  readonly items: ReadonlyArray<Item>
  readonly note: boolean
}

/**
 * A row's values split into lines that fit a chat view's width, each value
 * whole, in order: the first line after the word for why and the row's
 * name, the rest after an indent as wide as that word; its note after the
 * last value where it fits there, else on a line of its own. A value too
 * wide for any line has one to itself.
 */
export const evidenceLines = <Item extends ComposedEvidenceItem>(
  kind: DisplayEvidenceKind,
  name: string,
  items: ReadonlyArray<Item>,
  note: string | undefined,
  room: number = composedDisplayLayout.evidenceRowRoom,
): ReadonlyArray<EvidenceLine<Item>> => {
  const several = items.length > 1
  const indent = evidenceWhyWidth(kind) + ROW_GAP
  const lines: Array<EvidenceLine<Item>> = []
  let line: Item[] = []
  let used = indent + (name === '' ? 0 : evidenceNameWidth(name) + ROW_GAP)
  for (const item of items) {
    const width = evidenceItemWidth(item, several)
    if (line.length > 0 && used + width > room) {
      lines.push({ items: line, note: false })
      line = []
      used = indent
    }
    line.push(item)
    used += width + ROW_GAP
  }
  if (note === undefined) return [...lines, { items: line, note: false }]
  return used + evidenceNoteWidth(note) <= room
    ? [...lines, { items: line, note: true }]
    : [...lines, { items: line, note: false }, { items: [], note: true }]
}
