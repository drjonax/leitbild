import { z } from 'zod'
import type {
  GridBranchDefinition,
  GridBusDefinition,
  GridDemandProfileDefinition,
  GridGeneratorDefinition,
  GridHvdcLinkDefinition,
  GridLoadDefinition,
  GridStorageDefinition,
} from '../grid-model.ts'
import { gridReservesByProductSchema } from '../model.ts'
import type { GridHvdcTerminalState } from '../runtime/hvdc-terminals.ts'
import type {
  GridBranchState,
  GridBusState,
  GridGeneratorState,
  GridHvdcLinkState,
  GridLoadState,
  GridStorageState,
} from '../runtime/instance.ts'

// Wire schemas for Grid Model definitions and runtime state as Capabilities publish them.
// The compile-time checks below keep every runtime value assignable to its schema; the
// strict object schemas reject fields a schema does not declare.

const finite = z.number().finite()
const location = z.tuple([finite, finite]).readonly()
const sourceFields = { sourceId: z.string().optional(), sourceFeatureId: z.string().optional() }
const assetProvenanceSchema = z.object({
  sources: z.array(z.string()).readonly(),
  method: z.enum(['mapped', 'registry', 'measured', 'inferred', 'curated']),
  confidence: z.enum(['high', 'medium', 'low']),
  note: z.string().optional(),
}).strict().describe('Where the asset\'s values come from and how they were obtained.')

export const busDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['substation', 'plant-terminal', 'connection-point', 'junction', 'boundary'])
    .describe('substation, plant-terminal or connection-point: a voltage level of a station; junction: a tee point where corridors meet outside a station; boundary: a bus of an external system.'),
  nominalKv: finite,
  location,
  ...sourceFields,
  provenance: assetProvenanceSchema.optional(),
}).strict()

export const branchDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['ac_line', 'cable', 'transformer']),
  fromBusId: z.string(),
  toBusId: z.string(),
  nominalKv: finite.describe('Nominal voltage; the high side of a transformer (kV).'),
  lengthKm: finite.optional().describe('Route length of a line or cable (km).'),
  circuits: z.number().int().positive().describe('Parallel circuits; ratings and impedances are for all of them together.'),
  ratingMw: finite.describe('Continuous rating (MW).'),
  emergencyRatingMw: finite.describe('Emergency rating (MW), allowed for emergencyDurationSeconds.'),
  emergencyDurationSeconds: finite,
  reactancePu: finite.describe('Series reactance, per unit on the Model base power.'),
  resistancePu: finite.describe('Series resistance, per unit on the Model base power.'),
  chargingSusceptancePu: finite.describe('Total line charging susceptance, per unit on the Model base power.'),
  tapRatio: finite.optional().describe('Off-nominal turns ratio of a transformer at its from end.'),
  ...sourceFields,
  provenance: assetProvenanceSchema.optional(),
}).strict()

export const generatorDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['hydro', 'wind', 'solar', 'thermal', 'nuclear']),
  busId: z.string(),
  location,
  capacityMw: finite,
  ratedMva: finite,
  powerFactor: finite.describe('Rated power factor; the reactive limit is ratedMva·√(1 − powerFactor²).'),
  voltageSetpointPu: finite.describe('Bus voltage the unit holds while it controls voltage (pu).'),
  inertiaSeconds: finite.describe('Inertia constant H on ratedMva (s); 0 for converter-connected units.'),
  synchronous: z.boolean(),
  minimumStableMw: finite,
  blackStartCapable: z.boolean(),
  rampRateMwPerMinute: finite,
  availableMw: finite.describe('Availability at the Operating Point (MW).'),
  initialState: z.enum(['online', 'offline', 'tripped']).describe('Lifecycle state at the Operating Point.'),
  initialTargetMw: finite.nullable().describe('Set-point at the Operating Point for a unit that starts online (MW); the starting dispatch keeps this pattern and shares only the remaining imbalance. Null: no set-point of its own.'),
  annualProductionGwh: finite.optional(),
  priceArea: z.string().optional(),
  ...sourceFields,
  provenance: assetProvenanceSchema.optional(),
}).strict()

