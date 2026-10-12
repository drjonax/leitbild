import type { ProcessPlantIcRule } from '../runtime/index.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'
import { alarm, all, annunciator, any, comparison, reactorTripBreakerWrites, rule, trip, vote, write } from './reference-ic-helpers.ts'

const reactorAlarm = annunciator({
  system: 'reactorProtection',
  equipmentId: 'core',
  group: 'reactor-protection',
  priority: 'urgent',
  role: 'symptom',
})

const reactorAction = annunciator({
  system: 'reactorProtection',
  equipmentId: 'core',
  group: 'reactor-protection',
  firstOutGroup: 'reactor-trip',
  priority: 'urgent',
  role: 'automaticAction',
})

const lowRcpFlowVoteThresholdFor = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): number =>
  Math.max(1, Math.ceil(loops.length * 0.75))

const lowRcpFlowTripThresholdKgPerS = 3_000

// Overtemperature and overpower delta-T: each loop's channel
// (deltaTProtectionChannel) computes its setpoint from its own Tavg and the
// pressurizer pressure and trips when its delta-T rises past it; two channels
// trip the reactor, as two of four do at the reference four-loop plant
// (NUREG-1431 Table 3.3.1-1, functions 6 and 7).
const deltaTTripVoteFor = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): number => Math.min(2, loops.length)

// The reactor protection system reads power on the power-range channels
// (NIS-PR-AVG), in percent of rated power.
const powerRange = { tagId: 'NIS-PR-AVG' } as const

// The high-power alarm and trip, at the reference core's 3,600 MW and
// 3,750 MW of its 3,400 MW rated power.
const powerHighAlarmPercent = 105.9
const powerHighAlarmClearPercent = 102.9
const powerHighTripPercent = 110.3

// P-7 and P-8, on the power-range channels: above P-8 (48 % of rated power)
// the loss of one loop's forced flow trips the reactor; between P-7 (10 %)
// and P-8 the loss of two (NUREG-1431 Table 3.3.1-1, functions 10, 11 and 16).
const p7PowerRangePercent = 10
const p8PowerRangePercent = 48

// P-9: above half of rated power the steam dumps cannot take the whole load
// a turbine trip rejects, so the turbine trip trips the reactor. Below it the
// reactor rides the trip out.
const p9PowerRangePercent = 50

// Rod control's temperature error, Tavg minus the Tref turbine load programs:
// in power operation it alarms outside 1.7 °C (3 °F) either way for 2 s and
// clears inside 1.1 °C (2 °F), as a signed deviation like the pressurizer's
// level from its program.
const averageTemperatureDeviation = { tagId: 'TAVG-TREF' } as const
const averageTemperatureDeviationAlarmC = 1.7
const averageTemperatureDeviationClearC = 1.1

const rodControlAlarm = annunciator({
  system: 'reactorCoolantSystem',
  equipmentId: 'core',
  group: 'rod-control',
  priority: 'high',
  role: 'symptom',
})

const averageTemperatureDeviationRules = (): ReadonlyArray<ProcessPlantIcRule> => (['high', 'low'] as const).map(side => rule({
  id: `tavg-tref-deviation-${side}`,
  label: `Tavg ${side === 'high' ? 'above' : 'below'} Tref`,
  ruleClass: 'alarm',
  modes: ['powerOperation'],
  condition: side === 'high'
    ? comparison(averageTemperatureDeviation, '>', averageTemperatureDeviationAlarmC)
    : comparison(averageTemperatureDeviation, '<', -averageTemperatureDeviationAlarmC),
  clearCondition: side === 'high'
    ? comparison(averageTemperatureDeviation, '<', averageTemperatureDeviationClearC)
    : comparison(averageTemperatureDeviation, '>', -averageTemperatureDeviationClearC),
  clearDelayMs: 1_000,
  delayMs: 2_000,
  latch: false,
  resetWhenClear: true,
  effects: [alarm({
    id: `tavg-tref-deviation-${side}`,
    title: `Tavg ${side === 'high' ? 'above' : 'below'} Tref`,
    message: `The loops' average temperature stands more than ${averageTemperatureDeviationAlarmC} °C ${side === 'high' ? 'above' : 'below'} the reference temperature turbine load programs (Tref).`,
    severity: 'warning',
    annunciator: rodControlAlarm,
  })],
}))

