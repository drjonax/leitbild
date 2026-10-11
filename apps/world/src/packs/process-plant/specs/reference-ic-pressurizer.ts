import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, comparison, deadbandController, reactorTripBreakerWrites, rule, trip, write } from './reference-ic-helpers.ts'

const pzrAlarm = annunciator({
  system: 'reactorCoolantSystem',
  equipmentId: 'pressurizer',
  group: 'pressurizer',
  priority: 'high',
  role: 'symptom',
})

const pzrAction = annunciator({
  system: 'reactorCoolantSystem',
  equipmentId: 'pressurizer',
  group: 'pressurizer',
  priority: 'urgent',
  role: 'automaticAction',
})

// Pressurizer pressure ladder of the reference four-loop plant, absolute, with
// the gauge pressure Westinghouse plants set it at: normal 15.5 MPa
// (2,235 psig), held by the heaters below 15.35 MPa and the spray above
// 15.65 MPa (2,260 psig); the high-pressure alarm at 16.0 MPa (2,306 psig);
// the PORV opening at 16.18 MPa (2,335 psig) and reseating at 15.85 MPa; the
// high-pressure reactor trip above it at 16.55 MPa (2,385 psig), so a PORV
// that relieves a pressure surge keeps the reactor at power; the code safety
// valves at 17.24 MPa (2,485 psig, the valves' own set pressure). Below
// normal: the low-pressure alarm at 14.8 MPa, the low-pressure reactor trip at
// 13.8 MPa, P-11 at 13.3 MPa and safety injection at 12.7 MPa
// (reference-ic-safety-injection.ts).
const highPressureAlarmMPa = 16.0
const porvOpenMPa = 16.18
const porvReseatMPa = 15.85
const highPressureReactorTripMPa = 16.55
const lowPressureAlarmMPa = 14.8
const lowPressureReactorTripMPa = 13.8

