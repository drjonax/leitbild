// How an energy end's faceplate reads as one-line rows under its drawing (HF
// review, HF-02: 24–28 px rows, not lead-value blocks): the words of every
// part of a row, and which parts a row keeps where its column is narrow.
// World derives and compiles the faceplate (faceplate.ts) and says how it
// reads now from a display's sample (faceplate-live.ts); this only words it,
// in the words the rest of the display uses: tags whole, values as a readout
// writes them, states in their declared words, limits by the trend-reading
// rule, rules by their trip's title. Pure, so the pinned states are tested
// without a browser; FaceplatePanel draws what it returns.
import type { ComposedDisplayPen, ComposedFaceplatePanel } from '../../../packs/process-plant/displays/compose.ts'
import { faceplateNow, type Faceplate, type FaceplateComparison, type FaceplateCriterion, type FaceplateHead, type FaceplateHeld, type FaceplateLive, type FaceplateRow } from '../../../packs/process-plant/displays/faceplate-live.ts'
import { displayValue, logarithmicSpan, offScale, positionWord, readingValueText, shownReading, unitLabel, valueDigits } from '../../../packs/process-plant/displays/display-text.ts'
import type { ComposedDisplayThreshold } from '../../../packs/process-plant/displays/ic-thresholds.ts'
import { activeThreshold, limitsInForce, rateWindowMs, trendReading, type LimitState, type TrendPoint, type TrendReading } from '../../../packs/process-plant/displays/trend-reading.ts'
import { LEAD_VALUE_SPARKLINE_MS } from '../../../packs/process-plant/displays/composition.ts'
import type { SafetyFunctionChip } from '../../../packs/process-plant/displays/safety-function-content.ts'
import type { ComposedDisplaySample } from './composed-display-client.ts'
import { alarmAge, alertTypeOf, limitStateForms, sampledGates } from './panel-presenters.ts'

/** What a faceplate reads live, from a display's sample: values, the mode, the annunciated alarms, the safety functions. */
export const faceplateLive = (sample: ComposedDisplaySample): FaceplateLive => {
  const values = new Map(sample.values.map(entry => [entry.path, entry.value]))
  return { mode: sample.mode?.id ?? null, read: path => values.get(path), alarms: sample.alarms ?? [], functions: sample.safetyFunctions ?? [] }
}

/** The window each faceplate sparkline spans: a lead value's (ISA-101 Level 1). */
export const FACEPLATE_SPARKLINE_MS = LEAD_VALUE_SPARKLINE_MS

/** How a value is written in a row: a number for its readout, or a state in its declared words. */
export type FaceplateValue =
  | {
    readonly kind: 'number'
    /** The readout's value: a number, or text at an end of its span or over decades ("<0", "2.2×10⁻⁶"); null where none is sampled. */
    readonly value: number | string | null
    readonly fractionDigits: number
    /** The digits its readout block holds: the number's own, so it is as wide as it writes. */
    readonly maxDigits: number
    readonly unit: string
    /** At an end of its instrument's span: the indication says only that the quantity is there or beyond. */
    readonly offScale: 'below' | 'above' | null
    /** As written, for a tooltip, a table cell and a width: "2.2×10⁻⁶ A". */
    readonly text: string
  }
  | {
    readonly kind: 'state'
    /** Its declared words for the state it reads ("Rods on bottom", "Grid LIVE"); "—" where none is sampled. */
    readonly words: string
    readonly on: boolean | null
  }

/** One value of a row: its pen, how it is written, its limits as read now, and the I&C limit acting on it, if any. */
export interface FaceplateCell {
  readonly pen: ComposedDisplayPen
  /** A number's tag (never shortened), or its name; empty for a state, whose words name it. */
  readonly name: string
  readonly value: FaceplateValue
  /** How it reads against its limits now (trend-reading.ts); null for a state or where nothing is sampled. */
  readonly reading: TrendReading | null
  /** The most severe of its limits in force whose rule is active: the alarm chip beside it. */
  readonly inAlarm: ComposedDisplayThreshold | null
}

