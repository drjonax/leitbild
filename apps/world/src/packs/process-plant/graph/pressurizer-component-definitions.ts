import { z } from 'zod'
import type { CompiledComponent, ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics, type AspectTravel } from './semantics.ts'

// Its motor moves the block valve across its whole stroke in its stroke time (pressurizer-behaviors.ts).
const blockValveTravel = (parameters: unknown): AspectTravel => {
  const strokeS = z.object({ blockValveStrokeTimeS: z.number() }).passthrough().parse(parameters).blockValveStrokeTimeS
  return { onS: strokeS, offS: strokeS }
}

const pressurizerLevelControlSchema = z.object({
  noLoadAverageTemperatureC: z.number().finite(),
  noLoadLevelPercent: z.number().finite().min(0).max(100),
  fullLoadAverageTemperatureC: z.number().finite(),
  fullLoadLevelPercent: z.number().finite().min(0).max(100),
  /** Charging flow at the program level: what balances normal letdown. */
  nominalChargingFlowKgPerS: z.number().finite().nonnegative(),
  maxChargingFlowKgPerS: z.number().finite().positive(),
  /** Charging flow added for each percent the level stands below the program, and taken away for each above it. */
  gainKgPerSPerPercent: z.number().finite().positive(),
}).strict().refine(control => control.fullLoadAverageTemperatureC > control.noLoadAverageTemperatureC, {
  message: 'pressurizer level program full-load temperature must be above its no-load temperature',
})

export type PressurizerLevelControl = z.infer<typeof pressurizerLevelControlSchema>

const levelControlByComponent = new WeakMap<CompiledComponent, PressurizerLevelControl>()

/** A pressurizer's level control, as its parameters declare it. */
export const pressurizerLevelControl = (component: CompiledComponent): PressurizerLevelControl => {
  const cached = levelControlByComponent.get(component)
  if (cached !== undefined) return cached
  const parsed = pressurizerLevelControlSchema.parse((component.parameters as Readonly<Record<string, unknown>>).levelControl)
  levelControlByComponent.set(component, parsed)
  return parsed
}

