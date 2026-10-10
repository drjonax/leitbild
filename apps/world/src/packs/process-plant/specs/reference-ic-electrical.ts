import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, comparison, rule, trip, write } from './reference-ic-helpers.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'

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
// 4-loop PWR's (two motor-driven of 30 kg/s, one turbine-driven of 60 kg/s),
// so all three together feed some 120 kg/s, about 30 kg/s per steam
// generator, enough for decay heat; operators throttle from there.
const afwLineUpPositionFraction = 1

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
      annunciator: annunciator({ system: 'feedwater', equipmentId: 'auxFeedwaterHeader', group: 'auxiliary-feedwater', priority: 'urgent', role: 'automaticAction' }),
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
    delayMs: 3_000,
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
    delayMs: 3_000,
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
  // One cause per alarm: offsite power is lost when the grid gives no
  // voltage, whether it is disconnected or dead; a sagging grid is the
  // degraded-voltage alarm's.
  rule({
    id: 'loss-of-offsite-power',
    label: 'Loss of offsite power',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'GRID-VOLTAGE' }, '<=', 0),
    clearCondition: comparison({ tagId: 'GRID-VOLTAGE' }, '>', 0),
    clearDelayMs: 2_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'loss-of-offsite-power',
      title: 'Loss of offsite power',
      message: 'The offsite grid gives no voltage.',
      severity: 'critical',
      annunciator: annunciator({ ...electricalAlarm, equipmentId: 'offsiteGrid', role: 'cause' }),
    })],
  }),
  rule({
    id: 'offsite-grid-degraded-voltage',
    label: 'Offsite grid degraded voltage',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'GRID-VOLTAGE' }, '<', 0.9),
    clearCondition: comparison({ tagId: 'GRID-VOLTAGE' }, '>=', 0.92),
    clearDelayMs: 2_000,
    delayMs: 3_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'offsite-grid-degraded-voltage',
      title: 'Offsite grid degraded voltage',
      message: 'The offsite grid voltage is below the reference degraded-voltage threshold.',
      severity: 'warning',
      annunciator: annunciator({ ...electricalAlarm, equipmentId: 'offsiteGrid', role: 'cause' }),
    })],
  }),
]