/** What a row says of its first value beside it, whole first and then shorter, each form dropping a whole part; a row keeps the fullest that fits. */
export interface FaceplateNote {
  readonly forms: ReadonlyArray<string>
  /** Past a limit or off its span: caution text, as a readout's margin line reads. A criterion not met is set bold, never coloured. */
  readonly tone: 'quiet' | 'beyond' | 'unmet'
  /** The whole note, for its tooltip. */
  readonly title: string
}

/** OpenBridge's linear advice: a zone of the bar where an I&C limit in force acts. */
export interface FaceplateAdvice {
  readonly min: number
  readonly max: number
  readonly type: 'caution'
  readonly hinted: boolean
}

/** A bar over the span the value's instrument declares (decades in powers of ten), its I&C limits in force as advices. */
export interface FaceplateBar {
  readonly min: number
  readonly max: number
  readonly value: number
  readonly advices: ReadonlyArray<FaceplateAdvice>
}

export type FaceplateLine =
  /** Values on one line; the first value's note, bar and sparkline beside them. */
  | {
    readonly kind: 'values'
    readonly cells: ReadonlyArray<FaceplateCell>
    readonly note: FaceplateNote | null
    readonly bar: FaceplateBar | null
    /** The first value's recent history where the row draws a sparkline: the column's first reading, or a value that moves (HF-02). */
    readonly sparkline: { readonly pen: ComposedDisplayPen; readonly points: ReadonlyArray<TrendPoint>; readonly limit: ComposedDisplayThreshold | null; readonly inAlarm: ComposedDisplayThreshold | null } | null
  }
  /** An active rule by its trip's title, in its alarm's colour (an I&C trip acts), what set it off and holds after it. */
  | { readonly kind: 'rule'; readonly status: 'alarm' | 'warning' | 'caution'; readonly title: string; readonly firstOut: boolean; readonly deciding: ReadonlyArray<string> }
  /** Neutral words: "+3 acting", "+15 armed", a folded or failing check. */
  | { readonly kind: 'text'; readonly text: string; readonly title: string }
  /**
   * A rule elsewhere that acts on what this column's group moved: armed, or
   * idle (faint) with what it waits for. Its forms, whole first: the action,
   * the rule's title and its status with what decides it; then without the
   * title, whose action and column already say what it does (HF review,
   * HF-17: "→ RX TRIP on TURB TRIP: armed (PR > P-9)"); then without what
   * decides it.
   */
  | { readonly kind: 'consequence'; readonly forms: ReadonlyArray<string>; readonly title: string; readonly idle: boolean }
  /** Where a header sends its flow, each branch by its first equipment ("Steam header to: Turbine bypass 27.1 kg/s"). */
  | { readonly kind: 'flows'; readonly parts: ReadonlyArray<string> }
  /**
   * One quantity of parallel equipment side by side (the rod banks): a thin
   * bar each under its short label, groups apart; a value printed only on a
   * bar that differs from the others, or once for all where none does.
   */
  | { readonly kind: 'strip'; readonly groups: ReadonlyArray<ReadonlyArray<FaceplateStripBar>>; readonly all: string | null; readonly title: string }
  /** Parallel loops in one aligned table. */
  | { readonly kind: 'loops'; readonly table: FaceplateLoopTable }

export interface FaceplateStripBar {
  readonly label: string
  readonly value: number | null
  readonly max: number
  /** Its value, where it differs from the others. */
  readonly printed: string | null
  readonly title: string
}

export interface FaceplateLoopTable {
  /** A column's head: the tags its cells share, the loop's place in them written x ("TE-4x1-HOT"), with its unit; idle where no rule judging it acts in the mode. */
  readonly columns: ReadonlyArray<{ readonly head: string; readonly unit: string; readonly title: string; readonly idle: boolean }>
  readonly rows: ReadonlyArray<{ readonly loop: string; readonly cells: ReadonlyArray<{ readonly text: string; readonly title: string; readonly alert: 'alarm' | 'warning' | 'caution' | null }> }>
}

/** A column's head: the chips and group words the derivation heads it by, and the equipment its circuit reaches as a sub-line. */
export interface FaceplateHeadLine {
  readonly parts: ReadonlyArray<
    /** A group's or a circuit's words, and for a group whose first out came in, how long ago ("2:29 ago"). */
    | { readonly kind: 'words'; readonly text: string; readonly since?: string }
    | { readonly kind: 'chip'; readonly chip: SafetyFunctionChip }
  >
  readonly sub: string
}

