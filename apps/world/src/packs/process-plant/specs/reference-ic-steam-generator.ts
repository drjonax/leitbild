import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, any, comparison, feedwaterIsolationWrites, reactorTripBreakerWrites, rule, trip, turbineTripWrites, vote, write } from './reference-ic-helpers.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'
import { expectedAfterReactorTrip } from './reference-ic-first-out-groups.ts'
import { rcsLeakRateAlarmKgPerS } from './reference-ic-rcs-leakage.ts'

// A tube leak shows on instruments, never on the fault that makes it: at
// power primary water carries N-16 into this steam generator's steam, so its
// steam-line N-16 monitor (SG-<loop>-N16) rises above its 0.02 mSv/h
// background, and the RCS inventory balance shows water leaving by an
// unmeasured path. Both together point at this generator's tubes. N-16 lives
// seconds and is made only at power, so after a reactor trip these alarms
// clear and the inventory balance alone still shows the leak.
const tubeLeakRadiationMSvPerH = 0.03

// The narrow range spans the upper quarter of the wide range, about 12 ft
// around the normal water level (USNRC Westinghouse Technology Systems Manual
// 3.2), so its set points sit a few feet from the normal level, as a Model 51
// plant's do: P-14 at 78 % and low-low at 21 % on the 33 to 44 % program of
// USNRC Westinghouse Technology Manual 11.1, 82.4 % and 32.3 % in NUREG-1431's
// generic Table 3.3.1-1 and 3.3.2-1.
//
// Narrow-range level limits above the 55 % program: a high alarm, and P-14
// high-high, which isolates main feedwater (its pumps trip and every feed
// regulating valve shuts) and trips the turbine (and so, above P-9, the
// reactor) before water reaches the steam lines.
const levelHighPercent = 75
export const levelHighHighPercent = 82

// Low-low narrow-range level in any one steam generator starts the
// motor-driven auxiliary feedwater pumps and trips the reactor: a generator
// boiling down at power soon uncovers its tubes and the core loses its heat
// sink. The turbine-driven pump starts only on low-low level in two
// generators, as in a Westinghouse plant: one generator's low level is a
// feedwater fault the motor-driven pumps cover, two a loss of heat sink. The
// trip acts while the reactor can be critical (the standard technical
// specifications' modes 1 and 2); auxiliary feedwater starts in every mode,
// lined up, as on every other start, to every steam generator, so that one
// generator's low level does not send all the pumps' flow to it. A real plant
// votes two of three or four level channels per generator; this model has one
// channel each, so that one channel trips.
export const levelLowLowPercent = 20

// Steam pressure ladder of the reference main steam system: the steam dumps
// hold no-load pressure, 7.6 MPa (1,092 psig); each generator's atmospheric
// relief valve opens above 7.86 MPa (1,125 psig) when the condenser is not
// there to take the steam; the high-pressure alarm comes in above them and
// below the lowest safety valve set pressure, 8.27 MPa (the 1,185 psig design
// pressure).
const pressureHighMPa = 8.1

