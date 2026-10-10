import type { MimicFlowBinding, MimicItemBinding } from './bindings.ts'

// What a drawn item and pipe show for one sample. Pure and shared by the
// server (the compose result's equipment list) and the embed (the drawing),
// so what the agent says can never differ from what the operator sees. A
// missing or out-of-range value is unknown, never a substitute.

export type SampleIndex = ReadonlyMap<string, { readonly value: unknown; readonly quality: string }>

export const indexSample = (values: ReadonlyArray<{ readonly path: string; readonly value: unknown; readonly quality: string }> | undefined): SampleIndex =>
  new Map((values ?? []).map(entry => [entry.path, { value: entry.value, quality: entry.quality }]))

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
 * or open; a breaker's command (`closedWhileTrue`) closes it while true.
 */
const commandText = (index: SampleIndex, path: string | undefined, aspect: 'running' | 'position', closedWhileTrue = false): { readonly text: string; readonly open: boolean | null; readonly fraction: number | null } | null => {
  const flag = booleanAt(index, path)
  if (flag !== null && closedWhileTrue) return { text: flag ? 'CMD CLOSE' : 'CMD OPEN', open: !flag, fraction: null }
  if (flag !== null) return { text: aspect === 'running' ? (flag ? 'CMD RUN' : 'CMD STOP') : (flag ? 'CMD OPEN' : 'CMD SHUT'), open: flag, fraction: null }
  const fraction = numberAt(index, path)
  if (fraction === null) return null
  return { text: fraction < CLOSED_BELOW ? 'CMD SHUT' : `CMD ${percent(fraction)}`, open: fraction >= CLOSED_BELOW, fraction }
}

export const itemLook = (binding: MimicItemBinding, index: SampleIndex): ItemLook => {
  const state = binding.state
  if (state === null) return { state: { kind: 'none' }, notMeasured: false, mismatch: null, words: '' }
  const unknown = (notMeasured = false): ItemLook => ({ state: { kind: 'unknown' }, notMeasured, mismatch: null, words: notMeasured ? 'position not measured; no flow value' : 'state unknown' })

  if (state.aspect === 'running') {
    const value = state.state?.reading === 'true' ? booleanAt(index, state.state.path) : numberAt(index, state.state?.path)
    if (value === null) return unknown()
    // A flow runs equipment only above its no-flow band; a speed or flag as it reads.
    const band = state.state?.reading === 'flow' ? state.state.noFlowBelow ?? 0 : 0
    const running = typeof value === 'boolean' ? value : state.state?.reading === 'flow' ? Math.abs(value) >= band && value !== 0 : value > 0
    const command = commandText(index, state.command, 'running')
    const mismatch = command === null || command.open === running ? null : command.text
    return { state: { kind: running ? 'running' : 'stopped' }, notMeasured: false, mismatch, words: `${running ? 'running' : 'stopped'}${mismatch === null ? '' : `; commanded to ${running ? 'stop' : 'run'}`}` }
  }

  if (state.aspect === 'position') {
    const closedWhileTrue = state.state?.reading === 'closedWhileTrue'
    const command = commandText(index, state.command, 'position', closedWhileTrue)
    if (closedWhileTrue) {
      const closed = booleanAt(index, state.state?.path)
      if (closed === null) return unknown()
      // A breaker commanded open disagrees while its contacts stay closed, and the other way round.
      const mismatch = command === null || command.open === null || command.open === !closed ? null : command.text
      return { state: { kind: closed ? 'closed' : 'open' }, notMeasured: false, mismatch, words: `${closed ? 'closed' : 'open'}${mismatch === null ? '' : `; ${mismatch.replace('CMD', 'commanded').toLowerCase()} disagrees`}` }
    }
    if (state.state === undefined) {
      // The model does not compute the position: what passes the item judges it.
      const flow = numberAt(index, state.throughput?.path)
      if (flow === null) return unknown(true)
      const passing = Math.abs(flow) >= (state.throughput?.noFlowBelow ?? 0) && flow !== 0
      const mismatch = command === null ? null : passing && command.open === false ? command.text : !passing && command.open === true ? command.text : null
      return {
        state: { kind: passing ? 'passing' : 'notPassing', flow },
        notMeasured: true,
        mismatch,
        words: `position not measured; ${passing ? `passing ${flow.toFixed(Math.abs(flow) >= 100 ? 0 : 1)} kg/s` : 'no flow'}${mismatch === null ? '' : `; ${mismatch.replace('CMD', 'commanded').toLowerCase()}`}`,
      }
    }
    const position = numberAt(index, state.state.path)
    if (position === null) return unknown()
    const mismatch = command?.fraction !== null && command?.fraction !== undefined
      ? (Math.abs(command.fraction - position) > MISMATCH_FRACTION ? command.text : null)
      : command !== null && command !== undefined && command.open !== (position >= CLOSED_BELOW) ? command.text : null
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
    return { state: { kind: energized ? 'energized' : 'dead' }, notMeasured: false, mismatch: null, words: energized ? 'energized' : 'dead' }
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

export const flowLook = (binding: MimicFlowBinding, index: SampleIndex): FlowLook => {
  if (binding.fidelity === 'unverified') return { look: 'unknown', value: null }
  const value = numberAt(index, binding.flowPath)
  if (value === null) return { look: 'unknown', value: null }
  // An unrated link has no band: only an exact zero reads as no flow.
  if (value === 0 || Math.abs(value) < (binding.noFlowBelow ?? 0)) return { look: 'none', value }
  if (binding.fidelity === 'magnitudeOnly') return { look: 'flowing', value }
  return { look: value > 0 ? 'forward' : 'reverse', value }
}

export const powerLook = (energizedPath: string | null, index: SampleIndex): 'live' | 'dead' | 'unknown' => {
  const energized = booleanAt(index, energizedPath ?? undefined)
  return energized === null ? 'unknown' : energized ? 'live' : 'dead'
}