export const loadDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['residential', 'commercial', 'hospital', 'airport', 'industry', 'data_center', 'ev_charging', 'process_plant']),
  busId: z.string(),
  location,
  demandMw: finite.describe('Demand at the Operating Point before its load scale (MW).'),
  demandProfileId: z.string().describe('The Model demand profile the load follows over the day; asset.get gives its series and hour values.'),
  criticalMw: finite.describe('Demand no shedding disconnects (MW).'),
  powerFactor: finite.describe('Reactive demand is P·tan(acos powerFactor), lagging.'),
  priority: z.enum(['critical', 'high', 'normal', 'low']),
  interruptibleMw: finite.describe('Contractually or technically curtailable demand (MW); 0 when unknown.'),
  ...sourceFields,
  provenance: assetProvenanceSchema.optional(),
}).strict()

export const demandProfileSeriesSchema = z.object({
  profileSetId: z.string().describe('The Grid Load Profiles set the values come from.'),
  season: z.enum(['winter', 'summer']).describe('The profile week the Operating Point\'s season selects.'),
  priceArea: z.string(),
  group: z.enum(['private', 'business', 'industry'])
    .describe('Elhub municipality group: private = household + cabin, business = tertiary, industry = primary + secondary. Major sites follow their price area\'s industry group.'),
  referenceHour: z.string().describe('The Operating Point\'s hour, at which the profile is exactly 1.'),
}).strict()

export const demandProfileDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  weekday: z.array(finite).length(24).readonly().describe('Demand relative to the Operating Point\'s at Europe/Oslo local 00:00 … 23:00 of Monday to Friday; linear between hours.'),
  weekend: z.array(finite).length(24).readonly().describe('The same for Saturday and Sunday; from 23:00 demand moves towards 00:00 of the next date\'s day type.'),
  series: demandProfileSeriesSchema.nullable().describe('The measured Elhub series the profile follows; null for a profile the Model declares outright.'),
  provenance: assetProvenanceSchema,
}).strict()

export const demandSampleSchema = z.object({
  sampleAt: z.string().describe('The one-minute demand sample the loads\' demand was last set at (UTC).'),
  localTime: z.string().describe('Its Europe/Oslo local time, HH:MM.'),
  dayType: z.enum(['weekday', 'weekend']).describe('Day type of its Europe/Oslo local date: Monday to Friday, or Saturday and Sunday.'),
}).strict()

export const storageDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  busId: z.string(),
  location,
  capacityMwh: finite,
  maxChargeMw: finite,
  maxDischargeMw: finite,
  ...sourceFields,
}).strict()

export const hvdcLinkDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  fromBusId: z.string().describe('AC bus of the Norwegian converter; a positive transfer leaves it.'),
  toBusId: z.string().describe('Boundary bus of the external system, or another Norwegian converter bus.'),
  ratingMw: finite.describe('Transfer limit either way (MW).'),
  lossPercent: finite.describe('Converter and cable losses in percent of the sent power.'),
  rampMwPerMinute: finite.describe('Rate at which the transfer follows a set-point change (MW/min).'),
  osmWayIds: z.array(z.string()).readonly(),
  provenance: assetProvenanceSchema,
}).strict()

const islandFrequencyHz = finite.nullable().describe('Frequency of the island holding the asset; null while it is de-energised (Hz).')

export const busStateSchema = z.object({
  busId: z.string(),
  islandId: z.string().describe('Stable id of the island holding the bus (world.electric-grid.islands.list).'),
  energized: z.boolean(),
  voltagePu: finite.nullable().describe('AC load-flow voltage (pu); null while the island\'s AC load flow has not converged; 0 on a de-energised bus.'),
  voltageModel: z.enum(['ac-fdlf', 'not-converged', 'de-energised']).describe('ac-fdlf: voltagePu is the AC result; not-converged: the island is energised but no voltage is known; de-energised: no source holds the bus.'),
  reactiveInjectionMvar: finite.nullable().describe('Net reactive injection of the bus\'s sources in the AC solution (Mvar, generation − demand); null unless converged.'),
  frequencyHz: islandFrequencyHz,
  angleRad: finite,
  netInjectionMw: finite.describe('Net active power injected at the bus, including its share of branch losses (MW).'),
}).strict()

