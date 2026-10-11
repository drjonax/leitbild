import { z } from 'zod'
import type {
  GridBranchDefinition,
  GridBusDefinition,
  GridGeneratorDefinition,
  GridLoadDefinition,
  GridStorageDefinition,
} from '../grid-model.ts'
import { gridReservesByProductSchema } from '../model.ts'
import type {
  GridBranchState,
  GridBusState,
  GridGeneratorState,
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
}).strict().describe('Where the asset\'s values come from and how they were obtained, for assets a Model Addition adds with evidence.')

export const busDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  nominalKv: finite,
  location,
  ...sourceFields,
  provenance: assetProvenanceSchema.optional(),
}).strict()

export const branchDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['ac_line', 'cable', 'transformer', 'hvdc_link', 'switch']),
  fromBusId: z.string(),
  toBusId: z.string(),
  nominalKv: finite,
  ratingMw: finite,
  emergencyRatingMw: finite,
  reactancePu: finite,
  resistancePu: finite,
  weatherExposure: z.enum(['low', 'medium', 'high']),
  ...sourceFields,
  provenance: assetProvenanceSchema.optional(),
}).strict()

export const generatorDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['hydro', 'wind', 'solar', 'thermal', 'nuclear', 'battery', 'import']),
  busId: z.string(),
  location,
  capacityMw: finite,
  availableMw: finite,
  reserveMw: finite,
  rampRateMwPerMinute: finite,
  inertiaSeconds: finite,
  annualProductionGwh: finite.optional(),
  operator: z.string().optional(),
  priceArea: z.string().optional(),
  ...sourceFields,
}).strict()

export const loadDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['residential', 'commercial', 'hospital', 'airport', 'industry', 'data_center', 'ev_charging', 'process_plant']),
  busId: z.string(),
  location,
  demandMw: finite,
  criticalMw: finite,
  reactiveDemandMvar: finite,
  priority: z.enum(['critical', 'high', 'normal', 'low']),
  controllable: z.boolean(),
  ...sourceFields,
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

const islandFrequencyHz = finite.nullable().describe('Frequency of the island holding the asset; null while it is de-energised (Hz).')

export const busStateSchema = z.object({
  busId: z.string(),
  islandId: z.string().describe('Stable id of the island holding the bus (world.electric-grid.islands.list).'),
  energized: z.boolean(),
  voltagePu: finite.describe('1.0 on a live bus (nominal, not computed by the DC model); 0 on a de-energised bus.'),
  voltageModel: z.literal('dc-nominal'),
  frequencyHz: islandFrequencyHz,
  angleRad: finite,
  netInjectionMw: finite.describe('Net active power injected at the bus, including its share of branch losses (MW).'),
}).strict()

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
  flowMw: finite.describe('Active power flow, positive from fromBusId to toBusId (MW).'),
  loadingPercent: finite.describe('|flowMw| over the derated rating (%).'),
  voltageFromPu: finite,
  voltageToPu: finite,
  frequencyHz: islandFrequencyHz,
  lossesMw: finite.describe('Quadratic DC loss r·P²/S_base (MW).'),
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
export const loadShedCauseSchema = z.enum(['manual', 'lfdd'])

export const loadStateSchema = z.object({
  nominalDemandMw: finite.describe('Scheduled demand before the daily profile (MW).'),
  manualDemandLimitMw: finite.nullable().describe('Manual shedding limit from shed-load (MW); null when not shed manually.'),
  demandMw: finite.describe('Profiled demand before any shedding (MW).'),
  servedMw: finite.describe('Demand served: demand less curtailment, LFDD shedding and outage, at the island\'s load self-regulation (MW).'),
  curtailedMw: finite.describe('Demand shed manually (MW).'),
  lfddShedMw: finite.describe('Demand shed by automatic under-frequency load shedding (MW).'),
  outageMw: finite.describe('Demand lost because the load\'s island is de-energised (MW).'),
  unservedMw: finite.describe('Demand not served: curtailedMw + lfddShedMw + outageMw (MW).'),
  shedMw: finite.describe('Total shed demand: curtailedMw + lfddShedMw (MW).'),
  shedCauses: z.array(loadShedCauseSchema),
  frequencyHz: islandFrequencyHz,
  voltagePu: finite,
  serviceState: loadServiceStateSchema,
}).strict()

export const storageStateSchema = z.object({
  stateOfChargeFraction: finite,
  dispatchMw: finite.describe('Active power, positive when discharging into the Grid (MW).'),
  frequencyHz: islandFrequencyHz,
  voltagePu: finite,
  state: z.enum(['idle', 'charging', 'discharging', 'unavailable']),
}).strict()

type Accepts<Schema extends z.ZodType, Value extends z.input<Schema>> = Value
export type WireSchemasAcceptRuntimeValues = [
  Accepts<typeof busDefinitionSchema, GridBusDefinition>,
  Accepts<typeof branchDefinitionSchema, GridBranchDefinition>,
  Accepts<typeof generatorDefinitionSchema, GridGeneratorDefinition>,
  Accepts<typeof loadDefinitionSchema, GridLoadDefinition>,
  Accepts<typeof storageDefinitionSchema, GridStorageDefinition>,
  Accepts<typeof busStateSchema, GridBusState>,
  Accepts<typeof branchStateSchema, GridBranchState>,
  Accepts<typeof generatorStateSchema, GridGeneratorState>,
  Accepts<typeof loadStateSchema, GridLoadState>,
  Accepts<typeof storageStateSchema, GridStorageState>,
]