export interface FaceplateColumnLines {
  readonly head: FaceplateHeadLine
  readonly lines: ReadonlyArray<FaceplateLine>
}

/** The history a faceplate's sparklines draw, as the display keeps it. */
export type FaceplateHistory = ReadonlyMap<string, ReadonlyArray<TrendPoint>>

const operatorWords = { '<': '<', '<=': '≤', '>': '>', '>=': '≥', '==': '=', '!=': '≠' } as const

/**
 * A number with its unit as a cell writes it, at the pen's resolution (or a
 * row's, where the row reads its values at one); a valve's position SHUT or
 * OPEN at its ends, as its drawing words it (EvidencePanel does alike).
 */
const numberValue = (pen: ComposedDisplayPen, raw: unknown, rowResolution: number | null = null): FaceplateValue & { readonly kind: 'number' } => {
  const unit = unitLabel(pen.unit)
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { kind: 'number', value: null, fractionDigits: 0, maxDigits: 1, unit, offScale: null, text: '—' }
  const resolution = pen.resolution ?? rowResolution
  const value = shownReading(raw, resolution)
  const word = pen.position === true ? positionWord(value) : null
  if (word !== null) return { kind: 'number', value: word, fractionDigits: 0, maxDigits: 1, unit: '', offScale: null, text: word }
  const span = pen.limits?.instrumentSpan
  const end = offScale(value, span)
  const asText = end !== null || logarithmicSpan(span)
  const shown = displayValue(value, pen.unit)
  const written = readingValueText(value, pen.unit, resolution, span)
  return {
    kind: 'number',
    value: asText ? written : shown,
    fractionDigits: asText ? 0 : valueDigits(shown, resolution === null ? null : displayValue(resolution, pen.unit)),
    maxDigits: Math.max(1, String(Math.trunc(Math.abs(shown))).length),
    unit,
    offScale: end,
    text: `${written}${unit === '' ? '' : ` ${unit}`}`,
  }
}

/** A limit or criterion as the model declares it, in display units with a true minus: "5", "−0.2", "99.5". */
const declared = (value: number, unit: string): string => String(Number(displayValue(value, unit).toPrecision(12))).replace('-', '−')

/** A state in its declared words; "—" where none is sampled. */
const stateWords = (pen: ComposedDisplayPen, raw: unknown): string =>
  typeof raw !== 'boolean' ? '—' : (raw ? pen.states?.on : pen.states?.off) ?? pen.described

const stateValue = (pen: ComposedDisplayPen, raw: unknown): FaceplateValue =>
  ({ kind: 'state', words: stateWords(pen, raw), on: typeof raw === 'boolean' ? raw : null })

/** A reading's limit state where it says something: a margin or a limit passed, never "no … limit" filler (ReadoutsPanel's rule). */
const shownLimit = (reading: TrendReading): Extract<LimitState, { readonly kind: 'margin' | 'past' }> | null => reading.limit?.kind === 'margin' || reading.limit?.kind === 'past' ? reading.limit : null

/** A criterion's reference as its safety function asks it: "< 5 % SUBCRIT"; a state's, the function alone. */
const criterionText = (criterion: FaceplateCriterion, pen: ComposedDisplayPen, chip: string): string => typeof criterion.value === 'boolean'
  ? chip
  : `${operatorWords[criterion.operator]} ${declared(criterion.value, pen.unit)}${unitLabel(pen.unit) === '' ? '' : ` ${unitLabel(pen.unit)}`} ${chip}`

const holds = (value: unknown, operator: FaceplateCriterion['operator'], limit: number | boolean): boolean | null => {
  if (operator === '==') return value === limit
  if (operator === '!=') return value !== limit
  if (typeof value !== 'number' || typeof limit !== 'number') return null
  return operator === '<' ? value < limit : operator === '<=' ? value <= limit : operator === '>' ? value > limit : value >= limit
}

