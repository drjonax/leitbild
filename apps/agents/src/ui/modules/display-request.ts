// Display requests in the chat. Under an AI answer without a live display the
// reader can ask the answer's Agent to show it as one. The Agent replies later
// with a new message — a display resolves only in the message whose own turn
// composed it — whose cause names the requester and whose inReplyTo starts
// with the answer. Contract: core/display-request.ts.
//
// A Room re-render replaces every card, so what must outlive a card (a request
// in flight or awaiting its reply) is kept by answer id. Everything else is
// rebuilt as cards render: replies render after their answers, so a reply
// updates its answer's row whenever it renders, live or re-rendered.

import { apiFetch } from './api-client.ts'
import { icon } from './icon.ts'
import { showToast } from './toast.ts'
import { posterForRoom } from './room-poster.ts'
import { $agents, $roomMessages } from './stores.ts'
import type { UIMessage } from './render/render-types.ts'
import {
  DISPLAY_REQUEST_CAUSE,
  DISPLAY_SKILL,
  displayRequestPath,
  showsView,
  type DisplayRequestAccepted,
  type DisplayRequestBody,
  type DisplayRequestRefused,
} from '../../core/display-request.ts'

/** Whether a message may offer the request. Whether its author holds the
 *  display Skill is asked separately, from the server. */
export const offersDisplayRequest = (message: UIMessage, sender: { readonly kind: string } | undefined): boolean =>
  message.type === 'chat'
  && message.roomId !== undefined
  && message.generationTraceId !== undefined
  && sender?.kind === 'ai'
  && message.cause?.kind !== DISPLAY_REQUEST_CAUSE
  && !showsView(message.content)

export const isDisplayReply = (message: UIMessage): boolean => message.cause?.kind === DISPLAY_REQUEST_CAUSE

const repliesTo = (message: UIMessage, answerId: string): boolean =>
  isDisplayReply(message) && message.inReplyTo?.[0] === answerId

// 24-hour HH:MM:SS, as in the message header.
const clockTime = (timestamp: number): string => new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false })

/** Caption of a display-request reply. `answerAt` is the answer's time while the answer is shown. */
export const displayReplyCaption = (requester: string, answerAt: number | undefined): string =>
  `Display requested by ${requester} for ${answerAt === undefined ? 'an earlier answer' : `the answer at ${clockTime(answerAt)}`}`

/** What the reader is told about a request the server did not accept. A
 *  refusal names its rule; anything else is unexpected and reported by status. */
export const refusalMessage = (status: number, body: string): { readonly text: string; readonly expected: boolean } => {
  try {
    const refusal = JSON.parse(body) as Partial<DisplayRequestRefused> | null
    if (typeof refusal?.error === 'string' && refusal.error.length > 0) return { text: refusal.error, expected: true }
  } catch { /* not JSON: unexpected, reported by status below */ }
  return { text: `Display request failed (HTTP ${status})`, expected: false }
}

const toastError = (text: string): void => showToast(document.body, text, { type: 'error', position: 'fixed' })

