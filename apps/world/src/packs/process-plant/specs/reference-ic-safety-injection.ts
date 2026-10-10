import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, comparison, reactorTripBreakerWrites, rule, trip, write } from './reference-ic-helpers.ts'

// Safety injection on low pressurizer pressure: below 12.7 MPa (about
// 1,830 psig, within the 1,807 to 1,870 psig Westinghouse plants set it at)
// the SI signal starts the high-head safety injection pumps and trips the
// reactor (NUREG-1431 Table 3.3.2-1, function 1.d). It acts in modes 1 to 3;
// the reference model has no P-11, so it cannot be blocked for a planned
// depressurization in hot standby. The SI signal seals in: it starts the
// pumps once and stands until reset, and the pumps run until stopped.
const lowPressurizerPressureSiMPa = 12.7

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

export const safetyInjectionReferenceIcRules = (): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'safety-injection-low-pzr-pressure',
    label: 'Safety injection on low pressurizer pressure',
    ruleClass: 'protection',
    modes: ['powerOperation', 'startup', 'hotStandby'],
    condition: comparison({ tagId: 'PT-455' }, '<', lowPressurizerPressureSiMPa),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'safety-injection',
        title: 'Safety injection actuated',
        message: `Pressurizer pressure is below ${lowPressurizerPressureSiMPa} MPa: the SI signal starts both high-head safety injection pumps and trips the reactor.`,
        annunciator: siAction,
      }),
      ...siPumps.map(pump => write(`start-high-head-si-pump-${pump.train.toLowerCase()}`, { tagId: `SI-PUMP-${pump.train}` }, true)),
      ...reactorTripBreakerWrites('safety-injection'),
      write('insert-control-rods-safety-injection', { path: 'core.rodInsertionFraction' }, 1),
    ],
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
