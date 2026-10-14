import { z } from 'zod'
import {
  idSchema,
  electricalPortDefinitionSchema,
  isoTimestampSchema,
  type IsoTimestamp,
  type OperationalObject,
} from '../../core/model/index.ts'
import {
  processPlantAutomationSelectionSchema,
  processPlantModelSelectionSchema,
  processPlantOperatingPointSelectionSchema,
} from './config.ts'

export const processPlantPackId = 'process-plant' as const

export const processPlantUnitProjectionFieldSchema = z.object({
  key: idSchema,
  label: z.string().min(1),
  value: z.string().min(1),
}).strict()
export type ProcessPlantUnitProjectionField = z.infer<typeof processPlantUnitProjectionFieldSchema>

export const processPlantUnitProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  summary: z.string().min(1),
  statusTone: z.enum(['ready', 'working', 'error', 'idle']),
  statusLabel: z.string().min(1),
  highestSeverity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
  /** The label of the operating mode the Plant is in; absent where its model declares none or none holds. */
  modeLabel: z.string().min(1).optional(),
  /**
   * Present while a trip of a first-out group the model declares as its
   * reactor trip is active and annunciated; other trips (an auxiliary feed
   * start, a turbine trip) leave it absent.
   */
  reactorTripped: z.literal(true).optional(),
  activeAlarmCount: z.number().int().nonnegative(),
  activeTripCount: z.number().int().nonnegative(),
  fields: z.array(processPlantUnitProjectionFieldSchema),
  updatedAt: isoTimestampSchema,
}).strict()
export type ProcessPlantUnitProjection = z.infer<typeof processPlantUnitProjectionSchema>

export const processPlantUnitPackDataSchema = z.object({
  type: z.literal('process-plant'),
  schemaVersion: z.literal(1),
  model: processPlantModelSelectionSchema,
  operatingPoint: processPlantOperatingPointSelectionSchema,
  automation: processPlantAutomationSelectionSchema,
  clusterId: idSchema.optional(),
  coolingWater: z.string().min(1).optional(),
  /**
   * How AI agents operate the Plant. Absent, an agent proposes and a person
   * approves: its direct control writes, ramps, instructor actions and alarm
   * lifecycle changes are refused (plan-final QA-1). 'direct' lets an agent
   * operate it itself, as a training sandbox.
   */
  aiOperation: z.literal('direct').optional(),
  electricalPorts: z.array(electricalPortDefinitionSchema),
  projection: processPlantUnitProjectionSchema.optional(),
}).strict()
export type ProcessPlantUnitPackData = z.infer<typeof processPlantUnitPackDataSchema>

export const processPlantIdForObject = (
  object: Pick<OperationalObject, 'id' | 'packId' | 'packData'>,
): string | null => object.packId === processPlantPackId
  && processPlantUnitPackDataSchema.safeParse(object.packData).success
    ? String(object.id)
    : null

export const processPlantField = (
  key: string,
  label: string,
  value: string,
): ProcessPlantUnitProjectionField => ({
  key,
  label,
  value,
})

export const emptyProcessPlantProjection = (at: IsoTimestamp): ProcessPlantUnitProjection => ({
  schemaVersion: 1,
  summary: 'Process runtime pending',
  statusTone: 'idle',
  statusLabel: 'Runtime pending',
  activeAlarmCount: 0,
  activeTripCount: 0,
  fields: [
    processPlantField('runtime', 'Runtime', 'pending'),
  ],
  updatedAt: at,
})
