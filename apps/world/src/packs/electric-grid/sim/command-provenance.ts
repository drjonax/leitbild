import type { ActorId, DataSource } from '../../../core/model/index.ts'

// The Host derives command actor ids from the access context as `actor:<kind>:<id>`
// (core/api/simulation-run-routes.ts: actorIdForAccessContext), and the Scenario timeline
// issues its cues as `actor:scenario-timeline` (core/simulation-runs/runtime.ts).
const scenarioTimelineActorId = 'actor:scenario-timeline'

/** Provenance source for the Grid changes a command causes, from the actor that issued it. */
export const commandProvenanceSource = (actorId: ActorId): Extract<DataSource, 'ai' | 'system' | 'operator'> => {
  if (actorId.startsWith('actor:ai:')) return 'ai'
  if (actorId.startsWith('actor:system:') || actorId === scenarioTimelineActorId) return 'system'
  return 'operator'
}
