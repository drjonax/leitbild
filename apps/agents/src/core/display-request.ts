// Display requests. A reader asks the Agent that wrote an answer without a
// live display to show that answer as one. The request is fulfilled by an
// ordinary turn of the same Agent — same Skills, tools, evaluation loop and
// ```leitbild-view guard as any answer — with one transient instruction that
// carries the answer. How a display is composed stays in the display Skill and
// the owning Module, so both paths change together. The reply is posted as a
// new message (a view resolves only against the turn that composed it) whose
// cause names the requester and whose inReplyTo starts with the answer.
//
// Browser-safe: shared by the HTTP route and the UI.
import { extractFences } from '../agents/fence-extract.ts'
import { VIEW_FENCE_LANGUAGE } from './render-validators/view-fence.ts'

/** MessageCause kind stamped on the reply a display request produces. */
export const DISPLAY_REQUEST_CAUSE = 'display-request'

/** The Skill that teaches an Agent to compose displays; only its holders are asked. */
export const DISPLAY_SKILL = 'operator-displays'

/** True when the content presents a live view. */
export const showsView = (content: string): boolean => extractFences(content, [VIEW_FENCE_LANGUAGE]).length > 0

/** Route of the request, relative to the Agents API base (as apiFetch takes it). */
export const displayRequestPath = (roomId: string, messageId: string): string =>
  `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/display-request`

export interface DisplayRequestBody {
  // The human Agent (Room member) on whose behalf the reader asks.
  readonly requesterId: string
}

/** 202 response. `queued` is true when the Agent was busy and will run the request next. */
export interface DisplayRequestAccepted {
  readonly queued: boolean
}

// Every refusal names its own rule so the reader learns which gate refused.
export type DisplayRequestRefusalCode =
  | 'room_not_found'
  | 'message_not_found'
  | 'requester_invalid'
  | 'not_an_answer'
  | 'answer_shows_display'
  | 'display_already_shown'
  | 'agent_unavailable'
  | 'room_paused'
  | 'display_skill_missing'
  | 'request_pending'
  | 'script_running'

export const DISPLAY_REQUEST_REFUSAL_STATUS: Readonly<Record<DisplayRequestRefusalCode, number>> = {
  room_not_found: 404,
  message_not_found: 404,
  requester_invalid: 403,
  not_an_answer: 409,
  answer_shows_display: 409,
  display_already_shown: 409,
  agent_unavailable: 409,
  room_paused: 409,
  display_skill_missing: 409,
  request_pending: 409,
  script_running: 409,
}

/** Error response body of a refused request. */
export interface DisplayRequestRefused {
  readonly error: string
  readonly code: DisplayRequestRefusalCode
}

export type DisplayRequestRefusal = Error & { readonly code: DisplayRequestRefusalCode }

export const displayRequestRefusal = (code: DisplayRequestRefusalCode, message: string): DisplayRequestRefusal =>
  Object.assign(new Error(message), { code })

export const isDisplayRequestRefusal = (error: unknown): error is DisplayRequestRefusal => {
  if (!(error instanceof Error)) return false
  const code: unknown = (error as Error & { code?: unknown }).code
  return typeof code === 'string' && Object.hasOwn(DISPLAY_REQUEST_REFUSAL_STATUS, code)
}
