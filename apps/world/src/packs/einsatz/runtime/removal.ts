import { closeDraft, openDraft, putUnit, setMotion } from '../engine/draft.ts'
import type { EngineState, LastAction, Transition } from '../engine/model.ts'
import { settle } from '../engine/phases.ts'
import { byId, patch } from '../engine/values.ts'

/** Attribution of releases a core deletion causes: the Capability that deleted the record. */
export const deletionActor = 'world.object.delete'

/**
 * Drops records deleted from the Run. A unit committed to a deleted task is
 * released where it stands; a unit heading to or waiting at a deleted site
 * holds its load, and its deliver order, if any, finds another site. Task
 * coverage is brought up to date, so the transitions say what changed.
 */
export const removeRecords = (state: EngineState, ids: ReadonlySet<string>): { readonly state: EngineState; readonly transitions: ReadonlyArray<Transition> } => {
  const draft = openDraft(state)
  const released = (target: string, label: string): LastAction => ({ verb: 'release', target, by: deletionActor, cause: `${label} deleted`, atMs: draft.timeMs })
  for (const unit of [...draft.units.values()].sort(byId)) {
    if (ids.has(unit.id)) continue
    const task = unit.taskId !== undefined && ids.has(unit.taskId) ? draft.tasks.get(unit.taskId) : undefined
    const site = unit.siteId !== undefined && ids.has(unit.siteId) ? draft.units.get(unit.siteId) : undefined
    if (task === undefined && site === undefined) continue
    setMotion(draft, unit.id, { progressMs: 0 })
    const stopped = { leg: undefined, phaseSinceMs: draft.timeMs, phaseDueMs: undefined }
    if (task !== undefined) putUnit(draft, patch(unit, { ...stopped, taskId: undefined, phase: 'available', lastAction: released(task.id, task.label) }))
    else putUnit(draft, patch(unit, { ...stopped, siteId: undefined, phase: 'holding', lastAction: released(site!.id, site!.label) }))
  }
  for (const id of ids) {
    draft.units.delete(id)
    draft.tasks.delete(id)
    draft.motion.delete(id)
  }
  settle(draft)
  return { state: closeDraft(draft), transitions: draft.transitions.filter(transition => !ids.has(transition.record.id)) }
}
