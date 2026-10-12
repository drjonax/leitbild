import type { ProcessPlantIcSafetyFunction, ProcessPlantIcSafetyFunctionCondition, ProcessPlantIcStatusTreeNode } from '../runtime/index.ts'
import { signalReference, type SignalRef } from './reference-ic-helpers.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'

// The reference PWR's critical safety functions, judged by status trees after
// the generic Westinghouse Owners Group emergency response guidelines (ERG
// F-0.1 to F-0.6), in their order of priority. They are reference-model
// criteria, not qualified plant procedures: each branch compares signals the
// model publishes against the generic ERG value, or this model's own set
// point where the ERG brackets a plant-specific one, and cites which. Where
// the generic tree needs what the model does not publish, the tree says so:
// a branch on a signal the Plant lacks reads unknown; core cooling, without
// a vessel level referenced to core cover,
// shows the core covered only while the RCS is liquid-full and takes the
// lower-level side otherwise; integrity, without a cooldown over an hour or
// a vessel pressure-temperature limit, names the yellow path as the least a
// cold leg below its limit means. Operators place the trees in service
// once a reactor trip is demanded (E-0); all but subcriticality also read
// sensibly at power, so they are judged at all times and subcriticality once
// a trip is demanded.

const comparison = (signal: SignalRef, operator: '<' | '<=' | '>' | '>=' | '==' | '!=', value: number | boolean): ProcessPlantIcSafetyFunctionCondition =>
  ({ type: 'comparison', signal: signalReference(signal), operator, value })
const all = (conditions: ReadonlyArray<ProcessPlantIcSafetyFunctionCondition>): ProcessPlantIcSafetyFunctionCondition => ({ type: 'all', conditions })
const any = (conditions: ReadonlyArray<ProcessPlantIcSafetyFunctionCondition>): ProcessPlantIcSafetyFunctionCondition => ({ type: 'any', conditions })
const branch = (config: {
  readonly question: string
  readonly basis: string
  readonly condition: ProcessPlantIcSafetyFunctionCondition
  readonly yes: ProcessPlantIcStatusTreeNode
  readonly no: ProcessPlantIcStatusTreeNode
}): ProcessPlantIcStatusTreeNode => config
const status = (colour: 'green' | 'yellow' | 'orange' | 'red', meaning: string, procedure?: string): ProcessPlantIcStatusTreeNode =>
  ({ status: colour, meaning, ...(procedure === undefined ? {} : { procedure }) })

/** The loop's instrument number in the reference tags: loop A's cold leg is TE-411-COLD, loop B's TE-421-COLD. */
const loopNumber = (loops: ReadonlyArray<ProcessPlantReferenceLoop>, loop: ProcessPlantReferenceLoop): string => `4${loops.indexOf(loop) + 1}1`

// A reactor trip is demanded once either trip breaker's close command drops,
// and has happened once either reads open: a breaker that fails to open (an
// ATWS) still puts the trees in service, with power range high.
const tripDemanded = (): ProcessPlantIcSafetyFunctionCondition => any([
  comparison({ tagId: 'TRIP-BKR-A' }, '==', false),
  comparison({ tagId: 'TRIP-BKR-B' }, '==', false),
  comparison({ tagId: 'TRIP-BKR-A-POS' }, '==', false),
  comparison({ tagId: 'TRIP-BKR-B-POS' }, '==', false),
])
const atPower = (): ProcessPlantIcSafetyFunctionCondition => all([
  comparison({ tagId: 'TRIP-BKR-A' }, '==', true),
  comparison({ tagId: 'TRIP-BKR-B' }, '==', true),
  comparison({ tagId: 'TRIP-BKR-A-POS' }, '==', true),
  comparison({ tagId: 'TRIP-BKR-B-POS' }, '==', true),
])

/** 5 %: ERG F-0.1, the power range a tripped core reads below. */
const subcriticalPowerRangePercent = 5
/** −0.2 DPM: ERG F-0.1, the intermediate-range startup rate of a core still shutting down. */
const decayingStartupRateDpm = -0.2

