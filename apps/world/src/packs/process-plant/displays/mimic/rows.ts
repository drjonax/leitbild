import type { MimicFlowBinding, MimicFrame, MimicItemBinding, MimicRangeBinding, MimicShutdownBinding, MimicStubWord } from './bindings.ts'
import { flowLook, itemLook, powerLook, shutdownLook, type FlowLook, type ItemLook, type SampleIndex } from './evaluate.ts'
import type { MimicPipeState } from './mimic-model.ts'
import type { MimicPresentation } from './presentation.ts'
import { displayValue, logarithmicSpan, offScale, readingText, readingValueText, unitLabel } from '../display-text.ts'

// The text rows beside a drawn item, shared by the server (which reserves
// their room before any sample exists) and the embed (which fills them). A
// row's possible texts are known in advance, so the drawing never moves when
// a state changes; an abnormal row (STOP, POS ?, a disagreeing command) is
// never dropped to make room.

export type MimicRow =
  /**
   * A key value with its unit, and the span its instrument indicates over: at
   * an end of it the row reads the instrument that reads the same quantity
   * over a wider span (`wider`, WR), where the equipment declares one, else
   * the end itself ("<0 %"), never a value the quantity may be far beyond.
   */
  | {
    readonly kind: 'value'
    readonly path: string
    readonly unit: string
    /** What it measures, before the value, where its unit does not say (MimicValueBinding.letters). */
    readonly letters?: string
    readonly required: boolean
    readonly span?: { readonly min: number; readonly max: number }
    readonly wider?: { readonly path: string; readonly span: { readonly min: number; readonly max: number } }
    /**
     * On a device, the integer digits its readout reserves: those of the
     * widest value its instrument declares it reads over (a generator's
     * 1300 MW), which a device's value row needs declared.
     */
    readonly digits?: number
  }
  | { readonly kind: 'position'; readonly required: true }
  /**
   * The state in a word where the symbol alone could be misread: RUN or
   * STOP, ?, DEAD, POS ?; or the words its equipment declares for its state
   * signal (`words`: ON LINE and OFF LINE for a generator on its breaker).
   */
  | { readonly kind: 'state'; readonly texts: ReadonlyArray<string>; readonly words?: { readonly on: string; readonly off: string }; readonly required: true }
  /**
   * A flag that says the item has stopped (MimicShutdownBinding), in its
   * declared words, on two lines: empty while it has not and nothing
   * commands it to; its word once it has ("Rods on bottom"); and while a
   * trip's command to stop it stands unmet, its other word over that command
   * ("Rods off bottom", "CMD trip"), so a trip the item does not follow
   * never reads as an empty row (HF review: an absent "Rods on bottom" is no
   * cue of a failed trip). A vessel writes them like its tag, so they fit
   * the column beside a hub's lanes.
   */
  | { readonly kind: 'shutdown'; readonly part: 'word' | 'command'; readonly flag: MimicShutdownBinding; readonly texts: ReadonlyArray<string>; readonly required: true }
  /**
   * A quantity its instruments read in turn (MimicRangeBinding), on the
   * instrument that reads it now: the widest whose flag holds, else the
   * narrowest ("PWR 100 %", "6.9×10⁻⁷ A", "24000 cps"); a reading over
   * decades in powers of ten. `texts` are the widest it can write, for its
   * room. A vessel writes it like its tag, so it fits the column beside a
   * hub's lanes.
   */
  | { readonly kind: 'range'; readonly chain: MimicRangeBinding; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** What passes an item whose position is not computed: PASSING or NO FLOW. */
  | { readonly kind: 'throughput'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** A command the item does not follow: CMD 100 %, CMD RUN, CMD SHUT. */
  | { readonly kind: 'mismatch'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** Stacked commands: the row above says CMD where the item disagrees, and this row the command (RUN, STOP). */
  | { readonly kind: 'commandValue'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /**
   * A valve marker's text. What the valve does comes first (`word`): SHUT,
   * OPEN, or its opening while it stands between them (35 %), or POS ?
   * where its position is not known, so no valve is drawn by its icon alone
   * (HMI review of run 23: feed regulating and main steam isolation valves
   * read by icon only). A command it does not follow follows, CMD
   * (`command`) over its value (`value`: 100 %), never in place of what it
   * does. A valve without a command says the same of its position (`whole`).
   */
  | { readonly kind: 'marker'; readonly part: 'word' | 'command' | 'value' | 'whole'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /**
   * Under a framed vessel's values: the action of the alarm its flap names,
   * where the frame is too narrow for the whole flap ("RX TRIP" under "PWR
   * HI-HI"), or how many other alarms of its own are active ("+2 alarms").
   * Empty while there is nothing to say; a device says the same on its
   * flap's further lines (MimicDrawnItem.flapLines).
   */
  | { readonly kind: 'alarm'; readonly part: FlapPart; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** Grouped parallel equipment: how many members are in the state the group is drawn by ("RUN 1/2"), or, with none in it, how many are in the other ("STOP 2/2"). */
  | { readonly kind: 'count'; readonly members: ReadonlyArray<MimicItemBinding>; readonly word: string; readonly texts: ReadonlyArray<string>; readonly required: true }

const POSITION_COMMANDS = ['CMD SHUT', 'CMD OPEN', 'CMD 100 %', 'CMD 10 %']
/** What a position command can be, without its CMD (evaluate.ts commandText). */
const COMMANDED_POSITIONS = POSITION_COMMANDS.map(text => text.slice('CMD '.length))
const RUNNING_COMMANDS = ['CMD RUN', 'CMD STOP']
/** A breaker's commands (evaluate.ts commandText). */
const BREAKER_COMMANDS = ['CMD CLOSE', 'CMD OPEN']
/** A digital valve reads shut below and open above these positions (evaluate.ts); between, a marker shows its opening. */
const SHUT_BELOW = 0.05
const OPEN_ABOVE = 0.95
/** The widest opening a marker can show. */
const WIDEST_OPENING = '95 %'

/** The word a group counts its members by, per state aspect; aspects without one are not grouped. */
export const COUNT_WORDS: Readonly<Partial<Record<string, string>>> = { running: 'RUN', energized: 'LIVE', position: 'OPEN' }
/** The state word for a member not in the counted state, as a single item's row says it (RUN and STOP, OPEN and SHUT). */
const OTHER_WORDS: Readonly<Record<string, string>> = { RUN: 'STOP', LIVE: 'DEAD', OPEN: 'SHUT', CLOSED: 'OPEN' }

/** Whether an item's position is a breaker's contacts, closed while its state reads true. */
const switching = (binding: MimicItemBinding): boolean => binding.state?.state?.reading === 'closedWhileTrue'

/** What a trip's command to stop an item says beside the flag's other word while it stands unmet. */
export const SHUTDOWN_COMMAND = 'CMD trip'

/** A flag's two shutdown rows: its word (its other word only where a trip commands it), and the command where one does. */
const shutdownRows = (flag: MimicShutdownBinding): ReadonlyArray<MimicRow> => flag.demands.length === 0
  ? [{ kind: 'shutdown', part: 'word', flag, texts: [flag.words.on, '?'], required: true }]
  : [
      { kind: 'shutdown', part: 'word', flag, texts: [flag.words.on, flag.words.off, '?'], required: true },
      { kind: 'shutdown', part: 'command', flag, texts: [SHUTDOWN_COMMAND], required: true },
    ]

/** Whether any of an item's shutdown rows stands commanded and unmet for one sample: the item is outlined as not following its command. */
export const shutdownDemanded = (rows: ReadonlyArray<MimicRow>, index: SampleIndex): boolean =>
  rows.some(row => row.kind === 'shutdown' && row.part === 'word' && shutdownLook(row.flag, index) === 'demanded')

/** A range row's widest texts: every instrument's span ends, and the widest value its span's decades or digits can write. */
const rangeTexts = (chain: MimicRangeBinding): ReadonlyArray<string> => ['?', '—', ...chain.steps.flatMap(step => {
  const lettered = (text: string): string => (step.letters === undefined ? text : `${step.letters} ${text}`)
  const span = step.span
  if (span === undefined) return [lettered(readingText(888.8, step.unit, null, undefined))]
  // Over decades, each power of ten it spans with the widest mantissa; else a value just under each power of ten up to its top.
  const low = logarithmicSpan(span) ? Math.floor(Math.log10(span.min)) : -1
  const high = Math.ceil(Math.log10(Math.max(Math.abs(span.max), 1)))
  const samples = Array.from({ length: high - low + 1 }, (_, at) => 8.8 * 10 ** (low + at)).filter(value => value > span.min && value < span.max)
  return [span.min, span.max, ...samples].map(value => lettered(readingText(value, step.unit, null, span)))
})]

/** Which instrument of a range row reads now: the widest whose flag holds, else the narrowest; null where a flag is not known. */
const rangeStep = (chain: MimicRangeBinding, index: SampleIndex): MimicRangeBinding['steps'][number] | null => {
  for (let at = chain.steps.length - 1; at > 0; at -= 1) {
    const flag = index.get(String(chain.steps[at - 1]!.widerWhile))?.value
    if (typeof flag !== 'boolean') return null
    if (flag) return chain.steps[at]!
  }
  return chain.steps[0]!
}

/** A range row's text for one sample: the reading instrument's value, "—" where it measures nothing now, "?" where it is not known. */
export const rangeText = (chain: MimicRangeBinding, index: SampleIndex): string => {
  const step = rangeStep(chain, index)
  if (step === null) return '?'
  if (step.meaningful !== undefined && index.get(String(step.meaningful))?.value !== true) return '—'
  const entry = index.get(String(step.path))
  if (entry === undefined || typeof entry.value !== 'number' || entry.quality === 'outside-hard-range') return '?'
  const text = readingText(entry.value, step.unit, null, step.span)
  return step.letters === undefined ? text : `${step.letters} ${text}`
}

/** The digits of the widest whole value a range reaches, in the unit it is shown in. */
const integerDigits = (range: { readonly min: number; readonly max: number }, unit: string): number =>
  Math.max(...[range.min, range.max].map(bound => String(Math.round(Math.abs(displayValue(bound, unit)))).length + (bound < 0 ? 1 : 0)))

// The state word leads, as on a single item, so "0/2 RUN" never reads as running (QA review of run 22).
const countTexts = (members: number, word: string): ReadonlyArray<string> =>
  [word, OTHER_WORDS[word]!].flatMap(state => [`${state} ${members}/${members}`, `${state} ${members}/${members} ?`])

/**
 * The rows beside an item. A valve drawn as a marker has the one or two short
 * rows its bindings let it fill; a group of parallel members has its count,
 * and a disagreeing command of any member.
 */
export const itemRows = (
  binding: MimicItemBinding,
  presentation: MimicPresentation,
  options: { readonly marker: boolean; readonly members: ReadonlyArray<MimicItemBinding>; readonly commands: 'inline' | 'stacked'; readonly offSpan: 'end' | 'wider' },
): ReadonlyArray<MimicRow> => {
  const stacked = options.commands === 'stacked'
  const valuesOf = (commands: ReadonlyArray<string>): ReadonlyArray<string> => commands.map(text => text.slice('CMD '.length))
  if (options.members.length > 1) {
    const aspect = binding.state?.aspect
    // Breakers are counted by how many are closed.
    const word = aspect === undefined ? undefined : switching(binding) ? 'CLOSED' : COUNT_WORDS[aspect]
    if (word === undefined) throw new Error(`a group of ${binding.label} has no state to count its members by`)
    const commanded = options.members.some(member => member.state?.command !== undefined)
    const commands = aspect === 'running' ? RUNNING_COMMANDS : switching(binding) ? BREAKER_COMMANDS : POSITION_COMMANDS
    return [
      { kind: 'count', members: options.members, word, texts: countTexts(options.members.length, word), required: true },
      ...(!commanded ? [] : stacked
        ? [{ kind: 'state' as const, texts: ['CMD'], required: true as const }, { kind: 'commandValue' as const, texts: valuesOf(commands), required: true as const }]
        : [{ kind: 'mismatch' as const, texts: commands, required: true as const }]),
    ]
  }
  if (options.marker) {
    // A marker reserves only what its bindings let it say.
    const state = binding.state
    if (state === null || state.aspect !== 'position') return []
    const computed = state.state !== undefined
    if (state.command === undefined) return [{ kind: 'marker', part: 'whole', texts: computed ? ['POS ?', WIDEST_OPENING, 'SHUT', 'OPEN'] : ['POS ?'], required: true }]
    return [
      { kind: 'marker', part: 'word', texts: ['POS ?', ...(computed ? [WIDEST_OPENING, 'SHUT', 'OPEN'] : [])], required: true },
      { kind: 'marker', part: 'command', texts: ['CMD'], required: true },
      { kind: 'marker', part: 'value', texts: COMMANDED_POSITIONS, required: true },
    ]
  }
  const state = binding.state
  const device = presentation.element === 'device'
  const valueRow = (value: MimicItemBinding['values'][number], required: boolean): MimicRow => ({
    kind: 'value',
    path: value.path,
    unit: value.unit,
    ...(value.letters === undefined ? {} : { letters: value.letters }),
    required,
    ...(value.span === undefined ? {} : { span: value.span }),
    ...(value.wider === undefined || options.offSpan !== 'wider' ? {} : { wider: { path: value.wider.path, span: value.wider.span } }),
    ...(!device || value.range === undefined ? {} : { digits: integerDigits(value.range, value.unit) }),
  })
  const ranges: ReadonlyArray<MimicRow> = binding.ranges.map(chain => ({ kind: 'range', chain, texts: rangeTexts(chain), required: true }))
  const shutdown = binding.shutdown.flatMap(shutdownRows)
  if (!device || state === null) return [...binding.values.map((value, index) => valueRow(value, index === 0)), ...ranges, ...shutdown]
  // A device's key values follow what its state rows say, each sized for the
  // widest value its instrument declares it reads (a generator's MW, a
  // diesel's kW); one that declares no such range has no row. They go before
  // anything else when a drawing has no room.
  const after = [...binding.values.flatMap(value => value.range === undefined ? [] : [valueRow(value, false)]), ...ranges, ...shutdown]
  return [...stateRows(binding, state, stacked, valuesOf), ...after]
}

// What a device says of its state, before its values.
const stateRows = (
  binding: MimicItemBinding,
  state: NonNullable<MimicItemBinding['state']>,
  stacked: boolean,
  valuesOf: (commands: ReadonlyArray<string>) => ReadonlyArray<string>,
): ReadonlyArray<MimicRow> => {
  // Its equipment's words for its state signal, where it declares them, else the aspect's own.
  const worded = (on: string, off: string): Pick<Extract<MimicRow, { kind: 'state' }>, 'texts' | 'words'> =>
    state.words === undefined ? { texts: [on, off, '?'] } : { texts: [state.words.on, state.words.off, '?'], words: state.words }
  // Running equipment says RUN in words as stopped equipment says STOP: an
  // icon's fill alone does not tell the two apart for every reader (HMI review, run 22).
  if (state.aspect === 'running') {
    const running = worded('RUN', 'STOP')
    if (!stacked) return [{ kind: 'state', ...running, texts: [...running.texts, ...RUNNING_COMMANDS], required: true }]
    // Stacked rows reserve only what the item's bindings let it say: no command, no CMD.
    if (state.command === undefined) return [{ kind: 'state', ...running, required: true }]
    return [{ kind: 'state', ...running, texts: [...running.texts, 'CMD'], required: true }, { kind: 'commandValue', texts: valuesOf(RUNNING_COMMANDS), required: true }]
  }
  // A source or supply says LIVE as it says DEAD (HMI review of run 23: the grid and the auxiliary transformer drawn without a state).
  if (state.aspect === 'energized') return [{ kind: 'state', ...worded('LIVE', 'DEAD'), required: true }]
  if (switching(binding)) {
    // No symbol shows a breaker's contacts, so its first row always says them; a command it does not follow follows.
    const contacts: MimicRow = { kind: 'state', ...worded('CLOSED', 'OPEN'), required: true }
    if (state.command === undefined) return [contacts]
    return stacked
      ? [contacts, { kind: 'state', texts: ['CMD'], required: true }, { kind: 'commandValue', texts: valuesOf(BREAKER_COMMANDS), required: true }]
      : [contacts, { kind: 'mismatch', texts: BREAKER_COMMANDS, required: true }]
  }
  if (state.aspect === 'position' && state.state === undefined) {
    // The model does not compute the position: say so, and what passes.
    return [
      { kind: 'state', texts: ['POS ?'], required: true },
      ...(state.throughput === undefined ? [] : [{ kind: 'throughput' as const, texts: ['PASSING', 'NO FLOW', '?'], required: true as const }]),
      ...(state.command === undefined ? [] : [{ kind: 'mismatch' as const, texts: POSITION_COMMANDS, required: true as const }]),
    ]
  }
  if (state.aspect === 'position') {
    return [
      { kind: 'position', required: true },
      ...(state.command === undefined ? [] : [{ kind: 'mismatch' as const, texts: POSITION_COMMANDS, required: true as const }]),
    ]
  }
  return []
}

/** What a row shows for one sample; empty when there is nothing to say (a fully open valve). */
export const rowText = (row: MimicRow, look: ItemLook, index: SampleIndex, format: (value: number, unit: string) => string): string => {
  if (row.kind === 'marker') {
    const opening = look.state.kind === 'position' && look.state.fraction >= SHUT_BELOW && look.state.fraction <= OPEN_ABOVE ? `${Math.round(look.state.fraction * 100)} %` : ''
    const unknown = look.state.kind === 'unknown' || look.notMeasured
    if (row.part === 'command') return look.mismatch === null ? '' : 'CMD'
    if (row.part === 'value') return look.mismatch === null ? '' : look.mismatch.slice('CMD '.length)
    if (unknown) return 'POS ?'
    const settled = look.state.kind === 'position' && look.state.fraction < SHUT_BELOW ? 'SHUT' : 'OPEN'
    return opening === '' ? settled : opening
  }
  if (row.kind === 'count') {
    // RUN 1/2 while any member runs; STOP 2/2 while none does, counting those known stopped.
    const looks = row.members.map(member => itemLook(member, index))
    const counted = looks.filter(member => counts(member, row.word)).length
    const unknown = looks.filter(member => member.state.kind === 'unknown').length
    const known = counted > 0 ? `${row.word} ${counted}` : `${OTHER_WORDS[row.word]!} ${looks.length - unknown}`
    return `${known}/${row.members.length}${unknown > 0 ? ' ?' : ''}`
  }
  if (row.kind === 'value') {
    const reading = valueRowReading(row, index)
    if (reading === null) return '—'
    const lettered = (text: string): string => (row.letters === undefined ? text : `${row.letters} ${text}`)
    if (!reading.wider) return lettered(reading.end === null ? format(reading.value, row.unit) : readingText(reading.value, row.unit, null, reading.span))
    const unit = unitLabel(row.unit)
    const shown = reading.end === null ? String(Math.round(displayValue(reading.value, row.unit))) : readingValueText(reading.value, row.unit, null, reading.span)
    return `${WIDER_RANGE} ${shown}${unit === '' ? '' : ` ${unit}`}`
  }
  if (row.kind === 'position') {
    if (look.state.kind === 'unknown') return 'POS ?'
    if (look.state.kind !== 'position') return ''
    const fraction = look.state.fraction
    return fraction >= SHUT_BELOW && fraction <= OPEN_ABOVE ? format(fraction, 'fraction') : fraction < SHUT_BELOW ? 'SHUT' : 'OPEN'
  }
  if (row.kind === 'mismatch') return look.mismatch ?? ''
  // What a framed item says of its alarms depends on the alarms, not the sample: the drawing writes it (flapTexts).
  if (row.kind === 'alarm') return ''
  if (row.kind === 'commandValue') return look.mismatch === null ? '' : look.mismatch.slice('CMD '.length)
  if (row.kind === 'throughput') return look.state.kind === 'passing' ? 'PASSING' : look.state.kind === 'notPassing' ? 'NO FLOW' : '?'
  if (row.kind === 'range') return rangeText(row.chain, index)
  if (row.kind === 'shutdown') {
    const stopped = shutdownLook(row.flag, index)
    if (row.part === 'command') return stopped === 'demanded' ? SHUTDOWN_COMMAND : ''
    return stopped === 'stopped' ? row.flag.words.on : stopped === 'demanded' ? row.flag.words.off : stopped === 'unknown' ? '?' : ''
  }
  if (row.texts.includes('POS ?')) return 'POS ?'
  // The state word, unless the symbol disagrees with its command: then the command, or CMD over it.
  if (look.mismatch !== null && row.texts.includes(look.mismatch)) return look.mismatch
  if (look.mismatch !== null && row.texts.includes('CMD')) return 'CMD'
  const on = look.state.kind === 'running' || look.state.kind === 'energized' || look.state.kind === 'closed'
  const off = look.state.kind === 'stopped' || look.state.kind === 'dead' || look.state.kind === 'open'
  if (row.kind === 'state' && row.words !== undefined) return on ? row.words.on : off ? row.words.off : look.state.kind === 'unknown' ? '?' : ''
  const word = look.state.kind === 'running' ? 'RUN' : look.state.kind === 'stopped' ? 'STOP' : look.state.kind === 'energized' ? 'LIVE' : look.state.kind === 'dead' ? 'DEAD' : look.state.kind === 'unknown' ? '?'
    : look.state.kind === 'closed' ? 'CLOSED' : look.state.kind === 'open' ? 'OPEN' : ''
  return row.texts.includes(word) ? word : ''
}

/** The words a power line's far end says of its state after its name ("from UAT · LIVE"), as a supply's symbol says it. */
export const POWER_STATE_WORDS: ReadonlyArray<string> = ['LIVE', 'DEAD', '?']

/** A power line's far end in words: LIVE, DEAD, or ? where it is not known. */
export const powerStateWord = (look: 'live' | 'dead' | 'unknown'): string => look === 'live' ? 'LIVE' : look === 'dead' ? 'DEAD' : '?'

/** What a power stub says of lines to or from equipment that declares no energized state: supplied, or no supply. */
export const SUPPLY_WORDS: ReadonlyArray<string> = ['supplied', 'no supply', '?']

/**
 * Every text a power stub's word can show, for its room: LIVE, DEAD or ?
 * for the equipment it names, and with several named, how many are live
 * ("LIVE 1/2"); or the supply words.
 */
export const stubWordTexts = (word: MimicStubWord): ReadonlyArray<string> => word.kind === 'supply'
  ? SUPPLY_WORDS
  : ['LIVE', 'DEAD', '?', ...(word.energized.length > 1 ? [`LIVE ${word.energized.length - 1}/${word.energized.length}`] : [])]

/**
 * What a power stub says under its name for one sample (MimicStubWord):
 * the named equipment LIVE or DEAD, all of it; with several named and some
 * live, how many ("LIVE 1/2"); ? where any is not known. Lines to
 * equipment without a state of its own: supplied while any is live, else
 * no supply.
 */
export const stubWordText = (word: MimicStubWord, index: SampleIndex): string => {
  const read = (path: string): boolean | null => {
    const value = index.get(path)?.value
    return typeof value === 'boolean' ? value : null
  }
  if (word.kind === 'supply') {
    const look = powerLook(word.lines, index)
    return look === 'live' ? 'supplied' : look === 'dead' ? 'no supply' : '?'
  }
  const states = word.energized.map(read)
  if (states.includes(null)) return '?'
  const live = states.filter(Boolean).length
  return live === states.length ? 'LIVE' : live === 0 ? 'DEAD' : `LIVE ${live}/${states.length}`
}

/** What a value row reading the wider instrument says before its value, read in whole units: the wide range. */
export const WIDER_RANGE = 'WR'

/**
 * What a value row reads for one sample: its own value; at an end of its
 * instrument's span, the instrument that reads the same quantity over a wider
 * span, where it has one (a steam generator's narrow-range level at 0 % reads
 * its wide range), else the end (`end`: shown "<0 %", in low-integrity style).
 * Null where the value is not read.
 */
export const valueRowReading = (row: Extract<MimicRow, { kind: 'value' }>, index: SampleIndex): {
  readonly path: string
  readonly value: number
  readonly end: 'below' | 'above' | null
  readonly span: { readonly min: number; readonly max: number } | undefined
  readonly wider: boolean
} | null => {
  const read = (path: string): number | null => {
    const entry = index.get(path)
    return entry !== undefined && typeof entry.value === 'number' && entry.quality !== 'outside-hard-range' ? entry.value : null
  }
  const value = read(row.path)
  if (value === null) return null
  const end = offScale(value, row.span)
  const wider = end === null || row.wider === undefined ? null : read(row.wider.path)
  return wider === null || row.wider === undefined
    ? { path: row.path, value, end, span: row.span, wider: false }
    : { path: row.wider.path, value: wider, end: offScale(wider, row.wider.span), span: row.wider.span, wider: true }
}

/** What a framed item says of its alarms besides its flap: the flap's action where the frame is too narrow for it whole, and the count of the others. */
export type FlapPart = 'action' | 'count'

/** The other active alarms on a framed item, spelled out under its flap: "+1 alarm", "+2 alarms". */
export const flapCount = (others: number): string => `+${others} alarm${others === 1 ? '' : 's'}`

/**
 * What a framed item shows of its most severe active alarm (`frame`) and
 * the others: the whole flap where the frame is wide enough for it
 * (`fits`), else what it watches, with the action on the line the item
 * reserves for it (`places`); and how many others, on the line it reserves
 * for them, else after the flap where that fits. Each part's text is empty
 * where it has nothing to say.
 */
export const flapTexts = (
  frame: Pick<MimicFrame, 'flap' | 'watches' | 'action'>,
  others: number,
  fits: (text: string) => boolean,
  places: ReadonlyArray<FlapPart>,
): { readonly flap: string; readonly parts: Readonly<Record<FlapPart, string>> } => {
  const whole = fits(frame.flap) || frame.action === undefined
  const head = whole ? frame.flap : frame.watches
  const count = others === 0 ? '' : flapCount(others)
  const counted = count !== '' && !places.includes('count') && fits(`${head} ${count}`) ? `${head} ${count}` : head
  return { flap: counted, parts: { action: whole || !places.includes('action') ? '' : frame.action!, count: places.includes('count') ? count : '' } }
}

/** Where an item says its flap's action and its count of other alarms: a device's flap lines, a vessel's alarm rows. */
export const flapPlaces = (item: { readonly flapLines: ReadonlyArray<FlapPart>; readonly rows: ReadonlyArray<MimicRow> }): ReadonlyArray<FlapPart> =>
  [...item.flapLines, ...item.rows.flatMap(row => (row.kind === 'alarm' ? [row.part] : []))]

/** Whether a member's look is in the state its group counts by. */
const counts = (look: ItemLook, word: string): boolean =>
  word === 'RUN' ? look.state.kind === 'running' : word === 'LIVE' ? look.state.kind === 'energized' : word === 'CLOSED' ? look.state.kind === 'closed'
    : look.state.kind === 'position' && look.state.fraction >= SHUT_BELOW

/**
 * How a drawn item looks for one sample: its own look, or for a group the
 * look of its members together. A group shows its state while any member is
 * in it (one of two feed pumps running still feeds), is unknown when no member
 * is in it and any is unknown, and carries the first command a member does not
 * follow; its count row says how many.
 */
export const drawnLook = (binding: MimicItemBinding, rows: ReadonlyArray<MimicRow>, index: SampleIndex): ItemLook => {
  const count = rows.find((row): row is Extract<MimicRow, { kind: 'count' }> => row.kind === 'count')
  if (count === undefined) return itemLook(binding, index)
  const looks = count.members.map(member => itemLook(member, index))
  const counted = looks.filter(look => counts(look, count.word))
  const mismatch = looks.find(look => look.mismatch !== null)?.mismatch ?? null
  const words = `${counted.length} of ${looks.length} ${count.word === 'RUN' ? 'running' : count.word === 'LIVE' ? 'energized' : count.word === 'CLOSED' ? 'closed' : 'open'}${mismatch === null ? '' : `; a member is ${mismatch.replace('CMD', 'commanded').toLowerCase()}`}`
  const state = counted[0]?.state ?? (looks.some(look => look.state.kind === 'unknown') ? { kind: 'unknown' as const } : looks[0]!.state)
  return { state, notMeasured: looks.some(look => look.notMeasured), mismatch, words }
}

/**
 * How a drawn item stands out (ISA-101): framed in its alarm's colour while
 * an alarm of its own is active; outlined as abnormal, in no alarm colour,
 * while it (or a member of its group) does not follow its command, so the
 * cause of an upset shows on the drawing before any alarm it leads to, as
 * while a trip's command to stop it stands unmet (`demanded`,
 * shutdownDemanded); drawn as normal otherwise.
 */
export const itemTreatment = (look: ItemLook, alarmed: boolean, demanded = false): 'alarm' | 'abnormal' | 'normal' =>
  alarmed ? 'alarm' : look.mismatch !== null || demanded ? 'abnormal' : 'normal'

/** A pipe standing for parallel pipes carries flow while any of them does; it is unknown when none does and any is unknown. */
export const bundleFlowLook = (flows: ReadonlyArray<MimicFlowBinding>, index: SampleIndex): FlowLook => {
  const looks = flows.map(flow => flowLook(flow, index))
  const order: ReadonlyArray<FlowLook['look']> = ['forward', 'reverse', 'flowing', 'unknown', 'none']
  return looks.reduce((best, look) => (order.indexOf(look.look) < order.indexOf(best.look) ? look : best))
}

/**
 * How a drawn pipe looks: one pipe's own state, or for a stub, every line it
 * stands for together, so a bus fed from its diesel reads live though its
 * offsite feeder is dead.
 */
export const pipeStatesLook = (states: ReadonlyArray<MimicPipeState>, index: SampleIndex): FlowLook['look'] | 'live' | 'dead' => {
  const power = states.flatMap(state => state.kind === 'power' ? [state.energizedPath] : [])
  const fluid = states.flatMap(state => state.kind === 'fluid' ? [state.flow, ...state.parallel] : [])
  if (power.length > 0 && fluid.length > 0) throw new Error('a drawn pipe cannot carry both power and fluid')
  return power.length > 0 ? powerLook(power, index) : bundleFlowLook(fluid, index).look
}

export const itemRowTexts = (binding: MimicItemBinding, presentation: MimicPresentation, rows: ReadonlyArray<MimicRow>, index: SampleIndex, format: (value: number, unit: string) => string): ReadonlyArray<string> => {
  const look = drawnLook(binding, rows, index)
  return rows.map(row => rowText(row, look, index, format))
}
