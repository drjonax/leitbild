import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import type { CompiledComponent, ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

const primaryLoopIdsFrom = (parameters: unknown): ReadonlyArray<string> => {
  const parsed = z.object({
    primaryLoopIds: z.array(idSchema).min(1).max(64).optional(),
  }).passthrough().parse(parameters)
  return parsed.primaryLoopIds ?? []
}

/**
 * What the ex-core nuclear instruments can indicate, declared as their
 * instrument spans so displays tell a pinned reading from a value; a reading
 * beyond pins at the end of its span: the power range 0 to 120 % of rated power, the
 * intermediate range's compensated ion chamber 1e-11 A to 1e-3 A and its
 * startup-rate meter -0.5 to +5 decades a minute, the source range's
 * proportional counter up to 1e6 counts a second.
 */
export const nuclearInstrumentSpans = {
  powerRangePercent: { min: 0, max: 120 },
  intermediateRangeCurrentAmps: { min: 1e-11, max: 1e-3 },
  intermediateRangeStartupRateDpm: { min: -0.5, max: 5 },
  sourceRangeCountRateCps: { min: 0, max: 1e6 },
} as const

// How a core behaves once it is shut down, as its parameters declare it. The
// reference four-loop core declares:
// - Keepin's six delayed-neutron groups for thermal fission of U-235, beta
//   0.0065 (G. R. Keepin, Physics of Nuclear Kinetics, 1965; Lamarsh and
//   Baratta, Introduction to Nuclear Engineering, Table 7.4);
// - seven decay-heat groups fitted, within 3 % from 10 s to two days, to the
//   Wigner-Way fit of the ANS-5.1 curve for a core a year at power,
//   P / P0 = 0.0622 (t^-0.2 - (t + T)^-0.2): 6 % at shutdown, 3.7 % at 10 s,
//   2.3 % at 100 s, 1.5 % at ten minutes, 1 % at an hour;
// - the 4 % dk/k total trip reactivity and 2.7 s drop to dashpot entry that
//   Westinghouse four-loop safety analyses assume for the falling rods (FSAR
//   Chapter 15.0, rod cluster control assembly insertion characteristics),
//   the drop time the standard technical specifications hold each rod to
//   (NUREG-1431, LCO 3.1.4).

/** Delayed-neutron precursor groups the core's kinetics carries. */
export const delayedNeutronGroupCount = 6
/** Fission-product decay-heat groups the core's thermal power carries. */
export const decayHeatGroupCount = 7

const delayedNeutronsSchema = z.object({
  /** The share of fission neutrons born delayed, beta. */
  fraction: z.number().finite().gt(0).lt(0.02),
  /** Each precursor group's share of the delayed neutrons and its decay constant. */
  groups: z.array(z.object({
    relativeYield: z.number().finite().gt(0).lt(1),
    decayConstantPerS: z.number().finite().positive(),
  }).strict()).length(delayedNeutronGroupCount),
}).strict().refine(neutrons => Math.abs(neutrons.groups.reduce((sum, group) => sum + group.relativeYield, 0) - 1) < 1e-6, {
  message: 'delayed-neutron group yields must add up to 1',
})

const decayHeatGroupsSchema = z.array(z.object({
  /** The group's decay heat at equilibrium, as a share of fission power. */
  fractionOfFissionPower: z.number().finite().gt(0).lt(0.2),
  timeConstantS: z.number().finite().positive(),
}).strict()).length(decayHeatGroupCount).refine(groups => groups.reduce((sum, group) => sum + group.fractionOfFissionPower, 0) < 0.2, {
  message: 'decay heat groups must add up to less than a fifth of fission power',
})

const scramSchema = z.object({
  /** The negative reactivity all control rods insert, falling from their at-power positions, once the trip breakers open. */
  reactivityPcm: z.number().finite().positive(),
  /** The time the falling rods take to insert it. */
  insertionTimeS: z.number().finite().positive(),
  /** The reactor trip breakers in series on the rod drive power: either one open drops the rods. */
  reactorTripBreakers: z.array(idSchema).min(1),
}).strict()

const temperatureProgramSchema = z.object({
  /** The average coolant temperature the program asks for with the turbine unloaded. */
  noLoadAverageTemperatureC: z.number().finite(),
  /** The average coolant temperature the program asks for at full turbine load. */
  fullLoadAverageTemperatureC: z.number().finite(),
  /** The turbine whose load, its steam flow over its rated flow as its first-stage pressure reads it, sets the program. */
  turbine: idSchema,
}).strict().refine(program => program.fullLoadAverageTemperatureC > program.noLoadAverageTemperatureC, {
  message: 'average temperature program full-load temperature must be above its no-load temperature',
})

export type ReactorTemperatureProgram = z.infer<typeof temperatureProgramSchema>

const temperatureProgramByComponent = new WeakMap<CompiledComponent, ReactorTemperatureProgram>()

/** A core's average temperature program, Tref against turbine load, as its parameters declare it. */
export const reactorTemperatureProgram = (component: CompiledComponent): ReactorTemperatureProgram => {
  const cached = temperatureProgramByComponent.get(component)
  if (cached !== undefined) return cached
  const parsed = temperatureProgramSchema.parse((component.parameters as Readonly<Record<string, unknown>>).temperatureProgram)
  temperatureProgramByComponent.set(component, parsed)
  return parsed
}

const reactorNeutronicsSchema = z.object({
  delayedNeutrons: delayedNeutronsSchema,
  decayHeatGroups: decayHeatGroupsSchema,
  scram: scramSchema,
}).passthrough()

export type ReactorNeutronics = z.infer<typeof reactorNeutronicsSchema>

const neutronicsByComponent = new WeakMap<CompiledComponent, ReactorNeutronics>()

/** A core's delayed neutrons, decay heat and scram, as its parameters declare them. */
export const reactorNeutronics = (component: CompiledComponent): ReactorNeutronics => {
  const cached = neutronicsByComponent.get(component)
  if (cached !== undefined) return cached
  const parsed = reactorNeutronicsSchema.parse(component.parameters)
  neutronicsByComponent.set(component, parsed)
  return parsed
}

export const reactorComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'reactorCore' as ComponentKind,
    label: 'Reactor Core',
    ports: {
      hotLegA: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      hotLegB: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      hotLegC: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      hotLegD: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      hotLegE: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      hotLegF: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      coldLegA: { kind: 'hydraulicThermal', direction: 'in', circuit: 'coolant' },
      coldLegB: { kind: 'hydraulicThermal', direction: 'in', circuit: 'coolant' },
      coldLegC: { kind: 'hydraulicThermal', direction: 'in', circuit: 'coolant' },
      coldLegD: { kind: 'hydraulicThermal', direction: 'in', circuit: 'coolant' },
      coldLegE: { kind: 'hydraulicThermal', direction: 'in', circuit: 'coolant' },
      coldLegF: { kind: 'hydraulicThermal', direction: 'in', circuit: 'coolant' },
      vesselThermal: { kind: 'thermal', direction: 'out' },
      rodDemand: { kind: 'controlSignal', direction: 'in' },
      tripSignal: { kind: 'logicSignal', direction: 'in' },
    },
    resolveAdditionalPorts: ({ parameters }) =>
      Object.fromEntries(primaryLoopIdsFrom(parameters).flatMap(loopId => [
        [`hotLeg${loopId}`, { kind: 'hydraulicThermal' as const, direction: 'out' as const, circuit: 'coolant' }],
        [`coldLeg${loopId}`, { kind: 'hydraulicThermal' as const, direction: 'in' as const, circuit: 'coolant' }],
      ])),
    parametersSchema: z.object({
      ratedPowerMw: z.number().finite().positive(),
      /** Reactor coolant pressure at which the initial coolant temperatures are sized. */
      nominalCoolantPressureMPa: z.number().finite().positive(),
      primaryLoopIds: z.array(idSchema).min(1).max(64).optional(),
      initialPowerFraction: normalized,
      initialCoolantInletTemperatureC: z.number().finite().optional(),
      coolantThermalTimeConstantS: z.number().finite().positive().optional(),
      fuelThermalTimeConstantS: z.number().finite().positive().optional(),
      fuelTemperatureRiseAtRatedPowerC: z.number().finite().positive().optional(),
      /** Delayed-neutron precursor groups, which set how fission power falls once the core is shut down. */
      delayedNeutrons: delayedNeutronsSchema,
      /** Fission-product decay heat as exponential groups; together their share of fission power at equilibrium. */
      decayHeatGroups: decayHeatGroupsSchema,
      /** What the reactor trip does to the core. */
      scram: scramSchema,
      /** The rod control's reference average coolant temperature, Tref, programmed from turbine load. */
      temperatureProgram: temperatureProgramSchema,
      referenceCoolantOutletTemperatureC: z.number().finite().optional(),
      referenceFuelTemperatureC: z.number().finite().optional(),
      coolantTemperatureFeedbackPcmPerC: z.number().finite().optional(),
      fuelTemperatureFeedbackPcmPerC: z.number().finite().optional(),
      referenceBoronConcentrationPpm: z.number().finite().nonnegative().optional(),
      boronFeedbackPcmPerPpm: z.number().finite().optional(),
      /** Reactivity per percent of the coolant's volume that is steam. */
      voidFeedbackPcmPerPercent: z.number().finite().nonpositive().optional(),
      criticalRodInsertionFraction: normalized.optional(),
      rodWorthPcm: z.number().finite().positive().optional(),
      kineticsPcmPerEfoldPerSecond: z.number().finite().positive().optional(),
      maxPowerRampFractionPerS: z.number().finite().positive().optional(),
      fuelThermalCapacityMjPerC: z.number().finite().positive(),
      nominalPrimaryFlowKgPerS: z.number().finite().positive().optional(),
      /**
       * The coolant's pressure drop through the reactor vessel, cold-leg nozzles
       * to hot-leg nozzles, at nominal primary flow: the path every loop shares.
       */
      nominalPressureDropMPa: z.number().finite().positive().optional(),
      /** The share of vessel flow that bypasses the fuel (head, baffle and guide-thimble flow), so carries no core heat. */
      coreBypassFlowFraction: z.number().finite().min(0).max(0.3).optional(),
      /** Design shaft power the running reactor coolant pumps put into the coolant; sizes the initial loop temperatures. */
      reactorCoolantPumpHeatMw: z.number().finite().nonnegative().optional(),
      /** Source-range count rate at P-6, where its high voltage is cut. */
      nominalSourceRangeCountRateCps: z.number().finite().positive().optional(),
      /** Intermediate-range current at rated power. */
      nominalIntermediateRangeCurrentAmps: z.number().finite().positive().optional(),
      /** P-6: the intermediate-range current above which the source range's high voltage is cut. */
      p6IntermediateRangeCurrentAmps: z.number().finite().positive(),
      /** P-10: the power-range reading, in percent of rated power, above which the low-power trips may be blocked. */
      p10PowerRangePercent: z.number().finite().positive().max(100),
      minimumNaturalCirculationCoolingFraction: normalized.optional(),
    }),
    semantics: fixedSemantics({
      // The core-exit thermocouples are the instrument an operator reads the core's outlet by; the mixed outlet
      // temperature beside them is the model's, at the same point (HMI review of run 23: a detail repeated both).
      keyValues: ['coreExitTemperatureC'],
      // Above P-6 the source range's high voltage is cut and it counts nothing.
      meaningfulWhile: [{ flag: 'sourceRangeEnergized', variables: ['sourceRangeCountRateCps'] }],
      permissives: ['aboveP6', 'aboveP10'],
      // Rod control holds the coolant's average temperature, as the vessel the core heats reads it, to Tref.
      programs: [{ reading: 'meanPrimaryCoolantTemperatureC', via: 'vesselThermal', program: 'referenceAverageTemperatureC', deviation: 'averageTemperatureDeviationC' }],
      // After a reactor trip the power range falls to decay power and the startup rate goes negative.
      shutdownReadings: ['powerRangePercent', 'intermediateRangeStartupRateDpm'],
      energy: [{ role: 'source', circuit: 'coolant', rate: 'totalThermalPowerMw' }],
    }),
    variables: [
      // Fission power is what the power-range channels read: calibrated so that
      // at equilibrium it equals core thermal power, the prompt share of
      // fission energy plus the decay heat of earlier fissions.
      variable({ path: 'powerMw', label: 'Core fission power', kind: 'state', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'fissionPowerMw', label: 'Core fission power diagnostic', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW', simulatorOnly: true }),
      variable({ path: 'totalThermalPowerMw', label: 'Core thermal power', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'reactivityPcm', label: 'Reactivity', kind: 'state', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm', simulatorOnly: true }),
      variable({ path: 'promptReactivityPcm', label: 'Rod-programmed reactivity', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm', simulatorOnly: true }),
      variable({ path: 'temperatureFeedbackPcm', label: 'Temperature feedback reactivity', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm', simulatorOnly: true }),
      variable({ path: 'boronFeedbackPcm', label: 'Boron feedback reactivity', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm', simulatorOnly: true }),
      variable({ path: 'voidFeedbackPcm', label: 'Void feedback reactivity', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm', simulatorOnly: true }),
      variable({ path: 'effectiveReactivityPcm', label: 'Effective core reactivity', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm', simulatorOnly: true }),
      variable({ path: 'rodInsertionFraction', label: 'Rod insertion demand', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', measurand: 'insertion', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'sourceRangeEnergized', label: 'Source-range detector high voltage on', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'sourceRangeCountRateCps', label: 'Source-range neutron count rate', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'countRate', unit: 'cps', limits: { hardRange: nuclearInstrumentSpans.sourceRangeCountRateCps, instrumentSpan: nuclearInstrumentSpans.sourceRangeCountRateCps } }),
      variable({ path: 'intermediateRangeCurrentAmps', label: 'Intermediate-range neutron current', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'electricalCurrent', unit: 'amps', limits: { hardRange: nuclearInstrumentSpans.intermediateRangeCurrentAmps, instrumentSpan: nuclearInstrumentSpans.intermediateRangeCurrentAmps } }),
      variable({ path: 'coolantInletTemperatureC', label: 'Core coolant inlet temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coolantOutletTemperatureC', label: 'Core coolant outlet temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coreExitTemperatureC', label: 'Core-exit temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'averageHotLegFlowKgPerS', label: 'Average hot-leg primary flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'fuelTemperatureC', label: 'Core fuel temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC', simulatorOnly: true }),
      variable({ path: 'fuelLowerTemperatureC', label: 'Lower fuel temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC', simulatorOnly: true }),
      variable({ path: 'fuelMidTemperatureC', label: 'Mid-core fuel temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC', simulatorOnly: true }),
      variable({ path: 'fuelUpperTemperatureC', label: 'Upper fuel temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC', simulatorOnly: true }),
      variable({ path: 'fuelStoredEnergyMj', label: 'Fuel stored heat energy', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'energy', unit: 'MJ', simulatorOnly: true }),
      variable({ path: 'coreCoolingAvailabilityFraction', label: 'Core cooling availability', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', measurand: 'availability', quantity: 'ratio', unit: 'fraction', simulatorOnly: true }),
      variable({ path: 'coreHeatRemovalDeficitMw', label: 'Core heat removal deficit', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'powerDelta', unit: 'MW', simulatorOnly: true }),
      variable({ path: 'fuelHeatupRateCPerS', label: 'Fuel heatup rate', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperatureRate', unit: 'degC/s', simulatorOnly: true }),
      variable({ path: 'decayHeatMw', label: 'Decay heat', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW', simulatorOnly: true }),
      // Each delayed-neutron precursor group as the fission power it sustains at equilibrium.
      ...Array.from({ length: delayedNeutronGroupCount }, (_, index) => variable({ path: `delayedNeutronGroup${index + 1}PowerMw`, label: `Delayed-neutron precursor group ${index + 1}`, kind: 'state', discipline: 'nuclear', writable: false, publish: 'internal', quantity: 'power', unit: 'MW' })),
      ...Array.from({ length: decayHeatGroupCount }, (_, index) => variable({ path: `decayHeatGroup${index + 1}Mw`, label: `Decay heat group ${index + 1}`, kind: 'state', discipline: 'thermal', writable: false, publish: 'internal', quantity: 'power', unit: 'MW' })),
      variable({ path: 'pumpHeatMw', label: 'Reactor coolant pump heat', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW', simulatorOnly: true }),
      variable({ path: 'heatToCoolantMw', label: 'Heat to coolant', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW', simulatorOnly: true }),
      variable({ path: 'vapourGenerationKgPerS', label: 'Reactor coolant steam generation', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s', simulatorOnly: true }),
      variable({ path: 'powerRangePercent', label: 'Power-range neutron flux', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'power', unit: 'percent', limits: { hardRange: nuclearInstrumentSpans.powerRangePercent, instrumentSpan: nuclearInstrumentSpans.powerRangePercent } }),
      variable({ path: 'aboveP10', label: 'P-10 power range above setpoint', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'intermediateRangeStartupRateDpm', label: 'Intermediate-range startup rate', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'startupRate', unit: 'DPM', limits: { hardRange: nuclearInstrumentSpans.intermediateRangeStartupRateDpm, instrumentSpan: nuclearInstrumentSpans.intermediateRangeStartupRateDpm } }),
      variable({ path: 'aboveP6', label: 'P-6 intermediate range above setpoint', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'referenceAverageTemperatureC', label: 'Reference average coolant temperature', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'averageTemperatureDeviationC', label: 'Average coolant temperature deviation from reference', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
    ],
  }),
  defineComponent({
    kind: 'reactorVessel' as ComponentKind,
    label: 'Reactor Vessel',
    ports: {
      coreThermal: { kind: 'thermal', direction: 'in' },
      lowerPlenum: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      upperPlenum: { kind: 'hydraulicThermal', direction: 'in', circuit: 'coolant' },
      pressurizerSurge: { kind: 'hydraulicThermal', direction: 'bidirectional', circuit: 'coolant' },
      releaseOutlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      letdownOutlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
    },
    parametersSchema: z.object({
      /** Loop coolant at the operating point's temperatures and pressure: the reference inventory deviations are read from. */
      nominalPrimaryCoolantInventoryKg: z.number().finite().positive(),
      /** The share of the loops' volume that starts filled with water; steam fills the rest. */
      initialPrimaryCoolantInventoryFraction: normalized,
      /** The loops' volume outside the pressurizer. */
      primaryCoolantVolumeM3: z.number().finite().positive(),
      /** Water-solid stiffness of the reactor coolant system, its liquid and the piping's stretch together. */
      effectiveBulkModulusMPa: z.number().finite().positive(),
      referencePrimaryCoolantTemperatureC: z.number().finite(),
      /** How fast loop water above saturation flashes to steam. */
      flashingTimeConstantS: z.number().finite().positive(),
      /** How fast loop water below saturation takes steam back. */
      condensationTimeConstantS: z.number().finite().positive(),
      /** How fast the surge line's water follows the loops' expansion and contraction. */
      surgeLineTimeConstantS: z.number().finite().positive(),
      /** Letdown flow through the orifices while the coolant is well above the letdown line's backpressure. */
      normalLetdownFlowKgPerS: z.number().finite().nonnegative().optional(),
      /** Pressure the letdown backpressure valve holds behind the orifices. */
      letdownBackpressureMPa: z.number().finite().positive(),
      primaryReleaseRadiationMSvPerH: z.number().finite().nonnegative().optional(),
      initialBoronConcentrationPpm: z.number().finite().nonnegative().optional(),
      collapsedLevelReferenceInventoryFraction: normalized.optional(),
    }),
    semantics: fixedSemantics({
      keyValues: ['subcoolingMarginC', 'collapsedLiquidLevelPercent'],
      aspects: [aspect('level', { variable: 'collapsedLiquidLevelPercent', reading: 'value' })],
      ratedOutflow: [{ port: 'letdownOutlet', parameter: 'normalLetdownFlowKgPerS' }],
    }),
    variables: [
      variable({ path: 'primaryCoolantInventoryKg', label: 'Primary coolant inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'primaryCoolantInventoryDeviationKg', label: 'Primary coolant inventory deviation', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'collapsedLiquidLevelPercent', label: 'Reactor vessel collapsed liquid level', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'meanPrimaryCoolantTemperatureC', label: 'Mean primary coolant temperature', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'subcoolingMarginC', label: 'RCS subcooling margin', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      variable({ path: 'loopSteamMassKg', label: 'Reactor coolant loop steam', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'loopSteamVolumeM3', label: 'Reactor coolant loop steam volume', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'volume', unit: 'm3', simulatorOnly: true }),
      variable({ path: 'loopVoidFraction', label: 'Reactor coolant loop void fraction', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'void', quantity: 'ratio', unit: 'fraction', simulatorOnly: true }),
      variable({ path: 'surgeFlowKgPerS', label: 'Pressurizer surge flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s', simulatorOnly: true }),
      variable({ path: 'chargingFlowKgPerS', label: 'Primary charging flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'safetyInjectionFlowKgPerS', label: 'Primary safety injection flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'letdownFlowKgPerS', label: 'Primary letdown flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'reliefOutflowKgPerS', label: 'Primary relief outflow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s', simulatorOnly: true }),
      variable({ path: 'primaryLeakFlowKgPerS', label: 'Primary coolant boundary leak flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s', simulatorOnly: true }),
      variable({ path: 'tubeLeakFlowKgPerS', label: 'Primary-to-secondary tube leak flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s', simulatorOnly: true }),
      variable({ path: 'netInventoryFlowKgPerS', label: 'Primary inventory net flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s', simulatorOnly: true }),
      variable({ path: 'primaryInventoryBalanceResidualKg', label: 'Primary inventory balance residual', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'boronConcentrationPpm', label: 'Primary coolant boron concentration', kind: 'state', discipline: 'chemical', writable: false, publish: 'telemetry', quantity: 'concentration', unit: 'ppm' }),
      variable({ path: 'primaryReleaseRadiationMSvPerH', label: 'Primary release radiation source term', kind: 'derived', discipline: 'radiological', writable: false, publish: 'telemetry', quantity: 'radiationDoseRate', unit: 'mSv/h', simulatorOnly: true }),
    ],
  }),
]
