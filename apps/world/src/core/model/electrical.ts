import { z } from 'zod'
import { idSchema, objectIdSchema, type ObjectId } from './ids.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

interface ElectricalPortStateBase {
  /** Positive values leave the owning Operational Object. */
  readonly activePowerMw: number
  readonly connected: boolean
  readonly observedAt: IsoTimestamp
}

/** A live port: positive finite voltage (pu) and frequency (Hz). */
export interface EnergizedElectricalPortState extends ElectricalPortStateBase {
  readonly energized: true
  readonly voltagePu: number
  readonly frequencyHz: number
}

/** A dead port: no voltage and no frequency (frequency is absent, never 0 Hz). */
export interface DeenergizedElectricalPortState extends ElectricalPortStateBase {
  readonly energized: false
  readonly voltagePu: 0
  readonly frequencyHz: null
}

export type ElectricalPortState = EnergizedElectricalPortState | DeenergizedElectricalPortState

export interface ElectricalPortDefinition {
  readonly id: string
  readonly label: string
  readonly role: 'system' | 'network'
  readonly nominalKv: number
  readonly maximumExportMw: number
  readonly maximumImportMw: number
  readonly inertiaSeconds?: number | undefined
  readonly state?: ElectricalPortState | undefined
}

export interface ElectricalConnectionEndpoint {
  readonly objectId: ObjectId
  readonly portId: string
}

export interface ElectricalConnectionDefinition {
  readonly id: string
  readonly type: 'electrical'
  readonly system: ElectricalConnectionEndpoint
  readonly network: ElectricalConnectionEndpoint
  readonly nominalKv: number
  readonly maximumSystemExportMw: number
  readonly maximumSystemImportMw: number
  readonly systemInertiaSeconds?: number | undefined
}

const electricalPortStateBaseShape = {
  activePowerMw: z.number().finite(),
  connected: z.boolean(),
  observedAt: isoTimestampSchema,
}

export const electricalPortStateSchema = z.discriminatedUnion('energized', [
  z.object({
    ...electricalPortStateBaseShape,
    energized: z.literal(true),
    voltagePu: z.number().finite().positive(),
    frequencyHz: z.number().finite().positive(),
  }).strict(),
  z.object({
    ...electricalPortStateBaseShape,
    energized: z.literal(false),
    voltagePu: z.literal(0),
    frequencyHz: z.null(),
  }).strict(),
])

export const electricalPortDefinitionSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  role: z.enum(['system', 'network']),
  nominalKv: z.number().finite().positive(),
  maximumExportMw: z.number().finite().nonnegative(),
  maximumImportMw: z.number().finite().nonnegative(),
  inertiaSeconds: z.number().finite().nonnegative().optional(),
  state: electricalPortStateSchema.optional(),
}).strict()

export const electricalConnectionEndpointSchema = z.object({
  objectId: objectIdSchema,
  portId: idSchema,
}).strict()

export const electricalConnectionSpecSchema = z.object({
  id: idSchema,
  type: z.literal('electrical'),
  system: electricalConnectionEndpointSchema,
  network: electricalConnectionEndpointSchema,
}).strict()

export const electricalConnectionDefinitionSchema = electricalConnectionSpecSchema.extend({
  nominalKv: z.number().finite().positive(),
  maximumSystemExportMw: z.number().finite().nonnegative(),
  maximumSystemImportMw: z.number().finite().nonnegative(),
  systemInertiaSeconds: z.number().finite().nonnegative().optional(),
}).strict()

const electricalPortCarrierSchema = z.object({
  electricalPorts: z.array(electricalPortDefinitionSchema),
}).passthrough()

export const electricalPortsFromObject = (
  object: { readonly packData?: unknown },
): ReadonlyArray<ElectricalPortDefinition> => {
  const parsed = electricalPortCarrierSchema.safeParse(object.packData)
  return parsed.success ? parsed.data.electricalPorts : []
}

export const electricalPortFromObject = (
  object: { readonly packData?: unknown },
  portId: string,
): ElectricalPortDefinition | undefined =>
  electricalPortsFromObject(object).find(port => port.id === portId)