/** A row's note on its first value: its safety function's criterion once the end has stopped, else its limit state, else where it stands off its span. */
const noteOf = (cell: FaceplateCell, criteria: ReadonlyArray<FaceplateCriterion>, chips: ReadonlyMap<string, SafetyFunctionChip>, raw: unknown): FaceplateNote | null => {
  const criterion = criteria.find(entry => entry.path === String(cell.pen.path))
  if (criterion !== undefined) {
    const text = criterionText(criterion, cell.pen, chips.get(criterion.safetyFunction)?.shortLabel ?? criterion.safetyFunction)
    // A state is a branch its tree takes, not a criterion failed; a number past its criterion challenges the function.
    const unmet = typeof criterion.value === 'number' && holds(raw, criterion.operator, criterion.value) === false
    return { forms: [text], tone: unmet ? 'unmet' : 'quiet', title: `${chips.get(criterion.safetyFunction)?.label ?? criterion.safetyFunction}: its status tree asks ${text.replace(/ \S+$/, '')}` }
  }
  const reading = cell.reading
  if (reading === null) return null
  const limit = shownLimit(reading)
  const range = reading.offScale === null ? [] : [`${reading.offScale} range`]
  if (limit === null && range.length === 0) return null
  const forms = limit === null ? range : limitStateForms(limit, cell.pen.unit, cell.pen.resolution).map(form => [...range, form].join(' · '))
  return { forms, tone: reading.offScale !== null || limit?.kind === 'past' ? 'beyond' : 'quiet', title: forms[0]! }
}

/** The bar of a value whose instrument declares a span; over decades it reads in powers of ten. */
const barOf = (cell: FaceplateCell, raw: unknown, sample: ComposedDisplaySample): FaceplateBar | null => {
  const span = cell.pen.limits?.instrumentSpan
  if (span === undefined || typeof raw !== 'number' || span.max <= span.min) return null
  const decades = logarithmicSpan(span)
  const at = (value: number): number => decades ? Math.log10(value) : displayValue(value, cell.pen.unit)
  const min = at(span.min)
  const max = at(span.max)
  const value = Math.min(max, Math.max(min, at(decades ? Math.max(raw, span.min) : raw)))
  // Each I&C limit in force that alarms or trips, as the zone beyond it; hinted until its rule acts.
  const advices = limitsInForce(cell.pen.thresholds, sample.mode, sampledGates(sample))
    .filter(threshold => threshold.kind !== 'control')
    .map((threshold): FaceplateAdvice => {
      const edge = Math.min(max, Math.max(min, at(threshold.value)))
      return { min: threshold.direction === 'high' ? edge : min, max: threshold.direction === 'high' ? max : edge, type: 'caution', hinted: cell.inAlarm?.ruleId !== threshold.ruleId }
    })
    .filter(advice => advice.max > advice.min)
  return { min, max, value, advices }
}

/** Tags shared by a loop table column's cells, the places where they differ written x: TE-411-HOT … TE-441-HOT read TE-4x1-HOT. */
export const sharedTag = (names: ReadonlyArray<string>): string => {
  const first = names[0] ?? ''
  if (names.some(name => name.length !== first.length)) return first
  return [...first].map((character, index) => names.every(name => name[index] === character) ? character : 'x').join('')
}

/** Two shared tags of one cell as one head, their common ending once: OTDT-4x1-MARGIN and OPDT-4x1-MARGIN read OTDT/OPDT-4x1-MARGIN. */
export const pairedTags = (tags: ReadonlyArray<string>): string => {
  if (tags.length < 2) return tags[0] ?? ''
  const parts = tags.map(tag => tag.split('-'))
  let common = 0
  while (common < parts[0]!.length - 1 && parts.every(segments => segments.length > common + 1 && segments.at(-1 - common) === parts[0]!.at(-1 - common))) common += 1
  if (common === 0) return tags.join(' / ')
  return `${parts.map(segments => segments.slice(0, segments.length - common).join('-')).join('/')}-${parts[0]!.slice(-common).join('-')}`
}

/** Where a comparison is one channel of a vote: how many hold of how many, and how many it needs. */
const voteText = (comparison: FaceplateComparison): string => comparison.vote === undefined ? '' : ` · ${comparison.vote.holding} of ${comparison.vote.of}, acts at ${comparison.vote.required}`

