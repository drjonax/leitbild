import { activeStep, skipSteps, targetLabel } from '../engine/chain-steps.ts'
import { closeDraft, openDraft, putUnit, setMotion } from '../engine/draft.ts'
import type { EngineState, LastAction, Transition } from '../engine/model.ts'
import { settle } from '../engine/phases.ts'
import { stepTargetId } from '../steps.ts'
import { byId, patch } from '../engine/values.ts'

/** Attribution of releases a core deletion causes: the Capability that deleted the record. */
export const deletionActor = 'world.object.delete'

/**
 * Drops records deleted from the Run. A unit committed to a deleted task is
 * released where it stands; a unit heading to or waiting at a deleted site
 * holds its load, and its deliver order, if any, finds another site; a unit
 * going to a deleted site stops where it is. Every step leading to a deleted
 * record is skipped, and each chain goes on. Task coverage is brought up to
 * date, so the transitions say what changed.
 */
export const removeRecords = (state: EngineState, ids: ReadonlySet<string>): { readonly state: EngineState; readonly transitions: ReadonlyArray<Transition> } => {
  const draft = openDraft(state)
  const released = (target: string, label: string): LastAction => ({ verb: 'release', target, by: deletionActor, cause: `${label} deleted`, atMs: draft.timeMs })
  for (const unit of [...draft.units.values()].sort(byId)) {
    if (ids.has(unit.id)) continue
    const deleted = (id: string | undefined): boolean => id !== undefined && ids.has(id)
    const skipped = skipSteps(unit, draft.timeMs, step => deleted(stepTargetId(step.target)) ? { label: targetLabel(draft, step.target), reason: 'deleted' } : undefined)
    const task = deleted(unit.taskId) ? draft.tasks.get(unit.taskId!) : undefined
    const site = deleted(unit.siteId) ? draft.units.get(unit.siteId!) : undefined
    const head = activeStep(unit)
    const goingTo = head?.kind === 'move' && 'siteId' in head.target && deleted(head.target.siteId) ? draft.units.get(head.target.siteId) : undefined
    if (task === undefined && site === undefined && goingTo === undefined) {
      if (skipped !== unit) putUnit(draft, skipped)
      continue
    }
    setMotion(draft, unit.id, { progressMs: 0 })
    const stopped = { leg: undefined, phaseSinceMs: draft.timeMs, phaseDueMs: undefined }
    if (task !== undefined) putUnit(draft, patch(skipped, { ...stopped, taskId: undefined, phase: 'available', lastAction: released(task.id, task.label) }))
    else if (site !== undefined) putUnit(draft, patch(skipped, { ...stopped, siteId: undefined, phase: 'holding', lastAction: released(site.id, site.label) }))
    else putUnit(draft, patch(skipped, { ...stopped, phase: 'available', lastAction: released(goingTo!.id, goingTo!.label) }))
  }
  for (const id of ids) {
    draft.units.delete(id)
    draft.tasks.delete(id)
    draft.motion.delete(id)
  }
  settle(draft)
  return { state: closeDraft(draft), transitions: draft.transitions.filter(transition => !ids.has(transition.record.id)) }
}
