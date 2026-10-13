// What Agents is doing in each loaded Workspace right now, for the Host's
// Manage Workspaces view (packages/contracts/src/activity.ts). Memory only:
// it reads the registry's loaded runtimes, never loads one and never touches
// a Workspace's idle clock, so polling it keeps nothing in memory.
//
// Two facts, both work that uses a model at this moment:
//   - AI Agents generating a turn (an answer, a trigger, a procedure step, a
//     turn an approved proposal resumed): the state drain and idle eviction
//     wait on (runtime-registry.ts).
//   - model comparisons whose job runs (agents/comparisons.ts). They call the
//     model outside any Agent's turn, so the first fact does not show them.

import type { ModuleActivity, WorkspaceActivityItem } from '@leitbild/contracts'
import { asAIAgent } from '../../agents/shared.ts'
import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import type { WorkspaceRuntimeRegistry } from './runtime-registry.ts'

const counted = (count: number, one: string, many: string, doing: string): string =>
  `${count} ${count === 1 ? one : many} ${doing}`

const activityOf = (runtime: AgentsWorkspaceRuntime): WorkspaceActivityItem[] => {
  const answering = runtime.team.listAgents().filter(agent => asAIAgent(agent)?.state.get() === 'generating').length
  const comparing = runtime.comparisons.running()
  return [
    ...(answering === 0 ? [] : [{ key: 'agents-answering', label: counted(answering, 'AI agent', 'AI agents', 'answering'), count: answering, active: true }]),
    ...(comparing === 0 ? [] : [{ key: 'comparisons-running', label: counted(comparing, 'model comparison', 'model comparisons', 'running'), count: comparing, active: true }]),
  ]
}

export const agentsActivity = (registry: Pick<WorkspaceRuntimeRegistry, 'list' | 'tryGetLive'>): ModuleActivity => ({
  workspaces: registry.list().flatMap(({ id }) => {
    // Only an active runtime reports. An evicting one is leaving memory and
    // ends its last generation within the drain bound; a save-failed one is
    // already quiesced. Neither starts work, and the next poll sees it gone.
    const runtime = registry.tryGetLive(id)
    if (runtime === undefined) return []
    const items = activityOf(runtime)
    return items.length === 0 ? [] : [{ workspaceId: id, items }]
  }),
})
