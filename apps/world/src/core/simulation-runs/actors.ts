import { z } from 'zod'
import type { ActorId, CommandEnvelope } from '../model/index.ts'

export const actorRoleSchema = z.enum(['operator', 'supervisor', 'observer', 'controller', 'ai_agent', 'system'])
export type ActorRole = z.infer<typeof actorRoleSchema>

export interface Actor {
  readonly id: ActorId
  readonly label: string
  /** In a role Run, controller when any held role is controller-class, else operator. */
  readonly role: ActorRole
  /** The Scenario roles this actor holds; present only in a Run that declares roles. */
  readonly roleIds?: ReadonlyArray<string>
}

export const canIssueCommand = (actor: Actor, command: CommandEnvelope): boolean => {
  if (command.kind.startsWith('scenario.')) {
    return actor.role === 'controller' || actor.role === 'system'
  }
  return actor.role === 'operator' || actor.role === 'supervisor' || actor.role === 'controller' || actor.role === 'ai_agent' || actor.role === 'system'
}
