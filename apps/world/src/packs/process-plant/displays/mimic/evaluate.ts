import { followAllowanceMs } from '../../operations/controls.ts'
import type { MimicItemBinding, MimicShutdownBinding, MimicStateBinding } from './bindings.ts'
import type { LinkFlowBinding } from '../../equipment/link-flow.ts'

// What a drawn item and pipe show for one sample. Pure and shared by the
// server (the compose result's equipment list) and the embed (the drawing),
// so what the agent says can never differ from what the operator sees. A
// missing or out-of-range value is unknown, never a substitute.

/**
 * A sample's values by path. `heldMs`: how long a command has read this
 * value since a person or an AI agent issued it, where the Plant's operations
 * log says so (commandsHeld); a display judges such a command "not followed"
 * only once the equipment's declared travel time and margin have passed.
 */
export type SampleIndex = ReadonlyMap<string, { readonly value: unknown; readonly quality: string; readonly heldMs?: number }>

/** How long each command has read the value it reads now, in plant ms; undefined where it is not known. */
export type CommandHeld = (path: string, value: unknown) => number | undefined

export const indexSample = (values: ReadonlyArray<{ readonly path: string; readonly value: unknown; readonly quality: string }> | undefined, held?: CommandHeld): SampleIndex =>
  new Map((values ?? []).map(entry => {
    const heldMs = held?.(entry.path, entry.value)
    return [entry.path, heldMs === undefined ? { value: entry.value, quality: entry.quality } : { value: entry.value, quality: entry.quality, heldMs }]
  }))

/**
 * How long each command has read its value, from the commands people and AI
 * agents issued (the Plant's operations log, as display.sample serves it): the
 * latest one on a path, where the command still reads the value it wrote.
 * Where none does (the I&C or a scenario moved it, or the log no longer keeps
 * it), the time is not known and the command is judged as it reads.
 */
export const commandsHeld = (log: ReadonlyArray<{ readonly path: string; readonly value: unknown; readonly elapsedMs: number }>, nowElapsedMs: number): CommandHeld => {
  const latest = new Map<string, { readonly value: unknown; readonly elapsedMs: number }>()
  for (const record of log) {
    const known = latest.get(record.path)
    if (known === undefined || record.elapsedMs >= known.elapsedMs) latest.set(record.path, record)
  }
  return (path, value) => {
    const record = latest.get(path)
    if (record === undefined) return undefined
    const same = typeof record.value === 'number' && typeof value === 'number' ? Math.abs(record.value - value) <= 1e-9 : record.value === value
    return same ? Math.max(0, nowElapsedMs - record.elapsedMs) : undefined
  }
}

const numberAt = (index: SampleIndex, path: string | undefined): number | null => {
  if (path === undefined) return null
  const entry = index.get(path)
  return entry !== undefined && typeof entry.value === 'number' && entry.quality !== 'outside-hard-range' ? entry.value : null
}

const booleanAt = (index: SampleIndex, path: string | undefined): boolean | null => {
  if (path === undefined) return null
  const value = index.get(path)?.value
  return typeof value === 'boolean' ? value : null
}

/** A command disagrees with a position when they differ by more than this fraction. */
export const MISMATCH_FRACTION = 0.1
/** A digital valve reads closed below and open above these positions; between, it shows its opening. */
const CLOSED_BELOW = 0.05
const OPEN_ABOVE = 0.95

const percent = (fraction: number): string => `${Math.round(fraction * 100)} %`

export type ItemState =
  | { readonly kind: 'running' | 'stopped' }
  | { readonly kind: 'position'; readonly fraction: number }
  /** A breaker's contacts. */
  | { readonly kind: 'closed' | 'open' }
  | { readonly kind: 'passing' | 'notPassing'; readonly flow: number }
  | { readonly kind: 'level'; readonly percent: number; readonly offScale: 'high' | 'low' | null }
  | { readonly kind: 'flowing' | 'noFlow' }
  | { readonly kind: 'energized' | 'dead' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'none' }

export interface ItemLook {
  readonly state: ItemState
  /** The position is not computed by the model: drawn "POS ?". */
  readonly notMeasured: boolean
  /** The demand disagrees with the state: "CMD 100 %", "CMD RUN", "CMD SHUT". */
  readonly mismatch: string | null
  /** The state in words, for the compose result and screen readers. */
  readonly words: string
}

/**
 * A command as the item shows it. `open` is whether it demands the item run
 * or open; a breaker's command (`closedWhileTrue`) closes it while true; a
 * valve that stands open or shut (`twoState`) is commanded OPEN or SHUT at
 * either end of its travel, as its position reads there.
 */
