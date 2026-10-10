import type { MimicFlowBinding, MimicItemBinding } from './bindings.ts'
import { flowLook, itemLook, type FlowLook, type ItemLook, type SampleIndex } from './evaluate.ts'
import type { MimicPresentation } from './presentation.ts'

// The text rows beside a drawn item, shared by the server (which reserves
// their room before any sample exists) and the embed (which fills them). A
// row's possible texts are known in advance, so the drawing never moves when
// a state changes; an abnormal row (STOP, POS ?, a disagreeing command) is
// never dropped to make room.

export type MimicRow =
  /** A value with its unit, from a key value or a valve's partial opening. */
  | { readonly kind: 'value'; readonly path: string; readonly unit: string; readonly required: boolean }
  | { readonly kind: 'position'; readonly required: true }
  /** The state in a word where the symbol alone could be misread: STOP, ?, DEAD, POS ?. */
  | { readonly kind: 'state'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** What passes an item whose position is not computed: PASSING or NO FLOW. */
  | { readonly kind: 'throughput'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** A command the item does not follow: CMD 100 %, CMD RUN, CMD SHUT. */
  | { readonly kind: 'mismatch'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** Stacked commands: the row above says CMD where the item disagrees, and this row the command (RUN, STOP). */
  | { readonly kind: 'commandValue'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /**
   * A valve marker's text, empty while the valve is quiet. What the valve
   * does comes first (`word`): its opening while it stands between shut and
   * open (35 %), SHUT or OPEN where it disagrees with its command, or POS ?
   * where its position is not known. A command it does not follow follows,
   * CMD (`command`) over its value (`value`: 100 %), never in place of what
   * it does. A valve without a command says only what its position allows
   * (`whole`).
   */
  | { readonly kind: 'marker'; readonly part: 'word' | 'command' | 'value' | 'whole'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** Grouped parallel equipment: how many members are in the state the group is drawn by ("1/2 RUN"). */
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

/** Whether an item's position is a breaker's contacts, closed while its state reads true. */
const switching = (binding: MimicItemBinding): boolean => binding.state?.state?.reading === 'closedWhileTrue'

const countTexts = (members: number, word: string): ReadonlyArray<string> => [`${members}/${members} ${word}`, `${members}/${members} ${word} ?`]

/**
 * The rows beside an item. A valve drawn as a marker has the one or two short
 * rows its bindings let it fill; a group of parallel members has its count,
 * and a disagreeing command of any member.
 */
export const itemRows = (
  binding: MimicItemBinding,
  presentation: MimicPresentation,
  options: { readonly marker: boolean; readonly members: ReadonlyArray<MimicItemBinding>; readonly commands: 'inline' | 'stacked' },
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
    if (state.command === undefined) return [{ kind: 'marker', part: 'whole', texts: computed ? ['POS ?', WIDEST_OPENING] : ['POS ?'], required: true }]
    return [
      { kind: 'marker', part: 'word', texts: ['POS ?', ...(computed ? [WIDEST_OPENING, 'SHUT', 'OPEN'] : [])], required: true },
      { kind: 'marker', part: 'command', texts: ['CMD'], required: true },
      { kind: 'marker', part: 'value', texts: COMMANDED_POSITIONS, required: true },
    ]
  }
  const state = binding.state
  const values: ReadonlyArray<MimicRow> = binding.values.map((value, index) => ({ kind: 'value', path: value.path, unit: value.unit, required: index === 0 }))
  if (presentation.element !== 'device' || state === null) return values
  if (state.aspect === 'running') {
    if (!stacked) return [{ kind: 'state', texts: ['STOP', '?', ...RUNNING_COMMANDS], required: true }]
    // Stacked rows reserve only what the item's bindings let it say: no command, no CMD.
    if (state.command === undefined) return [{ kind: 'state', texts: ['STOP', '?'], required: true }]
    return [{ kind: 'state', texts: ['STOP', '?', 'CMD'], required: true }, { kind: 'commandValue', texts: valuesOf(RUNNING_COMMANDS), required: true }]
  }
  if (state.aspect === 'energized') return [{ kind: 'state', texts: ['DEAD', '?'], required: true }]
  if (switching(binding)) {
    // No symbol shows a breaker's contacts, so its first row always says them; a command it does not follow follows.
    const contacts: MimicRow = { kind: 'state', texts: ['CLOSED', 'OPEN', '?'], required: true }
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
  return values
}

/** What a row shows for one sample; empty when there is nothing to say (a fully open valve). */
export const rowText = (row: MimicRow, look: ItemLook, index: SampleIndex, format: (value: number, unit: string) => string): string => {
  if (row.kind === 'marker') {
    const opening = look.state.kind === 'position' && look.state.fraction >= SHUT_BELOW && look.state.fraction <= OPEN_ABOVE ? `${Math.round(look.state.fraction * 100)} %` : ''
    const unknown = look.state.kind === 'unknown' || look.notMeasured
    if (row.part === 'command') return look.mismatch === null ? '' : 'CMD'
    if (row.part === 'value') return look.mismatch === null ? '' : look.mismatch.slice('CMD '.length)
    if (unknown) return 'POS ?'
    // Where it disagrees with its command, a fully shut or open valve says so too.
    const settled = look.state.kind === 'position' && look.state.fraction < SHUT_BELOW ? 'SHUT' : 'OPEN'
    return row.part === 'word' && look.mismatch !== null && opening === '' ? settled : opening
  }
  if (row.kind === 'count') {
    const looks = row.members.map(member => itemLook(member, index))
    const counted = looks.filter(member => counts(member, row.word)).length
    const unknown = looks.some(member => member.state.kind === 'unknown')
    return `${counted}/${row.members.length} ${row.word}${unknown ? ' ?' : ''}`
  }
  if (row.kind === 'value') {
    const entry = index.get(row.path)
    return entry !== undefined && typeof entry.value === 'number' && entry.quality !== 'outside-hard-range' ? format(entry.value, row.unit) : '—'
  }
  if (row.kind === 'position') {
    if (look.state.kind === 'unknown') return 'POS ?'
    if (look.state.kind !== 'position') return ''
    const fraction = look.state.fraction
    return fraction >= 0.05 && fraction <= 0.95 ? format(fraction, 'fraction') : ''
  }
  if (row.kind === 'mismatch') return look.mismatch ?? ''
  if (row.kind === 'commandValue') return look.mismatch === null ? '' : look.mismatch.slice('CMD '.length)
  if (row.kind === 'throughput') return look.state.kind === 'passing' ? 'PASSING' : look.state.kind === 'notPassing' ? 'NO FLOW' : '?'
  if (row.texts.includes('POS ?')) return 'POS ?'
  // The state word, unless the symbol disagrees with its command: then the command, or CMD over it.
  if (look.mismatch !== null && row.texts.includes(look.mismatch)) return look.mismatch
  if (look.mismatch !== null && row.texts.includes('CMD')) return 'CMD'
  const word = look.state.kind === 'stopped' ? 'STOP' : look.state.kind === 'dead' ? 'DEAD' : look.state.kind === 'unknown' ? '?'
    : look.state.kind === 'closed' ? 'CLOSED' : look.state.kind === 'open' ? 'OPEN' : ''
  return row.texts.includes(word) ? word : ''
}

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
 * cause of an upset shows on the drawing before any alarm it leads to; drawn
 * as normal otherwise.
 */
export const itemTreatment = (look: ItemLook, alarmed: boolean): 'alarm' | 'abnormal' | 'normal' =>
  alarmed ? 'alarm' : look.mismatch !== null ? 'abnormal' : 'normal'

/** A pipe standing for parallel pipes carries flow while any of them does; it is unknown when none does and any is unknown. */
export const bundleFlowLook = (flows: ReadonlyArray<MimicFlowBinding>, index: SampleIndex): FlowLook => {
  const looks = flows.map(flow => flowLook(flow, index))
  const order: ReadonlyArray<FlowLook['look']> = ['forward', 'reverse', 'flowing', 'unknown', 'none']
  return looks.reduce((best, look) => (order.indexOf(look.look) < order.indexOf(best.look) ? look : best))
}

export const itemRowTexts = (binding: MimicItemBinding, presentation: MimicPresentation, rows: ReadonlyArray<MimicRow>, index: SampleIndex, format: (value: number, unit: string) => string): ReadonlyArray<string> => {
  const look = drawnLook(binding, rows, index)
  return rows.map(row => rowText(row, look, index, format))
}
