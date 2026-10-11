import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, comparison, rule, trip, write } from './reference-ic-helpers.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'

/** Undervoltage relay set points, as fractions of nominal voltage (the offsite power alarms below). */
const degradedVoltageFraction = 0.9
const lossOfVoltageFraction = 0.7

const electricalAlarm = annunciator({
  system: 'electrical',
  group: 'electrical-power',
  priority: 'high',
  role: 'automaticAction',
})

// A standby diesel's output breaker stands open. The load sequencer closes it
// only once the diesel reads running, at rated voltage and frequency, onto a
// dead safety bus: never in parallel with offsite power. The bus's loads,
// still commanded on, then come back on the diesel. The breaker opens again
// when its diesel stops or fails, as the generator protection would trip it,
// so it stands open for the next dead-bus start; with offsite power restored
// the operator stops the diesel and the bus stays on offsite power.
const dieselGeneratorRules = (train: 'A' | 'B'): ReadonlyArray<ProcessPlantIcRule> => {
  const lower = train.toLowerCase()
  return [
    rule({
      id: `diesel-generator-${lower}-output-breaker-close`,
      label: `Diesel generator ${train} output breaker close on dead bus`,
      ruleClass: 'normalControl',
      condition: all([
        comparison({ tagId: `EDG-${train}-RUN` }, '==', true),
        comparison({ tagId: `BUS-${train}-ENERGIZED` }, '==', false),
      ]),
      latch: false,
      resetWhenClear: true,
      effects: [
        write(`close-diesel-breaker-${lower}`, { tagId: `BRK-EDG-${train}-CLOSED` }, true),
      ],
    }),
    rule({
      id: `diesel-generator-${lower}-output-breaker-open`,
      label: `Diesel generator ${train} output breaker open on diesel stop`,
      ruleClass: 'normalControl',
      condition: all([
        comparison({ tagId: `EDG-${train}-RUN` }, '==', false),
        comparison({ tagId: `BRK-EDG-${train}-POS` }, '==', true),
      ]),
      latch: false,
      resetWhenClear: true,
      effects: [
        write(`open-diesel-breaker-${lower}`, { tagId: `BRK-EDG-${train}-CLOSED` }, false),
      ],
    }),
    // The load sequencer: the bus's loads that were running come back as the
    // breaker closes (the in-service charging pump among them); once the
    // diesel has recovered from that block, the motor-driven auxiliary
    // feedwater pump starts, as a loss of offsite power demands. The safety
    // injection and RHR pumps start on a safety injection signal instead.
    rule({
      id: `diesel-generator-${lower}-sequencer-afw`,
      label: `Diesel generator ${train} load sequencer auxiliary feedwater step`,
      ruleClass: 'normalControl',
      condition: comparison({ tagId: `BRK-EDG-${train}-POS` }, '==', true),
      delayMs: 5_000,
      latch: false,
      resetWhenClear: true,
      effects: [
        write(`start-motor-afw-${lower}`, { tagId: `AFW-PUMP-${train}` }, true),
      ],
    }),
    // On its diesel alone, the bus can carry no more than the diesel's rating:
    // a bus margin of 0 MW means the diesel is loaded to its limit.
    rule({
      id: `diesel-generator-${lower}-overload`,
      label: `Diesel generator ${train} overload`,
      ruleClass: 'alarm',
      condition: all([
        comparison({ tagId: `BRK-EDG-${train}-POS` }, '==', true),
        comparison({ tagId: `BRK-OFFSITE-${train}-POS` }, '==', false),
        comparison({ tagId: `BUS-${train}-MARGIN` }, '<=', 0),
      ]),
      clearDelayMs: 2_000,
      delayMs: 2_000,
      latch: false,
      resetWhenClear: true,
      effects: [
        alarm({
          id: 'overload',
          title: `EDG ${train} overload`,
          message: `Emergency diesel generator ${train} carries safety bus ${train} alone and is loaded to its rating: the bus has no power margin left.`,
          severity: 'warning',
          annunciator: annunciator({ ...electricalAlarm, equipmentId: `dieselGenerator${train}`, role: 'symptom' }),
        }),
      ],
    }),
  ]
}

// Both unit buses dead is a loss of offsite power to the unit: the steam-driven
// auxiliary feedwater pump starts at once and auxiliary feedwater is lined up
// to every steam generator; the motor-driven pumps follow on the sequencer.
// Each line opens fully, as on low-low level: the pumps are rated like a
// 4-loop PWR's (two motor-driven of 440 gpm, 27.6 kg/s, one turbine-driven of
// 880 gpm, 55.2 kg/s), so all three together feed some 110 kg/s into
// generators at their no-load pressure, about 27 kg/s each, enough for decay
// heat; operators throttle from there.
const afwLineUpPositionFraction = 1