const commandText = (index: SampleIndex, path: string | undefined, aspect: 'running' | 'position', closedWhileTrue = false, twoState = false): { readonly text: string; readonly open: boolean | null; readonly fraction: number | null } | null => {
  const flag = booleanAt(index, path)
  if (flag !== null && closedWhileTrue) return { text: flag ? 'CMD CLOSE' : 'CMD OPEN', open: !flag, fraction: null }
  if (flag !== null) return { text: aspect === 'running' ? (flag ? 'CMD RUN' : 'CMD STOP') : (flag ? 'CMD OPEN' : 'CMD SHUT'), open: flag, fraction: null }
  const fraction = numberAt(index, path)
  if (fraction === null) return null
  return { text: fraction < CLOSED_BELOW ? 'CMD SHUT' : twoState && fraction > OPEN_ABOVE ? 'CMD OPEN' : `CMD ${percent(fraction)}`, open: fraction >= CLOSED_BELOW, fraction }
}

/** commandsHeld of a running Plant: its operations log, timed at its plant time now; none where it keeps no log. */
export const heldCommands = (system: {
  readonly operations?: { readonly log: () => ReadonlyArray<{ readonly path: string; readonly value: unknown; readonly elapsedMs: number }> }
  readonly runtime: { readonly elapsedMs: () => number }
}): CommandHeld | undefined => system.operations === undefined ? undefined : commandsHeld(system.operations.log(), system.runtime.elapsedMs())

/**
 * Whether a command that disagrees with its state is judged not followed
 * (QA-6, I-2): only once the equipment's declared travel toward the commanded
 * state and its margin (followAllowanceMs) have passed since it was issued;
 * at once where that time is not known (commandsHeld); never where the model
 * declares no travel time, whose state is awaited.
 */
const judged = (state: MimicStateBinding, index: SampleIndex, mismatch: string | null, towardOn: boolean): string | null => {
  if (mismatch === null || state.command === undefined || state.travel === undefined) return null
  const heldMs = index.get(state.command)?.heldMs
  return heldMs === undefined || heldMs > followAllowanceMs(1_000 * (towardOn ? state.travel.onS : state.travel.offS)) ? mismatch : null
}

/**
 * Where a flag that says an item has stopped stands: stopped while it reads
 * true; `demanded` while it does not and a trip's command to stop it stands
 * (the command reads what the trip writes); `quiet` otherwise; unknown
 * without a reading.
 */
export const shutdownLook = (shutdown: MimicShutdownBinding, index: SampleIndex): 'stopped' | 'demanded' | 'quiet' | 'unknown' => {
  const stopped = booleanAt(index, shutdown.path)
  if (stopped === null) return 'unknown'
  if (stopped) return 'stopped'
  return shutdown.demands.some(demand => index.get(demand.path)?.value === demand.value) ? 'demanded' : 'quiet'
}

/** An item's look, with what its shutdown flags say in words after its state's (`Rods on bottom`). */
export const itemLook = (binding: MimicItemBinding, index: SampleIndex): ItemLook => {
  const look = stateLook(binding, index)
  const said = binding.shutdown.flatMap(flag => {
    const stopped = shutdownLook(flag, index)
    return stopped === 'stopped' ? [flag.words.on] : stopped === 'demanded' ? [`${flag.words.off}; commanded to trip`] : []
  })
  return said.length === 0 ? look : { ...look, words: [look.words, ...said].filter(words => words !== '').join('; ') }
}

