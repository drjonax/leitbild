import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'
import { fixedSemantics } from './semantics.ts'

// Instrument channels: equipment that measures and computes, moves no fluid
// and has no ports. Each reads the plant's solved state the way its
// instruments would and publishes what it computes; the I&C rules act on that.

const positive = z.number().finite().positive()
const nonnegative = z.number().finite().nonnegative()

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
    semantics: fixedSemantics({ keyValues: ['overtemperatureMarginC', 'overpowerMarginC'] }),
    variables: [
      variable({ path: 'deltaTC', label: 'Loop delta-T', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      variable({ path: 'averageTemperatureC', label: 'Loop average temperature', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'overtemperatureSetpointC', label: 'Overtemperature delta-T setpoint', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      variable({ path: 'overpowerSetpointC', label: 'Overpower delta-T setpoint', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      variable({ path: 'overtemperatureMarginC', label: 'Overtemperature delta-T margin', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      variable({ path: 'overpowerMarginC', label: 'Overpower delta-T margin', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
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
]