export const steamGeneratorReferenceIcRules = (
  loop: ProcessPlantReferenceLoop,
  loops: ReadonlyArray<ProcessPlantReferenceLoop>,
): ReadonlyArray<ProcessPlantIcRule> => {
  const lower = loop.toLowerCase()
  const sg = `sg${loop}`
  const sgAlarm = annunciator({
    system: 'steamGenerators',
    equipmentId: sg,
    group: `steam-generator-${lower}`,
    priority: 'high',
    role: 'symptom',
  })
  const sgAction = annunciator({
    system: 'steamGenerators',
    equipmentId: sg,
    group: `steam-generator-${lower}`,
    priority: 'urgent',
    role: 'automaticAction',
  })
  // What the levels' shrink after a reactor trip brings in is expected then (expectedAfterReactorTrip).
  const sgShrinkAlarm = annunciator({ ...sgAlarm, expectedAfter: expectedAfterReactorTrip })
  // The reactor trip is the reactor protection system's, first out among its trips.
  const reactorTripAction = annunciator({
    system: 'reactorProtection',
    equipmentId: sg,
    group: 'reactor-protection',
    firstOutGroup: 'reactor-trip',
    priority: 'urgent',
    role: 'automaticAction',
  })
  return [
    rule({
      id: `sg-${lower}-tube-leak-indication`,
      label: `Steam generator ${loop} tube leak indication`,
      ruleClass: 'alarm',
      condition: all([
        comparison({ tagId: `SG-${loop}-N16` }, '>', tubeLeakRadiationMSvPerH),
        comparison({ tagId: 'RCS-LEAK-RATE' }, '>', rcsLeakRateAlarmKgPerS),
      ]),
      clearCondition: any([
        comparison({ tagId: `SG-${loop}-N16` }, '<', (0.02 + tubeLeakRadiationMSvPerH) / 2),
        comparison({ tagId: 'RCS-LEAK-RATE' }, '<', rcsLeakRateAlarmKgPerS / 2),
      ]),
      delayMs: 10_000,
      clearDelayMs: 10_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'tube-leak',
        title: `Steam generator ${loop} tube leak indicated`,
        message: `Steam generator ${loop} secondary radiation is above ${tubeLeakRadiationMSvPerH} mSv/h while the RCS inventory balance shows a leak above 0.063 kg/s: primary water is leaking through its tubes.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-secondary-radiation-high`,
      label: `Steam generator ${loop} secondary radiation high`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-N16` }, '>', 0.5),
      clearCondition: comparison({ tagId: `SG-${loop}-N16` }, '<', 0.4),
      delayMs: 1_000,
      clearDelayMs: 10_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'secondary-radiation-high',
        title: `Steam generator ${loop} secondary radiation high`,
        message: `Steam generator ${loop} secondary radiation is above the reference alarm threshold.`,
        severity: 'critical',
        annunciator: annunciator({ ...sgAlarm, priority: 'urgent', role: 'cause' }),
      })],
    }),
    rule({
      id: `sg-${lower}-level-low`,
      label: `Steam generator ${loop} narrow-range level low`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', 30),
      clearCondition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '>', 35),
      clearDelayMs: 1_000,
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'level-low',
        title: `Steam generator ${loop} level low`,
        message: `Steam generator ${loop} narrow-range level is below the reference low-level threshold.`,
        severity: 'warning',
        annunciator: sgShrinkAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-level-low-low-afw-actuation`,
      label: `Steam generator ${loop} low-low level auxiliary feedwater actuation`,
      ruleClass: 'protection',
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', levelLowLowPercent),
      delayMs: 1_000,
      effects: [
        trip({
          id: 'afw-actuation',
          title: `Steam generator ${loop} low-low level`,
          message: `Steam generator ${loop} low-low level starts the motor-driven auxiliary feedwater pumps, feeding every steam generator.`,
          annunciator: annunciator({ ...sgAction, firstOutGroup: 'auxiliary-feedwater', expectedAfter: expectedAfterReactorTrip }),
        }),
        write('start-motor-afw', { path: 'auxFeedwaterPumpMotor.running' }, true),
        write('start-motor-afw-b', { path: 'auxFeedwaterPumpMotorB.running' }, true),
        ...loops.map(fed => write(`open-afw-valve-${fed.toLowerCase()}`, { path: `auxFeedwaterValve${fed}.positionFraction` }, 1)),
      ],
    }),
    rule({
      id: `sg-${lower}-level-low-low-reactor-trip`,
      label: `Steam generator ${loop} low-low level reactor trip`,
      ruleClass: 'protection',
      modes: ['powerOperation', 'startup'],
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', levelLowLowPercent),
      delayMs: 1_000,
      effects: [
        trip({
          id: 'low-low-level-reactor-trip',
          title: `Reactor trip on steam generator ${loop} low-low level`,
          message: `Steam generator ${loop} narrow-range level fell below the ${levelLowLowPercent} % low-low reactor trip setpoint.`,
          annunciator: annunciator({ ...reactorTripAction, expectedAfter: expectedAfterReactorTrip }),
        }),
        ...reactorTripBreakerWrites(`sg-${lower}-low-low-level-trip`),
        write(`insert-control-rods-sg-${lower}-low-low-level`, { path: 'core.rodInsertionFraction' }, 1),
      ],
    }),
    rule({
      id: `sg-${lower}-level-high`,
      label: `Steam generator ${loop} narrow-range level high`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '>', levelHighPercent),
      clearCondition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', levelHighPercent - 3),
      clearDelayMs: 1_000,
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'level-high',
        title: `Steam generator ${loop} level high`,
        message: `Steam generator ${loop} narrow-range level is above the reference high-level threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-level-high-high-feedwater-isolation`,
      label: `Steam generator ${loop} high-high level feedwater isolation and turbine trip`,
      ruleClass: 'protection',
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '>', levelHighHighPercent),
      delayMs: 1_000,
      effects: [
        trip({
          id: 'feedwater-isolation',
          title: `Steam generator ${loop} high-high level`,
          message: `Steam generator ${loop} high-high level (P-14) isolates main feedwater, tripping its pumps and shutting every feed regulating valve, and trips the turbine.`,
          annunciator: annunciator({ ...sgAction, firstOutGroup: 'feedwater-isolation' }),
        }),
        // The turbine trip it causes is annunciated in the turbine trip's first-out group too, on the same
        // system, so a P-14 trip below P-9, which trips no reactor, still shows the turbine trip and its cause.
        trip({
          id: 'turbine-trip',
          title: `Turbine trip on steam generator ${loop} high-high level (P-14)`,
          message: `Steam generator ${loop} high-high level (P-14) trips the turbine: the stop valves shut and the generator's load is rejected.`,
          annunciator: annunciator({ ...sgAction, firstOutGroup: 'turbine-trip' }),
        }),
        ...feedwaterIsolationWrites('feedwater-isolation', loops),
        ...turbineTripWrites('turbine-trip'),
      ],
    }),
    rule({
      id: `sg-${lower}-pressure-high`,
      label: `Steam generator ${loop} pressure high`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-PRESS` }, '>', pressureHighMPa),
      clearCondition: comparison({ tagId: `SG-${loop}-PRESS` }, '<', pressureHighMPa - 0.1),
      clearDelayMs: 1_000,
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'pressure-high',
        title: `Steam generator ${loop} pressure high`,
        message: `Steam generator ${loop} pressure is above the reference high-pressure threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-atmospheric-relief-valve-open`,
      label: `Steam generator ${loop} atmospheric relief valve open`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-ARV-POS` }, '>', 0.05),
      clearCondition: comparison({ tagId: `SG-${loop}-ARV-POS` }, '<', 0.02),
      clearDelayMs: 1_000,
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'atmospheric-relief-valve-open',
        title: `Steam generator ${loop} atmospheric relief valve open`,
        message: `Steam generator ${loop} atmospheric relief valve reads open: it is venting steam to the atmosphere.`,
        severity: 'warning',
        annunciator: annunciator({ system: 'mainSteam', equipmentId: `steamGeneratorReliefValve${loop}`, group: 'main-steam', priority: 'high', role: 'status' }),
      })],
    }),
    rule({
      id: `sg-${lower}-feedwater-low`,
      label: `Steam generator ${loop} feedwater flow low`,
      ruleClass: 'alarm',
      condition: all([
        comparison({ path: `${sg}.levelPercent` }, '<', 40),
        comparison({ path: `${sg}.feedwaterFlowKgPerS` }, '<', 150),
      ]),
      clearCondition: any([
        comparison({ path: `${sg}.levelPercent` }, '>', 45),
        comparison({ path: `${sg}.feedwaterFlowKgPerS` }, '>', 180),
      ]),
      clearDelayMs: 2_000,
      delayMs: 3_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'feedwater-low',
        title: `Steam generator ${loop} feedwater low`,
        message: `Steam generator ${loop} feedwater flow is low while level is below the reference operating band.`,
        severity: 'warning',
        annunciator: sgShrinkAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-feedwater-flow-low`,
      label: `Steam generator ${loop} feedwater flow low`,
      ruleClass: 'alarm',
      modes: ['powerOperation'],
      condition: comparison({ path: `${sg}.feedwaterFlowKgPerS` }, '<', 150),
      clearCondition: comparison({ path: `${sg}.feedwaterFlowKgPerS` }, '>', 180),
      clearDelayMs: 2_000,
      delayMs: 3_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'feedwater-flow-low',
        title: `Steam generator ${loop} feedwater flow low`,
        message: `Steam generator ${loop} feedwater flow is below the reference low-flow threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
  ]
}

/** The turbine-driven auxiliary feedwater pump's start on low-low level in two of the steam generators. */
export const turbineDrivenAuxiliaryFeedwaterReferenceIcRules = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'sg-level-low-low-turbine-afw-start',
    label: 'Turbine-driven auxiliary feedwater start on low-low level in two steam generators',
    ruleClass: 'protection',
    condition: vote(Math.min(2, loops.length), loops.map(loop => comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', levelLowLowPercent))),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'turbine-afw-start',
        title: 'Turbine-driven AFW start on low-low level',
        message: `Narrow-range level is below ${levelLowLowPercent} % in two steam generators: the turbine-driven auxiliary feedwater pump starts.`,
        annunciator: annunciator({ system: 'feedwater', equipmentId: 'auxFeedwaterPumpTurbine', group: 'auxiliary-feedwater', firstOutGroup: 'auxiliary-feedwater', priority: 'urgent', role: 'automaticAction', expectedAfter: expectedAfterReactorTrip }),
      }),
      write('start-turbine-afw', { path: 'auxFeedwaterPumpTurbine.running' }, true),
    ],
  }),
]
