// Which human the reader acts as in a Room. Chat send and display requests
// resolve it the same way: the human the reader chose for the Room, else the
// Room's only human member. With no human or several and none chosen, the
// reader has to choose.

import { $agents, $roomMembers, $selectedHumanByRoom } from './stores.ts'

export type RoomPoster =
  | { readonly kind: 'chosen'; readonly humanId: string }
  | { readonly kind: 'only-human'; readonly humanId: string }
  | { readonly kind: 'undecided' }

export const resolveRoomPoster = (
  roomId: string,
  chosen: Readonly<Record<string, string>>,
  agents: Readonly<Record<string, { readonly id: string; readonly kind: string }>>,
  memberIds: ReadonlyArray<string>,
): RoomPoster => {
  const choice = chosen[roomId]
  if (choice) return { kind: 'chosen', humanId: choice }
  const members = new Set(memberIds)
  const humans = Object.values(agents).filter(agent => agent.kind === 'human' && members.has(agent.id))
  return humans.length === 1 ? { kind: 'only-human', humanId: humans[0]!.id } : { kind: 'undecided' }
}

/** The posting human's id, or undefined when the reader must choose. Remembers
 *  an only-human resolution as the Room's choice. */
export const posterForRoom = (roomId: string): string | undefined => {
  // Membership not fetched yet means no only-human: the reader chooses.
  const poster = resolveRoomPoster(roomId, $selectedHumanByRoom.get(), $agents.get(), $roomMembers.get()[roomId] ?? [])
  if (poster.kind === 'undecided') return undefined
  if (poster.kind === 'only-human') $selectedHumanByRoom.setKey(roomId, poster.humanId)
  return poster.humanId
}
