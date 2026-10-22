// The proposal card under an AI answer whose turn proposed a plant operation
// (plan C1 §4.4): the action, its target, who proposed it and World's live
// status, read again while a person has yet to decide. "Review in display"
// opens the default display of the proposal's element in the window (Q23),
// where the element's pop-over carries the pending proposal with its approve
// and decline; there is no Approve here. Neutral and
// accent colours only: a proposal is not a process alarm.
import { apiFetch } from '../api-client.ts'
import { openSubjectDefault } from '../live-view/open.ts'
import type { UIMessage } from '../render/render-types.ts'
import type { ProposalCard } from '../../../agents/proposal-cards.ts'
import { proposalCardView, proposedInTurn, type ProposalCardView, type ProposalTone } from './model.ts'

// Often enough to follow a person's decision and a valve's stroke, seldom
// enough that a long room of answers costs little.
const POLL_MS = 3_000

const TONE_CLASS: Readonly<Record<ProposalTone, string>> = {
  pending: 'text-accent',
  executed: 'text-text-strong',
  closed: 'text-text-muted',
  refused: 'text-text-muted',
  unknown: 'text-text-subtle',
}

const line = (className: string, text: string): HTMLElement => {
  const element = document.createElement('div')
  element.className = className
  element.textContent = text
  return element
}

const cardElement = (view: ProposalCardView): HTMLElement => {
  const card = document.createElement('div')
  card.className = 'flex flex-col gap-0.5 w-full max-w-[520px] px-3 py-2 rounded-md border border-border bg-surface'
  card.dataset.proposalTone = view.tone
  card.append(
    line('text-[10.5px] font-semibold tracking-wide text-text-subtle', 'PROPOSAL'),
    line('text-[13px] font-semibold text-text-strong break-words', `${view.action}${view.item === undefined ? '' : ` · ${view.item}`}`),
    line('text-[11.5px] text-text-subtle', `Proposed by ${view.proposer}`),
    line(`text-[12px] break-words ${TONE_CLASS[view.tone]}`, view.status),
  )
  if (view.review !== undefined) card.append(line('text-[11.5px] text-text-muted break-words', view.review))
  const reviewAt = view.reviewAt
  if (view.tone === 'pending' && reviewAt !== undefined) {
    const review = document.createElement('button')
    review.type = 'button'
    review.className = 'self-start mt-1 inline-flex items-center min-h-[32px] px-3 rounded-md border border-border bg-surface text-xs font-medium text-text-muted interactive cursor-pointer hover:bg-surface-strong hover:border-accent hover:text-accent'
    review.textContent = 'Review in display ›'
    review.onclick = () => {
      if (openSubjectDefault(reviewAt.resource, reviewAt.subject, reviewAt.title)) return
      review.replaceWith(line('text-[11.5px] text-text-subtle', 'No display window here: open the Workspace display window at the equipment.'))
    }
    card.append(review)
  }
  return card
}

const fetchCards = async (roomId: string, turnId: string): Promise<ReadonlyArray<ProposalCard>> => {
  const response = await apiFetch(`/rooms/${encodeURIComponent(roomId)}/executions/${encodeURIComponent(turnId)}/proposals`)
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { readonly error?: unknown } | undefined
    throw new Error(typeof body?.error === 'string' ? body.error : `reading the proposal status failed with HTTP ${response.status}`)
  }
  return (await response.json() as { readonly cards: ReadonlyArray<ProposalCard> }).cards
}

/**
 * Mounts the cards of an answer whose turn proposed, below its content, and
 * reads their status again every few seconds while one is pending and the
 * answer is on screen. A failed read shows why in place of the status.
 */
export const mountProposalCards = (messageDiv: HTMLElement, msg: UIMessage): void => {
  if (!proposedInTurn(msg)) return
  const host = document.createElement('div')
  host.className = 'flex flex-col gap-1.5 mt-2'
  host.dataset.proposalCards = msg.generationTraceId!
  messageDiv.appendChild(host)
  const proposerName = msg.senderName ?? msg.senderId
  const refresh = async (): Promise<void> => {
    if (!host.isConnected && host.childElementCount > 0) return
    let views: ReadonlyArray<ProposalCardView>
    try {
      views = (await fetchCards(msg.roomId!, msg.generationTraceId!)).map(card => proposalCardView(card, proposerName))
    } catch (error) {
      host.replaceChildren(line('text-[11.5px] text-text-subtle', `Proposal status unavailable: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    host.replaceChildren(...views.map(cardElement))
    // A re-rendered answer mounts its own cards; this one stops once it leaves the page or nothing awaits a person.
    if (host.isConnected && views.some(view => view.live)) setTimeout(() => { void refresh() }, POLL_MS)
  }
  void refresh()
}
