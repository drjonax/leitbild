import { z } from 'zod'
import { variablePathSchema, type ComponentDefinition, type ComponentKind } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'
import { fixedSemantics } from './semantics.ts'

// Instrument channels: equipment that measures and computes, moves no fluid
// and has no ports. Each reads the plant's solved state the way its
// instruments would and publishes what it computes; the I&C rules act on that.

const positive = z.number().finite().positive()
const nonnegative = z.number().finite().nonnegative()

/** The spans a loop's delta-T power and flow indicators read over: 0 to 150 % of rated power, 0 to 120 % of rated flow. */
export const deltaTChannelSpans = {
  deltaTPowerPercent: { min: 0, max: 150 },
  loopFlowFraction: { min: 0, max: 1.2 },
} as const

export const instrumentationComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'deltaTProtectionChannel' as ComponentKind,
    label: 'Delta-T Protection Channel',
    // One per reactor coolant loop: the loop's hot- and cold-leg RTDs give its
    // delta-T and average temperature, and the pressurizer pressure channel its
    // pressure. The channel computes the overtemperature and overpower delta-T
    // setpoints in the standard Westinghouse form (NUREG-1431 Table 3.3.1-1,
    // notes 1 and 2; design basis WCAP-8745), as fractions of the loop delta-T
    // at rated thermal power:
    //   OTdT setpoint = dT0 [K1 - K2 (Tavg - T') + K3 (P - P')]
    //   OPdT setpoint = dT0 [K4 - K6 (Tavg - T'')], the K6 term only above T''
    // Simplified where the model lacks a term: it solves no axial flux
    // difference, so f1(dI) and f2(dI) are zero, as they are inside the
    // dI deadband; and it has no lead-lag or rate compensation, so the
    // OTdT lead-lag on Tavg and the OPdT rate term (K5) are left out and
    // the setpoints are their steady-state values. dT0, T' (= T'') and P'
    // are the model's own rated loop delta-T, rated Tavg and nominal
    // pressurizer pressure.
    // The same delta-T over dT0 is the loop's delta-T power, the board's
    // check of the power range, calibrated at forced flow: in natural
    // circulation the loop's delta-T measures its slow flow, not its power,
    // so it reads power only while the loop's reactor coolant pump runs. The
    // loop's flow instruments on its cold leg read the loop's forward flow as
    // a share of its rated flow; a loop the others drive backwards reads none.
    // Both indicators pin at the ends of their spans.
    ports: {},
    parametersSchema: z.object({
      /** Overtemperature delta-T margin at T' and P', a fraction of dT0. */
      overtemperatureK1: positive,
      /** Fall of the overtemperature setpoint per degree of Tavg above T', a fraction of dT0 per degC. */
      overtemperatureK2PerC: nonnegative,
      /** Rise of the overtemperature setpoint per MPa of pressure above P', a fraction of dT0 per MPa. */
      overtemperatureK3PerMPa: nonnegative,
      /** Overpower delta-T margin at or below T'', a fraction of dT0. */
      overpowerK4: positive,
      /** Fall of the overpower setpoint per degree of Tavg above T'', a fraction of dT0 per degC. */
      overpowerK6PerC: nonnegative,
    }).strict(),
    semantics: fixedSemantics({
      keyValues: ['overtemperatureMarginC', 'overpowerMarginC'],
      meaningfulWhile: [{ flag: 'forcedFlow', variables: ['deltaTPowerPercent'] }],
    }),
    variables: [
      variable({ path: 'deltaTC', label: 'Loop delta-T', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      variable({ path: 'averageTemperatureC', label: 'Loop average temperature', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'overtemperatureSetpointC', label: 'Overtemperature delta-T setpoint', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      variable({ path: 'overpowerSetpointC', label: 'Overpower delta-T setpoint', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      variable({ path: 'overtemperatureMarginC', label: 'Overtemperature delta-T margin', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      variable({ path: 'overpowerMarginC', label: 'Overpower delta-T margin', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      // Declared last, so the variables before them keep their places.
      variable({ path: 'deltaTPowerPercent', label: 'Loop delta-T power', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'percent', limits: { hardRange: deltaTChannelSpans.deltaTPowerPercent, instrumentSpan: deltaTChannelSpans.deltaTPowerPercent } }),
      variable({ path: 'forcedFlow', label: 'Loop forced flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      // How fast the loop's hot leg moves, which natural circulation checks stable or falling.
      variable({ path: 'hotLegTemperatureRateCPerS', label: 'Loop hot-leg temperature rate', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperatureRate', unit: 'degC/s' }),
      variable({ path: 'loopFlowFraction', label: 'Loop flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'flow', quantity: 'ratio', unit: 'fraction', limits: { hardRange: deltaTChannelSpans.loopFlowFraction, instrumentSpan: deltaTChannelSpans.loopFlowFraction } }),
    ],
  }),
  defineComponent({
    kind: 'rcsInventoryBalance' as ComponentKind,
    label: 'RCS Inventory Balance',
    // The plant computer's RCS water inventory balance: what the measured
    // flows put into the reactor coolant system (charging, safety injection)
    // less what they take out (letdown, PORV relief, which is identified
    // leakage to the relief tank) and less the change in its water inventory
    // is water leaving it by an unmeasured path: a leak, into containment or
    // through steam generator tubes. A plant infers the inventory change from
    // the pressurizer level; the model's pressurizer level does not follow the
    // RCS inventory, so the balance reads the inventory the model solves.
    ports: {},
    parametersSchema: z.object({
      /** Time constant of the balance's averaging, which steadies it through transients. */
      averagingTimeConstantS: positive,
    }).strict(),
    semantics: fixedSemantics({ keyValues: ['leakRateKgPerS'] }),
    variables: [
      variable({ path: 'leakRateKgPerS', label: 'RCS leak rate', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s' }),
      variable({ path: 'balancedInventoryKg', label: 'RCS inventory at the last balance', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'internal', quantity: 'mass', unit: 'kg' }),
    ],
  }),
  defineComponent({
    kind: 'safetyInjectionBlockLogic' as ComponentKind,
    label: 'Safety Injection Block Logic',
    // The safeguards logic that lets operators block safety injection on low
    // pressurizer pressure for a planned cooldown and depressurization. P-11
    // is pressurizer pressure below its setpoint. Pressed there, the momentary
    // BLOCK pushbutton sets a block memory and springs back; the block holds
    // only while P-11 does and the reactor is tripped (either trip breaker
    // open, P-4), so it resets by itself when pressure rises past P-11 and can
    // never hold with the reactor at power. Requiring P-4 goes beyond the
    // reference plant's logic, where low pressure would trip the reactor first.
    ports: {},
    parametersSchema: z.object({
      /** P-11: the pressurizer pressure below which the block may be set and holds. */
      p11PressureMPa: positive,
      /** The reactor trip breakers whose open contacts make P-4. */
      reactorTripBreakers: z.array(z.string().min(1)).min(1),
    }).strict(),
    semantics: fixedSemantics({ keyValues: ['blocked'], permissives: ['belowP11'] }),
    variables: [
      variable({ path: 'blockPushbutton', label: 'Low pressurizer pressure SI block pushbutton', kind: 'discrete', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'blocked', label: 'Low pressurizer pressure SI blocked', kind: 'state', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'belowP11', label: 'P-11 pressurizer pressure below setpoint', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
    ],
  }),
  defineComponent({
    kind: 'manualActuation' as ComponentKind,
    label: 'Manual Actuation',
    // A control-board pushbutton that demands one protective actuation by
    // hand: a manual reactor trip, a manual turbine trip, manual safety
    // injection. Pressed, it springs back within the step; its logic holds
    // the demand until the actuation has acted, as the equipment it commands
    // reads it (`actedWhen`: the reactor trip breakers open, the generator
    // off line, the safety injection pumps commanded to run), so the
    // protection rule that acts on the demand, evaluated after the step, sees
    // every press, and acts once on it. A press with the actuation already
    // acted demands nothing.
    ports: {},
    parametersSchema: z.object({
      /** The on/off readings that say the demanded actuation has acted, each with the value it then reads. */
      actedWhen: z.array(z.object({ path: variablePathSchema, equals: z.boolean() }).strict()).min(1),
    }).strict(),
    semantics: fixedSemantics({}),
    variables: [
      variable({ path: 'pushbutton', label: 'Pushbutton', kind: 'discrete', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'demanded', label: 'Actuation demanded', kind: 'state', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
    ],
  }),
]
