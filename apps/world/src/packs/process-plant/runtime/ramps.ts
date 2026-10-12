import { z } from 'zod'
import { variablePathSchema, type VariablePath } from '../graph/index.ts'
import type { ProcessPlantRuntime } from './model.ts'

export const processPlantRampSchema = z.object({
  id: z.string().min(1),
  path: variablePathSchema,
  from: z.number().finite(),
  target: z.number().finite(),
  startedAtMs: z.number().finite().nonnegative(),
  durationMs: z.number().finite().positive(),
}).strict()

export type ProcessPlantRamp = z.infer<typeof processPlantRampSchema>

export const processPlantRampSnapshotSchema = z.object({
  active: z.array(processPlantRampSchema),
}).strict()

export type ProcessPlantRampSnapshot = z.infer<typeof processPlantRampSnapshotSchema>

export interface ProcessPlantRampRunner {
  readonly start: (config: {
    readonly id: string
    readonly path: VariablePath
    readonly target: number
    readonly durationMs: number
  }) => void
  readonly apply: (nextElapsedMs: number) => void
  /** Ends the ramp on a path, if one runs: an automatic action wrote it, and a ramp would write over that on its next step. */
  readonly cancel: (path: VariablePath) => boolean
  readonly snapshot: () => ProcessPlantRampSnapshot
}

export const createProcessPlantRampRunner = (config: {
  readonly runtime: ProcessPlantRuntime
  readonly restoredSnapshot?: ProcessPlantRampSnapshot
}): ProcessPlantRampRunner => {
  const restored = processPlantRampSnapshotSchema.parse(config.restoredSnapshot ?? { active: [] })
  const active = new Map<VariablePath, ProcessPlantRamp>()
  for (const candidate of restored.active) {
    if (active.has(candidate.path)) throw new Error(`duplicate restored process plant ramp path: ${candidate.path}`)
    active.set(candidate.path, candidate)
  }

  return {
    start: candidate => {
      const snapshot = config.runtime.readVariableSnapshot(candidate.path)
      if (typeof snapshot.value !== 'number') {
        throw new Error(`process plant ramp requires a numeric variable: ${candidate.path}`)
      }
      const ramp = processPlantRampSchema.parse({
        ...candidate,
        from: snapshot.value,
        startedAtMs: config.runtime.elapsedMs(),
      })
      active.set(ramp.path, ramp)
    },
    apply: nextElapsedMs => {
      for (const [path, ramp] of active) {
        const fraction = Math.min(1, Math.max(0, (nextElapsedMs - ramp.startedAtMs) / ramp.durationMs))
        config.runtime.writeCommand({
          type: 'setVariable',
          path,
          value: ramp.from + (ramp.target - ramp.from) * fraction,
        })
        if (fraction >= 1) active.delete(path)
      }
    },
    cancel: path => active.delete(path),
    snapshot: () => ({ active: [...active.values()] }),
  }
}
