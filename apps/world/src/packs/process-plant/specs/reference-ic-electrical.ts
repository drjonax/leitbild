import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, any, comparison, rule, write } from './reference-ic-helpers.ts'

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
const dieselOutputBreakerRules = (train: 'A' | 'B'): ReadonlyArray<ProcessPlantIcRule> => {
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
  ]
}

export const electricalReferenceIcRules = (): ReadonlyArray<ProcessPlantIcRule> => [
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
  ...dieselOutputBreakerRules('A'),
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
  ...dieselOutputBreakerRules('B'),
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
  rule({
    id: 'loss-of-offsite-power',
    label: 'Loss of offsite power',
    ruleClass: 'alarm',
    condition: any([
      comparison({ tagId: 'GRID-AVAIL' }, '==', false),
      comparison({ tagId: 'GRID-MW' }, '<', 1),
    ]),
    clearCondition: comparison({ tagId: 'GRID-AVAIL' }, '==', true),
    clearDelayMs: 2_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'loss-of-offsite-power',
      title: 'Loss of offsite power',
      message: 'The offsite grid source is unavailable or providing no usable power.',
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
