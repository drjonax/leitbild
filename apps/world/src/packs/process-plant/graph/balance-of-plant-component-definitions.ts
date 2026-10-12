import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

export const balanceOfPlantComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'processTank' as ComponentKind,
    label: 'Process Tank',
    ports: {
      inlet: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
      outlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'flow' },
    },
    parametersSchema: z.object({
      nominalInventoryKg: z.number().finite().positive(),
      initialInventoryFraction: normalized,
      initialTemperatureC: z.number().finite(),
      initialSoluteConcentrationPpm: z.number().finite().nonnegative().optional(),
      makeupSoluteConcentrationPpm: z.number().finite().nonnegative().optional(),
      makeupFlowKgPerS: z.number().finite().nonnegative(),
      maxOutletFlowKgPerS: z.number().finite().nonnegative(),
      thermalTimeConstantS: z.number().finite().positive().optional(),
      /**
       * A level controller on what the tank takes in, as a feedwater tank's
       * level control valve throttles the condensate pumps' flow into it: fully
       * open up to its set point, shut a proportional band above it, moving
       * with its time constant. What flows toward the tank on a service whose
       * flow follows downstream demand is cut by its opening.
       */
      inletLevelControl: z.object({
        setpointPercent: z.number().finite().min(0).max(100),
        proportionalBandPercent: z.number().finite().positive(),
        timeConstantS: z.number().finite().positive(),
      }).strict().optional(),
    }).strict(),
    semantics: fixedSemantics({ keyValues: ['levelPercent'], aspects: [aspect('level', { variable: 'levelPercent', reading: 'value' })], ratedOutflow: [{ port: 'outlet', parameter: 'maxOutletFlowKgPerS' }] }),
    variables: [
      variable({ path: 'inventoryKg', label: 'Tank inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'levelPercent', label: 'Tank level', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'temperatureC', label: 'Tank temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'soluteConcentrationPpm', label: 'Tank solute concentration', kind: 'state', discipline: 'chemical', writable: false, publish: 'telemetry', quantity: 'concentration', unit: 'ppm' }),
      variable({ path: 'makeupFlowKgPerS', label: 'Tank makeup flow', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'boundary', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'availableOutletFlowKgPerS', label: 'Available outlet flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      // Fully open without an inlet level controller.
      variable({ path: 'inletControlFraction', label: 'Inlet level control valve position', kind: 'state', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'position', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
    ],
  }),
  defineComponent({
    kind: 'turbineLoadSink' as ComponentKind,
    label: 'Turbine Load Sink',
    ports: {
      steamInlet: { kind: 'steam', direction: 'in', circuit: 'steam' },
      exhaustSteamOutlet: { kind: 'steam', direction: 'out', circuit: 'steam' },
      loadDemand: { kind: 'controlSignal', direction: 'in' },
      generatorOutput: { kind: 'electricalAc', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalElectricMw: z.number().finite().positive(),
      /** Generator output over the steam generators' heat at rated load; an operating point sizes nominalElectricMw from it. */
      grossCycleEfficiencyFraction: z.number().finite().gt(0).lt(1).optional(),
      nominalBackPressurePa: z.number().finite().positive().optional(),
      nominalSteamPressureMPa: z.number().finite().positive().optional(),
      initialLoadFraction: normalized,
      nominalSteamFlowKgPerS: z.number().finite().positive(),
      electricalTimeConstantS: z.number().finite().positive().optional(),
      exhaustTemperatureAtFullLoadC: z.number().finite().optional(),
      exhaustTemperatureAtNoLoadC: z.number().finite().optional(),
    }),
    // A turbine-generator runs on line while its output breaker is closed onto the grid, carrying load.
    semantics: fixedSemantics({ keyValues: ['electricMw'], aspects: [aspect('running', { variable: 'outputBreakerClosed', reading: 'true' })], ratedOutflow: [{ port: 'exhaustSteamOutlet', parameter: 'nominalSteamFlowKgPerS' }], energy: [{ role: 'sink', circuit: 'steam', rate: 'electricMw' }] }),
    variables: [
      variable({ path: 'electricMw', label: 'Electrical output', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      // The generator's output breaker: closed while the turbine carries a load demand, open as its load is rejected.
      variable({ path: 'outputBreakerClosed', label: 'Generator output breaker closed', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'loadFraction', label: 'Load demand', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', measurand: 'load', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'steamFlowKgPerS', label: 'Turbine steam flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'steamDemandKgPerS', label: 'Turbine steam demand', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'steamAvailabilityFraction', label: 'Turbine steam availability', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', measurand: 'availability', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'exhaustTemperatureC', label: 'Turbine exhaust temperature', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
    ],
  }),
  defineComponent({
    kind: 'condenserSink' as ComponentKind,
    label: 'Condenser Sink',
    ports: {
      steamInlet: { kind: 'steam', direction: 'in', circuit: 'condensing' },
      condensateOutlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'condensing' },
      coolingWater: { kind: 'hydraulicThermal', direction: 'in', circuit: 'cooling' },
      coolingWaterOutlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'cooling' },
    },
    parametersSchema: z.object({
      coolingWaterTemperatureC: z.number().finite(),
      initialSteamFlowFraction: normalized.optional(),
      initialSteamTemperatureC: z.number().finite().optional(),
      nominalCoolingWaterFlowKgPerS: z.number().finite().positive(),
      coolingWaterDesignDeltaTK: z.number().finite().positive(),
      nominalSteamFlowKgPerS: z.number().finite().positive(),
      condensateApproachTemperatureK: z.number().finite().nonnegative(),
      nominalCondensateInventoryKg: z.number().finite().positive(),
      initialCondensateInventoryFraction: normalized,
      maxCondensateOutletFlowKgPerS: z.number().finite().nonnegative(),
      condenserThermalTimeConstantS: z.number().finite().positive().optional(),
      exhaustCondensationTemperatureC: z.number().finite().optional(),
    }),
    semantics: fixedSemantics({ keyValues: ['condensateLevelPercent', 'backPressurePa'], aspects: [aspect('level', { variable: 'condensateLevelPercent', reading: 'value' })], ratedOutflow: [{ port: 'condensateOutlet', parameter: 'maxCondensateOutletFlowKgPerS' }, { port: 'coolingWaterOutlet', parameter: 'nominalCoolingWaterFlowKgPerS' }], energy: [{ role: 'transfer', from: 'condensing', to: 'cooling' }] }),
    variables: [
      variable({ path: 'steamFlowKgPerS', label: 'Condenser steam flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'condensateProductionKgPerS', label: 'Condensate production', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'heatRejectedMw', label: 'Condenser heat rejected', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'condensateInventoryKg', label: 'Condensate inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'condensateLevelPercent', label: 'Condensate level', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'availableCondensateOutletFlowKgPerS', label: 'Available condensate outlet flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'condensateTemperatureC', label: 'Condensate temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'backPressurePa', label: 'Condenser back pressure', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'Pa' }),
      variable({ path: 'coolingWaterFlowKgPerS', label: 'Condenser cooling-water flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'coolingWaterInletTemperatureC', label: 'Condenser cooling-water inlet temperature', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coolingWaterOutletTemperatureC', label: 'Condenser cooling-water outlet temperature', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coolingWaterHeatCapacityMw', label: 'Condenser cooling-water heat capacity', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'coolingWaterAvailabilityFraction', label: 'Condenser cooling-water availability', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', measurand: 'availability', quantity: 'ratio', unit: 'fraction' }),
    ],
  }),
]
