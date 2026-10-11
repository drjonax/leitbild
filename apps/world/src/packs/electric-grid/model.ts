import { z } from 'zod'
import type { OperationalObject } from '../../core/model/index.ts'
import { electricalPortDefinitionSchema } from '../../core/model/index.ts'
import {
  gridAutomationSelectionSchema,
  gridModelSelectionSchema,
  gridOperatingPointSelectionSchema,
} from './config.ts'

export const electricGridPackId = 'electric-grid' as const

const finiteNumber = z.number().finite()

const nonNegative = finiteNumber.nonnegative()
const count = z.number().int().nonnegative()

/** Reserve allocated by product (MW), units and external equivalents of the island together. */
export const gridReservesByProductSchema = z.object({
  fcrNMw: nonNegative,
  fcrDUpMw: nonNegative,
  fcrDDownMw: nonNegative,
  afrrUpMw: nonNegative,
  afrrDownMw: nonNegative,
  mfrrUpMw: nonNegative,
  mfrrDownMw: nonNegative,
}).strict()

/** One electrical island with a stable id; frequency and RoCoF are null while it is de-energised. */
export const gridIslandProjectionSchema = z.object({
  id: z.string().min(1),
  energized: z.boolean(),
  busCount: count,
  frequencyHz: finiteNumber.positive().nullable(),
  rocofHzPerSecond: finiteNumber.nullable(),
  /** Electrical output of the island's generators and storage (MW). */
  generationMw: finiteNumber,
  /** Net power into the island from external systems, connected systems and HVDC (MW; negative exports). */
  importMw: finiteNumber,
  loadMw: nonNegative,
  servedLoadMw: nonNegative,
  lossesMw: nonNegative,
  reserves: gridReservesByProductSchema,
  /** ac-fdlf: the island's AC load flow converged; not-converged: it did not, and its buses publish no voltage. */
  voltageModel: z.enum(['ac-fdlf', 'not-converged', 'de-energised']),
  /** Where its branch flows and loading come from: ac when its AC load flow converged, dc when not; null when de-energised. */
  flowModel: z.enum(['ac', 'dc']).nullable(),
  /** Lowest and highest bus voltage of a converged energised island (pu); null otherwise. */
  voltageMinPu: finiteNumber.positive().nullable(),
  voltageMaxPu: finiteNumber.positive().nullable(),
  alarmCount: count,
}).strict()
export type GridIslandProjection = z.infer<typeof gridIslandProjectionSchema>

export const gridProjectionSchema = z.object({
  statusTone: z.enum(['ready', 'working', 'error', 'idle']),
  statusLabel: z.string().min(1),
  summary: z.string().min(1),
  nominalFrequencyHz: finiteNumber.positive(),
  /** Headline frequency: the frequency of the energised island with the largest demand; null when no island is energised. */
  frequencyHz: finiteNumber.positive().nullable(),
  frequencyBasis: z.literal('largest-load-energized-island'),
  frequencyIslandId: z.string().min(1).nullable(),
  frequencyMinHz: finiteNumber.positive().nullable(),
  frequencyMaxHz: finiteNumber.positive().nullable(),
  /** Bus voltages come from each energised island's AC load flow (fast-decoupled); islands[] tells which converged. */
  voltageModel: z.literal('ac-fdlf'),
  /** Lowest and highest bus voltage over the converged energised islands (pu); null when there is none. */
  voltageMinPu: finiteNumber.positive().nullable(),
  voltageMaxPu: finiteNumber.positive().nullable(),
  /** Energised islands whose AC load flow did not converge: their buses publish no voltage. */
  notConvergedIslandCount: count,
  totalGenerationMw: nonNegative,
  totalLoadMw: nonNegative,
  servedLoadMw: nonNegative,
  unservedLoadMw: nonNegative,
  lossesMw: nonNegative,
  reserveMarginMw: finiteNumber,
  highestBranchLoadingPercent: nonNegative,
  /** Energised islands. */
  activeIslandCount: count,
  islandCount: count,
  activeAlarmCount: count,
  /** Islands that hold a generator, load, storage, connection point or external system. */
  islands: z.array(gridIslandProjectionSchema),
  energyAudit: z.object({
    /** Largest |Σ injection| of an energised island at the last solve (MW). */
    maximumIslandMismatchMw: nonNegative,
    cumulativeMismatchMwh: nonNegative,
  }).strict(),
  tick: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
}).strict()
export type GridProjection = z.infer<typeof gridProjectionSchema>

export const electricGridPackDataSchema = z.object({
  type: z.literal('electric-grid'),
  schemaVersion: z.literal(1),
  model: gridModelSelectionSchema,
  operatingPoint: gridOperatingPointSelectionSchema,
  automation: gridAutomationSelectionSchema,
  electricalPorts: z.array(electricalPortDefinitionSchema),
  projection: gridProjectionSchema,
}).strict()
export type ElectricGridPackData = z.infer<typeof electricGridPackDataSchema>

export const emptyGridProjection = (at: string, nominalFrequencyHz: number): GridProjection => ({
  statusTone: 'idle',
  statusLabel: 'Initializing',
  summary: 'Grid runtime is initializing',
  nominalFrequencyHz,
  frequencyHz: null,
  frequencyBasis: 'largest-load-energized-island',
  frequencyIslandId: null,
  frequencyMinHz: null,
  frequencyMaxHz: null,
  voltageModel: 'ac-fdlf',
  voltageMinPu: null,
  voltageMaxPu: null,
  notConvergedIslandCount: 0,
  totalGenerationMw: 0,
  totalLoadMw: 0,
  servedLoadMw: 0,
  unservedLoadMw: 0,
  lossesMw: 0,
  reserveMarginMw: 0,
  highestBranchLoadingPercent: 0,
  activeIslandCount: 0,
  islandCount: 0,
  activeAlarmCount: 0,
  islands: [],
  energyAudit: { maximumIslandMismatchMw: 0, cumulativeMismatchMwh: 0 },
  tick: 0,
  updatedAt: at,
})

export const parseElectricGridObjectData = (
  object: Pick<OperationalObject, 'packId' | 'packData'>,
): ElectricGridPackData | null => {
  if (object.packId !== electricGridPackId) return null
  const parsed = electricGridPackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

export const gridIdForObject = (
  object: Pick<OperationalObject, 'id' | 'packId' | 'packData'>,
): string | null => parseElectricGridObjectData(object) === null ? null : object.id
