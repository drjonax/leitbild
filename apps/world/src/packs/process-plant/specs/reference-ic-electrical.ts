import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, comparison, rule, trip, write, type SignalRef } from './reference-ic-helpers.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'
import { auxiliaryFeedwaterThrottleFloor } from './reference-ic-afw-throttle.ts'

/** Undervoltage relay set points, as fractions of nominal voltage (the offsite power alarms below). */
const degradedVoltageFraction = 0.9
const lossOfVoltageFraction = 0.7

// Each safety train's load sequencer (the loadSequencer component counts its
// steps, 5 s apart) closes the bus's loads back onto its diesel in timed
// blocks, so the diesel picks them up a block at a time rather than all at
// once and recovers its frequency and voltage between them. Westinghouse
// plants step at about 5 s, and the standard technical specifications hold
// each interval to within 10 % of its design (NUREG-1431, SR 3.8.1.18). The
// reference plant's blocks are the same on both trains, but for the backup
// heaters, which hang on train A only:
//   step 1 (0 s, the diesel breaker closes): the low-voltage load centres,
//     never shed (battery chargers, valve motors, ventilation), and the
//     charging pump that was running, its run command standing;
//   step 2 (5 s): the motor-driven auxiliary feedwater pump, as a loss of
//     offsite power demands;
//   step 3 (10 s): the component cooling water pump;
//   step 4 (15 s): the service water pump;
//   step 5 (20 s): the containment fan coolers;
//   step 6 (25 s, train A): the pressurizer backup heaters, whose pressure
//     control then decides whether they heat.
// Some 3 to 5 MW in all on each 7 MW diesel. As the bus dies its
// undervoltage relays open the sequenced loads' feeder breakers, so none
// returns before its step. The safety injection and RHR pumps start on a safety
// injection signal, not on this sequence; the component cooling water,
// service water and fan cooler loads have no process model, only their
// electrical load.
interface SequencedLoad {
  readonly step: number
  readonly id: string
  readonly label: string
  /** What the step closes or starts. */
  readonly signal: SignalRef
  /** Whether the bus's undervoltage relays shed it: a breaker the step recloses. A standby pump the step starts is not shed. */
  readonly shed: boolean
}

const sequencedLoads = (train: 'A' | 'B'): ReadonlyArray<SequencedLoad> => [
  { step: 2, id: 'afw', label: 'auxiliary feedwater', signal: { tagId: `AFW-PUMP-${train}` }, shed: false },
  { step: 3, id: 'component-cooling-water', label: 'component cooling water pump', signal: { tagId: `BRK-CCW-${train}-CLOSED` }, shed: true },
  { step: 4, id: 'service-water', label: 'service water pump', signal: { tagId: `BRK-SW-${train}-CLOSED` }, shed: true },
  { step: 5, id: 'containment-fan-coolers', label: 'containment fan coolers', signal: { tagId: `BRK-CFC-${train}-CLOSED` }, shed: true },
  ...(train === 'A' ? [{ step: 6, id: 'pressurizer-heaters', label: 'pressurizer backup heater', signal: { tagId: 'BRK-PZR-HTR-A-CLOSED' }, shed: true }] : []),
]

const loadSequencerRules = (train: 'A' | 'B'): ReadonlyArray<ProcessPlantIcRule> => {
  const lower = train.toLowerCase()
  const loads = sequencedLoads(train)
  return [
    rule({
      id: `safety-bus-${lower}-load-shed`,
      label: `Safety bus ${train} load shed on dead bus`,
      ruleClass: 'normalControl',
      condition: comparison({ tagId: `BUS-${train}-ENERGIZED` }, '==', false),
      latch: false,
      resetWhenClear: true,
      effects: loads.filter(load => load.shed).map(load => write(`shed-${load.id}-${lower}`, load.signal, false)),
    }),
    ...loads.map(load => rule({
      id: `diesel-generator-${lower}-sequencer-${load.id}`,
      label: `Diesel generator ${train} load sequencer ${load.label} step`,
      ruleClass: 'normalControl',
      condition: comparison({ tagId: `SEQ-${train}-STEP` }, '>=', load.step),
      latch: false,
      resetWhenClear: true,
      effects: [write(`sequence-${load.id}-${lower}`, load.signal, true)],
    })),
  ]
}

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
    ...loadSequencerRules(train),
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
  throttleFloor: auxiliaryFeedwaterThrottleFloor,
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
