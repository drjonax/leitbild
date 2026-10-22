// What an answer's proposal card says, from where World says each proposal
// stands (agents/proposal-cards.ts): the action and its target, who proposed
// it, and its status in World's words, never the agent's prose. A person
// approves only in the display window, so the card offers no Approve; it
// offers the default display of the proposal's element on its Run, where the
// element's pop-over carries the proposal (Q23). Pure: no DOM, no network.
import type { WorkspaceResourceReference } from '@leitbild/contracts'
import type { ProposalCard } from '../../../agents/proposal-cards.ts'
import { PROPOSE_OPERATION_ID } from '../../../agents/operation-claims.ts'
import type { UIMessage } from '../render/render-types.ts'

/** Whether an answer's turn called the propose operation, as its tool trace records. */
export const proposedInTurn = (msg: UIMessage): boolean =>
  msg.type === 'chat' && msg.generationTraceId !== undefined && msg.roomId !== undefined
  && (msg.toolTrace ?? []).some(entry => (entry.operationIds ?? []).includes(PROPOSE_OPERATION_ID))

export type ProposalTone = 'pending' | 'executed' | 'closed' | 'refused' | 'unknown'

export interface ProposalCardView {
  /** What it does, as World words the control: "SHUT MOV-8000A", "RESET Manual safety injection". */
  readonly action: string
  /** The equipment it is on, as World names the drawn item: "pressurizer.blockValve". */
  readonly item?: string
  readonly proposer: string
  readonly tone: ProposalTone
  readonly status: string
  /** World's review of a pending proposal: whether the I&C allows it now, and whether the plant moved since. */
  readonly review?: string
  /** Still awaiting a person: its status is read again until it closes. */
  readonly live: boolean
  /** A pending proposal's review: its element's default display on the Run it was proposed on (`<plantId>#<item>`). */
  readonly reviewAt?: { readonly resource: WorkspaceResourceReference; readonly subject: string; readonly title: string }
}

/** A person or agent as an actor id names them: "actor:human:hilde" → "hilde". */
export const actorName = (actorId: string): string => actorId.replace(/^actor:(?:human|ai|system|anonymous):/, '')

const valueWords = (value: unknown): string => typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)

/** What the turn asked for, before World words it: a write's target and value, or an actuation's reset by its rule id. */
const asked = (card: ProposalCard): string => card.reset === true ? `RESET ${card.target}` : `${card.target} → ${valueWords(card.value)}`

export const proposalCardView = (card: ProposalCard, proposerName: string): ProposalCardView => {
  const outcome = card.outcome
  if (outcome.kind === 'refused') {
    return { action: asked(card), proposer: proposerName, tone: 'refused', status: `Refused by World: ${outcome.reason}`, live: false }
  }
  if (outcome.kind === 'unreadable') {
    return { action: asked(card), proposer: proposerName, tone: 'unknown', status: `Status unavailable: ${outcome.reason}`, live: false }
  }
  const proposal = outcome.proposal
  // A reset's word names its actuation ("RESET Manual safety injection"); a write's names the control's action, so the target follows.
  const base = { action: card.reset === true ? proposal.word : `${proposal.word} ${card.target}`, item: proposal.item, proposer: proposerName }
  const by = proposal.closed?.actorId === undefined ? '' : ` by ${actorName(proposal.closed.actorId)}`
  const why = proposal.closed?.reason === undefined ? '' : `: ${proposal.closed.reason}`
  switch (proposal.status) {
    case 'pending': {
      const review = outcome.review
      const allowed = review === undefined ? undefined : review.permitted ? 'I&C allows it now' : `I&C does not allow it now: ${review.refusal ?? 'no reason given'}`
      const changed = review?.changed === true ? 'plant changed since proposed' : undefined
      const words = [allowed, changed].filter((part): part is string => part !== undefined)
      const reviewAt = { resource: outcome.resource, subject: `${card.plantId}#${proposal.item}`, title: `Review: ${base.action}`.slice(0, 120) }
      return { ...base, tone: 'pending', status: 'Awaiting a person\'s approval in the display window', ...(words.length === 0 ? {} : { review: words.join(' · ') }), live: true, reviewAt }
    }
    case 'approved': return { ...base, tone: 'executed', status: `Approved${by} · executed`, live: false }
    case 'rejected': return { ...base, tone: 'closed', status: `Rejected${by}${why}`, live: false }
    case 'expired': return { ...base, tone: 'closed', status: 'Expired before a person decided · not executed', live: false }
    case 'superseded': return { ...base, tone: 'closed', status: `Superseded${why} · not executed`, live: false }
    case 'withdrawn': return { ...base, tone: 'closed', status: 'Withdrawn by its proposer · not executed', live: false }
  }
}