/** A comparison a rule is decided on, as its row names it: a state in its words, a number against its limit ("NIS-PR-AVG 100 % > 50 %"). */
const comparisonText = (comparison: FaceplateComparison, pens: ReadonlyMap<string, ComposedDisplayPen>, read: (path: string) => unknown): string | null => {
  const pen = pens.get(comparison.path)
  if (pen === undefined) return null
  const raw = read(comparison.path)
  if (typeof comparison.value === 'boolean') {
    // The state it holds, or, while it does not, the state it waits for.
    const wanted = (comparison.operator === '==') === comparison.value
    const words = typeof raw === 'boolean' && comparison.holds === true ? (raw ? pen.states?.on : pen.states?.off) : `${wanted ? pen.states?.on : pen.states?.off} awaited`
    return `${words ?? pen.described}${voteText(comparison)}`
  }
  const unit = unitLabel(pen.unit)
  return `${pen.tagId ?? pen.name} ${numberValue(pen, raw).text} ${operatorWords[comparison.operator]} ${declared(comparison.value, pen.unit)}${unit === '' ? '' : ` ${unit}`}${voteText(comparison)}`
}

/** The deciding readings a row names: those the panel resolves a pen for (compose.ts), in the order the rule decides on them. */
const decidingTexts = (comparisons: ReadonlyArray<FaceplateComparison>, pens: ReadonlyMap<string, ComposedDisplayPen>, read: (path: string) => unknown): ReadonlyArray<string> =>
  [...new Set(comparisons.flatMap(comparison => comparisonText(comparison, pens, read) ?? []))]

const headLine = (heads: ReadonlyArray<FaceplateHead & { readonly firstOutSinceMs?: number }>, chips: ReadonlyMap<string, SafetyFunctionChip>, sample: ComposedDisplaySample): FaceplateHeadLine => ({
  parts: heads.flatMap((head): FaceplateHeadLine['parts'] => {
    if (head.kind === 'safetyFunction') {
      const chip = chips.get(head.id)
      return chip === undefined ? [{ kind: 'words', text: head.title }] : [{ kind: 'chip', chip }]
    }
    if (head.kind === 'group' && head.firstOutSinceMs !== undefined) return [{ kind: 'words', text: head.title, since: `${alarmAge(sample.plantElapsedMs, head.firstOutSinceMs)} ago` }]
    return [{ kind: 'words', text: head.title }]
  }),
  sub: heads.flatMap(head => head.kind === 'circuit' ? [head.equipment.join(' · ')] : []).join(' · '),
})

/**
 * Each column of a faceplate as it reads in a display's sample: its head and
 * its one-line rows. A rule row names what decides it where the panel
 * resolves that reading; a loop table's idle column is drawn faint.
 */