const subcriticality = (): ProcessPlantIcSafetyFunction => {
  const startupRateNegative = branch({
    question: 'Intermediate-range startup rate more negative than −0.2 DPM',
    basis: 'ERG F-0.1: intermediate-range SUR more negative than [−0.2 DPM]',
    condition: comparison({ tagId: 'NIS-IR-SUR' }, '<', decayingStartupRateDpm),
    yes: status('green', 'The core is subcritical and its flux is still falling.'),
    no: status('yellow', 'The intermediate-range flux is no longer falling and the source range is off: the core may be approaching criticality slowly.', 'FR-S.2'),
  })
  return {
    id: 'subcriticality',
    label: 'Subcriticality',
    shortLabel: 'SUBCRIT',
    basis: 'Westinghouse ERG F-0.1 (generic), reference-model criteria',
    monitored: { when: tripDemanded(), otherwise: 'Judged once a reactor trip is demanded: at power the reactor is critical by design.' },
    tree: branch({
      question: `Power range below ${subcriticalPowerRangePercent} %`,
      basis: 'ERG F-0.1: power range less than [5 %]',
      condition: comparison({ tagId: 'NIS-PR-AVG' }, '<', subcriticalPowerRangePercent),
      yes: branch({
        question: 'Intermediate-range startup rate zero or negative',
        basis: 'ERG F-0.1: intermediate-range SUR zero or negative',
        condition: comparison({ tagId: 'NIS-IR-SUR' }, '<=', 0),
        yes: branch({
          question: 'Source range energized',
          basis: 'ERG F-0.1: source range energized',
          condition: comparison({ tagId: 'NIS-SR-HV' }, '==', true),
          yes: branch({
            question: 'Source-range startup rate zero or negative',
            basis: 'ERG F-0.1: source-range SUR zero or negative; the rate reads zero on the step the high voltage comes back, before it has a count to compare',
            condition: comparison({ tagId: 'NIS-SR-SUR' }, '<=', 0),
            yes: status('green', 'The core is subcritical with the source range in service.'),
            no: status('yellow', 'The source-range count rate is rising: the core may be approaching criticality slowly.', 'FR-S.2'),
          }),
          no: startupRateNegative,
        }),
        no: status('orange', 'Power range is low but the flux is rising: the core is not shutting down.', 'FR-S.1'),
      }),
      no: status('red', 'Power range is at or above 5 % after a trip demand: the reactor is not shut down (ATWS).', 'FR-S.1'),
    }),
    checks: [],
    expectations: [{
      when: tripDemanded(),
      text: 'After a trip, power range falls below 5 % within about a minute and the intermediate-range startup rate stays negative (pinned at −0.5 DPM at first) as the flux decays: that is shutdown, not a challenge.',
    }],
  }
}

/**
 * 99.5 %: a reactor vessel collapsed liquid level that reads 100 % as a
 * display shows it, the RCS liquid-full; the model's level carries a few
 * litres of numerical steam at power.
 */
const liquidFullPercent = 99.5

/** 649 °C (1,200 °F): ERG F-0.2, the core-exit temperature of inadequate core cooling. */
const inadequateCoreExitC = 649
/** 371 °C (700 °F): ERG F-0.2, the core-exit temperature separating degraded from inadequate core cooling. */
const degradedCoreExitC = 371
/** 16.7 °C (30 °F): ES-0.1 natural-circulation subcooling, this model's subcooling LO ALM (reference-ic-subcooling.ts). */
const naturalCirculationSubcoolingC = 16.7
/** 2.8 °C (5 °F): how close to its steam generator's saturation temperature a cold leg reads under natural circulation. */
const coldLegAtSaturationC = 2.8
// ES-0.1 asks for steam generator pressures, hot legs and core exit "stable or
// falling" and gives no number. This model takes a reading as stable while it
// moves less than its displays call steady, 0.1 % of the reading a minute:
// 0.3 °C/min for a temperature near 300 °C, 0.0076 MPa/min for a steam
// generator at its 7.6 MPa no-load pressure, which moves the saturation
// temperature of that pressure 0.03 °C/min (3.8 °C per MPa there).
/** 0.3 °C/min, in °C/s: the most a stable or falling core-exit or hot-leg temperature rises. */
const stableTemperatureCPerS = 0.3 / 60
/** 0.03 °C/min, in °C/s: the most a stable or falling steam generator pressure moves its saturation temperature up. */
const stableSteamGeneratorSaturationCPerS = 0.03 / 60