export const hvdcTerminalStateSchema = z.object({
  busId: z.string(),
  externalSystemId: z.string().describe('The asynchronous external system the terminal belongs to; it holds the terminal\'s AC voltage and absorbs or supplies its links\' transfer.'),
  area: z.string().describe('The external system\'s area, for example DE or GB.'),
  links: z.array(z.object({
    linkId: z.string(),
    state: z.enum(['deblocked', 'blocked', 'tripped']),
    setpointMw: finite.describe('Transfer set-point (MW), positive exports from Norway.'),
    transferMw: finite.describe('Power sent at the sending converter (MW), positive exports from Norway.'),
  }).strict()).readonly().describe('The HVDC links ending at the terminal, in Model order.'),
  deliveredMw: finite.describe('Net power the converters at the terminal deliver into the external system (MW): positive while Norway exports, after converter and cable losses.'),
}).strict().describe('An HVDC terminal: the bus of an external system reached only by HVDC links. It lies outside the modelled AC network and in no island, and takes no part in energisation or island alarms.')

export const branchSwitchingStateSchema = z.enum(['closed', 'open', 'tripped'])
  .describe('open: opened by an operator; tripped: opened by its protection, closable only after reset-branch-protection.')

const branchProtectionStateSchema = z.object({
  thermalLevel: finite.describe('Conductor thermal state as (flow / derated rating)² in steady state; 1 is the steady state at the continuous rating.'),
  overEmergencySinceElapsedMs: finite.nullable().describe('Grid elapsed time since which the flow exceeds the derated emergency rating; null below it.'),
  trip: z.object({
    element: z.enum(['thermal', 'emergency-duration', 'instantaneous']),
    at: z.string(),
    atElapsedMs: finite,
    flowMw: finite,
    loadingPercent: finite,
    thermalLevel: finite,
  }).strict().nullable().describe('The protection operation that tripped the branch; null unless tripped.'),
}).strict()

export const branchStateSchema = z.object({
  state: branchSwitchingStateSchema,
  availability: finite.describe('Available fraction of the rating (derate).'),
  flowModel: z.enum(['ac', 'dc']).nullable().describe('ac: flows from the island\'s converged AC load flow; dc: the DC solution, because the island\'s AC load flow did not converge; null: no flow (open or de-energised).'),
  flowMw: finite.describe('Active power entering at the from end, positive towards toBusId (MW).'),
  apparentPowerMva: finite.describe('The flow its ratings bound: the larger end apparent power (MVA) with flowModel ac, |flowMw| with dc.'),
  loadingPercent: finite.describe('apparentPowerMva over the derated rating (%).'),
  voltageFromPu: finite.nullable().describe('AC voltage at the from end (pu); null while not converged; 0 when de-energised.'),
  voltageToPu: finite.nullable(),
  reactiveFromMvar: finite.nullable().describe('AC reactive power entering the branch at its from end (Mvar); null unless converged.'),
  reactiveToMvar: finite.nullable(),
  frequencyHz: islandFrequencyHz,
  lossesMw: finite.describe('I²R loss of the AC solution (MW); the quadratic DC estimate r·P²/S_base while the island\'s AC load flow has not converged.'),
  protection: branchProtectionStateSchema,
}).strict()

export const generatorLifecycleStateSchema = z.enum(['online', 'offline', 'starting', 'stopping', 'tripped'])

export const generatorStateSchema = z.object({
  state: generatorLifecycleStateSchema,
  availableMw: finite,
  dispatchMw: finite.describe('Active power output (MW).'),
  targetMw: finite.describe('Operator or dispatch set-point (MW).'),
  scheduledMw: finite.describe('Set-point the unit follows at its ramp rate; frequency control acts on top of it (MW).'),
  fcrMw: finite.describe('Activated FCR-N and FCR-D (MW).'),
  afrrMw: finite.describe('Activated aFRR (MW).'),
  mfrrMw: finite.describe('Activated mFRR (MW).'),
  reserves: gridReservesByProductSchema.describe('Reserve volumes allocated to the unit at dispatch (MW).'),
  reserveMw: finite.describe('Upward reserve allocated: FCR-N, FCR-D up, aFRR up and mFRR up (MW).'),
  frequencyHz: islandFrequencyHz,
  synchronisesAtElapsedMs: finite.nullable().describe('Run elapsed time at which a starting unit synchronises; null otherwise.'),
}).strict()

export const loadServiceStateSchema = z.enum(['normal', 'constrained', 'shed', 'outage'])
export const loadShedCauseSchema = z.enum(['manual', 'emergency', 'lfdd'])
  .describe('manual: curtailment within the load\'s interruptible demand; emergency: manual shedding beyond it; lfdd: automatic under-frequency shedding.')