export const faceplateLines = (
  panel: ComposedFaceplatePanel,
  sample: ComposedDisplaySample,
  history: FaceplateHistory,
): ReadonlyArray<FaceplateColumnLines> => {
  const live = faceplateLive(sample)
  const faceplate: Faceplate = faceplateNow(panel.faceplate, live)
  const pens = new Map(panel.pens.map(pen => [String(pen.path), pen] as const))
  const chips = new Map((sample.safetyFunctions ?? []).map(chip => [chip.id, chip] as const))
  const activeRuleIds = new Set((sample.alarms ?? []).filter(alarm => alarm.active).map(alarm => alarm.ruleId))
  const gates = sampledGates(sample)
  // The history the display keeps of a recorded value (composed-display-session.ts), as shown; none where it keeps none.
  const pointsOf = (pen: ComposedDisplayPen): ReadonlyArray<TrendPoint> | null => {
    const points = pen.recorded ? history.get(String(pen.path)) : undefined
    return points === undefined ? null : points.map(point => ({ t: point.t, v: shownReading(point.v, pen.resolution) }))
  }
  const cellOf = (path: string): FaceplateCell => {
    const pen = pens.get(path) ?? missing(path)
    const raw = live.read(path)
    const value = pen.valueKind === 'boolean' ? stateValue(pen, raw) : numberValue(pen, raw)
    const inAlarm = activeThreshold(pen.thresholds, activeRuleIds, sample.mode, gates)
    const reading = value.kind !== 'number' || typeof raw !== 'number' ? null : trendReading({
      value: shownReading(raw, pen.resolution),
      points: pointsOf(pen),
      windowMs: rateWindowMs(FACEPLATE_SPARKLINE_MS),
      unit: pen.unit,
      thresholds: pen.thresholds,
      mode: sample.mode,
      gates,
      activeRuleIds,
      resolution: pen.resolution,
      ...(pen.limits?.instrumentSpan === undefined ? {} : { span: pen.limits.instrumentSpan }),
    })
    return { pen, name: value.kind === 'state' ? '' : pen.tagId ?? pen.name, value, reading, inAlarm }
  }
  const alarmOf = (ruleId: string) => (sample.alarms ?? []).find(alarm => alarm.active && alarm.ruleId === ruleId)
  return faceplate.columns.map(column => {
    // The column's first reading draws its sparkline, and so does any value that moves.
    let firstReading = true
    const lineOf = (row: FaceplateRow): FaceplateLine => {
      if (row.kind === 'values' && row.strip === true) return stripOf(row.paths.map(path => pens.get(path) ?? missing(path)), live.read)
      if (row.kind === 'values') {
        const cells = row.paths.map(cellOf)
        const lead = cells[0]!
        const raw = live.read(String(lead.pen.path))
        const numeric = lead.value.kind === 'number' && lead.value.value !== null
        const moving = lead.reading?.travel === 'rising' || lead.reading?.travel === 'falling'
        const points = numeric ? pointsOf(lead.pen) : null
        const drawn = points !== null && (firstReading || moving)
        if (numeric) firstReading = false
        const limit = lead.reading === null ? null : shownLimit(lead.reading)
        return {
          kind: 'values',
          cells,
          note: noteOf(lead, row.criteria, chips, raw),
          bar: cells.length === 1 ? barOf(lead, raw, sample) : null,
          sparkline: drawn ? { pen: lead.pen, points: points!, limit: limit === null ? null : limit.margin.threshold, inAlarm: lead.inAlarm } : null,
        }
      }
      if (row.kind === 'rule') {
        const severity = alarmOf(row.rule)?.severity ?? 'critical'
        return { kind: 'rule', status: alertTypeOf(severity), title: row.title, firstOut: row.firstOut, deciding: decidingTexts(row.deciding, pens, live.read) }
      }
      if (row.kind === 'acting') return { kind: 'text', text: `+${row.count} acting`, title: `${row.count} more rules of this group acting` }
      if (row.kind === 'armed') return { kind: 'text', text: `+${row.count} armed`, title: `${row.count} rules of this group act in this mode with what arms them holding` }
      if (row.kind === 'consequence') {
        const deciding = decidingTexts(row.deciding, pens, live.read)
        const why = deciding.length === 0 ? '' : ` (${deciding.join(' · ')})`
        const whole = `→ ${row.action} · ${row.title} · ${row.status}`
        return {
          kind: 'consequence',
          forms: why === '' ? [whole] : [`${whole}${why}`, `→ ${row.action} · ${row.status}${why}`, whole],
          title: `${whole}${why}`,
          idle: row.status === 'idle',
        }
      }
      // A check not met says "not yet met": never "expected", which only a declaration of the I&C config could say.
      if (row.kind === 'check') return { kind: 'text', text: `○ ${row.label} · ${row.met === 'no' ? 'not yet met' : 'not known'}`, title: `${chips.get(row.safetyFunction)?.label ?? row.safetyFunction} check: ${row.label}` }
      // Folded: ✓ only while all are met; a compact faceplate names those not yet met on the same line, which wraps.
      if (row.kind === 'checks') return { kind: 'text', text: `${row.met === row.of ? '✓' : '○'} ${row.label} ${row.met}/${row.of}${row.notMet === undefined ? '' : ` · not yet met: ${row.notMet.map(label => label.includes(':') ? label.slice(label.indexOf(':') + 1).trim() : label).join('; ')}`}`, title: `${chips.get(row.safetyFunction)?.label ?? row.safetyFunction}: ${row.met} of the ${row.of} checks that apply are met${row.notMet === undefined ? '' : `; not yet met: ${row.notMet.join('; ')}`}` }
      if (row.kind === 'flows') {
        // One header's branches read at one resolution, the finest any of them declares: no "0.0000012 kg/s" beside "1512 kg/s".
        const branches = row.branches.map(branch => ({ ...branch, pen: pens.get(branch.path) ?? missing(branch.path) }))
        const resolutions = branches.flatMap(branch => branch.pen.resolution ?? [])
        const resolution = resolutions.length === 0 ? null : Math.min(...resolutions)
        return { kind: 'flows', parts: branches.map((branch, index) => `${index === 0 ? `${row.from} to: ` : ''}${branch.destination} ${numberValue(branch.pen, live.read(branch.path), resolution).text}`) }
      }
      return { kind: 'loops', table: loopTable(row, pens, live.read, activeRuleIds, sample, gates) }
    }
    // A value its controller holds: under its row, what it holds and to what, the only mode the model has.
    return { head: headLine(column.heads, chips, sample), lines: column.rows.flatMap(row => row.kind === 'values' && row.held !== undefined ? [lineOf(row), heldLine(row.held)] : [lineOf(row)]) }
  })
}

