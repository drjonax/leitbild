import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

export const steamGeneratorComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'steamGenerator' as ComponentKind,
    label: 'Steam Generator',
    ports: {
      primaryInlet: { kind: 'hydraulicThermal', direction: 'in', circuit: 'primary' },
      primaryOutlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'primary' },
      feedwaterInlet: { kind: 'hydraulicThermal', direction: 'in', circuit: 'secondary' },
      steamOutlet: { kind: 'steam', direction: 'out', circuit: 'secondary' },
      // The steam line's atmospheric relief branch, ahead of the isolation
      // valve: steam it vents leaves the Plant, so it is a circuit of its own.
      steamReliefOutlet: { kind: 'steam', direction: 'out', circuit: 'relief' },
      isolationSignal: { kind: 'logicSignal', direction: 'in' },
      // The steam line's branch to a pump's drive turbine (the turbine-driven
      // auxiliary feedwater pump's), ahead of the isolation valve, so it still
      // has steam with the steam lines isolated. The turbine exhausts it to
      // the atmosphere, so it too is a circuit of its own.
      driveSteamOutlet: { kind: 'steam', direction: 'out', circuit: 'drive' },
    },
    parametersSchema: z.object({
      nominalPressureMPa: z.number().finite().positive(),
      /** The feedwater temperature the plant's feedwater heaters deliver at full power: with the nominal pressure it sets the energy each kilogram of steam takes. */
      designFeedwaterTemperatureC: z.number().finite(),
      nominalLevelPercent: normalized,
      heatTransferCoefficientMwPerK: z.number().finite().positive(),
      initialPrimaryInletTemperatureC: z.number().finite().optional(),
      initialPrimaryOutletTemperatureC: z.number().finite().optional(),
      initialSecondaryTemperatureC: z.number().finite().optional(),
      nominalSecondaryInventoryKg: z.number().finite().positive().optional(),
      nominalSteamFlowKgPerS: z.number().finite().positive().optional(),
      initialSteamFlowFraction: normalized.optional(),
      recirculationRatio: z.number().finite().positive().optional(),
      primaryThermalTimeConstantS: z.number().finite().positive().optional(),
      secondaryThermalTimeConstantS: z.number().finite().positive().optional(),
      steamQualityTimeConstantS: z.number().finite().positive().optional(),
      steamPressureGainMPaPerKgS: z.number().finite().nonnegative().optional(),
      steamMassPressureGainFraction: z.number().finite().nonnegative().optional(),
      temperaturePressureGainFraction: z.number().finite().nonnegative().optional(),
      nominalSteamMassKg: z.number().finite().positive().optional(),
      voidFractionAtNominalBoiling: normalized.optional(),
      voidFractionTimeConstantS: z.number().finite().positive().optional(),
      /**
       * The mixture level the boiling voids add, in percent of the full-scale inventory per unit void fraction:
       * the swell a trip's void collapse takes away. Calibrate it against the narrow range's span, not the
       * generator's height: the reference's full-power swell is about a fifth of its narrow range.
       */
      swellLevelGainPercent: z.number().finite().nonnegative().optional(),
      narrowRangeLowerFraction: normalized.optional(),
      narrowRangeUpperFraction: normalized.optional(),
      /** The wide range's span, from about the tube sheet to above the separators, as fractions of the full-scale inventory like the narrow range's. */
      wideRangeLowerFraction: normalized.optional(),
      wideRangeUpperFraction: normalized.optional(),
      tubeBundleBottomLevelPercent: normalized.optional(),
      tubeBundleTopLevelPercent: normalized.optional(),
      minimumUncoveredTubeHeatTransferFraction: normalized.optional(),
      pressureInventoryGainMPaPerFraction: z.number().finite().nonnegative().optional(),
      tubeMetalThermalCapacityMjPerK: z.number().finite().positive().optional(),
      tubeMetalInitialTemperatureC: z.number().finite().optional(),
      tubeLeakFlowCoefficientKgPerSPerSqrtMPa: z.number().finite().nonnegative().optional(),
      tubeLeakRadiationGainMSvPerHPerKgS: z.number().finite().nonnegative().optional(),
      tubeLeakRadiationTimeConstantS: z.number().finite().positive().optional(),
    }),
    semantics: fixedSemantics({
      keyValues: ['levelPercent', 'pressureMPa'],
      aspects: [aspect('level', { variable: 'levelPercent', reading: 'value' })],
      ratedOutflow: [{ port: 'steamOutlet', parameter: 'nominalSteamFlowKgPerS' }],
      // What its feed lines bring in through the feedwater inlet, and what its steam lines take out.
      portFlows: [{ port: 'feedwaterInlet', variable: 'feedwaterFlowKgPerS' }, { port: 'steamOutlet', variable: 'steamOutflowKgPerS' }],
      energy: [{ role: 'transfer', from: 'primary', to: 'secondary' }],
      // The wide range reads the same level from the tube sheet up: where the narrow range is off scale, it reads on.
      widerRanges: [{ reading: 'levelPercent', wider: 'wideRangeLevelPercent' }],
    }),
    variables: [
      // Each level instrument reads 0 to 100 % of its own span and stays at the end of it when the level leaves it,
      // its span declared so that displays tell a reading at its end from a value.
      variable({ path: 'levelPercent', label: 'Steam generator narrow-range level', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent', limits: { hardRange: { min: 0, max: 100 }, instrumentSpan: { min: 0, max: 100 } } }),
      variable({ path: 'wideRangeLevelPercent', label: 'Steam generator wide-range level', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent', limits: { hardRange: { min: 0, max: 100 }, instrumentSpan: { min: 0, max: 100 } } }),
      variable({ path: 'pressureMPa', label: 'Steam generator pressure', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'heatTransferMw', label: 'Heat transfer', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'primaryInletTemperatureC', label: 'Primary inlet temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'primaryOutletTemperatureC', label: 'Primary outlet temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'tubeMetalTemperatureC', label: 'Tube metal temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'secondaryTemperatureC', label: 'Secondary temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'steamFlowKgPerS', label: 'Steam production', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'boilingRateKgPerS', label: 'Secondary boiling rate', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s', simulatorOnly: true }),
      variable({ path: 'feedwaterFlowKgPerS', label: 'Feedwater inflow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'steamOutflowKgPerS', label: 'Steam outlet flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'steamQualityFraction', label: 'Steam quality', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', measurand: 'quality', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'secondaryInventoryKg', label: 'Secondary inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'collapsedLevelPercent', label: 'Collapsed water level, full height', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'voidFraction', label: 'Secondary void fraction', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', measurand: 'void', quantity: 'ratio', unit: 'fraction', simulatorOnly: true }),
      variable({ path: 'swellLevelPercent', label: 'Void swell, full height', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent', simulatorOnly: true }),
      variable({ path: 'tubeCoverageFraction', label: 'Steam generator tube coverage', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'coverage', quantity: 'ratio', unit: 'fraction', simulatorOnly: true }),
      variable({ path: 'tubeUncoveredFraction', label: 'Steam generator uncovered tube fraction', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'coverage', quantity: 'ratio', unit: 'fraction', simulatorOnly: true }),
      variable({ path: 'availableHeatTransferFraction', label: 'Available steam generator heat transfer fraction', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', measurand: 'availability', quantity: 'ratio', unit: 'fraction', simulatorOnly: true }),
      variable({ path: 'steamMassKg', label: 'Steam space mass proxy', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'pressureTargetMPa', label: 'Steam generator pressure target', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa', simulatorOnly: true }),
      variable({ path: 'steamMassPressureBiasMPa', label: 'Steam mass pressure contribution', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa', simulatorOnly: true }),
      variable({ path: 'temperaturePressureBiasMPa', label: 'Secondary temperature pressure contribution', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa', simulatorOnly: true }),
      variable({ path: 'inventoryPressureBiasMPa', label: 'Secondary inventory pressure contribution', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa', simulatorOnly: true }),
      variable({ path: 'secondaryInventoryBalanceResidualKg', label: 'Secondary inventory balance residual', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'steamMassBalanceResidualKg', label: 'Steam mass balance residual', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'boilingEnergyResidualMw', label: 'Boiling energy balance residual', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'powerDelta', unit: 'MW', simulatorOnly: true }),
      variable({ path: 'tubeLeakFraction', label: 'Tube leak fraction', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'faultInjection', measurand: 'leak', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'primaryToSecondaryLeakKgPerS', label: 'Primary-to-secondary leak flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s', simulatorOnly: true, faultTruth: true }),
      variable({ path: 'secondaryRadiationMSvPerH', label: 'Secondary radiation', kind: 'derived', discipline: 'radiological', writable: false, publish: 'telemetry', quantity: 'radiationDoseRate', unit: 'mSv/h' }),
      // How fast the saturation temperature of its pressure moves: its pressure's trend, which natural circulation
      // checks stable or falling. Declared last, so the variables before it keep their places.
      variable({ path: 'saturationTemperatureRateCPerS', label: 'Steam generator saturation temperature rate', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperatureRate', unit: 'degC/s' }),
    ],
  }),
]
