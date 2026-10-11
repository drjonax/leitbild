import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, comparison, reactorTripBreakerOpen, reactorTripBreakerWrites, rule, trip, write } from './reference-ic-helpers.ts'
import { containmentPressureHigh1MPa } from './reference-ic-containment.ts'

// Safety injection on low pressurizer pressure: below 12.7 MPa (about
// 1,830 psig, within the 1,807 to 1,870 psig Westinghouse plants set it at)
// the SI signal starts the high-head safety injection pumps and trips the
// reactor (NUREG-1431 Table 3.3.2-1, function 1.d). It acts in modes 1 to 3,
// unless operators have blocked it below P-11 (13.3 MPa, 1,915 psig) for a
// planned cooldown and depressurization: the block (SI-BLOCKED) is a memory
// of the safeguards logic (safetyInjectionBlockLogic), which resets it when
// pressure rises past P-11 and holds it only with the reactor tripped. The
// SI signal seals in: it starts the pumps once and stands until reset, and
// the pumps run until stopped.
const lowPressurizerPressureSiMPa = 12.7
const p11PressureMPa = 13.3

const siAction = annunciator({
  system: 'safetyInjection',
  equipmentId: 'safetyInjectionHeader',
  group: 'safety-injection',
  firstOutGroup: 'safety-injection',
  priority: 'urgent',
  role: 'automaticAction',
})

const siPumps = [
  { id: 'safetyInjectionPumpA', train: 'A' },
  { id: 'safetyInjectionPumpB', train: 'B' },
] as const

const safetyInjectionWrites = (idPrefix: string) => [
  ...siPumps.map(pump => write(`start-high-head-si-pump-${pump.train.toLowerCase()}`, { tagId: `SI-PUMP-${pump.train}` }, true)),
  ...reactorTripBreakerWrites(idPrefix),
  write(`insert-control-rods-${idPrefix}`, { path: 'core.rodInsertionFraction' }, 1),
]

export const safetyInjectionReferenceIcRules = (): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'safety-injection-low-pzr-pressure',
    label: 'Safety injection on low pressurizer pressure',
    ruleClass: 'protection',
    modes: ['powerOperation', 'startup', 'hotStandby'],
    condition: all([
      comparison({ tagId: 'PT-455' }, '<', lowPressurizerPressureSiMPa),
      comparison({ tagId: 'SI-BLOCKED' }, '==', false),
    ]),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'safety-injection',
        title: 'Safety injection actuated',
        message: `Pressurizer pressure is below ${lowPressurizerPressureSiMPa} MPa: the SI signal starts both high-head safety injection pumps and trips the reactor.`,
        actuates: ['safetyInjection', 'reactorTrip'],
        annunciator: siAction,
      }),
      ...safetyInjectionWrites('safety-injection'),
    ],
  }),
  // Containment pressure Hi-1 (NUREG-1431 Table 3.3.2-1, function 1.c), in
  // modes 1 to 4: a break inside containment pressurizes it before the
  // pressurizer's pressure falls to its SI set point.
  rule({
    id: 'safety-injection-containment-pressure-high-1',
    label: 'Safety injection on containment pressure Hi-1',
    ruleClass: 'protection',
    modes: ['powerOperation', 'startup', 'hotStandby', 'hotShutdown'],
    condition: comparison({ tagId: 'CTMT-PR' }, '>', containmentPressureHigh1MPa),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'safety-injection',
        title: 'Safety injection actuated on containment pressure Hi-1',
        message: `Containment pressure is above Hi-1, ${containmentPressureHigh1MPa} MPa (3.86 psig): the SI signal starts both high-head safety injection pumps and trips the reactor.`,
        actuates: ['safetyInjection', 'reactorTrip'],
        annunciator: siAction,
      }),
      ...safetyInjectionWrites('safety-injection-containment'),
    ],
  }),
  // The BLOCK pushbutton is accepted only where the block can hold: below
  // P-11, with the reactor tripped. Anywhere else it is refused.
  rule({
    id: 'safety-injection-block-permissive',
    label: 'Low pressurizer pressure SI block permitted below P-11',
    ruleClass: 'permissive',
    condition: all([comparison({ tagId: 'P-11' }, '==', true), reactorTripBreakerOpen()]),
    effects: [],
    commandGates: [{
      signal: { tagId: 'SI-BLOCK' },
      message: `Safety injection on low pressurizer pressure can be blocked only below P-11 (${p11PressureMPa} MPa) with the reactor tripped`,
    }],
  }),
  rule({
    id: 'safety-injection-blocked',
    label: 'Low pressurizer pressure SI blocked',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'SI-BLOCKED' }, '==', true),
    clearCondition: comparison({ tagId: 'SI-BLOCKED' }, '==', false),
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'blocked',
      title: 'Low-pressure SI blocked',
      message: `Safety injection on low pressurizer pressure is blocked; the block resets when pressure rises above P-11 (${p11PressureMPa} MPa).`,
      severity: 'notice',
      annunciator: annunciator({ system: 'safetyInjection', equipmentId: 'safetyInjectionHeader', group: 'safety-injection', priority: 'medium', role: 'status' }),
    })],
  }),
  // Each pump's run feedback, so the board shows which train is injecting.
  ...siPumps.flatMap(pump => {
    const pumpAlarm = annunciator({
      system: 'safetyInjection',
      equipmentId: pump.id,
      group: `safety-injection-pump-${pump.train.toLowerCase()}`,
      priority: 'medium',
      role: 'status',
    })
    return [
      rule({
        id: `si-pump-${pump.train.toLowerCase()}-running`,
        label: `High-head SI pump ${pump.train} running`,
        ruleClass: 'alarm',
        condition: comparison({ tagId: `SI-PUMP-${pump.train}-RUNNING` }, '==', true),
        clearCondition: comparison({ tagId: `SI-PUMP-${pump.train}-RUNNING` }, '==', false),
        delayMs: 1_000,
        clearDelayMs: 1_000,
        latch: false,
        resetWhenClear: true,
        effects: [alarm({
          id: 'running',
          title: `High-head SI pump ${pump.train} running`,
          message: `High-head safety injection pump ${pump.train} is running; it injects into the cold legs once reactor coolant pressure is below its 18.5 MPa shutoff.`,
          severity: 'notice',
          annunciator: pumpAlarm,
        })],
      }),
    ]
  }),
]