export const reactorReferenceIcRules = (
  loops: ReadonlyArray<ProcessPlantReferenceLoop>,
): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'reactor-power-high',
    label: 'Reactor power high',
    ruleClass: 'alarm',
    condition: comparison(powerRange, '>', powerHighAlarmPercent),
    clearCondition: comparison(powerRange, '<', powerHighAlarmClearPercent),
    clearDelayMs: 1_000,
    delayMs: 1_000,
    effects: [alarm({
      id: 'power-high',
      title: 'Reactor power high',
      message: `The power range reads above ${powerHighAlarmPercent} % of rated power.`,
      severity: 'critical',
      annunciator: reactorAlarm,
    })],
  }),
  rule({
    id: 'reactor-high-power-trip',
    label: 'Reactor high-power trip',
    ruleClass: 'protection',
    condition: comparison(powerRange, '>', powerHighTripPercent),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'high-power-trip',
        title: 'Reactor high-power trip',
        message: `The power range reads above the ${powerHighTripPercent} % high-power trip setpoint.`,
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('high-power-trip'),
      write('insert-control-rods', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'reactor-overtemperature-delta-t-trip',
    label: 'Reactor overtemperature delta-T trip',
    ruleClass: 'protection',
    modes: ['powerOperation'],
    condition: vote(deltaTTripVoteFor(loops), loops.map(loop => comparison({ path: `deltaTChannel${loop}.overtemperatureMarginC` }, '<', 0))),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'overtemperature-delta-t-trip',
        title: 'Reactor overtemperature delta-T trip',
        message: `${deltaTTripVoteFor(loops)} or more loops' delta-T is above its overtemperature setpoint, which falls as loop Tavg rises and pressurizer pressure falls.`,
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('overtemperature-delta-t-trip'),
      write('insert-control-rods-overtemperature-delta-t', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'reactor-overpower-delta-t-trip',
    label: 'Reactor overpower delta-T trip',
    ruleClass: 'protection',
    modes: ['powerOperation'],
    condition: vote(deltaTTripVoteFor(loops), loops.map(loop => comparison({ path: `deltaTChannel${loop}.overpowerMarginC` }, '<', 0))),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'overpower-delta-t-trip',
        title: 'Reactor overpower delta-T trip',
        message: `${deltaTTripVoteFor(loops)} or more loops' delta-T is above its overpower setpoint, which falls as loop Tavg rises above its rated value.`,
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('overpower-delta-t-trip'),
      write('insert-control-rods-overpower-delta-t', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  // A simulator trip with no counterpart in a Westinghouse reactor protection
  // system: it reads the model's own RCS inventory balance, a value no plant
  // instrument measures (simulator-only), and trips the reactor on a net loss
  // above 250 kg/s. Its name says so; the loss of forced flow trips are the
  // reactor coolant pump rules below.
  rule({
    id: 'reactor-low-primary-flow-trip',
    label: 'RCS inventory loss (simulator trip)',
    ruleClass: 'protection',
    modes: ['powerOperation'],
    condition: comparison({ path: 'vessel.netInventoryFlowKgPerS' }, '<', -250),
    delayMs: 2_000,
    effects: [
      trip({
        id: 'low-flow-trip',
        title: 'RCS inventory loss (simulator trip)',
        message: 'The model\'s RCS inventory balance, a simulator value no plant instrument measures, shows a net loss above 250 kg/s: a simulator trip with no Westinghouse counterpart.',
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('low-flow-trip'),
      write('insert-control-rods-low-flow', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'reactor-turbine-trip',
    label: 'Reactor trip on turbine trip',
    ruleClass: 'protection',
    // In power operation, so the turbine trip a reactor trip itself causes does not trip it again.
    modes: ['powerOperation'],
    // The stop valve closed and power above P-9, as the RPS logic ANDs them.
    condition: all([
      comparison({ tagId: 'TURB-STOP-POS' }, '<', 0.05),
      comparison(powerRange, '>', p9PowerRangePercent),
    ]),
    effects: [
      trip({
        id: 'turbine-trip-reactor-trip',
        title: 'Reactor trip on turbine trip',
        message: `The turbine stop valve closed with the power range above P-9 (${p9PowerRangePercent} % of rated power).`,
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('turbine-trip'),
      write('insert-control-rods-turbine-trip', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'reactor-rcp-breaker-open-trip',
    label: 'Reactor trip on reactor coolant pump breaker open',
    ruleClass: 'protection',
    modes: ['powerOperation'],
    // On each pump's run feedback, which reads not running once its breaker
    // opens or its bus goes dead, so the reactor trips on the first scan
    // rather than waiting for the loop flow to coast down to the low-flow trip.
    condition: any([
      all([
        comparison(powerRange, '>', p8PowerRangePercent),
        vote(1, loops.map(loop => comparison({ tagId: `RCP-${loop}-RUNNING` }, '==', false))),
      ]),
      all([
        comparison(powerRange, '>', p7PowerRangePercent),
        vote(Math.min(2, loops.length), loops.map(loop => comparison({ tagId: `RCP-${loop}-RUNNING` }, '==', false))),
      ]),
    ]),
    effects: [
      trip({
        id: 'rcp-breaker-open-trip',
        title: 'Reactor trip on RCP breaker open',
        message: `A reactor coolant pump stopped, its breaker open or its bus dead, with the power range above P-8 (${p8PowerRangePercent} %), or two stopped above P-7 (${p7PowerRangePercent} %).`,
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('rcp-breaker-open-trip'),
      write('insert-control-rods-rcp-breaker-open', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'reactor-low-rcp-flow-trip',
    label: 'Reactor low reactor coolant pump flow trip',
    ruleClass: 'protection',
    modes: ['powerOperation'],
    condition: vote(lowRcpFlowVoteThresholdFor(loops), loops.map(loop => comparison({ path: `rcp${loop}.loopFlowKgPerS` }, '<', lowRcpFlowTripThresholdKgPerS))),
    delayMs: 2_000,
    effects: [
      trip({
        id: 'low-rcp-flow-trip',
        title: 'Reactor low RCP flow trip',
        message: `${lowRcpFlowVoteThresholdFor(loops)} or more reactor coolant pump loops are below ${lowRcpFlowTripThresholdKgPerS} kg/s.`,
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('low-rcp-flow-trip'),
      write('insert-control-rods-low-rcp-flow', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  ...averageTemperatureDeviationRules(),
]
