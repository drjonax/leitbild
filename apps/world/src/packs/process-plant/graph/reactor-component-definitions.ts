import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

const primaryLoopIdsFrom = (parameters: unknown): ReadonlyArray<string> => {
  const parsed = z.object({
    primaryLoopIds: z.array(idSchema).min(1).max(64).optional(),
  }).passthrough().parse(parameters)
  return parsed.primaryLoopIds ?? []
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
      primaryLoopIds: z.array(idSchema).min(1).max(64).optional(),
      initialPowerFraction: normalized,
      initialCoolantInletTemperatureC: z.number().finite().optional(),
      coolantThermalTimeConstantS: z.number().finite().positive().optional(),
      fuelThermalTimeConstantS: z.number().finite().positive().optional(),
      fuelTemperatureRiseAtRatedPowerC: z.number().finite().positive().optional(),
      decayHeatFractionAtPower: z.number().finite().min(0).max(0.2).optional(),
      decayHeatTimeConstantS: z.number().finite().positive().optional(),
      referenceCoolantOutletTemperatureC: z.number().finite().optional(),
      referenceFuelTemperatureC: z.number().finite().optional(),
      coolantTemperatureFeedbackPcmPerC: z.number().finite().optional(),
      fuelTemperatureFeedbackPcmPerC: z.number().finite().optional(),
      referenceBoronConcentrationPpm: z.number().finite().nonnegative().optional(),
      boronFeedbackPcmPerPpm: z.number().finite().optional(),
      criticalRodInsertionFraction: normalized.optional(),
      rodWorthPcm: z.number().finite().positive().optional(),
      kineticsPcmPerEfoldPerSecond: z.number().finite().positive().optional(),
      maxPowerRampFractionPerS: z.number().finite().positive().optional(),
      fuelThermalCapacityMjPerC: z.number().finite().positive(),
      nominalPrimaryFlowKgPerS: z.number().finite().positive().optional(),
      /** Source-range count rate at P-6, where its high voltage is cut. */
      nominalSourceRangeCountRateCps: z.number().finite().positive().optional(),
      /** Intermediate-range current at rated power. */
      nominalIntermediateRangeCurrentAmps: z.number().finite().positive().optional(),
      /** P-6: the intermediate-range current above which the source range's high voltage is cut. */
      sourceRangeCutoffCurrentAmps: z.number().finite().positive().optional(),
      minimumNaturalCirculationCoolingFraction: normalized.optional(),
    }),
    semantics: fixedSemantics({
      keyValues: ['coolantOutletTemperatureC'],
      // Above P-6 the source range's high voltage is cut and it counts nothing.
      meaningfulWhile: [{ flag: 'sourceRangeEnergized', variables: ['sourceRangeCountRateCps'] }],
      energy: [{ role: 'source', circuit: 'coolant', rate: 'totalThermalPowerMw' }],
    }),
    variables: [
      variable({ path: 'powerMw', label: 'Core fission power', kind: 'state', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'fissionPowerMw', label: 'Core fission power diagnostic', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'totalThermalPowerMw', label: 'Core total thermal power', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'reactivityPcm', label: 'Reactivity', kind: 'state', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm' }),
      variable({ path: 'promptReactivityPcm', label: 'Rod-programmed reactivity', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm' }),
      variable({ path: 'temperatureFeedbackPcm', label: 'Temperature feedback reactivity', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm' }),
      variable({ path: 'boronFeedbackPcm', label: 'Boron feedback reactivity', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm' }),
      variable({ path: 'effectiveReactivityPcm', label: 'Effective core reactivity', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm' }),
      variable({ path: 'rodInsertionFraction', label: 'Rod insertion demand', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', measurand: 'insertion', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'sourceRangeEnergized', label: 'Source-range detector high voltage on', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'sourceRangeCountRateCps', label: 'Source-range neutron count rate', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'countRate', unit: 'cps' }),
      variable({ path: 'intermediateRangeCurrentAmps', label: 'Intermediate-range neutron current', kind: 'derived', discipline: 'nuclear', writable: false, publish: 'telemetry', quantity: 'electricalCurrent', unit: 'amps' }),
      variable({ path: 'coolantInletTemperatureC', label: 'Core coolant inlet temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coolantOutletTemperatureC', label: 'Core coolant outlet temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'averageHotLegFlowKgPerS', label: 'Average hot-leg primary flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'fuelTemperatureC', label: 'Core fuel temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'fuelLowerTemperatureC', label: 'Lower fuel temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'fuelMidTemperatureC', label: 'Mid-core fuel temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'fuelUpperTemperatureC', label: 'Upper fuel temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'fuelStoredEnergyMj', label: 'Fuel stored heat energy', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'energy', unit: 'MJ' }),
      variable({ path: 'coreCoolingAvailabilityFraction', label: 'Core cooling availability', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', measurand: 'availability', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'coreHeatRemovalDeficitMw', label: 'Core heat removal deficit', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'powerDelta', unit: 'MW' }),
      variable({ path: 'fuelHeatupRateCPerS', label: 'Fuel heatup rate', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperatureRate', unit: 'degC/s' }),
      variable({ path: 'decayHeatMw', label: 'Decay heat', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'heatToCoolantMw', label: 'Heat to coolant', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
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
    },
    parametersSchema: z.object({
      nominalPrimaryCoolantInventoryKg: z.number().finite().positive(),
      initialPrimaryCoolantInventoryFraction: normalized,
      primaryCoolantVolumeM3: z.number().finite().positive(),
      nominalPrimaryCoolantDensityKgPerM3: z.number().finite().positive(),
      effectiveBulkModulusMPa: z.number().finite().positive(),
      thermalExpansionCoefficientPerC: z.number().finite().nonnegative(),
      referencePrimaryCoolantTemperatureC: z.number().finite(),
      normalLetdownFlowKgPerS: z.number().finite().nonnegative().optional(),
      primaryReleaseRadiationMSvPerH: z.number().finite().nonnegative().optional(),
      initialBoronConcentrationPpm: z.number().finite().nonnegative().optional(),
      collapsedLevelReferenceInventoryFraction: normalized.optional(),
    }),
    semantics: fixedSemantics({ keyValues: ['subcoolingMarginC', 'collapsedLiquidLevelPercent'], aspects: [aspect('level', { variable: 'collapsedLiquidLevelPercent', reading: 'value' })] }),
    variables: [
      variable({ path: 'primaryCoolantInventoryKg', label: 'Primary coolant inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'primaryCoolantInventoryDeviationKg', label: 'Primary coolant inventory deviation', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg' }),
      variable({ path: 'collapsedLiquidLevelPercent', label: 'Reactor vessel collapsed liquid level', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'meanPrimaryCoolantTemperatureC', label: 'Mean primary coolant temperature', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'subcoolingMarginC', label: 'RCS subcooling margin', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperatureDelta', unit: 'degC' }),
      variable({ path: 'compressibilityPressureBiasMPa', label: 'Primary compressibility pressure bias', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa' }),
      variable({ path: 'thermalExpansionPressureBiasMPa', label: 'Primary thermal expansion pressure bias', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa' }),
      variable({ path: 'primaryPressureBiasMPa', label: 'Primary pressure inventory bias', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa' }),
      variable({ path: 'chargingFlowKgPerS', label: 'Primary charging flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'safetyInjectionFlowKgPerS', label: 'Primary safety injection flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'letdownFlowKgPerS', label: 'Primary letdown flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'reliefOutflowKgPerS', label: 'Primary relief outflow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'primaryLeakFlowKgPerS', label: 'Primary coolant boundary leak flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'tubeLeakFlowKgPerS', label: 'Primary-to-secondary tube leak flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'netInventoryFlowKgPerS', label: 'Primary inventory net flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s' }),
      variable({ path: 'primaryInventoryBalanceResidualKg', label: 'Primary inventory balance residual', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg' }),
      variable({ path: 'boronConcentrationPpm', label: 'Primary coolant boron concentration', kind: 'state', discipline: 'chemical', writable: false, publish: 'telemetry', quantity: 'concentration', unit: 'ppm' }),
      variable({ path: 'primaryReleaseRadiationMSvPerH', label: 'Primary release radiation source term', kind: 'derived', discipline: 'radiological', writable: false, publish: 'telemetry', quantity: 'radiationDoseRate', unit: 'mSv/h' }),
    ],
  }),
]