// One lookup per Agent for the page session. A failed lookup is logged and
// forgotten: the action stays hidden and the next render asks again.
const skillLookups = new Map<string, Promise<boolean>>()
const holdsDisplaySkill = (agentId: string): Promise<boolean> => {
  const known = skillLookups.get(agentId)
  if (known) return known
  const lookup = (async () => {
    const response = await apiFetch(`/agents/${encodeURIComponent(agentId)}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const detail = await response.json() as { readonly skills?: unknown }
    if (!Array.isArray(detail.skills)) throw new Error('the Agent detail lists no Skills')
    return detail.skills.includes(DISPLAY_SKILL)
  })().catch((error: unknown) => {
    skillLookups.delete(agentId)
    console.error(`Display request: cannot tell whether Agent ${agentId} holds the ${DISPLAY_SKILL} Skill; its answers offer no display request.`, error)
    return false
  })
  skillLookups.set(agentId, lookup)
  return lookup
}

// --- Request state, by answer id ---

const requesting = new Set<string>()

interface PendingRequest {
  readonly queued: boolean
  // Messages the Room held when the reader asked: a reply among them answered an earlier request.
  readonly earlier: ReadonlySet<string>
  readonly stop: () => void
}
const pending = new Map<string, PendingRequest>()

// --- Action rows ---

interface Row {
  readonly answer: UIMessage
  readonly agentName: string
  holdsSkill?: boolean   // unknown until the lookup resolves
  displayReply?: string  // id of a rendered reply that shows the display
}
const rows = new WeakMap<HTMLElement, Row>()

const findCard = (root: ParentNode, messageId: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`)
const findRow = (root: ParentNode, answerId: string): { readonly host: HTMLElement; readonly row: Row } | undefined => {
  const host = root.querySelector<HTMLElement>(`[data-display-request="${CSS.escape(answerId)}"]`)
  const row = host ? rows.get(host) : undefined
  return host && row ? { host, row } : undefined
}

const reveal = (card: HTMLElement): void => {
  card.scrollIntoView({ behavior: 'smooth', block: 'start' })
  card.classList.add('ring-2', 'ring-accent')
  setTimeout(() => card.classList.remove('ring-2', 'ring-accent'), 1500)
}

const revealMessage = (root: ParentNode, messageId: string, missing: string): void => {
  const card = findCard(root, messageId)
  if (card) reveal(card)
  else toastError(missing)
}

const rowButton = (label: string, glyph: SVGSVGElement, title: string): HTMLButtonElement => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'icon-btn gap-1 text-xs text-text-subtle enabled:hover:text-accent'
  button.title = title
  button.append(glyph, label)
  return button
}

// A display shown below wins over a request in progress, which wins over the offer.
const paint = (host: HTMLElement, row: Row): void => {
  const { answer, agentName, displayReply } = row
  const request = pending.get(answer.id)
  host.replaceChildren()
  if (displayReply !== undefined) {
    const below = rowButton('Display below ↓', icon('chart-line', { size: 13 }), `Scroll to the live display ${agentName} posted in reply`)
    below.onclick = () => revealMessage(document, displayReply, 'The reply with the display is no longer shown here.')
    host.appendChild(below)
  } else if (request) {
    const spinner = icon('refresh-cw', { size: 13 })
    spinner.classList.add('animate-spin')
    const status = rowButton('Preparing display…', spinner, request.queued
      ? `${agentName} finishes its current work, then composes the display and posts it as a reply.`
      : `${agentName} is composing the display and posts it as a reply.`)
    status.disabled = true
    host.appendChild(status)
  } else if (row.holdsSkill === true) {
    const offer = rowButton('Show display', icon('chart-line', { size: 13 }), `Show this answer as a live display. ${agentName} composes one and posts it as a reply.`)
    offer.disabled = requesting.has(answer.id)
    offer.onclick = () => { void requestDisplay(answer) }
    host.appendChild(offer)
  }
  host.hidden = host.childElementCount === 0
}

// An answer whose card is not shown (another Room, or trimmed from the list)
// has nothing to repaint; its next render paints from the same state.
const repaint = (answerId: string): void => {
  const found = findRow(document, answerId)
  if (found) paint(found.host, found.row)
}

/** The action row under an eligible answer. It stays empty until the author is
 *  known to hold the display Skill, so the offer never flashes and vanishes. */
export const displayRequestRow = (answer: UIMessage, agentName: string): HTMLElement => {
  const host = document.createElement('div')
  host.className = 'flex items-center mt-1'
  host.dataset.displayRequest = answer.id
  const row: Row = { answer, agentName }
  rows.set(host, row)
  paint(host, row)
  void holdsDisplaySkill(answer.senderId).then(holds => {
    row.holdsSkill = holds
    paint(host, row)
  })
  return host
}

// --- Request lifecycle ---

const settle = (answerId: string): boolean => {
  const request = pending.get(answerId)
  if (!request) return false
  request.stop()
  pending.delete(answerId)
  repaint(answerId)
  return true
}

// A queued request lets the Agent finish other work first, so the reply is
// given up on only after the Agent has been idle this long without one.
const NO_REPLY_AFTER_IDLE_MS = 5_000

const awaitReply = (answer: UIMessage, queued: boolean, earlier: ReadonlySet<string>): void => {
  const roomId = answer.roomId!
  const replied = (messages: ReadonlyArray<UIMessage> | undefined): boolean =>
    messages !== undefined && messages.some(message => repliesTo(message, answer.id) && !earlier.has(message.id))
  // The store, not the render, settles the request: a reply to a Room the
  // reader is not viewing arrives without rendering.
  const stopMessages = $roomMessages.listen(rooms => { if (replied(rooms[roomId])) settle(answer.id) })
  let silence: ReturnType<typeof setTimeout> | undefined
  const stopAgents = $agents.subscribe(agents => {
    // An Agent missing from the Workspace counts as idle: it cannot reply.
    if (agents[answer.senderId]?.state === 'generating') {
      clearTimeout(silence)
      silence = undefined
    } else if (silence === undefined) {
      silence = setTimeout(() => {
        if (settle(answer.id)) toastError('No display arrived; the request may have been cancelled.')
      }, NO_REPLY_AFTER_IDLE_MS)
    }
  })
  pending.set(answer.id, { queued, earlier, stop: () => { clearTimeout(silence); stopMessages(); stopAgents() } })
  if (replied($roomMessages.get()[roomId])) settle(answer.id)
}

const requestDisplay = async (answer: UIMessage): Promise<void> => {
  const roomId = answer.roomId!
  const requesterId = posterForRoom(roomId)
  if (requesterId === undefined) {
    toastError('Choose who you post as in this room first (click a human\'s dot among the room members), then ask again.')
    return
  }
  // A Room whose messages were cleared since holds no earlier replies.
  const earlier = new Set(($roomMessages.get()[roomId] ?? []).map(message => message.id))
  requesting.add(answer.id)
  repaint(answer.id)
  try {
    const body: DisplayRequestBody = { requesterId }
    const response = await apiFetch(displayRequestPath(roomId, answer.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.status === 202) {
      const accepted = await response.json() as DisplayRequestAccepted
      awaitReply(answer, accepted.queued, earlier)
      return
    }
    const text = await response.text()
    const refusal = refusalMessage(response.status, text)
    if (!refusal.expected) console.error(`Display request for message ${answer.id} failed with HTTP ${response.status}`, text)
    toastError(refusal.text)
  } catch (error) {
    console.error(`Display request for message ${answer.id} failed`, error)
    toastError(`Display request failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    requesting.delete(answer.id)
    repaint(answer.id)
  }
}

// --- Replies ---

/** Caption of a display-request reply, linking to its answer while that is shown. */
export const displayReplyCaptionElement = (container: HTMLElement, reply: UIMessage): HTMLElement => {
  const answerId = reply.inReplyTo?.[0]
  if (answerId === undefined) console.error(`Display-request reply ${reply.id} does not name its answer`)
  const answer = answerId === undefined || reply.roomId === undefined
    ? undefined
    : $roomMessages.get()[reply.roomId]?.find(message => message.id === answerId)
  const shown = answer !== undefined && findCard(container, answer.id) !== null
  const text = displayReplyCaption(reply.cause!.name, shown ? answer.timestamp : undefined)
  const caption = document.createElement('div')
  caption.className = 'text-[10px] text-text-subtle mt-0.5'
  caption.textContent = text
  caption.title = text
  if (shown) {
    const link = document.createElement('button')
    link.type = 'button'
    link.className = 'ml-1 text-accent hover:underline'
    link.textContent = '↑ answer'
    link.title = 'Scroll to the answer'
    link.onclick = () => revealMessage(container, answer.id, 'The answer is no longer shown here.')
    caption.appendChild(link)
  }
  return caption
}

/** Applies a rendered display-request reply to its answer: settles the
 *  request, then points the answer's row at the display, or — when the reply
 *  shows none because the Agent explained why — offers the request again. */
export const applyDisplayReply = (container: HTMLElement, reply: UIMessage): void => {
  const answerId = reply.inReplyTo?.[0]
  // The caption reports a reply without an answer.
  if (answerId === undefined) return
  const request = pending.get(answerId)
  if (request && !request.earlier.has(reply.id)) settle(answerId)
  // The answer may be trimmed from the list, or rendered without a row
  // because its author is no longer a known AI Agent.
  const found = findRow(container, answerId)
  if (!found) return
  if (showsView(reply.content)) found.row.displayReply = reply.id
  paint(found.host, found.row)
}
