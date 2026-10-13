// What the Workspace page keeps open (the Run in `?world`, the conversation
// in `?agents`) once it has read the Workspace's Resources. A Run or room the
// list no longer holds closes (deleted here or elsewhere), but only when its
// Module answered: a Module that failed to answer never closes what it owns.
// A room that does not serve the open Run closes too.

import type { ModuleQueryOutcome, ModuleResourceDescriptor } from '@leitbild/contracts'
import { roomServesRun } from './run-room-scope.ts'

export interface OpenSelection {
  readonly world: string | null
  readonly agents: string | null
  readonly agentsVisible: boolean
}

export const keptSelection = (
  selection: OpenSelection,
  resources: ReadonlyArray<ModuleResourceDescriptor>,
  modules: ReadonlyArray<ModuleQueryOutcome>,
): OpenSelection => {
  const answered = (moduleId: string): boolean => !modules.some(outcome => outcome.moduleId === moduleId && outcome.status === 'failed')
  const run = resources.find(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === selection.world)
  const room = resources.find(resource => resource.ref.type === 'agents.room' && resource.ref.id === selection.agents)
  const world = selection.world !== null && run === undefined && answered('world') ? null : selection.world
  const roomGone = selection.agents !== null && room === undefined && answered('agents')
  const roomOutsideRun = run !== undefined && room !== undefined && !roomServesRun(room, run)
  return roomGone || roomOutsideRun
    ? { world, agents: null, agentsVisible: false }
    : { world, agents: selection.agents, agentsVisible: selection.agentsVisible }
}
