// Display requests, server side (the shared contract is core/display-request.ts).
// Checks that a reader may ask the author of an answer for a live display,
// then asks that author for one ordinary turn ending with a transient
// instruction that carries the answer. The gates run in a fixed order and
// each refuses with its own code, so the reader learns which rule refused.
import type { RoomDirectory } from '../core/rooms/directory.ts'
import type { RequestedTurnResult, Team } from '../core/types/agent.ts'
import type { Message } from '../core/types/messaging.ts'
import {
  DISPLAY_REQUEST_CAUSE,
  DISPLAY_SKILL,
  displayRequestRefusal,
  showsView,
  type DisplayRequestAccepted,
  type DisplayRequestRefusalCode,
} from '../core/display-request.ts'
import { VIEW_FENCE_LANGUAGE } from '../core/render-validators/view-fence.ts'
import { asAIAgent } from './shared.ts'
import { DEFAULTS } from '../core/types/constants.ts'

export interface DisplayRequestDeps {
  readonly rooms: Pick<RoomDirectory, 'getRoom'>
  readonly team: Pick<Team, 'getAgent'>
  readonly isScriptRunning: (roomId: string) => boolean
}

type TurnRefusal = Extract<RequestedTurnResult, { kind: 'refused' }>['reason']

const TURN_REFUSAL_CODE: Readonly<Record<TurnRefusal, DisplayRequestRefusalCode>> = {
  pending: 'request_pending',
  script: 'script_running',
}

// How to compose a display stays in the display Skill and the owning Module;
// the instruction only names the Skill and hands over the answer. An answer
// built on tool evidence points the author back at it, so the display shows
// the same Run and signals instead of a fresh search.
export const displayRequestInstruction = (input: { readonly requesterName: string; readonly answer: Message }): string => {
  const { requesterName, answer } = input
  const evidence = answer.toolTrace !== undefined && answer.toolTrace.length > 0
    ? `, reusing the Run, plant and signal identifiers from that answer's evidence (conversation_read messageId="${answer.id}") rather than searching again`
    : ''
  return [
    `[Display request] ${requesterName} asked you to show your answer below (messageId "${answer.id}") as a live display. `
      + 'This request replaces your own judgement of whether a display is needed. '
      + `Compose the display that best supports this answer as the ${DISPLAY_SKILL} skill describes${evidence}. `
      + 'Do not repeat the answer: write one or two sentences on what the display shows and what to watch, '
      + `then end with the ${VIEW_FENCE_LANGUAGE} block. `
      + 'If the answer concerns nothing a display can show, or two compositions are rejected, say why in one sentence instead.',
    '',
    'Your answer:',
    '<answer>',
    answer.content,
    '</answer>',
  ].join('\n')
}

// Throws DisplayRequestRefusal naming the first gate that refuses. `roomId`
// may be the Room's id or name, as in the other Room routes; the requested
// turn always runs in the Room's id.
export const requestDisplay = (
  deps: DisplayRequestDeps,
  roomId: string,
  messageId: string,
  requesterId: string,
): DisplayRequestAccepted => {
  const room = deps.rooms.getRoom(roomId)
  if (!room) throw displayRequestRefusal('room_not_found', `Room "${roomId}" not found`)
  const retained = room.getRetainedMessages()
  const answer = retained.find(message => message.id === messageId)
  if (!answer) throw displayRequestRefusal('message_not_found', `Message "${messageId}" not found`)

  // Membership is held by id, so a requester name never passes here.
  const requester = deps.team.getAgent(requesterId)
  if (requester?.kind !== 'human' || !room.hasMember(requesterId)) {
    throw displayRequestRefusal('requester_invalid', 'Only a person in this Room can ask for a display')
  }

  // An answer is an AI Agent's generated chat reply. An author removed from
  // the Team leaves the message an answer that nobody can fulfil any more;
  // the author gate below refuses it as agent_unavailable.
  const author = deps.team.getAgent(answer.senderId)
  if (answer.type !== 'chat' || answer.generationTraceId === undefined || (author !== undefined && author.kind !== 'ai')) {
    throw displayRequestRefusal('not_an_answer', 'Only an Agent\'s answer can be shown as a display')
  }
  if (answer.cause?.kind === DISPLAY_REQUEST_CAUSE) {
    throw displayRequestRefusal('not_an_answer', 'This message replies to a display request; ask on the original answer')
  }
  if (showsView(answer.content)) {
    throw displayRequestRefusal('answer_shows_display', 'This answer already shows a live display')
  }
  const shown = retained.some(message =>
    message.cause?.kind === DISPLAY_REQUEST_CAUSE && message.inReplyTo?.[0] === messageId && showsView(message.content))
  if (shown) throw displayRequestRefusal('display_already_shown', 'A live display of this answer is already shown')

  const ai = author === undefined ? undefined : asAIAgent(author)
  if (!ai) throw displayRequestRefusal('agent_unavailable', 'The Agent that wrote this answer no longer exists')
  if (!room.hasMember(ai.id)) throw displayRequestRefusal('agent_unavailable', `${ai.name} is no longer in this Room`)
  if (room.isMuted(ai.id)) throw displayRequestRefusal('agent_unavailable', `${ai.name} is muted in this Room`)
  if (!ai.requestTurn) throw displayRequestRefusal('agent_unavailable', `${ai.name} cannot take requested turns`)
  // A paused Room stores messages but runs no Agent; a request would bypass that.
  if (room.paused) throw displayRequestRefusal('room_paused', 'This Room is paused; resume it to ask for a display')
  // A script directs every turn in its Room, whether or not the author is in its cast.
  if (deps.isScriptRunning(room.profile.id)) throw displayRequestRefusal('script_running', 'A script directs this Room; ask again when it ends')
  if (!ai.getSkills().includes(DISPLAY_SKILL)) {
    throw displayRequestRefusal('display_skill_missing', `${ai.name} does not have the ${DISPLAY_SKILL} Skill`)
  }

  // A manual Room delivers nothing to the author, so it catches up on the
  // Room first, as manual activation does.
  if (room.deliveryMode === 'manual') {
    if (!ai.ingestHistory) throw displayRequestRefusal('agent_unavailable', `${ai.name} cannot catch up on a manual Room`)
    ai.ingestHistory(room.profile.id, room.getRecent((ai.getHistoryLimit() ?? DEFAULTS.historyLimit) * 2))
  }
  const result = ai.requestTurn(room.profile.id, {
    instruction: displayRequestInstruction({ requesterName: requester.name, answer }),
    inReplyTo: [messageId],
    cause: { kind: DISPLAY_REQUEST_CAUSE, name: requester.name },
    requireView: true,
  })
  if (result.kind === 'refused') throw displayRequestRefusal(TURN_REFUSAL_CODE[result.reason], result.message)
  return { queued: result.queued }
}
