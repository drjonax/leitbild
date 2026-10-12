import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, any, comparison, feedwaterIsolationWrites, reactorTripBreakerOpen, rule, trip, turbineTripWrites, vote, write } from './reference-ic-helpers.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'
import { expectedAfterReactorTrip } from './reference-ic-first-out-groups.ts'
import { levelHighHighPercent, levelLowLowPercent } from './reference-ic-steam-generator.ts'
import { auxiliaryFeedwaterThrottleFloor } from './reference-ic-afw-throttle.ts'

const feedwaterAlarm = annunciator({
  system: 'feedwater',
  equipmentId: 'feedwaterHeader',
  group: 'feedwater',
  priority: 'high',
  role: 'symptom',
})

const feedwaterAction = annunciator({
  system: 'feedwater',
  equipmentId: 'feedwaterHeader',
  group: 'feedwater',
  priority: 'urgent',
  role: 'automaticAction',
})

// P-4 (the reactor trip breakers open) with average coolant temperature below
// 564 °F isolates main feedwater, so the steam generators are not overfed as
// their steaming falls to decay heat and the coolant cools to no-load.
const lowTavgFeedwaterIsolationC = 295.6

// Feedwater isolation shuts the feed regulating valves and holds them shut
// against their level controllers (feedwaterIsolationWrites). As in the
// reference logic, P-4 seals the isolation in: it is released only once both
// reactor trip breakers are closed again and no steam generator stands at
// P-14 high-high level, the other isolation the model has. The annunciated
// trip itself latches until an operator resets it, as every trip does.
const feedwaterIsolationRelease = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ProcessPlantIcRule => rule({
  id: 'feedwater-isolation-release',
  label: 'Feedwater isolation release with the reactor trip breakers closed',
  ruleClass: 'normalControl',
  condition: all([
    comparison({ tagId: 'TRIP-BKR-A-POS' }, '==', true),
    comparison({ tagId: 'TRIP-BKR-B-POS' }, '==', true),
    ...loops.map(loop => comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', levelHighHighPercent)),
  ]),
  latch: false,
  resetWhenClear: true,
  effects: loops.map(loop => write(`release-feed-regulating-valve-${loop.toLowerCase()}`, { path: `feedwaterControlValve${loop}.isolationSignal` }, false)),
})

const hotwellLevelLowPercent = 35

// The condensate storage tank is the auxiliary feedwater pumps' suction. Its
// lowest 280,000 gal (1,060 m3) are the Technical Specification reserve for
// auxiliary feedwater, the reference plant's minimum (USNRC Westinghouse
// Technology Systems Manual 5.7; NUREG-1431 LCO 3.7.6 sizes it for hot standby
// and then a cooldown to RHR entry), which other users cannot draw down. The
// tank holds 450,000 gal (1,700 m3), so the reserve is its lowest 62 %, as
// Sequoyah's 240,000 gal reserve is of its 385,000 gal tank (TVA, ML023230321).
// The low-level alarm comes in as the level falls into the reserve: at the
// pumps' full 110 kg/s it then lasts about 2.6 h. The pumps' automatic
// transfer to essential service water on low suction pressure is not
// modelled: the tank can run dry.
const condensateStorageReserveLevelPercent = 62

const turbineAlarm = annunciator({
  system: 'balanceOfPlant',
  equipmentId: 'turbine',
  group: 'turbine-generator',
  priority: 'medium',
  role: 'status',
})

// Frequency ride-through of the generator on its grid boundary, at the
// Nordic values of NC RfG Article 13 (Commission Regulation (EU) 2016/631,
// Table 2) for a 50 Hz grid, the reference plant's nominal frequency.
// Between 49.0 and 51.0 Hz the unit stays connected without limit. Between
// 47.5 and 49.0 Hz, and between 51.0 and 51.5 Hz, it stays connected for at
// least 30 min, the code's minimum, and its frequency relays trip it once a
// band has held that long. Beyond 47.5 or 51.5 Hz the code asks nothing and
// the relays trip it after 0.5 s, a definite-time delay that rides through a
// measuring transient without letting the turbine run on at a frequency its
// blades and the reactor coolant pumps are not rated for. The relays read
// the frequency only of a live boundary, a dead one being the loss-of-load
// trip's. There is no rate-of-change-of-frequency relay, so a frequency
// swinging at 2 Hz/s inside the bands trips nothing. Each trip is the
// turbine trip, sealed in, and above P-9 it trips the reactor.
const frequencyBandMinutesMs = 30 * 60_000
const frequencyRelayDelayMs = 500

const gridFrequencyRideThrough = (): ReadonlyArray<ProcessPlantIcRule> => {
  const gridFrequency = { path: 'offsiteGrid.frequencyHz' }
  const relay = (config: {
    readonly id: string
    readonly label: string
    readonly operator: '<' | '>'
    readonly hz: number
    readonly delayMs: number
    readonly message: string
  }): ProcessPlantIcRule => rule({
    id: config.id,
    label: config.label,
    ruleClass: 'protection',
    condition: all([
      comparison({ tagId: 'GRID-AVAIL' }, '==', true),
      comparison(gridFrequency, config.operator, config.hz),
    ]),
    delayMs: config.delayMs,
    effects: [
      trip({
        id: 'frequency-turbine-trip',
        title: config.label,
        message: config.message,
        annunciator: annunciator({ ...turbineAlarm, firstOutGroup: 'turbine-trip', priority: 'urgent', role: 'automaticAction' }),
      }),
      ...turbineTripWrites(config.id),
    ],
  })
  return [
    relay({
      id: 'turbine-trip-on-grid-underfrequency',
      label: 'Turbine trip on grid underfrequency',
      operator: '<',
      hz: 47.5,
      delayMs: frequencyRelayDelayMs,
      message: 'Grid frequency is below 47.5 Hz, under the band the unit must ride through: the turbine trips.',
    }),
    relay({
      id: 'turbine-trip-on-grid-overfrequency',
      label: 'Turbine trip on grid overfrequency',
      operator: '>',
      hz: 51.5,
      delayMs: frequencyRelayDelayMs,
      message: 'Grid frequency is above 51.5 Hz, over the band the unit must ride through: the turbine trips.',
    }),
    relay({
      id: 'turbine-trip-on-sustained-low-grid-frequency',
      label: 'Turbine trip on 30 min of grid frequency below 49 Hz',
      operator: '<',
      hz: 49.0,
      delayMs: frequencyBandMinutesMs,
      message: 'Grid frequency has stayed below 49.0 Hz for 30 min, the time the unit must ride through it: the turbine trips.',
    }),
    relay({
      id: 'turbine-trip-on-sustained-high-grid-frequency',
      label: 'Turbine trip on 30 min of grid frequency above 51 Hz',
      operator: '>',
      hz: 51.0,
      delayMs: frequencyBandMinutesMs,
      message: 'Grid frequency has stayed above 51.0 Hz for 30 min, the time the unit must ride through it: the turbine trips.',
    }),
  ]
}

export const balanceOfPlantReferenceIcRules = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ReadonlyArray<ProcessPlantIcRule> => [
  // P-4: the reactor trip breakers open trip the turbine, whatever tripped
  // the reactor. It is a turbine trip like any other, annunciated in the
  // turbine trip's first-out group and sealed in until reset, so a display
  // lists it among the actuations of every reactor trip.
  rule({
    id: 'reactor-trip-turbine-trip',
    label: 'Turbine trip on reactor trip (P-4)',
    ruleClass: 'protection',
    condition: reactorTripBreakerOpen(),
    effects: [
      trip({
        id: 'reactor-trip-turbine-trip',
        title: 'Turbine trip on reactor trip (P-4)',
        message: 'The reactor trip breakers are open (P-4): the turbine stop valve shuts and the generator\'s load is rejected.',
        annunciator: annunciator({ ...turbineAlarm, firstOutGroup: 'turbine-trip', priority: 'urgent', role: 'automaticAction' }),
      }),
      ...turbineTripWrites('reactor-trip'),
    ],
  }),
  rule({
    id: 'reactor-trip-low-tavg-feedwater-isolation',
    label: 'Feedwater isolation on reactor trip with low Tavg (P-4)',
    ruleClass: 'protection',
    // After a trip from operation: in shutdown the feedwater is not in service.
    modes: ['hotStandby'],
    condition: all([reactorTripBreakerOpen(), comparison({ tagId: 'TAVG' }, '<', lowTavgFeedwaterIsolationC)]),
    // It trips both main feedwater pumps and shuts every feed regulating
    // valve until the isolation is released (feedwaterIsolationRelease).
    effects: [
      trip({
        id: 'feedwater-isolation',
        title: 'Feedwater isolation on reactor trip, low Tavg',
        message: `The reactor trip breakers are open (P-4) and average coolant temperature is below ${lowTavgFeedwaterIsolationC} °C (564 °F): the main feedwater pumps trip and the feed regulating valves shut until the trip breakers are closed again.`,
        annunciator: annunciator({ ...feedwaterAction, firstOutGroup: 'feedwater-isolation', expectedAfter: expectedAfterReactorTrip }),
      }),
      ...feedwaterIsolationWrites('feedwater-isolation', loops),
    ],
  }),
  feedwaterIsolationRelease(loops),
  rule({
    id: 'main-feedwater-pumps-tripped-afw-start',
    label: 'Auxiliary feedwater start on trip of all main feedwater pumps',
    ruleClass: 'protection',
    // The standard technical specifications' modes 1 and 2: below them the
    // main feedwater pumps may be shut down without a heat sink at stake.
    modes: ['powerOperation', 'startup'],
    // Pumps stopped with a unit bus still live were tripped. With both unit
    // buses dead it is a loss of offsite power: the safety buses are dead too
    // until the diesels pick them up, and each motor-driven pump starts on its
    // diesel's load sequencer, not with the block of loads that come back.
    condition: all([
      comparison({ tagId: 'MFW-PUMP-A-RUNNING' }, '==', false),
      comparison({ tagId: 'MFW-PUMP-B-RUNNING' }, '==', false),
      any([
        comparison({ tagId: 'UNIT-BUS-A-ENERGIZED' }, '==', true),
        comparison({ tagId: 'UNIT-BUS-B-ENERGIZED' }, '==', true),
      ]),
    ]),
    effects: [
      trip({
        id: 'afw-start',
        title: 'Auxiliary feedwater start on main feedwater pump trip',
        message: 'Both main feedwater pumps read stopped: the motor-driven auxiliary feedwater pumps start and feed every steam generator.',
        annunciator: annunciator({ ...feedwaterAction, equipmentId: 'auxFeedwaterHeader', firstOutGroup: 'auxiliary-feedwater' }),
      }),
      write('start-motor-afw-on-main-feedwater-pump-trip', { path: 'auxFeedwaterPumpMotor.running' }, true),
      write('start-motor-afw-b-on-main-feedwater-pump-trip', { path: 'auxFeedwaterPumpMotorB.running' }, true),
      ...loops.map(loop => write(`open-afw-valve-${loop.toLowerCase()}-on-main-feedwater-pump-trip`, { path: `auxFeedwaterValve${loop}.positionFraction` }, 1)),
    ],
    throttleFloor: auxiliaryFeedwaterThrottleFloor,
  }),
  rule({
    id: 'condensate-storage-tank-level-low',
    label: 'Condensate storage tank level low',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'CST-LVL' }, '<', condensateStorageReserveLevelPercent),
    clearCondition: comparison({ tagId: 'CST-LVL' }, '>', condensateStorageReserveLevelPercent + 2),
    clearDelayMs: 2_000,
    delayMs: 2_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'level-low',
      title: 'Condensate storage tank level low',
      message: `Condensate storage tank level is below ${condensateStorageReserveLevelPercent} %: auxiliary feedwater is drawing on the tank's Technical Specification reserve of 280,000 gal (1,060 m3).`,
      severity: 'warning',
      annunciator: annunciator({ system: 'feedwater', equipmentId: 'auxFeedwaterTank', group: 'auxiliary-feedwater', priority: 'high', role: 'symptom' }),
    })],
  }),
  // A low-low level that comes while a safety bus is dead, as the generators
  // shrink after a loss of offsite power, does not start that bus's
  // motor-driven pump with the block of loads its diesel picks up: the
  // diesel's load sequencer starts it in its own step
  // (reference-ic-electrical.ts). This hold acts with the low-low level's
  // start, in the same scan and after it.
  ...(['A', 'B'] as const).map(train => rule({
    id: `motor-driven-afw-pump-${train.toLowerCase()}-dead-bus-hold`,
    label: `Motor-driven auxiliary feedwater pump ${train} start held for its sequencer on a dead safety bus`,
    ruleClass: 'normalControl',
    condition: all([
      comparison({ tagId: `BUS-${train}-ENERGIZED` }, '==', false),
      vote(1, loops.map(loop => comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', levelLowLowPercent))),
    ]),
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [write(`hold-motor-driven-afw-pump-${train.toLowerCase()}`, { tagId: `AFW-PUMP-${train}` }, false)],
  })),
  rule({
    id: 'main-feedwater-pump-trip',
    label: 'Main feedwater pump unavailable',
    ruleClass: 'alarm',
    condition: any([
      comparison({ tagId: 'MFW-PUMP-A-RUNNING' }, '==', false),
      comparison({ tagId: 'MFW-PUMP-B-RUNNING' }, '==', false),
    ]),
    clearCondition: all([
      comparison({ tagId: 'MFW-PUMP-A-RUNNING' }, '==', true),
      comparison({ tagId: 'MFW-PUMP-B-RUNNING' }, '==', true),
    ]),
    clearDelayMs: 1_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'main-feedwater-pump-unavailable',
      title: 'Main feedwater pump unavailable',
      message: 'At least one main feedwater pump is not running.',
      severity: 'warning',
      annunciator: feedwaterAlarm,
    })],
  }),
  // Loss of load: the grid boundary dead while the generator's output
  // breaker is closed on it. A full load rejection is beyond what the steam
  // dumps and the rods take together (about 50 %), so, as at the reference
  // plant, generator protection opens the output breaker and the turbine
  // trips at once; above P-9 the turbine trip trips the reactor. Both are
  // on/off states, so no display draws a limit on the generator's output.
  // The trip seals in as every turbine trip does: the stop valve stays shut and
  // the load rejected until operators reopen and load it again, so a grid
  // that comes back finds the unit importing its house load, not exporting.
  rule({
    id: 'turbine-trip-on-loss-of-load',
    label: 'Turbine trip on loss of load, grid boundary dead',
    ruleClass: 'protection',
    condition: all([
      comparison({ tagId: 'GRID-AVAIL' }, '==', false),
      comparison({ path: 'turbine.outputBreakerClosed' }, '==', true),
    ]),
    effects: [
      trip({
        id: 'loss-of-load-turbine-trip',
        title: 'Turbine trip on loss of load',
        message: 'The grid boundary is dead while the generator\'s output breaker is closed on it: the breaker opens and the turbine trips.',
        annunciator: annunciator({ ...turbineAlarm, firstOutGroup: 'turbine-trip', priority: 'urgent', role: 'automaticAction' }),
      }),
      ...turbineTripWrites('loss-of-load'),
    ],
  }),
  ...gridFrequencyRideThrough(),
  rule({
    id: 'turbine-load-low',
    label: 'Turbine load low',
    ruleClass: 'alarm',
    modes: ['powerOperation'],
    condition: comparison({ tagId: 'TURB-LOAD' }, '<', 0.5),
    clearCondition: comparison({ tagId: 'TURB-LOAD' }, '>', 0.55),
    clearDelayMs: 1_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'load-low',
      title: 'Turbine load low',
      message: 'Turbine load demand is below the reference low-load threshold.',
      severity: 'notice',
      annunciator: turbineAlarm,
    })],
  }),
  rule({
    id: 'generator-output-low',
    label: 'Generator output low',
    ruleClass: 'alarm',
    modes: ['powerOperation'],
    condition: comparison({ tagId: 'GEN-MW' }, '<', 450),
    clearCondition: comparison({ tagId: 'GEN-MW' }, '>', 500),
    clearDelayMs: 2_000,
    delayMs: 5_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'generator-output-low',
      title: 'Generator output low',
      message: 'Generator electrical output is below the reference low-output threshold.',
      severity: 'notice',
      annunciator: turbineAlarm,
    })],
  }),
  rule({
    id: 'condenser-backpressure-high',
    label: 'Condenser backpressure high',
    ruleClass: 'alarm',
    condition: comparison({ path: 'condenser.backPressurePa' }, '>', 35_000),
    clearCondition: comparison({ path: 'condenser.backPressurePa' }, '<', 32_000),
    clearDelayMs: 2_000,
    delayMs: 2_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'backpressure-high',
      title: 'Condenser backpressure high',
      message: 'Condenser backpressure is above the reference operating threshold.',
      severity: 'warning',
      annunciator: annunciator({ ...turbineAlarm, equipmentId: 'condenser', priority: 'high', role: 'symptom' }),
    })],
  }),
  // The hotwell's low-level alarm, well below its 55 % normal level and
  // before the condensate pumps lose their suction. The feedwater tank's level
  // control valve stops the condensate pumps' flow when the feedwater pumps
  // stop, so a trip does not drain it, and what rises above 60 % is rejected
  // to the condensate storage tank.
  rule({
    id: 'condenser-hotwell-level-low',
    label: 'Condenser hotwell level low',
    ruleClass: 'alarm',
    condition: comparison({ path: 'condenser.condensateLevelPercent' }, '<', hotwellLevelLowPercent),
    clearCondition: comparison({ path: 'condenser.condensateLevelPercent' }, '>', hotwellLevelLowPercent + 5),
    clearDelayMs: 2_000,
    delayMs: 2_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'hotwell-level-low',
      title: 'Condenser hotwell level low',
      message: `Condenser hotwell level is below ${hotwellLevelLowPercent} %: the condensate pumps are drawing it down faster than the condenser refills it.`,
      severity: 'warning',
      annunciator: annunciator({ ...turbineAlarm, equipmentId: 'condenser', priority: 'high', role: 'symptom' }),
    })],
  }),
  // The manual turbine trip: a pushbutton on the control board
  // (manualActuation) whose demand shuts the turbine stop valves and rejects
  // the generator's load, a turbine trip like any other, sealed in and
  // annunciated in the turbine trip's first-out group; above P-9 the shut stop
  // valves then trip the reactor. The demand holds until the generator is off
  // line.
  rule({
    id: 'turbine-manual-trip',
    label: 'Manual turbine trip',
    ruleClass: 'protection',
    condition: comparison({ tagId: 'TURB-TRIP-MAN-DEMAND' }, '==', true),
    effects: [
      trip({
        id: 'manual-turbine-trip',
        title: 'Manual turbine trip',
        message: 'The manual turbine trip pushbutton was pressed: the turbine stop valves shut and the generator\'s load is rejected.',
        annunciator: annunciator({ ...turbineAlarm, firstOutGroup: 'turbine-trip', priority: 'urgent', role: 'automaticAction' }),
      }),
      ...turbineTripWrites('manual-turbine-trip'),
    ],
  }),
  rule({
    id: 'main-steam-safety-valve-open',
    label: 'Main steam safety valve open',
    ruleClass: 'alarm',
    condition: comparison({ path: 'mainSteamSafetyValve.effectivePositionFraction' }, '>', 0.1),
    clearCondition: comparison({ path: 'mainSteamSafetyValve.effectivePositionFraction' }, '<', 0.05),
    clearDelayMs: 1_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'safety-valve-open',
      title: 'Main steam safety valve open',
      message: 'Main steam safety valve effective position is above the reference open threshold.',
      severity: 'warning',
      annunciator: annunciator({ system: 'mainSteam', equipmentId: 'mainSteamSafetyValve', group: 'main-steam', priority: 'high', role: 'status' }),
    })],
  }),
]