const coreCooling = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ProcessPlantIcSafetyFunction => {
  const noPumpRunning = all(loops.map(loop => comparison({ tagId: `RCP-${loop}-RUNNING` }, '==', false)))
  // Saturated or superheated, the generic tree splits by vessel level; this model's vessel
  // level reads the share of the RCS that is liquid, so only a liquid-full RCS shows the core covered.
  const byCoreExit = (covered: boolean): ProcessPlantIcStatusTreeNode => branch({
    question: `Core-exit temperature below ${degradedCoreExitC} °C (700 °F)`,
    basis: 'ERG F-0.2: core-exit thermocouples less than [700 °F]',
    condition: comparison({ tagId: 'CET-AVG' }, '<', degradedCoreExitC),
    yes: covered
      ? status('yellow', 'Subcooling is lost with the RCS liquid-full: core cooling is degraded.', 'FR-C.3')
      : status('orange', 'Subcooling is lost and the vessel is not liquid-full: core cooling is degraded.', 'FR-C.2'),
    no: covered
      ? status('orange', 'Core exit is above 371 °C without subcooling: core cooling is degraded.', 'FR-C.2')
      : status('red', 'Core exit is above 371 °C without subcooling and the vessel is not liquid-full: core cooling is inadequate.', 'FR-C.1'),
  })
  return {
    id: 'core-cooling',
    label: 'Core cooling',
    shortLabel: 'CORE COOL',
    basis: 'Westinghouse ERG F-0.2 (generic) with the ES-0.1 natural-circulation checks, reference-model criteria',
    tree: branch({
      question: `Core-exit temperature below ${inadequateCoreExitC} °C (1,200 °F)`,
      basis: 'ERG F-0.2: core-exit thermocouples less than [1,200 °F]',
      condition: comparison({ tagId: 'CET-AVG' }, '<', inadequateCoreExitC),
      yes: branch({
        question: 'RCS subcooled at the core exit (margin above 0 °C)',
        basis: 'ERG F-0.2: RCS subcooling based on core-exit thermocouples greater than [the instrument uncertainty]; this model\'s instruments carry none',
        condition: comparison({ tagId: 'SUB-MARGIN' }, '>', 0),
        yes: status('green', 'The core exit is subcooled: core cooling is satisfied.'),
        no: branch({
          question: 'Reactor vessel liquid-full (collapsed liquid level reads 100 %)',
          basis: 'ERG F-0.2: RVLIS level greater than [the core-cover value]; this model publishes the liquid share of the RCS, so only 100 % shows the core covered',
          condition: comparison({ tagId: 'RVLS-DYN' }, '>=', liquidFullPercent),
          yes: byCoreExit(true),
          no: byCoreExit(false),
        }),
      }),
      no: status('red', 'Core exit is at or above 649 °C: core cooling is inadequate.', 'FR-C.1'),
    }),
    checks: [
      {
        label: `Natural circulation: subcooling above ${naturalCirculationSubcoolingC} °C (30 °F)`,
        basis: 'ES-0.1 natural-circulation verification: RCS subcooling greater than [30 °F]',
        when: noPumpRunning,
        condition: comparison({ tagId: 'SUB-MARGIN' }, '>', naturalCirculationSubcoolingC),
        notMet: 'Subcooling is too small to confirm natural circulation: keep the core exit subcooled (pressure up, cooldown on the steam generators).',
      },
      {
        label: `Natural circulation: every cold leg within ${coldLegAtSaturationC} °C (5 °F) of its steam generator's saturation temperature`,
        basis: 'ES-0.1 natural-circulation verification: RCS cold-leg temperatures at saturation temperature for steam generator pressure',
        when: noPumpRunning,
        condition: all(loops.map(loop => ({
          type: 'difference' as const,
          signal: signalReference({ tagId: `TE-${loopNumber(loops, loop)}-COLD` }),
          minus: signalReference({ path: `sg${loop}.secondaryTemperatureC` }),
          operator: '<=' as const,
          value: coldLegAtSaturationC,
        }))),
        notMet: 'A cold leg is not yet at its steam generator\'s saturation temperature: natural circulation is still forming or a loop is not carrying flow.',
      },
      {
        label: 'Natural circulation: steam generator pressures stable or falling',
        basis: 'ES-0.1 natural-circulation verification: SG pressures stable or falling; here each pressure moving the saturation temperature it sets up by no more than 0.03 °C/min (0.1 % of 7.6 MPa a minute)',
        when: noPumpRunning,
        condition: all(loops.map(loop => comparison({ tagId: `SG-${loop}-TSAT-RATE` }, '<=', stableSteamGeneratorSaturationCPerS))),
        notMet: 'A steam generator\'s pressure is rising: its steaming does not yet carry the core\'s heat away, or its feed is filling it; natural circulation is not confirmed.',
      },
      {
        label: 'Natural circulation: hot legs stable or falling',
        basis: 'ES-0.1 natural-circulation verification: RCS hot-leg temperatures stable or falling; here none rising faster than 0.3 °C/min',
        when: noPumpRunning,
        condition: all(loops.map(loop => comparison({ tagId: `TE-${loopNumber(loops, loop)}-HOT-RATE` }, '<=', stableTemperatureCPerS))),
        notMet: 'A hot leg is still heating up: natural circulation is still forming, or not carrying the core\'s heat to the steam generators.',
      },
      {
        label: 'Natural circulation: core exit stable or falling',
        basis: 'ES-0.1 natural-circulation verification: core-exit thermocouples stable or falling; here not rising faster than 0.3 °C/min',
        when: noPumpRunning,
        condition: comparison({ tagId: 'CET-AVG-RATE' }, '<=', stableTemperatureCPerS),
        notMet: 'The core exit is still heating up: natural circulation is still forming, or not carrying the core\'s heat away.',
      },
    ],
    expectations: [{
      when: noPumpRunning,
      text: 'With no reactor coolant pump running, core-exit temperature rises 10–20 °C above the cold legs while natural circulation forms. ES-0.1 judges it over 5–15 min: subcooling held, steam generator pressures, hot legs and core exit stable or falling, cold legs at steam generator saturation temperature.',
    }],
  }
}

