import { z } from 'zod'
import type {
  GridBranchDefinition,
  GridBusDefinition,
  GridGeneratorDefinition,
  GridLoadDefinition,
  GridStorageDefinition,
} from '../grid-model.ts'
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

export const busDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  nominalKv: finite,
  location,
  ...sourceFields,
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

export const busStateSchema = z.object({
  busId: z.string(),
  voltagePu: finite,
  frequencyHz: finite,
  angleRad: finite,
  islandId: z.string(),
  netInjectionMw: finite.describe('Net active power injected at the bus: generation minus served load (MW).'),
}).strict()

export const branchStateSchema = z.object({
  state: z.enum(['closed', 'open']),
  availability: finite.describe('Available fraction of the rating (derate).'),
  flowMw: finite.describe('Active power flow, positive from fromBusId to toBusId (MW).'),
  loadingPercent: finite.describe('|flowMw| over the derated rating (%).'),
  voltageFromPu: finite,
  voltageToPu: finite,
  frequencyHz: finite,
  lossesMw: finite,
}).strict()

export const generatorLifecycleStateSchema = z.enum(['online', 'offline', 'starting', 'stopping', 'tripped'])

export const generatorStateSchema = z.object({
  state: generatorLifecycleStateSchema,
  availableMw: finite,
  dispatchMw: finite.describe('Active power output (MW).'),
  targetMw: finite.describe('Dispatch target the unit ramps to (MW).'),
  reserveMw: finite,
  frequencyHz: finite,
  synchronisesAtElapsedMs: finite.nullable().describe('Run elapsed time at which a starting unit synchronises; null otherwise.'),
}).strict()

export const loadServiceStateSchema = z.enum(['normal', 'constrained', 'shed', 'outage'])
export const loadShedCauseSchema = z.enum(['manual', 'lfdd'])

export const loadStateSchema = z.object({
  nominalDemandMw: finite.describe('Scheduled demand before the daily profile (MW).'),
  manualDemandLimitMw: finite.nullable().describe('Manual shedding limit from shed-load (MW); null when not shed manually.'),
  demandMw: finite,
  servedMw: finite,
  curtailedMw: finite.describe('Demand shed manually (MW).'),
  lfddShedMw: finite.describe('Demand shed by automatic under-frequency load shedding (MW).'),
  shedMw: finite.describe('Total shed demand: curtailedMw + lfddShedMw (MW).'),
  shedCauses: z.array(loadShedCauseSchema),
  frequencyHz: finite,
  voltagePu: finite,
  serviceState: loadServiceStateSchema,
}).strict()

export const storageStateSchema = z.object({
  stateOfChargeFraction: finite,
  dispatchMw: finite.describe('Active power, positive when discharging into the Grid (MW).'),
  frequencyHz: finite,
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
