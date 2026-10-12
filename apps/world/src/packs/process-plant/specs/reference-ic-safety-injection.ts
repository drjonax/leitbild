import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, comparison, feedwaterIsolationWrites, reactorTripBreakerOpen, reactorTripBreakerWrites, rule, trip, write } from './reference-ic-helpers.ts'
import { containmentPressureHigh1MPa } from './reference-ic-containment.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'

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

// The SI signal also trips the reactor: annunciated as its own trip in the
// reactor trip's first-out group, where a first-out panel shows SI among the
// reactor trip's causes, while the SI actuation stands apart in its group.
const reactorTripOnSafetyInjection = (cause: string) => trip({
  id: 'reactor-trip',
  title: `Reactor trip on safety injection, ${cause}`,
  message: `The safety injection signal, on ${cause}, trips the reactor.`,
  annunciator: annunciator({ ...siAction, firstOutGroup: 'reactor-trip' }),
})

// The SI signal also isolates main feedwater (NUREG-1431 Table 3.3.2-1,
// function 5.c): both main feedwater pumps trip and every feed regulating
// valve shuts, so feedwater does not overcool the reactor coolant or feed a
// faulted steam generator while safety injection makes up the coolant. Like
// the reactor trip on SI, it is annunciated on the SI signal's own system, in
// the feedwater isolation's first-out group, where its other sources are
// (P-4 with low Tavg, P-14 high-high level), and it is released with
// them once both reactor trip breakers are closed again
// (reference-ic-balance-of-plant.ts), which the SI signal's own reactor trip
// keeps open meanwhile.
const feedwaterIsolationOnSafetyInjection = (cause: string) => trip({
  id: 'feedwater-isolation',
  title: `Feedwater isolation on safety injection, ${cause}`,
  message: `The safety injection signal, on ${cause}, isolates main feedwater: the main feedwater pumps trip and the feed regulating valves shut.`,
  annunciator: annunciator({ ...siAction, firstOutGroup: 'feedwater-isolation' }),
})

// The SI signal is reset no sooner than a minute after it acts: a
// Westinghouse plant's SI reset timer holds the reset off so that the
// actuated loads have started and sequenced before operators take them back.
const safetyInjectionResetAfterMs = 60_000

const siPumps = [
  { id: 'safetyInjectionPumpA', train: 'A' },
  { id: 'safetyInjectionPumpB', train: 'B' },
] as const

const safetyInjectionWrites = (idPrefix: string, loops: ReadonlyArray<ProcessPlantReferenceLoop>) => [
  ...siPumps.map(pump => write(`start-high-head-si-pump-${pump.train.toLowerCase()}`, { tagId: `SI-PUMP-${pump.train}` }, true)),
  ...reactorTripBreakerWrites(idPrefix),
  write(`insert-control-rods-${idPrefix}`, { path: 'core.rodInsertionFraction' }, 1),
  ...feedwaterIsolationWrites(`${idPrefix}-feedwater-isolation`, loops),
]

export const safetyInjectionReferenceIcRules = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ReadonlyArray<ProcessPlantIcRule> => [
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
        message: `Pressurizer pressure is below ${lowPressurizerPressureSiMPa} MPa: the SI signal starts both high-head safety injection pumps, trips the reactor and isolates main feedwater.`,
        annunciator: siAction,
      }),
      reactorTripOnSafetyInjection('low pressurizer pressure'),
      feedwaterIsolationOnSafetyInjection('low pressurizer pressure'),
      ...safetyInjectionWrites('safety-injection', loops),
    ],
    resetAfterMs: safetyInjectionResetAfterMs,
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
        message: `Containment pressure is above Hi-1, ${containmentPressureHigh1MPa} MPa (3.86 psig): the SI signal starts both high-head safety injection pumps, trips the reactor and isolates main feedwater.`,
        annunciator: siAction,
      }),
      reactorTripOnSafetyInjection('containment pressure Hi-1'),
      feedwaterIsolationOnSafetyInjection('containment pressure Hi-1'),
      ...safetyInjectionWrites('safety-injection-containment', loops),
    ],
    resetAfterMs: safetyInjectionResetAfterMs,
  }),
  // Manual safety injection: a pushbutton on the control board
  // (manualActuation), both trains' switches folded into one, whose demand is
  // the SI signal with all its effects, in any mode and whatever the
  // low-pressure block. The demand holds until both pumps are commanded to run
  // and both reactor trip breakers read open.
  rule({
    id: 'safety-injection-manual',
    label: 'Manual safety injection',
    ruleClass: 'protection',
    condition: comparison({ tagId: 'SI-MAN-DEMAND' }, '==', true),
    effects: [
      trip({
        id: 'safety-injection',
        title: 'Safety injection actuated manually',
        message: 'The manual safety injection pushbutton was pressed: the SI signal starts both high-head safety injection pumps, trips the reactor and isolates main feedwater.',
        annunciator: siAction,
      }),
      reactorTripOnSafetyInjection('manual actuation'),
      feedwaterIsolationOnSafetyInjection('manual actuation'),
      ...safetyInjectionWrites('safety-injection-manual', loops),
    ],
    resetAfterMs: safetyInjectionResetAfterMs,
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