// The pressurizer's backup heaters hang on safety bus A through their own
// breaker, so the diesel carries them when offsite power is lost. Their
// breaker opens when the bus goes dead, as its undervoltage relay sheds it, so
// the 1.4 MW group does not come back in the block of loads that return as the
// diesel picks the bus up; the sequencer's last step closes it once the
// diesel has taken that block and the motor-driven AFW pump, and the pressure
// control's command decides whether they heat.
const backupHeaterSequencerStepMs = 20_000

const pressurizerBackupHeaterBreakerRules = (): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'pressurizer-backup-heaters-a-load-shed',
    label: 'Pressurizer backup heater breaker A load shed on dead bus',
    ruleClass: 'normalControl',
    condition: comparison({ tagId: 'BUS-A-ENERGIZED' }, '==', false),
    latch: false,
    resetWhenClear: true,
    effects: [write('shed-pressurizer-backup-heaters-a', { tagId: 'BRK-PZR-HTR-A-CLOSED' }, false)],
  }),
  rule({
    id: 'diesel-generator-a-sequencer-pressurizer-heaters',
    label: 'Diesel generator A load sequencer pressurizer backup heater step',
    ruleClass: 'normalControl',
    condition: comparison({ tagId: 'BRK-EDG-A-POS' }, '==', true),
    delayMs: backupHeaterSequencerStepMs,
    latch: false,
    resetWhenClear: true,
    effects: [write('load-pressurizer-backup-heaters-a', { tagId: 'BRK-PZR-HTR-A-CLOSED' }, true)],
  }),
]

const lossOfOffsitePowerAuxiliaryFeedwater = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ProcessPlantIcRule => rule({
  id: 'loss-of-offsite-power-afw-actuation',
  label: 'Loss of offsite power auxiliary feedwater actuation',
  ruleClass: 'protection',
  condition: all([
    comparison({ tagId: 'UNIT-BUS-A-ENERGIZED' }, '==', false),
    comparison({ tagId: 'UNIT-BUS-B-ENERGIZED' }, '==', false),
  ]),
  delayMs: 1_000,
  effects: [
    trip({
      id: 'afw-actuation',
      title: 'AFW actuation on loss of offsite power',
      message: 'Both unit buses are dead: the turbine-driven auxiliary feedwater pump starts and auxiliary feedwater is lined up to every steam generator.',
      annunciator: annunciator({ system: 'feedwater', equipmentId: 'auxFeedwaterHeader', group: 'auxiliary-feedwater', firstOutGroup: 'auxiliary-feedwater', priority: 'urgent', role: 'automaticAction' }),
    }),
    write('start-turbine-afw', { tagId: 'AFW-PUMP-T' }, true),
    ...loops.map(loop => write(`open-afw-valve-${loop.toLowerCase()}`, { path: `auxFeedwaterValve${loop}.positionFraction` }, afwLineUpPositionFraction)),
  ],
})

