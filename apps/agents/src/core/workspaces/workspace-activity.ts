// What Agents is doing in each loaded Workspace right now, for the Host's
// Manage Workspaces view (packages/contracts/src/activity.ts). Memory only:
// it reads the registry's loaded runtimes, never loads one and never touches
// a Workspace's idle clock, so polling it keeps nothing in memory.
//
// It states what the registry's ownsAutonomousWork treats as keeping a
// Workspace loaded, plus comparisons, in at most four facts:
//   - AI Agents generating a turn (an answer, a trigger, a procedure step, a
//     turn an approved proposal resumed). Active.
//   - model comparisons whose job runs; they call the model outside any
//     Agent's turn (agents/comparisons.ts). Active.
//   - background work outside any Agent's turn: script runs advancing in an
//     unpaused Room (the model classifies each cast post and the runner
//     activates the next member), and room summaries being written (a
//     compression writes the Room's summary message too). Active.
//   - recurring or held work between runs: enabled triggers of AI or human
//     Agents (each fires on its own interval), timed summaries or
//     compressions, and script runs whose Room is paused until Resume. Not
//     active: none of it uses the server until it runs again.
// A fact made of one kind names it ("2 recurring triggers"); mixed kinds take
// the umbrella noun ("3 jobs waiting to run").

import type { ModuleActivity, WorkspaceActivityItem } from '@leitbild/contracts'
import { asAIAgent } from '../../agents/shared.ts'
import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import type { WorkspaceRuntimeRegistry } from './runtime-registry.ts'

interface Noun { readonly one: string; readonly many: string }
interface Part extends Noun { readonly count: number }

const fact = (key: string, active: boolean, parts: ReadonlyArray<Part>, umbrella?: Noun): WorkspaceActivityItem[] => {
  const present = parts.filter(part => part.count > 0)
  if (present.length === 0) return []
  const noun = present.length === 1 ? present[0] : umbrella
  if (noun === undefined) throw new Error(`Activity ${key} mixes kinds without an umbrella noun`)
  const count = present.reduce((sum, part) => sum + part.count, 0)
  return [{ key, label: `${count} ${count === 1 ? noun.one : noun.many}`, count, active }]
}

const activityOf = (runtime: AgentsWorkspaceRuntime): WorkspaceActivityItem[] => {
  const agents = runtime.team.listAgents()
  const rooms = runtime.rooms.listAllRooms().map(profile => {
    const room = runtime.rooms.getRoom(profile.id)
    if (!room) throw new Error(`Listed Room is missing: ${profile.id}`)
    return room
  })
  // A run whose Room was just deleted is being stopped (workspace-runtime.ts
  // roomDeleted → scriptRunner.stop) and counts as running until it ends.
  const scripts = runtime.scriptRunner.listRuns().filter(run => !run.ended)
  const pausedScripts = scripts.filter(run => runtime.rooms.getRoom(run.roomId)?.paused === true).length
  const summarising = rooms.reduce((sum, room) => sum
    + Number(runtime.summaryScheduler.isRunning(room.profile.id, 'summary'))
    + Number(runtime.summaryScheduler.isRunning(room.profile.id, 'compression')), 0)
  const timedSummaries = rooms.reduce((sum, room) => sum
    + [room.summaryConfig.summary, room.summaryConfig.compression].filter(config => config.enabled && config.schedule.kind === 'time').length, 0)
  const triggers = agents.reduce((sum, agent) => sum + (agent.getTriggers?.().filter(trigger => trigger.enabled).length ?? 0), 0)
  return [
    ...fact('agents-answering', true, [
      { count: agents.filter(agent => asAIAgent(agent)?.state.get() === 'generating').length, one: 'AI agent answering', many: 'AI agents answering' },
    ]),
    ...fact('comparisons-running', true, [
      { count: runtime.comparisons.running(), one: 'model comparison running', many: 'model comparisons running' },
    ]),
    ...fact('background-running', true, [
      { count: scripts.length - pausedScripts, one: 'script running', many: 'scripts running' },
      { count: summarising, one: 'room summary being written', many: 'room summaries being written' },
    ], { one: 'background job running', many: 'background jobs running' }),
    ...fact('jobs-waiting', false, [
      { count: triggers, one: 'recurring trigger', many: 'recurring triggers' },
      { count: timedSummaries, one: 'timed room summary', many: 'timed room summaries' },
      { count: pausedScripts, one: 'paused script', many: 'paused scripts' },
    ], { one: 'job waiting to run', many: 'jobs waiting to run' }),
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