/** What a controller holds, in words: "pressure mode only, 7.6 MPa". */
const heldLine = (held: FaceplateHeld): FaceplateLine => ({
  kind: 'text',
  text: `${held.quantity} mode only, ${held.setpoint} ${held.unit}`,
  title: `Its controller positions it to hold the ${held.quantity} at ${held.setpoint} ${held.unit}: the only control mode the model has`,
})

/**
 * Parallel equipment's short names: the words that tell their labels apart,
 * the first as its initial before the last unless the last already begins
 * with it ("Shutdown bank SA position" SA, "Control bank C position" CC),
 * grouped by that first word.
 */
const shortNames = (labels: ReadonlyArray<string>): ReadonlyArray<{ readonly name: string; readonly group: string }> => {
  const words = labels.map(label => label.split(' '))
  const common = new Set(words[0]!.filter(word => words.every(other => other.includes(word))))
  return words.map(list => {
    const telling = list.filter(word => !common.has(word))
    const [first, ...rest] = telling
    const last = rest.at(-1)
    if (first === undefined) throw new Error('parallel readings with alike labels cannot be told apart')
    // An identifier that already carries its group's initial before its own letter (SA) keeps it; a bare letter (C) takes it (CC).
    return { group: first, name: last === undefined ? first : last.length > 1 && last.startsWith(first.charAt(0)) ? last : `${first.charAt(0)}${last}` }
  })
}

/** A strip: a thin bar each over its instrument's declared range, values printed only where one differs from the others. */
const stripOf = (pens: ReadonlyArray<ComposedDisplayPen>, read: (path: string) => unknown): FaceplateLine => {
  const names = shortNames(pens.map(pen => pen.label))
  const values = pens.map(pen => {
    const raw = read(String(pen.path))
    return typeof raw === 'number' ? shownReading(raw, pen.resolution) : null
  })
  const counts = new Map<number | null, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const usual = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]![0]
  const written = (pen: ComposedDisplayPen) => numberValue(pen, read(String(pen.path))).text.replace(/ $/, '')
  const bars = pens.map((pen, at) => {
    const span = pen.limits?.instrumentSpan ?? pen.limits?.hardRange
    if (span === undefined) throw new Error(`${pen.tagId ?? pen.name} declares no range to draw its bar over`)
    return { group: names[at]!.group, bar: { label: names[at]!.name, value: values[at]!, max: span.max, printed: values[at] !== usual ? written(pen) : null, title: `${pen.tagId ?? pen.name} · ${pen.label}: ${written(pen)}` } }
  })
  const groups = [...new Set(bars.map(entry => entry.group))].map(group => bars.filter(entry => entry.group === group).map(entry => entry.bar))
  return {
    kind: 'strip',
    groups,
    all: counts.size === 1 && usual !== null ? `all ${written(pens[0]!)}` : null,
    title: bars.map(entry => entry.bar.title).join('\n'),
  }
}

/** Every value a row shows has its pen (compose.ts resolves them with the faceplate): one without is a fault, never skipped. */
const missing = (path: string): never => { throw new Error(`the faceplate shows ${path}, which its panel resolves no pen for`) }

