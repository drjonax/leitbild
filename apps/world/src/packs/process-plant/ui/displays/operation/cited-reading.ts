import { numberText, unitSymbol, type Observable, type Quantity } from '../../../../../core/observation/model.ts'
import { orderWord } from '../../../../../ui/embed/vignette/readout.ts'

// What a proposal's card shows of each reading it cites (QA-9, D3 ruling 1):
// its margin to its limits in World's number format and limit words, and its
// last minutes. Embed only, beside the vignette's readout words; the display
// window's chip lists proposals without them.

type Threshold = Observable['thresholds'][number]

/** A cited reading's margin to its limits (QA-9): the limit it is past, else the nearest protection limit and how far, with the minutes to it where its trend heads there. */
export interface CitedMargin {
  readonly text: string
  /** 0 past a limit; null where the reading does not head for one. */
  readonly minutes: number | null
}

const limitText = (threshold: Threshold, unit: string, quantity: Quantity | undefined): string =>
  `${orderWord(threshold)} ${numberText(threshold.value, unit, quantity)}${unitSymbol(unit) === '' ? '' : ` ${unitSymbol(unit)}`}${threshold.consequence === undefined ? '' : ` · ${threshold.consequence}`}`

/** A reading's margin, in the shared number format and limit words; null for a reading with no protection limit, or none to read. */
export const citedMargin = (input: {
  readonly value: unknown
  readonly unit: string
  readonly quantity?: Quantity
  readonly thresholds: ReadonlyArray<Threshold>
  readonly past?: string
  /** How fast it moves, in its unit per minute, from its recent history; null where none is read. */
  readonly ratePerMinute: number | null
}): CitedMargin | null => {
  const { value, unit, quantity } = input
  const past = input.thresholds.find(threshold => threshold.id === input.past)
  if (past !== undefined) return { text: `past ${limitText(past, unit, quantity)}`, minutes: 0 }
  if (typeof value !== 'number') return null
  const nearest = input.thresholds.filter(threshold => threshold.effect === 'alarm' || threshold.effect === 'trip')
    .sort((left, right) => Math.abs(value - left.value) - Math.abs(value - right.value))[0]
  if (nearest === undefined) return null
  const distance = Math.abs(value - nearest.value)
  const rate = input.ratePerMinute
  const heading = rate !== null && rate !== 0 && (nearest.value > value) === (rate > 0)
  const minutes = heading ? distance / Math.abs(rate) : null
  const side = value > nearest.value ? 'above' : 'below'
  return { text: `${numberText(distance, unit, quantity)}${unitSymbol(unit) === '' ? '' : ` ${unitSymbol(unit)}`} ${side} ${limitText(nearest, unit, quantity)}${minutes === null ? '' : `, ≈${Math.max(1, Math.round(minutes))} min`}`, minutes }
}

/** A cited reading as the card shows it beside its values: its margin, and its last minutes as a line with its words. */
export interface CitedReading {
  readonly margin: CitedMargin | null
  readonly line: { readonly path: string; readonly end: { readonly x: number; readonly y: number } | null; readonly text: string } | null
}

/** The rate over a reading's recent points, per minute; null with fewer than two a minute or more apart. */
export const ratePerMinute = (points: ReadonlyArray<{ readonly t: number; readonly v: number }>): number | null => {
  const last = points.at(-1)
  const first = last === undefined ? undefined : points.find(point => last.t - point.t <= 5 * 60_000)
  return last === undefined || first === undefined || last.t - first.t < 60_000 ? null : ((last.v - first.v) / (last.t - first.t)) * 60_000
}