export const electricalReferenceIcRules = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'safety-bus-a-loss-alarm',
    label: 'Safety bus A loss of power',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'BUS-A-ENERGIZED' }, '==', false),
    clearCondition: comparison({ tagId: 'BUS-A-ENERGIZED' }, '==', true),
    clearDelayMs: 2_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [
      alarm({
        id: 'safety-bus-a-loss',
        title: 'Safety bus A de-energized',
        message: 'Safety bus A is de-energized; emergency diesel generator A start is demanded.',
        severity: 'critical',
        annunciator: annunciator({ ...electricalAlarm, equipmentId: 'safetyBusA', firstOutGroup: 'electrical-power-loss' }),
      }),
    ],
  }),
  rule({
    id: 'safety-bus-a-loss-diesel-start',
    label: 'Safety bus A loss of power diesel start',
    ruleClass: 'normalControl',
    condition: comparison({ tagId: 'BUS-A-ENERGIZED' }, '==', false),
    clearCondition: comparison({ tagId: 'BUS-A-ENERGIZED' }, '==', true),
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [
      write('start-diesel-generator-a', { tagId: 'EDG-A-START' }, true),
    ],
  }),
  ...dieselGeneratorRules('A'),
  rule({
    id: 'safety-bus-a-degraded-voltage',
    label: 'Safety bus A degraded voltage',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'BUS-A-DEGRADED' }, '==', true),
    clearCondition: comparison({ tagId: 'BUS-A-DEGRADED' }, '==', false),
    clearDelayMs: 2_000,
    // At the degraded-voltage relay's pickup, as the offsite power alarms below explain.
    delayMs: 0,
    latch: false,
    resetWhenClear: true,
    effects: [
      alarm({
        id: 'safety-bus-a-degraded-voltage',
        title: 'Safety bus A degraded voltage',
        message: 'Safety bus A voltage is below the reference degraded-voltage threshold.',
        severity: 'warning',
        annunciator: annunciator({ ...electricalAlarm, equipmentId: 'safetyBusA', firstOutGroup: 'electrical-degraded-voltage' }),
      }),
    ],
  }),
  rule({
    id: 'safety-bus-b-loss-alarm',
    label: 'Safety bus B loss of power',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'BUS-B-ENERGIZED' }, '==', false),
    clearCondition: comparison({ tagId: 'BUS-B-ENERGIZED' }, '==', true),
    clearDelayMs: 2_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [
      alarm({
        id: 'safety-bus-b-loss',
        title: 'Safety bus B de-energized',
        message: 'Safety bus B is de-energized; emergency diesel generator B start is demanded.',
        severity: 'critical',
        annunciator: annunciator({ ...electricalAlarm, equipmentId: 'safetyBusB', firstOutGroup: 'electrical-power-loss' }),
      }),
    ],
  }),
  rule({
    id: 'safety-bus-b-loss-diesel-start',
    label: 'Safety bus B loss of power diesel start',
    ruleClass: 'normalControl',
    condition: comparison({ tagId: 'BUS-B-ENERGIZED' }, '==', false),
    clearCondition: comparison({ tagId: 'BUS-B-ENERGIZED' }, '==', true),
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [
      write('start-diesel-generator-b', { tagId: 'EDG-B-START' }, true),
    ],
  }),
  ...dieselGeneratorRules('B'),
  rule({
    id: 'safety-bus-b-degraded-voltage',
    label: 'Safety bus B degraded voltage',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'BUS-B-DEGRADED' }, '==', true),
    clearCondition: comparison({ tagId: 'BUS-B-DEGRADED' }, '==', false),
    clearDelayMs: 2_000,
    // At the degraded-voltage relay's pickup, as the offsite power alarms below explain.
    delayMs: 0,
    latch: false,
    resetWhenClear: true,
    effects: [
      alarm({
        id: 'safety-bus-b-degraded-voltage',
        title: 'Safety bus B degraded voltage',
        message: 'Safety bus B voltage is below the reference degraded-voltage threshold.',
        severity: 'warning',
        annunciator: annunciator({ ...electricalAlarm, equipmentId: 'safetyBusB', firstOutGroup: 'electrical-degraded-voltage' }),
      }),
    ],
  }),
  lossOfOffsitePowerAuxiliaryFeedwater(loops),
  ...pressurizerBackupHeaterBreakerRules(),
  // Two undervoltage relays watch the offsite supply, as at a reference
  // plant: the degraded-voltage relay at 90 % of nominal and the
  // loss-of-voltage relay at 70 %, the level below which a bus counts dead.
  // The degraded-voltage alarm comes in as its relay picks up; the relay's
  // time delay (about 10 s) belongs to the separation from offsite power the
  // model does not have, so the alarm does not wait for it. The
  // loss-of-voltage relay declares offsite power lost after about 1 s. A grid
  // that sags passes 90 % first and alarms degraded first; one that is lost
  // passes both in a moment, and the degraded alarm still comes first.
  rule({
    id: 'loss-of-offsite-power',
    label: 'Loss of offsite power',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'GRID-VOLTAGE' }, '<', lossOfVoltageFraction),
    clearCondition: comparison({ tagId: 'GRID-VOLTAGE' }, '>=', lossOfVoltageFraction + 0.05),
    clearDelayMs: 2_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'loss-of-offsite-power',
      title: 'Loss of offsite power',
      message: `The offsite grid voltage is below ${lossOfVoltageFraction * 100} % of nominal, the loss-of-voltage relays' set point: offsite power is lost.`,
      severity: 'critical',
      annunciator: annunciator({ ...electricalAlarm, equipmentId: 'offsiteGrid', role: 'cause' }),
    })],
  }),
  rule({
    id: 'offsite-grid-degraded-voltage',
    label: 'Offsite grid degraded voltage',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'GRID-VOLTAGE' }, '<', degradedVoltageFraction),
    clearCondition: comparison({ tagId: 'GRID-VOLTAGE' }, '>=', degradedVoltageFraction + 0.02),
    clearDelayMs: 2_000,
    delayMs: 0,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'offsite-grid-degraded-voltage',
      title: 'Offsite grid degraded voltage',
      message: `The offsite grid voltage is below ${degradedVoltageFraction * 100} % of nominal, the degraded-voltage relays' set point.`,
      severity: 'warning',
      annunciator: annunciator({ ...electricalAlarm, equipmentId: 'offsiteGrid', role: 'cause' }),
    })],
  }),
]
