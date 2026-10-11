import { gridAlarmLifecycleCommandKind, gridAlarmLifecyclePayloadSchema } from '../commands/alarm.ts'
import { gridResetBranchProtectionCommandKind, gridResetBranchProtectionPayloadSchema } from '../commands/protection.ts'
import { applyGridAlarmLifecycle } from './alarms.ts'
import type { GridRuntimeInstance } from './instance.ts'

/** Alarm lifecycle and protection reset commands: they change alarm and relay state, never flows or set-points. */
export const gridLifecycleCommandHandlers = {
  [gridAlarmLifecycleCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridAlarmLifecyclePayloadSchema.parse(rawPayload)
    if ((payload.action === 'shelve') !== (payload.shelveSeconds !== undefined)) {
      throw new Error('shelveSeconds is required for shelve and not allowed for acknowledge or unshelve')
    }
    const lifecycle = payload.action === 'shelve' ? { action: 'shelve' as const, shelveSeconds: payload.shelveSeconds! } : { action: payload.action }
    applyGridAlarmLifecycle(grid, payload.alarmIds, lifecycle, payload.reason ?? null)
  },
  [gridResetBranchProtectionCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridResetBranchProtectionPayloadSchema.parse(rawPayload)
    const entry = grid.definition.index.assetById.get(payload.assetId)
    const state = grid.branches.get(payload.assetId)
    if (entry?.kind !== 'branch' || !state) throw new Error(`branch Grid Asset not found: ${payload.assetId}`)
    if (state.state !== 'tripped') throw new Error(`branch ${payload.assetId} is ${state.state}, not tripped by its protection; there is no trip to reset`)
    state.state = 'open'
    state.protection.trip = null
    state.protection.overEmergencySinceElapsedMs = null
  },
} as const