export const pressurizerReferenceIcRules = (): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'pzr-pressure-low',
    label: 'Pressurizer pressure low',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'PT-455' }, '<', lowPressureAlarmMPa),
    clearCondition: comparison({ tagId: 'PT-455' }, '>', 15.0),
    clearDelayMs: 1_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'pressure-low',
      title: 'Pressurizer pressure low',
      message: 'Pressurizer pressure is below the reference low-pressure threshold.',
      severity: 'warning',
      annunciator: pzrAlarm,
    })],
  }),
  rule({
    id: 'pzr-pressure-high',
    label: 'Pressurizer pressure high',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'PT-455' }, '>', highPressureAlarmMPa),
    clearCondition: comparison({ tagId: 'PT-455' }, '<', 15.9),
    clearDelayMs: 1_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'pressure-high',
      title: 'Pressurizer pressure high',
      message: 'Pressurizer pressure is above the reference high-pressure threshold.',
      severity: 'warning',
      annunciator: pzrAlarm,
    })],
  }),
  rule({
    id: 'pzr-pressure-high-relief',
    label: 'Pressurizer high pressure relief actuation',
    ruleClass: 'protection',
    condition: comparison({ tagId: 'PT-455' }, '>', porvOpenMPa),
    delayMs: 1_000,
    // The PORV's bistable acts on every rise past its set point, so the PORV
    // cycles between it and its reseat pressure rather than opening once.
    latch: false,
    resetWhenClear: true,
    effects: [
      trip({
        id: 'relief-actuation',
        title: 'Pressurizer relief actuation',
        message: `Pressurizer pressure is above the PORV's ${porvOpenMPa} MPa (2,335 psig) opening set point: the PORV opens until pressure falls below ${porvReseatMPa} MPa.`,
        actuates: ['pressurizerReliefOpen'],
        annunciator: pzrAction,
      }),
      write('open-porv', { tagId: 'PORV-456A' }, 1),
    ],
  }),
  rule({
    id: 'pzr-relief-flow-high',
    label: 'Pressurizer relief flow high',
    ruleClass: 'alarm',
    condition: comparison({ path: 'pressurizer.reliefFlowKgPerS' }, '>', 1),
    clearCondition: comparison({ path: 'pressurizer.reliefFlowKgPerS' }, '<', 0.5),
    clearDelayMs: 1_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'relief-flow-high',
      title: 'Pressurizer relief flow high',
      message: 'Pressurizer relief flow is above the reference alarm threshold.',
      severity: 'warning',
      annunciator: pzrAlarm,
    })],
  }),
  rule({
    id: 'pzr-safety-valve-open',
    label: 'Pressurizer safety valve open',
    ruleClass: 'alarm',
    // On the valves' flow monitors: a code safety valve lifts only past 17.24 MPa and reseats 5 % below it.
    condition: comparison({ tagId: 'PSV-8010-OPEN' }, '==', true),
    clearCondition: comparison({ tagId: 'PSV-8010-OPEN' }, '==', false),
    clearDelayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'safety-valve-open',
      title: 'Pressurizer safety valve open',
      message: 'The pressurizer code safety valves have lifted and are discharging reactor coolant steam to the relief tank.',
      severity: 'critical',
      annunciator: annunciator({ ...pzrAlarm, priority: 'urgent' }),
    })],
  }),
  rule({
    id: 'pzr-porv-block-valve-not-open',
    label: 'Pressurizer PORV block valve not open',
    ruleClass: 'alarm',
    // On the valve's position feedback: a block valve not fully open isolates or throttles the PORV.
    condition: comparison({ tagId: 'MOV-8000A-POS' }, '<', 0.95),
    clearCondition: comparison({ tagId: 'MOV-8000A-POS' }, '>=', 0.99),
    delayMs: 1_000,
    clearDelayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'porv-block-valve-not-open',
      title: 'PORV block valve not open',
      message: 'The pressurizer PORV block valve is not fully open, so the PORV cannot relieve through it.',
      severity: 'notice',
      annunciator: annunciator({ ...pzrAlarm, priority: 'medium', role: 'status' }),
    })],
  }),
  rule({
    id: 'pzr-pressure-low-reactor-trip',
    label: 'Pressurizer pressure low reactor trip',
    ruleClass: 'protection',
    modes: ['powerOperation'],
    condition: comparison({ tagId: 'PT-455' }, '<', lowPressureReactorTripMPa),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'low-pzr-pressure-reactor-trip',
        title: 'Low pressurizer pressure reactor trip',
        message: 'Pressurizer pressure is below the reference reactor-trip threshold.',
        actuates: ['reactorTrip'],
        annunciator: pzrAction,
      }),
      ...reactorTripBreakerWrites('low-pzr-pressure-trip'),
      write('insert-control-rods-low-pzr-pressure', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'pzr-pressure-high-reactor-trip',
    label: 'Pressurizer pressure high reactor trip',
    ruleClass: 'protection',
    modes: ['powerOperation'],
    condition: comparison({ tagId: 'PT-455' }, '>', highPressureReactorTripMPa),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'high-pzr-pressure-reactor-trip',
        title: 'High pressurizer pressure reactor trip',
        message: `Pressurizer pressure is above the ${highPressureReactorTripMPa} MPa (2,385 psig) high-pressure reactor trip set point, above the PORV's opening.`,
        actuates: ['reactorTrip'],
        annunciator: pzrAction,
      }),
      ...reactorTripBreakerWrites('high-pzr-pressure-trip'),
      write('insert-control-rods-high-pzr-pressure', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'pzr-pressure-relief-reset',
    label: 'Pressurizer relief reset',
    ruleClass: 'normalControl',
    condition: comparison({ tagId: 'PT-455' }, '<', porvReseatMPa),
    latch: false,
    resetWhenClear: true,
    effects: [write('close-porv', { tagId: 'PORV-456A' }, 0)],
  }),
  ...deadbandController({
    id: 'pzr-pressure',
    label: 'Pressurizer pressure',
    signal: { tagId: 'PT-455' },
    low: {
      threshold: 15.35,
      effects: [
        write('energize-heaters', { tagId: 'PZR-HTR' }, 12),
        write('energize-backup-heaters', { tagId: 'PZR-HTR-BU' }, true),
        write('stop-spray', { tagId: 'PZR-SPRAY' }, 0),
      ],
    },
    high: {
      threshold: 15.65,
      effects: [
        write('deenergize-heaters', { tagId: 'PZR-HTR' }, 0),
        write('deenergize-backup-heaters', { tagId: 'PZR-HTR-BU' }, false),
        write('start-spray', { tagId: 'PZR-SPRAY' }, 120),
      ],
    },
    normal: {
      min: 15.4,
      max: 15.6,
      effects: [
        write('deenergize-heaters-normal', { tagId: 'PZR-HTR' }, 0),
        write('deenergize-backup-heaters-normal', { tagId: 'PZR-HTR-BU' }, false),
        write('stop-spray-normal', { tagId: 'PZR-SPRAY' }, 0),
      ],
    },
  }),
  rule({
    id: 'pzr-level-low',
    label: 'Pressurizer level low',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'PZR-LVL' }, '<', 35),
    clearCondition: comparison({ tagId: 'PZR-LVL' }, '>', 40),
    clearDelayMs: 1_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'level-low',
      title: 'Pressurizer level low',
      message: 'Pressurizer level is below the reference low-level threshold.',
      severity: 'warning',
      annunciator: pzrAlarm,
    })],
  }),
  // The low-level bistable at 17 % cuts off every heater, so that none runs
  // uncovered, and isolates letdown, so that the system keeps its water.
  // Letdown stays isolated until an operator opens it again.
  rule({
    id: 'pzr-level-low-letdown-isolation',
    label: 'Pressurizer level low letdown isolation',
    ruleClass: 'normalControl',
    condition: comparison({ tagId: 'PZR-HTR-LO-LVL' }, '==', true),
    latch: false,
    resetWhenClear: true,
    effects: [write('isolate-letdown', { tagId: 'LET-ISOL' }, 0)],
  }),
  rule({
    id: 'pzr-level-low-heaters-off',
    label: 'Pressurizer level low, heaters off',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'PZR-HTR-LO-LVL' }, '==', true),
    clearCondition: comparison({ tagId: 'PZR-HTR-LO-LVL' }, '==', false),
    clearDelayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'heaters-off-letdown-isolated',
      title: 'Pressurizer level low: heaters off, letdown isolated',
      message: 'Pressurizer level is below the 17 % cutoff: every heater is off and letdown is isolated.',
      severity: 'critical',
      annunciator: annunciator({ ...pzrAlarm, priority: 'urgent' }),
    })],
  }),
  rule({
    id: 'pzr-level-high',
    label: 'Pressurizer level high',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'PZR-LVL' }, '>', 75),
    clearCondition: comparison({ tagId: 'PZR-LVL' }, '<', 70),
    clearDelayMs: 1_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'level-high',
      title: 'Pressurizer level high',
      message: 'Pressurizer level is above the reference high-level threshold.',
      severity: 'warning',
      annunciator: pzrAlarm,
    })],
  }),
]
