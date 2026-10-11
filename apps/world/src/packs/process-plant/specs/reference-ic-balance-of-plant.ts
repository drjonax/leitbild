import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, any, comparison, feedwaterIsolationWrites, reactorTripBreakerOpen, rule, trip, turbineTripWrites, write } from './reference-ic-helpers.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'
import { levelHighHighPercent } from './reference-ic-steam-generator.ts'

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

const turbineAlarm = annunciator({
  system: 'balanceOfPlant',
  equipmentId: 'turbine',
  group: 'turbine-generator',
  priority: 'medium',
  role: 'status',
})

export const balanceOfPlantReferenceIcRules = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'reactor-trip-turbine-trip',
    label: 'Reactor trip turbine trip',
    ruleClass: 'normalControl',
    condition: reactorTripBreakerOpen(),
    latch: false,
    resetWhenClear: true,
    effects: [
      write('close-turbine-stop-valve-on-reactor-trip', { path: 'turbineStopValve.positionFraction' }, 0),
      write('reject-turbine-load-on-reactor-trip', { tagId: 'TURB-LOAD' }, 0),
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
        actuates: ['feedwaterIsolation'],
        annunciator: feedwaterAction,
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
        actuates: ['auxiliaryFeedwaterStart'],
        annunciator: annunciator({ ...feedwaterAction, equipmentId: 'auxFeedwaterHeader' }),
      }),
      write('start-motor-afw-on-main-feedwater-pump-trip', { path: 'auxFeedwaterPumpMotor.running' }, true),
      write('start-motor-afw-b-on-main-feedwater-pump-trip', { path: 'auxFeedwaterPumpMotorB.running' }, true),
      ...loops.map(loop => write(`open-afw-valve-${loop.toLowerCase()}-on-main-feedwater-pump-trip`, { path: `auxFeedwaterValve${loop}.positionFraction` }, 1)),
    ],
  }),
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
  // Loss of load: the grid boundary dead while the generator carries load.
  // A full load rejection is beyond what the steam dumps and the rods take
  // together (about 50 %), so, as at the reference plant, generator
  // protection opens the output breaker and the turbine trips at once; above
  // P-9 the turbine trip trips the reactor. The
  // trip seals in as every turbine trip does: the stop valve stays shut and
  // the load rejected until operators reopen and load it again, so a grid
  // that comes back finds the unit importing its house load, not exporting.
  rule({
    id: 'turbine-trip-on-loss-of-load',
    label: 'Turbine trip on loss of load, grid boundary dead',
    ruleClass: 'protection',
    condition: all([
      comparison({ tagId: 'GRID-AVAIL' }, '==', false),
      comparison({ tagId: 'GEN-MW' }, '>', 0),
    ]),
    effects: [
      trip({
        id: 'loss-of-load-turbine-trip',
        title: 'Turbine trip on loss of load',
        message: 'The grid boundary is dead while the generator carries load: its output breaker opens and the turbine trips.',
        actuates: ['turbineTrip'],
        annunciator: annunciator({ ...turbineAlarm, priority: 'urgent', role: 'automaticAction' }),
      }),
      ...turbineTripWrites('loss-of-load'),
    ],
  }),
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
  // before the condensate pumps lose their suction.
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
