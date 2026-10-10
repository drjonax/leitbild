// Which process displays the posted answers of a room composed, derived from
// the room's message store (data, not the DOM), so the list the Host relays
// to the display window does not flap when the chat re-renders. Pure: no DOM,
// no stores, no network.
import type { EmbeddedViewEnvelope, EmbeddedViewListing } from '@leitbild/contracts'
import { EMBEDDED_VIEW_LISTING_MAX } from '@leitbild/contracts/embedded-view-route'
import { marked } from 'marked'
import { parseViewFenceBody, viewRefFor, VIEW_FENCE_LANGUAGE, type ViewReference } from '../../../core/render-validators/view-fence.ts'
import type { UIMessage } from '../render/render-types.ts'
import type { ViewResolution } from './resolve.ts'

/** A posted answer: the only message whose ```leitbild-view fences become displays. */
export interface PostedAnswer {
  readonly roomId: string
  readonly turnId: string
  /** How the display window names where a display comes from, e.g. "Answer 14:02:31". */
  readonly caption: string
}

export interface ViewFence {
  /** `${roomId}/${turnId}/${callId}/${encoded fence key}`: stable across re-renders and reloads. */
  readonly key: string
  readonly answer: PostedAnswer
  readonly ref: ViewReference
}

export type ViewFenceParse =
  | { readonly kind: 'fence'; readonly fence: ViewFence }
  | { readonly kind: 'invalid'; readonly error: string }

const twoDigits = (value: number): string => String(value).padStart(2, '0')

/** Local wall-clock time, 24 h, as the message header shows it. */
export const answerCaption = (timestamp: number): string => {
  const time = new Date(timestamp)
  return `Answer ${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}:${twoDigits(time.getSeconds())}`
}

// The same condition under which render-message.ts names a message's room and
// turn for its fences: a chat message generated in a turn of a room.
export const postedAnswerOf = (message: UIMessage): PostedAnswer | null =>
  message.type === 'chat' && message.generationTraceId && message.roomId
    ? { roomId: message.roomId, turnId: message.generationTraceId, caption: answerCaption(message.timestamp) }
    : null

export const findPostedAnswer = (messages: ReadonlyArray<UIMessage>, turnId: string): PostedAnswer | null => {
  for (const message of messages) {
    const answer = postedAnswerOf(message)
    if (answer !== null && answer.turnId === turnId) return answer
  }
  return null
}

export const viewFenceKey = (answer: PostedAnswer, ref: ViewReference): string =>
  `${answer.roomId}/${answer.turnId}/${viewRefFor(ref.callId, ref.key)}`

export const viewFenceOf = (answer: PostedAnswer, body: string): ViewFenceParse => {
  const parsed = parseViewFenceBody(body)
  if (parsed.kind === 'invalid') return { kind: 'invalid', error: parsed.error }
  return { kind: 'fence', fence: { key: viewFenceKey(answer, parsed.ref), answer, ref: parsed.ref } }
}

/**
 * Bodies of the ```leitbild-view fences in a Markdown text, in document order.
 * Uses the lexer of the renderer that turns the same text into the chat's
 * `code.language-leitbild-view` blocks, so the list and the chips see the same
 * fences (nested in lists and quotes, ``` or ~~~; never indented code).
 */
export const viewFenceBodies = (markdown: string): ReadonlyArray<string> => {
  if (!markdown.includes(VIEW_FENCE_LANGUAGE)) return []
  const bodies: string[] = []
  marked.walkTokens(marked.lexer(markdown), token => {
    if (token.type !== 'code' || token.codeBlockStyle === 'indented') return
    if (((token.lang as string | undefined) ?? '').match(/^\S*/)?.[0] === VIEW_FENCE_LANGUAGE) bodies.push(token.text)
  })
  return bodies
}

/**
 * The valid fences of a room's posted answers in store order, each key once
 * (an answer that shows the same display twice lists it once; both chips open
 * it). Invalid fences are left out: their chips say why they are not shown.
 */
export const roomViewFences = (messages: ReadonlyArray<UIMessage>): ReadonlyArray<ViewFence> => {
  const fences: ViewFence[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    const answer = postedAnswerOf(message)
    if (answer === null) continue
    for (const body of viewFenceBodies(message.content)) {
      const parsed = viewFenceOf(answer, body)
      if (parsed.kind === 'invalid' || seen.has(parsed.fence.key)) continue
      seen.add(parsed.fence.key)
      fences.push(parsed.fence)
    }
  }
  return fences
}

export const viewListingOf = (fence: ViewFence, envelope: EmbeddedViewEnvelope): EmbeddedViewListing =>
  ({ key: fence.key, envelope, caption: fence.answer.caption })

export interface ResolvedViewFence {
  readonly fence: ViewFence
  readonly resolution: ViewResolution
}

/** The listings the Host relays, oldest first: refused displays left out, the most recent EMBEDDED_VIEW_LISTING_MAX kept. */
export const viewListings = (resolved: ReadonlyArray<ResolvedViewFence>): ReadonlyArray<EmbeddedViewListing> =>
  resolved
    .flatMap(({ fence, resolution }) => resolution.kind === 'view' ? [viewListingOf(fence, resolution.envelope)] : [])
    .slice(-EMBEDDED_VIEW_LISTING_MAX)
