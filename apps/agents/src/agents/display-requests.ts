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
  /** The operations a Room's Scope reaches that publish a display an Agent can present
   * (workspace-capability-tools createViewPublisherLookup); absent without a Workspace Host. */
  readonly viewPublishers: ((roomId: string) => Promise<ReadonlyArray<string>>) | undefined
}

type TurnRefusal = Extract<RequestedTurnResult, { kind: 'refused' }>['reason']

const TURN_REFUSAL_CODE: Readonly<Record<TurnRefusal, DisplayRequestRefusalCode>> = {
  pending: 'request_pending',
  script: 'script_running',
}

// How to compose a display stays in the Agent's Skills and the owning Module;
// the instruction only hands over the answer. An answer
// built on tool evidence points the author back at it, so the display shows
// the same Run and signals instead of a fresh search.
export const displayRequestInstruction = (input: { readonly requesterName: string; readonly answer: Message }): string => {
  const { requesterName, answer } = input
  const evidence = answer.toolTrace !== undefined && answer.toolTrace.length > 0
    ? `, reusing the Run, object and signal identifiers from that answer's evidence (conversation_read messageId="${answer.id}") rather than searching again`
    : ''
  return [
    `[Display request] ${requesterName} asked you to show your answer below (messageId "${answer.id}") as a live display. `
      + 'This request replaces your own judgement of whether a display is needed. '
      + `Compose the display that best supports this answer, as your skills describe${evidence}. `
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

const NO_PUBLISHER = 'Nothing in this Room\'s Scope publishes a live display'

// Every gate that reads the Room, the answer and the Agents, in order; throws
// the first refusal. `roomId` may be the Room's id or name, as in the other
// Room routes.
const admit = (deps: DisplayRequestDeps, roomId: string, messageId: string, requesterId: string) => {
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
  // the author gate below refuses it as agent_unavailable. A line the Agent
  // posted while its turn ran is not its answer.
  const author = deps.team.getAgent(answer.senderId)
  if (answer.progress === true) {
    throw displayRequestRefusal('not_an_answer', 'This is a progress line of a turn, not its answer; ask on the answer that follows it')
  }
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
  return { room, answer, requester, ai, requestTurn: ai.requestTurn }
}

/** Whether a Room's Scope reaches an operation that publishes a display; refuses where none does. */
const requirePublisher = async (deps: DisplayRequestDeps, roomId: string): Promise<void> => {
  if (deps.viewPublishers === undefined) throw displayRequestRefusal('no_display_publisher', `${NO_PUBLISHER}: this Agents runtime has no Workspace Host`)
  if ((await deps.viewPublishers(roomId)).length === 0) throw displayRequestRefusal('no_display_publisher', NO_PUBLISHER)
}

// Throws DisplayRequestRefusal naming the first gate that refuses. Whether the
// Room's Scope reaches a display publisher is asked of the Workspace Host
// last; the Room's gates run again after it, as they may have changed
// meanwhile. The requested turn always runs in the Room's id.
export const requestDisplay = async (
  deps: DisplayRequestDeps,
  roomId: string,
  messageId: string,
  requesterId: string,
): Promise<DisplayRequestAccepted> => {
  await requirePublisher(deps, admit(deps, roomId, messageId, requesterId).room.profile.id)
  const { room, answer, requester, ai, requestTurn } = admit(deps, roomId, messageId, requesterId)

  // A manual Room delivers nothing to the author, so it catches up on the
  // Room first, as manual activation does.
  if (room.deliveryMode === 'manual') {
    if (!ai.ingestHistory) throw displayRequestRefusal('agent_unavailable', `${ai.name} cannot catch up on a manual Room`)
    ai.ingestHistory(room.profile.id, room.getRecent((ai.getHistoryLimit() ?? DEFAULTS.historyLimit) * 2))
  }
  const result = requestTurn(room.profile.id, {
    instruction: displayRequestInstruction({ requesterName: requester.name, answer }),
    inReplyTo: [messageId],
    cause: { kind: DISPLAY_REQUEST_CAUSE, name: requester.name },
    requireView: true,
  })
  if (result.kind === 'refused') throw displayRequestRefusal(TURN_REFUSAL_CODE[result.reason], result.message)
  return { queued: result.queued }
}

/**
 * Whether answers of an AI Agent in a Room may offer "Show display": the Agent
 * is an AI member and the Room's Scope reaches an operation that publishes a
 * display. The per-answer gates are the UI's to apply (offersDisplayRequest).
 */
export const displayRequestOffered = async (deps: DisplayRequestDeps, roomId: string, agentId: string): Promise<boolean> => {
  const room = deps.rooms.getRoom(roomId)
  const agent = deps.team.getAgent(agentId)
  if (!room || agent?.kind !== 'ai' || !room.hasMember(agentId) || deps.viewPublishers === undefined) return false
  return (await deps.viewPublishers(room.profile.id)).length > 0
}
