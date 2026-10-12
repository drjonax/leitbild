import { audienceVisibleTo, type ObjectAudience, type ObjectId, type RoleSees, type SimulationRunEvent } from '../model/index.ts'

/**
 * Which views of a Run that declares sides an event reaches. Truth views
 * receive every event; a side view receives an object's events by the
 * object's audience, the shared clock, resets and guidance (which names only
 * public objects), and nothing else. The switch is exhaustive, so a new event
 * type does not compile until it is classified here.
 */
export type EventReach =
  | { readonly kind: 'public' }
  | { readonly kind: 'truth' }
  | { readonly kind: 'audience'; readonly audience: ObjectAudience }

const publicReach: EventReach = { kind: 'public' }
const truthReach: EventReach = { kind: 'truth' }

/** An object event reaches its object's audience; without one, truth views only. */
const audienceReach = (audience: ObjectAudience | undefined): EventReach =>
  audience === undefined ? truthReach : { kind: 'audience', audience }

export const eventReach = (
  event: SimulationRunEvent,
  audienceOf: (objectId: ObjectId) => ObjectAudience | undefined,
): EventReach => {
  switch (event.type) {
    case 'object.upserted':
      return audienceReach(event.object.audience)
    case 'object.deleted':
      // Written at commit in a sided Run; an event without it is truth-only.
      return audienceReach(event.audience)
    case 'telemetry.sampled':
      return audienceReach(audienceOf(event.objectId))
    case 'clock.updated':
    case 'simulationRun.reset':
    case 'scenario.guidance.shown':
    case 'scenario.guidance.hidden':
      return publicReach
    case 'command.issued':
    case 'command.result':
    case 'interaction.signal.received':
    case 'notification.emitted':
    case 'scenario.cue.started':
    case 'scenario.objects.highlighted':
    case 'scenario.highlights.cleared':
    case 'scenario.agent-restrictions.set':
    case 'procedure.run.started':
    case 'procedure.step.updated':
    case 'procedure.run.closed':
    case 'procedure.run.resumed':
    case 'procedure.branch.selected':
    case 'procedure.observation.updated':
    case 'procedure.run.reset':
      return truthReach
    default: {
      const unclassified: never = event
      throw new Error(`Unclassified Simulation Run event: ${(unclassified as { readonly type: string }).type}`)
    }
  }
}

export const eventVisibleTo = (
  event: SimulationRunEvent,
  sees: RoleSees,
  audienceOf: (objectId: ObjectId) => ObjectAudience | undefined,
): boolean => {
  if (sees === 'all') return true
  const reach = eventReach(event, audienceOf)
  return reach.kind === 'public' || (reach.kind === 'audience' && audienceVisibleTo(reach.audience, sees))
}
