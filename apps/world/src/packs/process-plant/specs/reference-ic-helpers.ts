import { processPlantSignalReferenceSchema, type ProcessPlantSignalReference } from '../signals.ts'
import type { ProcessPlantIcAnnunciator, ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'
import type { ReferenceActuationId } from './reference-ic-actuations.ts'
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
export const annunciator = (config: ReferenceAnnunciator): ReferenceAnnunciator => config

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

/** A trip: an automatic action, annunciated with what it actuates (reference-ic-actuations.ts), its own function first. */
export const trip = (config: {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly severity?: 'info' | 'notice' | 'warning' | 'critical'
  readonly actuates: readonly [ReferenceActuationId, ...ReferenceActuationId[]]
  readonly annunciator: ReferenceAnnunciator
}): ReferenceIcEffect => ({
  type: 'trip.enter',
  id: config.id,
  title: config.title,
  message: config.message,
  severity: config.severity ?? 'critical',
  annunciator: { ...config.annunciator, actuates: [...config.actuates] },
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
 * Feedwater isolation: both main feedwater pumps trip, and every feed
 * regulating valve's isolation signal shuts it against its level controller
 * until the isolation is released (reference-ic-balance-of-plant.ts). The
 * model has no feedwater isolation valves to close.
 */
export const feedwaterIsolationWrites = (idPrefix: string, loops: ReadonlyArray<string>): ReadonlyArray<ReferenceIcEffect> => [
  write(`${idPrefix}-trip-main-feedwater-pump-a`, { tagId: 'MFW-PUMP-A-RUN' }, false),
  write(`${idPrefix}-trip-main-feedwater-pump-b`, { tagId: 'MFW-PUMP-B-RUN' }, false),
  ...loops.map(loop => write(`${idPrefix}-shut-feed-regulating-valve-${loop.toLowerCase()}`, { path: `feedwaterControlValve${loop}.isolationSignal` }, true)),
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