/** 10 %: ERG F-0.3, a narrow-range level on span in a steam generator (normal containment). */
const narrowRangeOnSpanPercent = 10
/** 27.8 kg/s (440 gpm): ERG F-0.3, the total feed flow that removes decay heat. */
const minimumFeedFlowKgPerS = 27.8
/** 8.27 MPa (1,185 psig): this model's lowest main steam safety valve set pressure. */
const safetyValveSetMPa = 8.27
/** 82 %: this model's steam generator high-high level, feedwater isolation (reference-ic-steam-generator.ts). */
const highHighLevelPercent = 82
/** 8.1 MPa: this model's steam generator high-pressure alarm, above where the relief valves hold pressure (reference-ic-steam-generator.ts). */
const normalReliefLimitMPa = 8.1

const heatSink = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ProcessPlantIcSafetyFunction => {
  const level = (loop: ProcessPlantReferenceLoop): SignalRef => ({ tagId: `SG-${loop}-LVL-NR` })
  const pressure = (loop: ProcessPlantReferenceLoop): SignalRef => ({ tagId: `SG-${loop}-PRESS` })
  // Below the level question, both of its branches go on the same way.
  const onward: ProcessPlantIcStatusTreeNode = branch({
    question: `Pressure in every steam generator below ${safetyValveSetMPa} MPa`,
    basis: 'ERG F-0.3: pressure in all SGs less than [the safety valve set pressure]; this model\'s lowest is 8.27 MPa (1,185 psig)',
    condition: all(loops.map(loop => comparison(pressure(loop), '<', safetyValveSetMPa))),
    yes: branch({
      question: `Narrow-range level in every steam generator below ${highHighLevelPercent} %`,
      basis: 'ERG F-0.3: narrow-range level in all SGs less than [the high-level limit]; this model\'s high-high level is 82 %',
      condition: all(loops.map(loop => comparison(level(loop), '<', highHighLevelPercent))),
      yes: branch({
        question: `Pressure in every steam generator below ${normalReliefLimitMPa} MPa`,
        basis: 'ERG F-0.3: pressure in all SGs less than [the relief valve set pressure]; this model\'s high-pressure alarm, 8.1 MPa, lies above its relief valves (7.86 MPa)',
        condition: all(loops.map(loop => comparison(pressure(loop), '<', normalReliefLimitMPa))),
        yes: branch({
          question: `Narrow-range level in every steam generator above ${narrowRangeOnSpanPercent} %`,
          basis: 'ERG F-0.3: narrow-range level in all SGs greater than [10 %]',
          condition: all(loops.map(loop => comparison(level(loop), '>', narrowRangeOnSpanPercent))),
          yes: status('green', 'Every steam generator has level on span and pressure in hand: the heat sink is satisfied.'),
          no: status('yellow', 'A steam generator\'s narrow-range level is below span while feed holds the heat sink; after a trip from power that is the expected shrink, refilled by auxiliary feedwater.', 'FR-H.5'),
        }),
        no: status('yellow', 'A steam generator is above its relief valves\' pressure: normal steam release is not holding it.', 'FR-H.4'),
      }),
      no: status('yellow', 'A steam generator\'s level is at its high-high limit.', 'FR-H.3'),
    }),
    no: status('orange', 'A steam generator is at its safety valve set pressure.', 'FR-H.2'),
  })
  return {
    id: 'heat-sink',
    label: 'Heat sink',
    shortLabel: 'HEAT SINK',
    basis: 'Westinghouse ERG F-0.3 (generic), reference-model criteria',
    tree: branch({
      question: `Narrow-range level above ${narrowRangeOnSpanPercent} % in at least one steam generator`,
      basis: 'ERG F-0.3: narrow-range level in at least one SG greater than [10 %]',
      condition: any(loops.map(loop => comparison(level(loop), '>', narrowRangeOnSpanPercent))),
      yes: onward,
      no: branch({
        question: `Total feed flow to the steam generators at least ${minimumFeedFlowKgPerS} kg/s (440 gpm)`,
        basis: 'ERG F-0.3: total feedwater flow to SGs greater than [440 gpm], here the feed flowing into every steam generator, auxiliary and main',
        condition: { type: 'total', signals: loops.map(loop => signalReference({ path: `sg${loop}.feedwaterFlowKgPerS` })), operator: '>=', value: minimumFeedFlowKgPerS },
        yes: onward,
        no: status('red', 'No steam generator has level on span and feed is below the minimum flow: the secondary heat sink is lost.', 'FR-H.1'),
      }),
    }),
    checks: [],
    expectations: [{
      when: tripDemanded(),
      text: 'After a trip from power, shrink takes narrow-range levels below span; total feed flow at or above 27.8 kg/s holds the heat sink while auxiliary feedwater refills the steam generators.',
    }],
  }
}