export const loadStateSchema = z.object({
  nominalDemandMw: finite.describe('Scheduled demand before the daily profile (MW).'),
  modelledDemandMw: finite.describe('Demand before the daily profile as the Model and Operating Point set it (MW).'),
  manualDemandLimitMw: finite.nullable().describe('Manual shedding limit from shed-load (MW); null when not shed manually.'),
  manualShedEmergency: z.boolean().describe('The manual limit was set as emergency shedding, beyond the interruptible demand.'),
  profileFactor: finite.describe('The demand profile\'s factor at the demand sample: demandMw = max(criticalMw, nominalDemandMw × profileFactor).'),
  demandMw: finite.describe('Profiled demand before any shedding (MW).'),
  servedMw: finite.describe('Demand served: demand less curtailment, LFDD shedding and outage, at the island\'s load self-regulation (MW).'),
  curtailedMw: finite.describe('Demand shed manually (MW).'),
  lfddShedMw: finite.describe('Demand shed by automatic under-frequency load shedding (MW).'),
  outageMw: finite.describe('Demand lost because the load\'s island is de-energised (MW).'),
  unservedMw: finite.describe('Demand not served: curtailedMw + lfddShedMw + outageMw (MW).'),
  shedMw: finite.describe('Total shed demand: curtailedMw + lfddShedMw (MW).'),
  shedCauses: z.array(loadShedCauseSchema).readonly(),
  frequencyHz: islandFrequencyHz,
  voltagePu: finite.nullable().describe('Voltage of the load\'s bus (pu); null while not converged; 0 when de-energised.'),
  serviceState: loadServiceStateSchema,
}).strict()

export const storageStateSchema = z.object({
  stateOfChargeFraction: finite,
  dispatchMw: finite.describe('Active power, positive when discharging into the Grid (MW).'),
  frequencyHz: islandFrequencyHz,
  voltagePu: finite.nullable(),
  state: z.enum(['idle', 'charging', 'discharging', 'unavailable']),
}).strict()

export const hvdcLinkOperatingStateSchema = z.enum(['deblocked', 'blocked', 'tripped'])
  .describe('deblocked: the transfer follows the set-point; blocked: stopped at 0 MW by block-hvdc or after a trip reset, until deblock-hvdc; tripped: stopped by its converter protection or trip-hvdc, until reset-hvdc-trip.')

export const hvdcLinkStateSchema = z.object({
  state: hvdcLinkOperatingStateSchema,
  setpointMw: finite.describe('Transfer set-point (MW), positive from fromBusId to toBusId: positive exports from Norway.'),
  transferMw: finite.describe('Power sent at the sending converter (MW, signed like the set-point); it ramps towards the set-point at rampMwPerMinute.'),
  lossesMw: finite.describe('Converter and cable losses (MW); the receiving converter delivers |transferMw| − lossesMw.'),
  trip: z.object({
    cause: z.enum(['command', 'ac-voltage-loss']).describe('command: trip-hvdc; ac-voltage-loss: a converter terminal\'s AC bus was de-energised.'),
    atElapsedMs: finite,
    transferMw: finite.describe('Transfer when the link tripped (MW).'),
  }).strict().nullable().describe('The trip of a tripped link; null otherwise.'),
}).strict()

type Accepts<Schema extends z.ZodType, Value extends z.input<Schema>> = Value
export type WireSchemasAcceptRuntimeValues = [
  Accepts<typeof busDefinitionSchema, GridBusDefinition>,
  Accepts<typeof branchDefinitionSchema, GridBranchDefinition>,
  Accepts<typeof generatorDefinitionSchema, GridGeneratorDefinition>,
  Accepts<typeof loadDefinitionSchema, GridLoadDefinition>,
  Accepts<typeof demandProfileDefinitionSchema, GridDemandProfileDefinition>,
  Accepts<typeof storageDefinitionSchema, GridStorageDefinition>,
  Accepts<typeof busStateSchema, GridBusState>,
  Accepts<typeof hvdcTerminalStateSchema, GridHvdcTerminalState>,
  Accepts<typeof branchStateSchema, GridBranchState>,
  Accepts<typeof generatorStateSchema, GridGeneratorState>,
  Accepts<typeof loadStateSchema, GridLoadState>,
  Accepts<typeof storageStateSchema, GridStorageState>,
  Accepts<typeof hvdcLinkDefinitionSchema, GridHvdcLinkDefinition>,
  Accepts<typeof hvdcLinkStateSchema, GridHvdcLinkState>,
]
