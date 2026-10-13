import { processPlantSignalReferenceSchema, type ProcessPlantSignalReference } from '../signals.ts'
import type { ProcessPlantIcAnnunciator, ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'
import type { ReferenceAnnunciatorSystemId } from './reference-ic-annunciators.ts'
import type { ReferenceFirstOutGroupId } from './reference-ic-first-out-groups.ts'
import type { ReferenceOperatingModeId } from './reference-ic-modes.ts'

export type ReferenceIcEffect = ProcessPlantIcRule['effects'][number]
export type SignalRef = { readonly tagId: string } | { readonly path: string }

export const signalReference = (reference: SignalRef): ProcessPlantSignalReference =>
  processPlantSignalReferenceSchema.parse(reference)

export const comparison = (
  signal: SignalRef,
  operator: '<' | '<=' | '>' | '>=' | '==' | '!=',
  value: number | boolean,
): ProcessPlantIcCondition => ({
  type: 'comparison',
  signal: signalReference(signal),
  operator,
  value,
})

export const all = (conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({
  type: 'all',
  conditions,
})

export const any = (conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({
  type: 'any',
  conditions,
})

export const vote = (required: number, conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({
  type: 'vote',
  required,
  conditions,
})

/** An annunciator on one of the systems the reference PWR declares (reference-ic-annunciators.ts), in one of its first-out groups (reference-ic-first-out-groups.ts). */
export type ReferenceAnnunciator = ProcessPlantIcAnnunciator & { readonly system: ReferenceAnnunciatorSystemId; readonly firstOutGroup?: ReferenceFirstOutGroupId }
export const annunciator = <Annunciator extends ReferenceAnnunciator>(config: Annunciator): Annunciator => config

export const alarm = (config: {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly severity?: 'info' | 'notice' | 'warning' | 'critical'
  readonly annunciator?: ProcessPlantIcAnnunciator
}): ReferenceIcEffect => ({
  type: 'alarm.enter',
  id: config.id,
  title: config.title,
  message: config.message,
  severity: config.severity ?? 'warning',
  ...(config.annunciator === undefined ? {} : { annunciator: config.annunciator }),
})

/**
 * A trip: an automatic action, annunciated in the first-out group of what it
 * does (reference-ic-first-out-groups.ts), so a display names a limit by its
 * action ("RX TRIP", "AFW START") and the banner lists it as the reactor trip
 * or apart from it as an actuation.
 */
export const trip = (config: {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly severity?: 'info' | 'notice' | 'warning' | 'critical'
  readonly annunciator: ReferenceAnnunciator & { readonly firstOutGroup: ReferenceFirstOutGroupId }
}): ReferenceIcEffect => ({
  type: 'trip.enter',
  id: config.id,
  title: config.title,
  message: config.message,
  severity: config.severity ?? 'critical',
  annunciator: config.annunciator,
})

export const write = (id: string, signal: SignalRef, value: number | boolean): ReferenceIcEffect => ({
  type: 'writeSignal',
  id,
  signal: signalReference(signal),
  value,
})

/** The reactor is tripped while either reactor trip breaker's contacts read open, whatever their commands say. */
export const reactorTripBreakerOpen = (): ProcessPlantIcCondition => any([
  comparison({ tagId: 'TRIP-BKR-A-POS' }, '==', false),
  comparison({ tagId: 'TRIP-BKR-B-POS' }, '==', false),
])

/** Fission power above which the reactor is at power: 100 MW, about 3 % of rated. */
export const atPowerThresholdMw = 100

export const reactorTripBreakerWrites = (idPrefix: string): ReadonlyArray<ReferenceIcEffect> => [
  write(`${idPrefix}-open-trip-breaker-a`, { tagId: 'TRIP-BKR-A' }, false),
  write(`${idPrefix}-open-trip-breaker-b`, { tagId: 'TRIP-BKR-B' }, false),
]

/**
 * A turbine trip: the stop valve shuts and the generator's load is rejected,
 * its output breaker open, so it carries and exports nothing. Both stay so
 * until operators reopen the valve and load the generator again; above P-9
 * the shut stop valve trips the reactor (reference-ic-reactor.ts).
 */
export const turbineTripWrites = (idPrefix: string): ReadonlyArray<ReferenceIcEffect> => [
  write(`${idPrefix}-close-turbine-stop-valve`, { tagId: 'TURB-STOP' }, 0),
  write(`${idPrefix}-reject-turbine-load`, { tagId: 'TURB-LOAD' }, 0),
]

/**
 * The feed regulating valves' isolation: every feed regulating valve's
 * isolation signal shuts it against its level controller until the isolation
 * is released (reference-ic-balance-of-plant.ts). It is what P-4 with low
 * Tavg does after a reactor trip: the main feedwater pumps keep running. The
 * model draws no regulating bypass valves to shut with them.
 */
export const feedRegulatingValveIsolationWrites = (idPrefix: string, loops: ReadonlyArray<string>): ReadonlyArray<ReferenceIcEffect> =>
  loops.map(loop => write(`${idPrefix}-shut-feed-regulating-valve-${loop.toLowerCase()}`, { path: `feedwaterControlValve${loop}.isolationSignal` }, true))

/**
 * Feedwater isolation, as safety injection and P-14 high-high level act it:
 * both main feedwater pumps trip and every feed line is shut. The model draws
 * no feedwater isolation valves, so the feed regulating valves, shut by their
 * isolation signals (feedRegulatingValveIsolationWrites), shut the lines
 * instead; nothing feeds the steam generators but auxiliary feedwater until
 * operators restart a pump.
 */
export const feedwaterIsolationWrites = (idPrefix: string, loops: ReadonlyArray<string>): ReadonlyArray<ReferenceIcEffect> => [
  write(`${idPrefix}-trip-main-feedwater-pump-a`, { tagId: 'MFW-PUMP-A-RUN' }, false),
  write(`${idPrefix}-trip-main-feedwater-pump-b`, { tagId: 'MFW-PUMP-B-RUN' }, false),
  ...feedRegulatingValveIsolationWrites(idPrefix, loops),
]

/**
 * The steam lines that supply the turbine-driven auxiliary feedwater pump's
 * turbine, ahead of their isolation valves, as the reference design takes
 * them and its graph spec draws them: those of loops B and C, of the loops
 * the Plant has. Either alone drives the pump.
 */
export const turbineDrivenAfwSteamSupplyLoops = (loops: ReadonlyArray<string>): ReadonlyArray<string> =>
  loops.filter(loop => loop === 'B' || loop === 'C')

/**
 * The turbine-driven auxiliary feedwater pump's start: its steam supply
 * valves open and its trip and throttle valve admits the steam (its run
 * command), so the turbine comes up and drives the pump.
 */
export const turbineDrivenAfwStartWrites = (loops: ReadonlyArray<string>): ReadonlyArray<ReferenceIcEffect> => [
  write('start-turbine-afw', { tagId: 'AFW-PUMP-T' }, true),
  ...turbineDrivenAfwSteamSupplyLoops(loops).map(loop => write(`open-turbine-afw-steam-supply-${loop.toLowerCase()}`, { tagId: `TDAFW-STM-${loop}` }, 1)),
]

export const rule = (config: {
  readonly id: string
  readonly label?: string
  readonly ruleClass?: ProcessPlantIcRule['ruleClass']
  readonly modes?: ReadonlyArray<ReferenceOperatingModeId>
  readonly condition: ProcessPlantIcCondition
  readonly delayMs?: number
  readonly clearCondition?: ProcessPlantIcCondition
  readonly clearDelayMs?: number
  readonly latch?: boolean
  readonly resetWhenClear?: boolean
  readonly effects: ReadonlyArray<ReferenceIcEffect>
  /** For a permissive or interlock: the writes it gates. */
  readonly commandGates?: ReadonlyArray<{ readonly signal: SignalRef; readonly message?: string }>
  /** For an actuation that opens a modulating valve: how far a person may throttle it while it stands. */
  readonly throttleFloor?: ProcessPlantIcRule['throttleFloor']
  /** For a latched actuation: the least time after it acted before a person may reset it. */
  readonly resetAfterMs?: number
}): ProcessPlantIcRule => ({
  id: config.id,
  ...(config.label === undefined ? {} : { label: config.label }),
  enabled: true,
  ruleClass: config.ruleClass ?? 'alarm',
  ...(config.modes === undefined ? {} : { modes: [...config.modes] }),
  condition: config.condition,
  delayMs: config.delayMs ?? 0,
  ...(config.clearCondition === undefined ? {} : { clearCondition: config.clearCondition }),
  clearDelayMs: config.clearDelayMs ?? 0,
  latch: config.latch ?? true,
  resetWhenClear: config.resetWhenClear ?? false,
  effects: [...config.effects],
  commandGates: (config.commandGates ?? []).map(gate => ({ signal: signalReference(gate.signal), ...(gate.message === undefined ? {} : { message: gate.message }) })),
  ...(config.throttleFloor === undefined ? {} : { throttleFloor: config.throttleFloor }),
  ...(config.resetAfterMs === undefined ? {} : { resetAfterMs: config.resetAfterMs }),
})

export const deadbandController = (config: {
  readonly id: string
  readonly label: string
  readonly signal: SignalRef
  readonly low: {
    readonly threshold: number
    readonly effects: ReadonlyArray<ReferenceIcEffect>
  }
  readonly high: {
    readonly threshold: number
    readonly effects: ReadonlyArray<ReferenceIcEffect>
  }
  readonly normal?: {
    readonly min: number
    readonly max: number
    readonly effects: ReadonlyArray<ReferenceIcEffect>
  }
  readonly modes?: ReadonlyArray<ReferenceOperatingModeId>
}): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: `${config.id}-low-demand`,
    label: `${config.label} low demand`,
    ruleClass: 'normalControl',
    ...(config.modes === undefined ? {} : { modes: config.modes }),
    condition: comparison(config.signal, '<', config.low.threshold),
    latch: false,
    resetWhenClear: true,
    effects: config.low.effects,
  }),
  rule({
    id: `${config.id}-high-demand`,
    label: `${config.label} high demand`,
    ruleClass: 'normalControl',
    ...(config.modes === undefined ? {} : { modes: config.modes }),
    condition: comparison(config.signal, '>', config.high.threshold),
    latch: false,
    resetWhenClear: true,
    effects: config.high.effects,
  }),
  ...(config.normal === undefined ? [] : [
    rule({
      id: `${config.id}-normal-band`,
      label: `${config.label} normal band`,
      ruleClass: 'normalControl',
      ...(config.modes === undefined ? {} : { modes: config.modes }),
      condition: all([
        comparison(config.signal, '>=', config.normal.min),
        comparison(config.signal, '<=', config.normal.max),
      ]),
      latch: false,
      resetWhenClear: true,
      effects: config.normal.effects,
    }),
  ]),
]