/** 141 °C (285 °F): ERG F-0.4, the cold-leg temperature below which pressurized thermal shock is anticipated. */
const thermalShockColdLegC = 141

const integrity = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ProcessPlantIcSafetyFunction => ({
  id: 'rcs-integrity',
  label: 'RCS integrity',
  shortLabel: 'INTEGRITY',
  basis: 'Westinghouse ERG F-0.4 (generic), reference-model criteria',
  tree: branch({
    question: `Every RCS cold leg above ${thermalShockColdLegC} °C (285 °F)`,
    basis: 'ERG F-0.4: all RCS cold-leg temperatures greater than [285 °F]',
    condition: all(loops.map(loop => comparison({ tagId: `TE-${loopNumber(loops, loop)}-COLD` }, '>', thermalShockColdLegC))),
    yes: status('green', 'Every cold leg is above 141 °C. The tree\'s cooldown criterion (less than 56 °C, 100 °F, in 60 min) is judged on the cold-leg trends: this model publishes no cooldown signal.'),
    no: status('yellow', 'A cold leg is below 141 °C: pressurized thermal shock is anticipated. The orange and red paths depend on the 60-minute cooldown and the vessel pressure–temperature limit, which this model does not publish.', 'FR-P.2'),
  }),
  checks: [],
  expectations: [],
})

/** 0.42 MPa: this model's containment design pressure. */
const containmentDesignMPa = 0.42
/** 0.186 MPa: this model's Hi-3 containment pressure, containment spray (reference-ic-containment.ts). */
const containmentSprayMPa = 0.186
/** 0.5 mSv/h: this model's containment high-radiation alarm (reference-ic-containment.ts). */
const containmentRadiationHighMSvPerH = 0.5