const loopTable = (
  row: FaceplateRow & { readonly kind: 'loops' },
  pens: ReadonlyMap<string, ComposedDisplayPen>,
  read: (path: string) => unknown,
  activeRuleIds: ReadonlySet<string>,
  sample: ComposedDisplaySample,
  gates: ReturnType<typeof sampledGates>,
): FaceplateLoopTable => {
  const columns = row.columns.map(column => {
    const cellPens = column.cells.map(cell => cell.map(path => pens.get(path) ?? missing(path)))
    const tags = (cellPens[0] ?? []).map((_, at) => sharedTag(cellPens.map(cell => cell[at]!.tagId ?? cell[at]!.label)))
    const units = [...new Set(cellPens.flat().map(pen => unitLabel(pen.unit)))]
    const labels = [...new Set(cellPens.flat().map(pen => pen.label))]
    return { head: pairedTags(tags), unit: units.length === 1 ? units[0]! : '', title: `${labels.join(' / ')}${column.idle ? ' · idle: no rule that judges it acts in this mode' : ''}`, idle: column.idle, blank: column.blank, cellPens }
  })
  return {
    columns: columns.map(({ head, unit, title, idle }) => ({ head, unit, title, idle })),
    rows: row.loops.map((loop, at) => ({
      loop,
      cells: columns.map(column => {
        const cellPens = column.cellPens[at]!
        // A number without the unit its column's head carries; a state in its words.
        const values = cellPens.map(pen => {
          const raw = read(String(pen.path))
          // A value that measures nothing now (delta-T power without forced flow) reads "—" in its place.
          if (column.blank.includes(String(pen.path))) return { text: '—', pen }
          if (pen.valueKind === 'boolean') return { text: stateWords(pen, raw), pen }
          const written = numberValue(pen, raw)
          return { text: column.unit === '' || written.value === null ? written.text : written.text.slice(0, -(column.unit.length + 1)), pen }
        })
        const alarms = cellPens.map(pen => activeThreshold(pen.thresholds, activeRuleIds, sample.mode, gates)).filter((threshold): threshold is ComposedDisplayThreshold => threshold !== null)
        const worst = alarms.sort((left, right) => severityRank(left) - severityRank(right))[0]
        return {
          text: values.map(value => value.text).join(' / '),
          title: values.map(value => `${value.pen.tagId ?? value.pen.name} ${value.text}${column.unit === '' ? '' : ` ${column.unit}`}`).join(' · '),
          alert: worst === undefined ? null : alertTypeOf(worst.severity ?? 'warning'),
        }
      }),
    })),
  }
}

const severityRank = (threshold: ComposedDisplayThreshold): number => ({ critical: 0, warning: 1, notice: 2, info: 3 } as const)[threshold.severity ?? 'warning']


/** The lines a column takes under its head: one per row, a loop table its head line and one per loop (faceplate-live.ts faceplateLines). */
export const columnLineCount = (column: FaceplateColumnLines): number =>
  column.lines.reduce((count, line) => count + (line.kind === 'loops' ? 1 + line.table.rows.length : 1), 0)

/**
 * Which of a value row's optional parts it keeps in its room, beside its
 * values (never shortened): its sparkline gives way first, then its bar,
 * then its note drops whole parts (its fullest form that fits), and goes
 * last. Widths in px; gap is the space between parts.
 */
export const fitValuesRow = (input: {
  readonly room: number
  readonly cells: number
  readonly gap: number
  readonly note: ReadonlyArray<number>
  readonly bar: number | null
  readonly sparkline: number | null
}): { readonly note: number | null; readonly bar: boolean; readonly sparkline: boolean } => {
  const { room, cells, gap } = input
  const shortestNote = input.note.length === 0 ? 0 : gap + input.note.at(-1)!
  const left = room - cells
  const sparkline = input.sparkline !== null && left - gap - input.sparkline - shortestNote - (input.bar === null ? 0 : gap + input.bar) >= 0
  const afterSparkline = left - (sparkline ? gap + input.sparkline! : 0)
  const bar = input.bar !== null && afterSparkline - gap - input.bar - shortestNote >= 0
  const forNote = afterSparkline - (bar ? gap + input.bar! : 0) - gap
  const note = input.note.findIndex(width => width <= forNote)
  return { note: note < 0 ? null : note, bar, sparkline }
}

/** The fullest wording of a row's optional readings that fits beside its words: whole readings, from the first, never cut. */
export const fitParts = (parts: ReadonlyArray<string>, fits: (text: string) => boolean, separator = ' · '): ReadonlyArray<string> => {
  for (let count = parts.length; count > 0; count -= 1) if (fits(parts.slice(0, count).join(separator))) return parts.slice(0, count)
  return []
}