export const pressurizerComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'pressurizer' as ComponentKind,
    label: 'Pressurizer',
    ports: {
      surgeLine: { kind: 'hydraulicThermal', direction: 'bidirectional', circuit: 'coolant' },
      sprayInlet: { kind: 'hydraulicThermal', direction: 'in', circuit: 'coolant' },
      reliefOutlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      safetyOutlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      // The heaters come in two groups on separate supplies: the control group on a non-safety bus, and a backup
      // group on a diesel-backed safety bus, so some heat holds the pressure when offsite power is lost.
      heaterPower: { kind: 'electricalAc', direction: 'in', demand: 'demandMw' },
      backupHeaterPower: { kind: 'electricalAc', direction: 'in', demand: 'backupHeaterDemandMw' },
      // The PORV block valve's motor has its own supply, apart from the heaters': the valve must close on a stuck-open
      // PORV after a loss of offsite power, when the heaters' bus is dead and only the diesel-backed buses are live.
      blockValvePower: { kind: 'electricalAc', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalPressureMPa: z.number().finite().positive(),
      nominalLevelPercent: normalized,
      volumeM3: z.number().finite().positive(),
      reliefSetpointMPa: z.number().finite().positive(),
      /** Rated discharge of the fully open PORV: saturated steam at its rated pressure. A Westinghouse PORV passes about 210,000 lb/h (26.5 kg/s) at 2,335 psig (16.2 MPa). */
      reliefCapacityKgPerS: z.number().finite().nonnegative(),
      /** Inlet pressure at which the PORV's capacity is rated. Choked steam flow scales with the inlet pressure from there. */
      reliefRatedPressureMPa: z.number().finite().positive(),
      /** How fast water above saturation flashes to steam. */
      flashingTimeConstantS: z.number().finite().positive(),
      /** How fast steam condenses on water below saturation; slow, as the water stratifies under the interface. */
      condensationTimeConstantS: z.number().finite().positive(),
      /** Full stroke time of the motor-operated PORV block valve. */
      blockValveStrokeTimeS: z.number().finite().positive(),
      /** Set pressure of the spring-loaded code safety valves, where they pop open. */
      safetyValveSetpointMPa: z.number().finite().positive(),
      /** Rated discharge of all the code safety valves together: saturated steam at full lift, at set pressure plus accumulation. A four-loop Westinghouse plant's three are rated about 420,000 lb/h (52.9 kg/s) each. */
      safetyValvesCapacityKgPerS: z.number().finite().positive(),
      /** Pressure rise above the set pressure at which the safety valves reach full lift, a fraction of it. */
      safetyValveAccumulationFraction: z.number().finite().positive().max(0.1),
      /** Pressure fall below the set pressure at which the safety valves reseat, a fraction of it. */
      safetyValveBlowdownFraction: z.number().finite().positive().max(0.2),
      /** Level below which the heaters are cut off, so that none runs uncovered: 17 % in a Westinghouse plant. */
      heaterCutoffLevelPercent: z.number().finite().min(0).max(100),
      /** Heat of the backup heater group, all on or all off, from its diesel-backed supply. */
      backupHeaterCapacityMw: z.number().finite().positive(),
      /** The relief flow at and above which the PORV's acoustic flow monitor reads its valve passing flow. */
      reliefFlowMonitorThresholdKgPerS: z.number().finite().positive(),
      /**
       * Level control: the level the program sets for the loops' mean
       * temperature, rising in a straight line from its no-load to its
       * full-load point so that the level follows the coolant's own swell, and
       * the proportional controller that sets the charging flow to hold it
       * there: normal charging on the program, more below it, less above.
       */
      levelControl: pressurizerLevelControlSchema,
    }),
    // The block valve's motor drives it across its stroke time at a steady rate; the PORV is where its demand puts it, at once.
    semantics: parameters => fixedSemantics({ keyValues: ['pressureMPa', 'levelPercent'],
      aspects: [aspect('level', { variable: 'levelPercent', reading: 'value' })],
      // Level control holds the level to its program, set by the loops' mean temperature.
      programs: [{ reading: 'levelPercent', program: 'levelProgramPercent', deviation: 'levelDeviationPercent' }],
      // The PORV and its block valve are modelled inside the pressurizer, on its relief outlet, in the order they sit on
      // the relief line: the motor-operated block valve next to the pressurizer, then the PORV. The pressurizer solves
      // the relief flow itself, so both valves that throttle it belong to it; the line passes what the less open allows.
      // The PORV's position is its own opening: the demand, the automatic opening above the relief setpoint, or a failed
      // position. The block valve's is where its motor has driven it.
      embedded: [{
        id: 'blockValve',
        label: 'block valve',
        function: 'isolating',
        port: 'reliefOutlet',
        aspects: [aspect('position', { variable: 'blockValveEffectivePositionFraction', reading: 'value' }, 'blockValvePositionFraction', undefined, blockValveTravel(parameters))],
        variables: ['blockValvePositionFraction', 'blockValveEffectivePositionFraction'],
      }, {
        id: 'reliefValve',
        label: 'relief valve',
        function: 'relieving',
        port: 'reliefOutlet',
        aspects: [
          aspect('position', { variable: 'reliefValveEffectivePositionFraction', reading: 'value' }, 'reliefValvePositionFraction', undefined, { onS: 0, offS: 0 }),
          aspect('throughput', { variable: 'reliefFlowKgPerS', reading: 'flow' }),
        ],
        variables: ['reliefFlowKgPerS', 'reliefValvePositionFraction', 'reliefValveEffectivePositionFraction', 'reliefValveFailureActive', 'reliefValveFailedPositionFraction', 'reliefValveFlowing'],
      }, {
        // The spring-loaded code safety valves, on their own lines to the relief tank, which no block valve isolates.
        // The model holds them as one bank: they share a set pressure, so they lift together.
        id: 'safetyValves',
        label: 'code safety valves',
        function: 'relieving',
        port: 'safetyOutlet',
        aspects: [
          aspect('position', { variable: 'safetyValvesLiftFraction', reading: 'value' }),
          aspect('throughput', { variable: 'safetyValveFlowKgPerS', reading: 'flow' }),
        ],
        variables: ['safetyValvesLiftFraction', 'safetyValvesOpen', 'safetyValveFlowKgPerS'],
      }],
      ratedOutflow: [{ port: 'reliefOutlet', parameter: 'reliefCapacityKgPerS' }, { port: 'safetyOutlet', parameter: 'safetyValvesCapacityKgPerS' }],
    })(parameters),
    variables: [
      variable({ path: 'pressureMPa', label: 'Pressurizer pressure', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'levelPercent', label: 'Pressurizer level', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'waterInventoryKg', label: 'Pressurizer water inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'steamMassKg', label: 'Pressurizer steam mass', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'steamMassFlowKgPerS', label: 'Pressurizer steam net mass flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s', simulatorOnly: true }),
      variable({ path: 'steamVolumeM3', label: 'Pressurizer steam volume', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'volume', unit: 'm3', simulatorOnly: true }),
      variable({ path: 'flashingRateKgPerS', label: 'Pressurizer flashing rate', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s', simulatorOnly: true }),
      variable({ path: 'compressedWaterVolumeM3', label: 'Reactor coolant compressed beyond its room', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'volume', unit: 'm3', simulatorOnly: true }),
      variable({ path: 'waterInventoryBalanceResidualKg', label: 'Pressurizer water inventory balance residual', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'steamMassBalanceResidualKg', label: 'Pressurizer steam mass balance residual', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'waterTemperatureC', label: 'Pressurizer water temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'steamTemperatureC', label: 'Pressurizer steam temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'heaterPowerMw', label: 'Pressurizer heater power', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'power', unit: 'MW', limits: { hardRange: { min: 0, max: 30 } } }),
      variable({ path: 'levelProgramPercent', label: 'Pressurizer level program', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent' }),
      // The level control's error, level minus program: what its deviation alarms read.
      variable({ path: 'levelDeviationPercent', label: 'Pressurizer level deviation from program', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent', limits: { hardRange: { min: -100, max: 100 } } }),
      variable({ path: 'chargingFlowDemandKgPerS', label: 'Charging flow demanded by pressurizer level control', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'backupHeatersOn', label: 'Pressurizer backup heaters on', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'backupHeaterDemandMw', label: 'Pressurizer backup heater electrical demand', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'heatersCutOff', label: 'Pressurizer heaters cut off on low level', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'demandMw', label: 'Pressurizer electrical demand', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'sprayFlowKgPerS', label: 'Pressurizer spray flow', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'flowRate', unit: 'kg/s', limits: { hardRange: { min: 0, max: 250 } } }),
      variable({ path: 'reliefValvePositionFraction', label: 'Pressurizer relief valve position demand', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', measurand: 'position', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'reliefValveFailureActive', label: 'Pressurizer relief valve failure active', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'faultInjection', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'reliefValveFailedPositionFraction', label: 'Pressurizer relief valve failed position', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'faultInjection', measurand: 'position', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'reliefValveEffectivePositionFraction', label: 'Pressurizer relief valve effective position', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'position', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'reliefFlowKgPerS', label: 'Pressurizer relief flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s', simulatorOnly: true }),
      // What a plant reads of the relief flow: the acoustic monitor on the PORV's discharge, flow or no flow.
      variable({ path: 'reliefValveFlowing', label: 'Pressurizer PORV acoustic flow monitor', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'blockValvePositionFraction', label: 'Pressurizer PORV block valve position command', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', measurand: 'position', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'blockValveEffectivePositionFraction', label: 'Pressurizer PORV block valve position', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'position', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'safetyValvesOpen', label: 'Pressurizer code safety valves open', kind: 'state', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'safetyValvesLiftFraction', label: 'Pressurizer code safety valve lift', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'position', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'safetyValveFlowKgPerS', label: 'Pressurizer code safety valve flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s', simulatorOnly: true }),
    ],
  }),
  defineComponent({
    kind: 'reliefTank' as ComponentKind,
    label: 'Relief Tank',
    // A closed tank that takes the pressurizer's relief and code safety valve
    // discharge under its water, which condenses the steam: the water warms by
    // the steam's heat and rises by its mass. A nitrogen blanket fills the
    // room above the water, squeezed as the water rises and warmed with it, so
    // the tank's pressure is the blanket's plus the water's vapour pressure. A
    // rupture disk bursts at its set pressure and vents the tank to the
    // containment, whose pressure it then holds; what it vents, and any steam
    // its water no longer condenses, the model does not carry on into the
    // containment. The discharge is taken as steam at the temperature its line
    // brings it in at, so a pressurizer relieving water heats it somewhat too fast.
    ports: {
      inlet: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
    },
    parametersSchema: z.object({
      vesselVolumeM3: z.number().finite().positive(),
      initialLevelPercent: z.number().finite().min(0).max(100),
      initialTemperatureC: z.number().finite(),
      /** Its pressure, absolute, at its initial level and temperature: the nitrogen blanket's plus the water's vapour pressure. */
      initialPressureMPa: z.number().finite().positive(),
      /** The absolute pressure at which its rupture disk bursts. */
      ruptureDiskPressureMPa: z.number().finite().positive(),
    }).strict(),
    semantics: fixedSemantics({ keyValues: ['pressureMPa', 'levelPercent'], aspects: [aspect('level', { variable: 'levelPercent', reading: 'value' })] }),
    variables: [
      variable({ path: 'inventoryKg', label: 'Relief tank water inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'levelPercent', label: 'Relief tank level', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent', limits: { hardRange: { min: 0, max: 100 } } }),
      variable({ path: 'temperatureC', label: 'Relief tank temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'pressureMPa', label: 'Relief tank pressure', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'ruptureDiskBurst', label: 'Relief tank rupture disk burst', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
    ],
  }),
]