const containment = (): ProcessPlantIcSafetyFunction => ({
  id: 'containment',
  label: 'Containment',
  shortLabel: 'CTMT',
  basis: 'Westinghouse ERG F-0.5 (generic), reference-model criteria; the flooding branch (FR-Z.2) needs a sump flood level this model does not declare',
  tree: branch({
    question: `Containment pressure below ${containmentDesignMPa} MPa`,
    basis: 'ERG F-0.5: containment pressure less than [design pressure]; this model\'s is 0.42 MPa',
    condition: comparison({ tagId: 'CTMT-PR' }, '<', containmentDesignMPa),
    yes: branch({
      question: `Containment pressure below ${containmentSprayMPa} MPa`,
      basis: 'ERG F-0.5: containment pressure less than [the spray actuation set point]; this model\'s Hi-3 is 0.186 MPa',
      condition: comparison({ tagId: 'CTMT-PR' }, '<', containmentSprayMPa),
      yes: branch({
        question: `Containment radiation below ${containmentRadiationHighMSvPerH} mSv/h`,
        basis: 'ERG F-0.5: containment radiation less than [the high-radiation value]; this model\'s alarm is 0.5 mSv/h',
        condition: comparison({ tagId: 'CTMT-RAD' }, '<', containmentRadiationHighMSvPerH),
        yes: status('green', 'Containment pressure and radiation are within their limits.'),
        no: status('yellow', 'Containment radiation is high.', 'FR-Z.3'),
      }),
      no: status('orange', 'Containment pressure is at or above the spray set point.', 'FR-Z.1'),
    }),
    no: status('red', 'Containment pressure is at or above its design pressure.', 'FR-Z.1'),
  }),
  checks: [],
  expectations: [],
})

/** 92 %: ERG F-0.6, the pressurizer level of a nearly solid pressurizer. */
const pressurizerHighPercent = 92
/** 17 %: ERG F-0.6, the pressurizer level below which heaters are cut off (reference-ic-pressurizer.ts). */
const pressurizerLowPercent = 17
/** 10 kg/s: this model's maximum charging the pressurizer level control demands (maxChargingFlowKgPerS). */
const maximumChargingKgPerS = 10

const inventory = (): ProcessPlantIcSafetyFunction => ({
  id: 'rcs-inventory',
  label: 'RCS inventory',
  shortLabel: 'INVENTORY',
  basis: 'Westinghouse ERG F-0.6 (generic), reference-model criteria',
  tree: branch({
    question: `Pressurizer level below ${pressurizerHighPercent} %`,
    basis: 'ERG F-0.6: pressurizer level less than [92 %]',
    condition: comparison({ tagId: 'PZR-LVL' }, '<', pressurizerHighPercent),
    yes: branch({
      question: `Pressurizer level above ${pressurizerLowPercent} %`,
      basis: 'ERG F-0.6: pressurizer level greater than [17 %]',
      condition: comparison({ tagId: 'PZR-LVL' }, '>', pressurizerLowPercent),
      yes: branch({
        question: 'Reactor vessel liquid-full (collapsed liquid level reads 100 %)',
        basis: 'ERG F-0.6: RVLIS upper-head level [100 %]',
        condition: comparison({ tagId: 'RVLS-DYN' }, '>=', liquidFullPercent),
        yes: status('green', 'Pressurizer level is on span and the RCS is liquid-full: inventory is satisfied.'),
        no: status('yellow', 'Steam has formed in the RCS (vessel not liquid-full).', 'FR-I.3'),
      }),
      no: status('yellow', 'Pressurizer level is at or below 17 %.', 'FR-I.2'),
    }),
    no: status('yellow', 'Pressurizer level is at or above 92 %: the pressurizer is nearly solid.', 'FR-I.1'),
  }),
  checks: [{
    label: `At power: pressurizer level control demands less than its ${maximumChargingKgPerS} kg/s maximum charging`,
    basis: 'Generic Westinghouse abnormal procedure for RCS or steam generator tube leakage: trip and safety injection when pressurizer level cannot be held with maximum charging',
    when: atPower(),
    condition: comparison({ tagId: 'CHG-FLOW-SP' }, '<', maximumChargingKgPerS),
    notMet: 'Charging is at its maximum: if pressurizer level keeps falling with letdown isolated, normal makeup cannot hold RCS inventory, so trip the reactor and actuate SI (E-0; E-3 for a tube rupture).',
  }],
  expectations: [{
    when: tripDemanded(),
    text: 'After a trip from power the RCS shrinks: pressurizer level falls and charging runs to its maximum until the average temperature settles at no-load; that is expected, not a loss of inventory.',
  }],
})

export const referenceSafetyFunctions = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ReadonlyArray<ProcessPlantIcSafetyFunction> => [
  subcriticality(),
  coreCooling(loops),
  heatSink(loops),
  integrity(loops),
  containment(),
  inventory(),
]
