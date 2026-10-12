import { z } from 'zod'
import { einsatzConfigSchema } from '../config-validation.ts'
import { einsatzRuntimeStateSchema } from '../engine/objects.ts'

/**
 * What the Einsatz runtime keeps beside the canonical objects, never
 * journaled: the configuration in force and its revision, the next serial
 * of the unit and task ids it gives, and the engine's per-cycle values (Run time, leg progress
 * and failed reflex attempts). Saved with every checkpoint and Run copy, and
 * read back on connect.
 */
export const savedStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  config: einsatzConfigSchema,
  serials: z.object({ unit: z.number().int().positive(), task: z.number().int().positive() }).strict(),
  engine: einsatzRuntimeStateSchema,
}).strict()
export type SavedState = z.output<typeof savedStateSchema>