const stateLook = (binding: MimicItemBinding, index: SampleIndex): ItemLook => {
  const state = binding.state
  if (state === null) return { state: { kind: 'none' }, notMeasured: false, mismatch: null, words: '' }
  const unknown = (notMeasured = false): ItemLook => ({ state: { kind: 'unknown' }, notMeasured, mismatch: null, words: notMeasured ? 'position not measured; no flow value' : 'state unknown' })
  // An on/off state its equipment words reads in those words (ON LINE), else in the aspect's own.
  const worded = (on: boolean, own: string): string => state.words === undefined ? own : on ? state.words.on : state.words.off

  if (state.aspect === 'running') {
    const value = state.state?.reading === 'true' ? booleanAt(index, state.state.path) : numberAt(index, state.state?.path)
    if (value === null) return unknown()
    // A flow runs equipment only above its no-flow band; a speed or flag as it reads.
    const band = state.state?.reading === 'flow' ? state.state.noFlowBelow ?? 0 : 0
    const running = typeof value === 'boolean' ? value : state.state?.reading === 'flow' ? Math.abs(value) >= band && value !== 0 : value > 0
    const command = commandText(index, state.command, 'running')
    const mismatch = judged(state, index, command === null || command.open === running ? null : command.text, command?.open === true)
    return { state: { kind: running ? 'running' : 'stopped' }, notMeasured: false, mismatch, words: `${worded(running, running ? 'running' : 'stopped')}${mismatch === null ? '' : `; commanded to ${running ? 'stop' : 'run'}`}` }
  }

  if (state.aspect === 'position') {
    const closedWhileTrue = state.state?.reading === 'closedWhileTrue'
    const command = commandText(index, state.command, 'position', closedWhileTrue, state.twoState === true)
    if (closedWhileTrue) {
      const closed = booleanAt(index, state.state?.path)
      if (closed === null) return unknown()
      // A breaker commanded open disagrees while its contacts stay closed, and the other way round.
      // Its on state is closed in: a command to close (open false) moves it toward it.
      const mismatch = judged(state, index, command === null || command.open === null || command.open === !closed ? null : command.text, command?.open === false)
      return { state: { kind: closed ? 'closed' : 'open' }, notMeasured: false, mismatch, words: `${worded(closed, closed ? 'closed' : 'open')}${mismatch === null ? '' : `; ${mismatch.replace('CMD', 'commanded').toLowerCase()} disagrees`}` }
    }
    if (state.state === undefined) {
      // The model does not compute the position: what passes the item judges it.
      const flow = numberAt(index, state.throughput?.path)
      if (flow === null) return unknown(true)
      const passing = Math.abs(flow) >= (state.throughput?.noFlowBelow ?? 0) && flow !== 0
      // Never judged not followed: the model declares no travel time for a state it does not solve (I-2), so what passes
      // it is what it shows, whatever it is commanded.
      return {
        state: { kind: passing ? 'passing' : 'notPassing', flow },
        notMeasured: true,
        mismatch: null,
        words: `position not measured; ${passing ? `passing ${flow.toFixed(Math.abs(flow) >= 100 ? 0 : 1)} kg/s` : 'no flow'}`,
      }
    }
    const position = numberAt(index, state.state.path)
    if (position === null) return unknown()
    const mismatch = judged(state, index, command?.fraction !== null && command?.fraction !== undefined
      ? (Math.abs(command.fraction - position) > MISMATCH_FRACTION ? command.text : null)
      : command !== null && command !== undefined && command.open !== (position >= CLOSED_BELOW) ? command.text : null, command?.fraction !== null && command?.fraction !== undefined ? command.fraction > position : command?.open === true)
    const words = position < CLOSED_BELOW ? 'closed' : position > OPEN_ABOVE ? 'open' : `${percent(position)} open`
    return { state: { kind: 'position', fraction: position }, notMeasured: false, mismatch, words: `${words}${mismatch === null ? '' : `; ${mismatch.replace('CMD', 'commanded').toLowerCase()} disagrees`}` }
  }

  if (state.aspect === 'level') {
    const level = numberAt(index, state.state?.path)
    if (level === null) return unknown()
    const offScale = level > 100 ? 'high' : level < 0 ? 'low' : null
    return { state: { kind: 'level', percent: level, offScale }, notMeasured: false, mismatch: null, words: `level ${level.toFixed(1)} %` }
  }

  if (state.aspect === 'energized') {
    const energized = booleanAt(index, state.state?.path)
    if (energized === null) return unknown()
    return { state: { kind: energized ? 'energized' : 'dead' }, notMeasured: false, mismatch: null, words: worded(energized, energized ? 'energized' : 'dead') }
  }

  const flow = numberAt(index, state.state?.path)
  if (flow === null) return unknown()
  const flowing = Math.abs(flow) >= (state.throughput?.noFlowBelow ?? 0) && flow !== 0
  return { state: { kind: flowing ? 'flowing' : 'noFlow' }, notMeasured: false, mismatch: null, words: flowing ? 'carrying flow' : 'no flow' }
}

export interface FlowLook {
  /**
   * `forward`/`reverse` only where the model solves the direction; `flowing`
   * where it solves only the size (no chevron); `none` below the no-flow band;
   * `unknown` for a missing value or a flow the model does not verify.
   */
  readonly look: 'forward' | 'reverse' | 'flowing' | 'none' | 'unknown'
  readonly value: number | null
}

export const flowLook = (binding: LinkFlowBinding, index: SampleIndex): FlowLook => {
  if (binding.fidelity === 'unverified') return { look: 'unknown', value: null }
  const value = numberAt(index, binding.flowPath)
  if (value === null) return { look: 'unknown', value: null }
  // An unrated link has no band: only an exact zero reads as no flow.
  if (value === 0 || Math.abs(value) < (binding.noFlowBelow ?? 0)) return { look: 'none', value }
  if (binding.fidelity === 'magnitudeOnly') return { look: 'flowing', value }
  return { look: value > 0 ? 'forward' : 'reverse', value }
}

/**
 * A drawn power line, or a stub standing for several lines into one terminal
 * (a bus fed from its diesel and from offsite): live while any line is live,
 * unknown when none is and any is unknown, else dead.
 */
export const powerLook = (energizedPaths: ReadonlyArray<string | null>, index: SampleIndex): 'live' | 'dead' | 'unknown' => {
  const looks = energizedPaths.map(path => booleanAt(index, path ?? undefined))
  return looks.includes(true) ? 'live' : looks.includes(null) ? 'unknown' : 'dead'
}
